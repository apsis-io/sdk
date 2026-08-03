/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 */
#define _POSIX_C_SOURCE 200809L /* clock_gettime/CLOCK_MONOTONIC */

#include "io_internal.h"
#include "frame.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <openssl/rand.h>

/* ---- magicseam_pending_call: the one sync object an app thread blocked
 * in magicseam_quic_dial/_call actually waits on (see io_internal.h's own
 * doc comment for why this replaced an earlier, broken design that tried
 * to struct-copy a live pthread_cond_t between two slot objects). ---- */

void magicseam_pending_call_init(magicseam_pending_call *pc) {
  memset(pc, 0, sizeof(*pc));
  pthread_mutex_init(&pc->mu, NULL);
  pthread_cond_init(&pc->cv, NULL);
}

void magicseam_pending_call_destroy(magicseam_pending_call *pc) {
  pthread_mutex_destroy(&pc->mu);
  pthread_cond_destroy(&pc->cv);
}

void magicseam_pending_call_signal(magicseam_pending_call *pc, magicseam_status status,
                                    uint8_t *resp, size_t resp_len) {
  pthread_mutex_lock(&pc->mu);
  if (!pc->done) {
    pc->done = 1;
    pc->status = status;
    pc->resp = resp;
    pc->resp_len = resp_len;
    pthread_cond_broadcast(&pc->cv);
  } else {
    /* Already signaled (e.g. a race between stream_close and a fully-
     * parsed reply arriving in the same io_run_once pass) - the second
     * signal's payload is simply discarded, first signal wins. */
    free(resp);
  }
  pthread_mutex_unlock(&pc->mu);
}

void magicseam_pending_call_wait(magicseam_pending_call *pc) {
  pthread_mutex_lock(&pc->mu);
  while (!pc->done) {
    pthread_cond_wait(&pc->cv, &pc->mu);
  }
  pthread_mutex_unlock(&pc->mu);
}

magicseam_status magicseam_parse_tcp_addr(const char *addr, char *host, size_t hostcap,
                                           char *port, size_t portcap) {
  if (strncmp(addr, "tcp:", 4) != 0) {
    return MAGICSEAM_ERR_ARG;
  }
  const char *hp = addr + 4;
  const char *colon = strrchr(hp, ':');
  if (colon == NULL || colon == hp) {
    return MAGICSEAM_ERR_ARG;
  }
  size_t hlen = (size_t)(colon - hp);
  size_t plen = strlen(colon + 1);
  if (hlen == 0 || hlen >= hostcap || plen == 0 || plen >= portcap) {
    return MAGICSEAM_ERR_ARG;
  }
  memcpy(host, hp, hlen);
  host[hlen] = '\0';
  memcpy(port, colon + 1, plen + 1);
  return MAGICSEAM_OK;
}

/* ---- ngtcp2_conn <-> magicseam_conn recovery (for callbacks) ---- */

static ngtcp2_conn *conn_ref_get_conn(ngtcp2_crypto_conn_ref *ref) {
  magicseam_conn *c = (magicseam_conn *)ref->user_data;
  return c->conn;
}

/* ---- callbacks ---- */

static int cb_handshake_completed(ngtcp2_conn *conn, void *user_data) {
  (void)conn;
  magicseam_conn *c = (magicseam_conn *)user_data;
  c->handshake_done = 1;
  return 0;
}

static void cb_rand(uint8_t *dest, size_t destlen, const ngtcp2_rand_ctx *rand_ctx) {
  (void)rand_ctx;
  /* Only used in non-cryptographic contexts (PATH_CHALLENGE data, CID
   * generation entropy) per ngtcp2's own doc comment, but RAND_bytes is
   * already linked (OpenSSL) and correct, so there's no reason to reach
   * for anything weaker. */
  RAND_bytes(dest, (int)destlen);
}

static int cb_get_new_connection_id2(ngtcp2_conn *conn, ngtcp2_cid *cid,
                                      ngtcp2_stateless_reset_token *token,
                                      size_t cidlen, void *user_data) {
  (void)conn;
  (void)user_data;
  uint8_t buf[NGTCP2_MAX_CIDLEN];
  if (RAND_bytes(buf, (int)cidlen) != 1) {
    return NGTCP2_ERR_CALLBACK_FAILURE;
  }
  ngtcp2_cid_init(cid, buf, cidlen);
  if (RAND_bytes(token->data, NGTCP2_STATELESS_RESET_TOKENLEN) != 1) {
    return NGTCP2_ERR_CALLBACK_FAILURE;
  }
  return 0;
}

/* find_slot / alloc_slot / free_slot: the per-connection call-slot table
 * indexed by ngtcp2 stream_id. io_thread-only (see io_internal.h's own
 * doc comment on the locking model) - no lock needed here. */
static magicseam_call_slot *find_slot(magicseam_conn *c, int64_t stream_id) {
  for (size_t i = 0; i < c->nslots; i++) {
    if (c->slots[i].stream_id == stream_id) {
      return &c->slots[i];
    }
  }
  return NULL;
}

static magicseam_call_slot *alloc_slot(magicseam_conn *c, int64_t stream_id) {
  for (size_t i = 0; i < c->nslots; i++) {
    if (c->slots[i].stream_id == -1) {
      memset(&c->slots[i], 0, sizeof(c->slots[i]));
      c->slots[i].stream_id = stream_id;
      return &c->slots[i];
    }
  }
  size_t new_n = c->nslots == 0 ? 8 : c->nslots * 2;
  magicseam_call_slot *grown = realloc(c->slots, new_n * sizeof(*grown));
  if (grown == NULL) {
    return NULL;
  }
  for (size_t i = c->nslots; i < new_n; i++) {
    memset(&grown[i], 0, sizeof(grown[i]));
    grown[i].stream_id = -1;
  }
  c->slots = grown;
  size_t idx = c->nslots;
  c->nslots = new_n;
  c->slots[idx].stream_id = stream_id;
  return &c->slots[idx];
}

static void free_slot(magicseam_call_slot *s) {
  free(s->out_buf);
  free(s->in_buf);
  memset(s, 0, sizeof(*s));
  s->stream_id = -1;
}

/* in_append grows a slot's inbound buffer by datalen bytes. */
static int in_append(magicseam_call_slot *s, const uint8_t *data, size_t datalen) {
  if (datalen == 0) {
    return 0;
  }
  uint8_t *grown = realloc(s->in_buf, s->in_len + datalen);
  if (grown == NULL) {
    return -1;
  }
  memcpy(grown + s->in_len, data, datalen);
  s->in_buf = grown;
  s->in_len += datalen;
  return 0;
}

/* try_parse_handshake_client: the CLIENT side's handshake stream reply -
 * 1 accept byte then the served-version frame. Returns 1 once fully
 * parsed (writing *out_status and c->served_version), 0 if more data is
 * needed, -1 on a protocol violation. */
static int try_parse_handshake_client(magicseam_conn *c, magicseam_call_slot *s,
                                       magicseam_status *out_status) {
  if (s->in_len < 5) {
    return 0; /* accept byte + at least the 4-byte length prefix */
  }
  uint8_t accept = s->in_buf[0];
  size_t frame_len = magicseam_frame_decode_len(s->in_buf + 1);
  if (frame_len == (size_t)-1) {
    return -1;
  }
  if (s->in_len < 5 + frame_len) {
    return 0;
  }
  size_t copy_len = frame_len < sizeof(c->served_version) - 1 ? frame_len
                                                               : sizeof(c->served_version) - 1;
  memcpy(c->served_version, s->in_buf + 5, copy_len);
  c->served_version[copy_len] = '\0';
  *out_status = accept ? MAGICSEAM_OK : MAGICSEAM_ERR_VERSION;
  return 1;
}

/* try_parse_call_client: the CLIENT side's call-stream reply - 1 result
 * tag, then (only for tag OK) a response frame. On MAGICSEAM_OK, out_resp
 * and out_resp_len receive a malloc'd copy of the payload (the
 * caller - magicseam_quic_call - hands that same buffer straight back to
 * its own caller, per magicseam_free's ownership contract). Same
 * three-return-value shape as try_parse_handshake_client. */
static int try_parse_call_client(magicseam_call_slot *s, magicseam_status *out_status,
                                  uint8_t **out_resp, size_t *out_resp_len) {
  if (s->in_len < 1) {
    return 0;
  }
  uint8_t tag = s->in_buf[0];
  if (tag != MAGICSEAM_TAG_OK) {
    switch (tag) {
      case MAGICSEAM_TAG_REJECTED:
        *out_status = MAGICSEAM_ERR_REJECTED;
        break;
      case MAGICSEAM_TAG_TOOLARGE:
        *out_status = MAGICSEAM_ERR_TOOLARGE;
        break;
      default:
        *out_status = MAGICSEAM_ERR_UNAVAIL;
        break;
    }
    return 1;
  }
  if (s->in_len < 5) {
    return 0;
  }
  size_t frame_len = magicseam_frame_decode_len(s->in_buf + 1);
  if (frame_len == (size_t)-1) {
    return -1;
  }
  if (s->in_len < 5 + frame_len) {
    return 0;
  }
  uint8_t *resp = NULL;
  if (frame_len > 0) {
    resp = malloc(frame_len);
    if (resp == NULL) {
      return -1;
    }
    memcpy(resp, s->in_buf + 5, frame_len);
  }
  *out_resp = resp;
  *out_resp_len = frame_len;
  *out_status = MAGICSEAM_OK;
  return 1;
}

/* magicseam_try_parse_call_server: the SERVER side's inbound call - the
 * CALLER frame followed by the REQUEST frame, no leading tag byte (see
 * remote_quic.rs's wire spec: the client writes both before finishing,
 * unlike the tagged reply).
 *
 * THIS USED TO EXPECT ONE FRAME AND WAS BROKEN FROM 2026-07-31. The caller
 * frame (3532417c, "the seam can say who is calling") was added to the wire
 * two weeks after this SDK was last touched (fd63b912, 07-17), and nothing
 * here was updated. The parser returned 1 as soon as the CALLER frame was
 * complete, and server.c then dispatched `in_buf + 4` - the caller's BODY
 * plus the still-framed request - to the handler as if it were the request.
 *
 * It went unnoticed because the SDK's own tests use the SDK's own client,
 * which does not send a caller frame either, so C-to-C was self-consistent
 * and green while C-against-trail was dead. Confirmed live: trail BINDS to
 * magic-echo-c and then the first call tears the connection down and
 * re-dials in a loop, while ./magicseam_quic_test passes.
 *
 * Returns 1 once BOTH frames have arrived; req_off/req_len then locate the
 * request body inside in_buf. Partial arrivals return 0 as before - this is
 * an incremental parser and either frame can be split across datagrams. */
int magicseam_try_parse_call_server(magicseam_call_slot *s, size_t *req_off,
                                     size_t *req_len) {
  /* Frame 1: the caller. */
  if (s->in_len < 4) {
    return 0;
  }
  size_t caller_len = magicseam_frame_decode_len(s->in_buf);
  if (caller_len == (size_t)-1) {
    return -1;
  }
  if (s->in_len < 4 + caller_len) {
    return 0;
  }
  /* Frame 2: the request, immediately after it. */
  size_t off = 4 + caller_len;
  if (s->in_len < off + 4) {
    return 0;
  }
  size_t body_len = magicseam_frame_decode_len(s->in_buf + off);
  if (body_len == (size_t)-1) {
    return -1;
  }
  if (s->in_len < off + 4 + body_len) {
    return 0;
  }
  if (req_off != NULL) {
    *req_off = off + 4;
  }
  if (req_len != NULL) {
    *req_len = body_len;
  }
  return 1;
}

/* The HANDSHAKE stream carries a single frame (the required version), so it
 * keeps the original one-frame shape. Split out rather than parameterised so
 * neither path can accidentally adopt the other's framing. */
int magicseam_try_parse_handshake_server(magicseam_call_slot *s) {
  if (s->in_len < 4) {
    return 0;
  }
  size_t frame_len = magicseam_frame_decode_len(s->in_buf);
  if (frame_len == (size_t)-1) {
    return -1;
  }
  if (s->in_len < 4 + frame_len) {
    return 0;
  }
  return 1;
}

static int cb_recv_stream_data(ngtcp2_conn *conn, uint32_t flags, int64_t stream_id,
                                uint64_t offset, const uint8_t *data, size_t datalen,
                                void *user_data, void *stream_user_data) {
  (void)offset;
  (void)stream_user_data;
  magicseam_conn *c = (magicseam_conn *)user_data;
  magicseam_call_slot *s = find_slot(c, stream_id);
  if (s == NULL) {
    /* A slot should already exist by the time data arrives: cb_stream_open
     * allocates one for every PEER-opened stream (the server's case -
     * every stream in this protocol is client-opened), and
     * drain_open_intents allocates one itself right after
     * ngtcp2_conn_open_bidi_stream returns a stream_id (the client's
     * case). Allocate defensively here only as a last resort so a
     * surprising callback ordering can't crash. */
    s = alloc_slot(c, stream_id);
    if (s == NULL) {
      return NGTCP2_ERR_CALLBACK_FAILURE;
    }
    s->is_handshake = (stream_id == 0);
  }
  if (in_append(s, data, datalen) != 0) {
    return NGTCP2_ERR_CALLBACK_FAILURE;
  }
  /* ngtcp2 does not grow flow-control windows on its own (same "app
   * decides" design as extend_max_streams_bidi in cb_stream_close) -
   * every byte the peer sends counts against BOTH a per-stream and a
   * connection-wide budget (initial_max_stream_data_bidi_local/remote and
   * initial_max_data, see client.c/server.c) that only ever shrinks
   * unless explicitly extended here. datalen bytes just got copied into
   * s->in_buf (this
   * SDK's request/response payloads are small RPC-sized frames, never a
   * bulk transfer withheld for backpressure), so they're immediately
   * "consumed" from this protocol's point of view - extend both windows
   * back by datalen right away. Missing this was a real, confirmed bug:
   * a sustained run (100k calls, 1 KiB each) stalled after roughly
   * initial_max_data's worth of bytes had round-tripped, with every call
   * thereafter failing "unavailable" - see
   * done/2026-07-16_c-sdk-live-validation.md. */
  if (datalen > 0) {
    ngtcp2_conn_extend_max_stream_offset(conn, stream_id, datalen);
    ngtcp2_conn_extend_max_offset(conn, datalen);
  }
  if (flags & NGTCP2_STREAM_DATA_FLAG_FIN) {
    s->in_fin = 1;
  }

  if (c->is_server) {
    /* Server: parsing/dispatch-to-worker-pool happens in server.c's own
     * post-read_pkt pass (magicseam_io_run_once returns control there),
     * not inline in this callback - ngtcp2 forbids calling back into
     * itself (ngtcp2_conn_read_pkt/writev_stream) from inside a
     * callback, and invoking the application handler from here would
     * risk exactly that if the handler ever did anything synchronous
     * enough to tempt a shortcut. */
    return 0;
  }

  /* Client: parse either the handshake reply or a call reply, signal the
   * blocked application thread once complete (if one is still waiting -
   * s->pending is NULL if it already gave up, e.g. via a timeout this v1
   * doesn't implement yet, or was already signaled by cb_stream_close). */
  magicseam_status status = MAGICSEAM_OK;
  uint8_t *resp = NULL;
  size_t resp_len = 0;
  int rc = s->is_handshake ? try_parse_handshake_client(c, s, &status)
                            : try_parse_call_client(s, &status, &resp, &resp_len);
  if (rc < 0) {
    return NGTCP2_ERR_CALLBACK_FAILURE;
  }
  if (rc == 1 && s->pending != NULL) {
    magicseam_pending_call *pc = s->pending;
    s->pending = NULL;
    magicseam_pending_call_signal(pc, status, resp, resp_len);
  } else {
    free(resp);
  }
  return 0;
}

static int cb_stream_open(ngtcp2_conn *conn, int64_t stream_id, void *user_data) {
  (void)conn;
  magicseam_conn *c = (magicseam_conn *)user_data;
  magicseam_call_slot *s = alloc_slot(c, stream_id);
  if (s == NULL) {
    return NGTCP2_ERR_CALLBACK_FAILURE;
  }
  /* Only the SERVER ever sees this callback fire (every stream in this
   * protocol is opened by the client - see cb_recv_stream_data's own
   * comment); stream_id 0 is always the first stream a peer opens on a
   * connection, i.e. the handshake. */
  s->is_handshake = (stream_id == 0);
  return 0;
}

static int cb_stream_close(ngtcp2_conn *conn, uint32_t flags, int64_t stream_id,
                            uint64_t app_error_code, void *user_data,
                            void *stream_user_data) {
  (void)flags;
  (void)app_error_code;
  (void)stream_user_data;
  magicseam_conn *c = (magicseam_conn *)user_data;
  magicseam_call_slot *s = find_slot(c, stream_id);
  if (s == NULL) {
    return 0;
  }
  if (s->pending != NULL) {
    /* The peer went away mid-call (or mid-handshake) before a full reply
     * arrived - fail the blocked caller instead of hanging it forever. */
    magicseam_pending_call *pc = s->pending;
    s->pending = NULL;
    magicseam_pending_call_signal(pc, MAGICSEAM_ERR_IO, NULL, 0);
  }
  free_slot(s);
  /* SERVER only: every stream in this protocol is CLIENT-opened (see this
   * file's own comments), so only the server ever needs to hand back
   * bidi-stream credit as streams finish - the client never limits the
   * server's stream-opening (it never opens any). Without this,
   * initial_max_streams_bidi's fixed budget (1000, see server.c) is a
   * one-time allowance that's never replenished: the 1000th+ open_bi()
   * on the client just blocks until quinn's own connect/open timeout
   * fires - confirmed live (client-side instrumentation showed exactly
   * 999 successful calls, then every one thereafter failing with
   * "open_bi failed: timed out" - see
   * done/2026-07-16_c-sdk-live-validation.md's write-up of both this and
   * the earlier, separate write_side() retransmission-storm bug). */
  if (c->is_server) {
    ngtcp2_conn_extend_max_streams_bidi(conn, 1);
  }
  return 0;
}

static int cb_acked_stream_data_offset(ngtcp2_conn *conn, int64_t stream_id,
                                        uint64_t offset, uint64_t datalen,
                                        void *user_data, void *stream_user_data) {
  (void)conn;
  (void)offset;
  (void)stream_user_data;
  magicseam_conn *c = (magicseam_conn *)user_data;
  magicseam_call_slot *s = find_slot(c, stream_id);
  if (s != NULL) {
    s->out_acked += datalen;
  }
  return 0;
}

void magicseam_io_fill_callbacks(ngtcp2_callbacks *cb, int is_server) {
  memset(cb, 0, sizeof(*cb));
  if (is_server) {
    cb->recv_client_initial = ngtcp2_crypto_recv_client_initial_cb;
  } else {
    cb->client_initial = ngtcp2_crypto_client_initial_cb;
    /* ngtcp2_conn_client_new asserts recv_retry is non-NULL for a client
     * role (ngtcp2_conn.c: "server || callbacks->recv_retry") even though
     * this fixed intra-cluster deployment never expects a real Retry
     * packet - the ready-made ngtcp2_crypto_recv_retry_cb re-derives
     * Initial secrets against the Retry's new DCID, same as any other
     * ngtcp2-crypto-backed client must wire up regardless. */
    cb->recv_retry = ngtcp2_crypto_recv_retry_cb;
  }
  cb->recv_crypto_data = ngtcp2_crypto_recv_crypto_data_cb;
  cb->handshake_completed = cb_handshake_completed;
  cb->encrypt = ngtcp2_crypto_encrypt_cb;
  cb->decrypt = ngtcp2_crypto_decrypt_cb;
  cb->hp_mask = ngtcp2_crypto_hp_mask_cb;
  cb->recv_stream_data = cb_recv_stream_data;
  cb->acked_stream_data_offset = cb_acked_stream_data_offset;
  cb->stream_open = cb_stream_open;
  cb->stream_close = cb_stream_close;
  cb->rand = cb_rand;
  cb->get_new_connection_id2 = cb_get_new_connection_id2;
  cb->update_key = ngtcp2_crypto_update_key_cb;
  cb->delete_crypto_aead_ctx = ngtcp2_crypto_delete_crypto_aead_ctx_cb;
  cb->delete_crypto_cipher_ctx = ngtcp2_crypto_delete_crypto_cipher_ctx_cb;
  cb->get_path_challenge_data = ngtcp2_crypto_get_path_challenge_data_cb;
  cb->version_negotiation = ngtcp2_crypto_version_negotiation_cb;
}

/* ---- connection lifecycle helpers shared by client.c/server.c ---- */

magicseam_conn *magicseam_conn_new(void) {
  magicseam_conn *c = calloc(1, sizeof(*c));
  if (c == NULL) {
    return NULL;
  }
  c->fd = -1;
  c->wakeup_fds[0] = c->wakeup_fds[1] = -1;
  if (pipe(c->wakeup_fds) != 0) {
    free(c);
    return NULL;
  }
  /* The read end MUST be non-blocking: magicseam_io_thread_main's drain
   * loop is `while (read(...) > 0)`, which only terminates correctly on
   * an empty pipe if read() returns -1/EAGAIN there - on a blocking fd it
   * instead blocks forever waiting for a byte that may never come,
   * wedging the io_thread permanently outside its own poll() loop (found
   * via a live deadlock: every io_thread ends up parked in this exact
   * read() call, and any close()/join() waiting on it then hangs too).
   * The write end is set non-blocking too, purely for symmetry -
   * magicseam_wakeup's single-byte write to a non-full pipe never
   * actually blocks either way. */
  if (fcntl(c->wakeup_fds[0], F_SETFL, O_NONBLOCK) != 0 ||
      fcntl(c->wakeup_fds[1], F_SETFL, O_NONBLOCK) != 0) {
    close(c->wakeup_fds[0]);
    close(c->wakeup_fds[1]);
    free(c);
    return NULL;
  }
  pthread_mutex_init(&c->mu, NULL);
  atomic_init(&c->state, MAGICSEAM_CONN_HANDSHAKING);
  c->conn_ref.get_conn = conn_ref_get_conn;
  c->conn_ref.user_data = c;
  return c;
}

void magicseam_conn_free(magicseam_conn *c) {
  if (c == NULL) {
    return;
  }
  for (size_t i = 0; i < c->nslots; i++) {
    if (c->slots[i].stream_id != -1) {
      free_slot(&c->slots[i]);
    }
  }
  free(c->slots);
  for (magicseam_open_intent *it = c->open_intents; it != NULL;) {
    magicseam_open_intent *next = it->next;
    /* An unqueued-but-never-drained open_intent still has an app thread
     * stack-blocked on it (see magicseam_pending_call's own doc comment)
     * - fail it rather than silently freeing its wait forever. */
    magicseam_pending_call_signal(it->pending, MAGICSEAM_ERR_IO, NULL, 0);
    free(it->req);
    free(it);
    it = next;
  }
  for (magicseam_reply_intent *it = c->reply_intents; it != NULL;) {
    magicseam_reply_intent *next = it->next;
    free(it->payload);
    free(it);
    it = next;
  }
  for (magicseam_pkt *it = c->pkt_queue; it != NULL;) {
    magicseam_pkt *next = it->next;
    free(it->data);
    free(it);
    it = next;
  }
  if (c->wakeup_fds[0] != -1) {
    close(c->wakeup_fds[0]);
  }
  if (c->wakeup_fds[1] != -1) {
    close(c->wakeup_fds[1]);
  }
  pthread_mutex_destroy(&c->mu);
  free(c);
}

void magicseam_conn_request_close(magicseam_conn *c) {
  atomic_store(&c->state, MAGICSEAM_CONN_CLOSING);
  magicseam_wakeup(c);
}

void magicseam_wakeup(magicseam_conn *c) {
  uint8_t b = 0;
  ssize_t n = write(c->wakeup_fds[1], &b, 1);
  (void)n; /* best-effort - a full self-pipe just means a wake is already pending */
}

uint64_t magicseam_now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

void magicseam_conn_feed_pkt(magicseam_conn *c, const uint8_t *data, size_t len,
                              const struct sockaddr *peer_addr, socklen_t peer_addrlen) {
  magicseam_pkt *pkt = malloc(sizeof(*pkt));
  if (pkt == NULL) {
    return; /* drop - equivalent to a lost UDP datagram, which QUIC already tolerates */
  }
  pkt->data = malloc(len);
  if (pkt->data == NULL) {
    free(pkt);
    return;
  }
  memcpy(pkt->data, data, len);
  pkt->len = len;

  pkt->next = NULL;

  pthread_mutex_lock(&c->mu);
  if (peer_addrlen <= sizeof(c->remote_addr)) {
    memcpy(&c->remote_addr, peer_addr, peer_addrlen);
    c->remote_addrlen = peer_addrlen;
  }
  if (c->pkt_queue_tail != NULL) {
    c->pkt_queue_tail->next = pkt;
  } else {
    c->pkt_queue = pkt;
  }
  c->pkt_queue_tail = pkt;
  pthread_mutex_unlock(&c->mu);
  magicseam_wakeup(c);
}

/* ---- the event loop body (shared by client io_thread and server per-conn processing) ---- */

static void build_path(magicseam_conn *c, ngtcp2_path *path) {
  ngtcp2_addr_init(&path->local, (ngtcp2_sockaddr *)&c->local_addr, c->local_addrlen);
  ngtcp2_addr_init(&path->remote, (ngtcp2_sockaddr *)&c->remote_addr, c->remote_addrlen);
  path->user_data = NULL;
}

/* drain_open_intents: for a CLIENT connection, turn each queued
 * "please open a stream and send this" request into a real
 * ngtcp2_conn_open_bidi_stream + a populated call_slot with the request
 * bytes staged as outbound data (write_side below then actually sends
 * it) and slot->pending wired to the caller's own sync object. Must run
 * on the io_thread (only it may touch conn). */
static void drain_open_intents(magicseam_conn *c) {
  pthread_mutex_lock(&c->mu);
  magicseam_open_intent *intent = c->open_intents;
  c->open_intents = NULL;
  pthread_mutex_unlock(&c->mu);

  magicseam_open_intent *retry_head = NULL;
  magicseam_open_intent *retry_tail = NULL;

  while (intent != NULL) {
    magicseam_open_intent *next = intent->next;
    int64_t stream_id = -1;
    int rc = ngtcp2_conn_open_bidi_stream(c->conn, &stream_id, NULL);
    if (rc == NGTCP2_ERR_STREAM_ID_BLOCKED) {
      /* The peer's initial_max_streams_bidi transport parameter (how
       * many streams WE may open) isn't known yet - it only arrives once
       * we've processed the peer's handshake data, so a brand-new
       * connection's very first open (the version handshake itself)
       * reliably hits this on io_run_once's first pass, before any
       * packet has round-tripped. Re-queue rather than fail: the next
       * drain_open_intents pass (triggered once the peer's transport
       * params are in) will retry successfully. */
      intent->next = NULL;
      if (retry_tail != NULL) {
        retry_tail->next = intent;
      } else {
        retry_head = intent;
      }
      retry_tail = intent;
      intent = next;
      continue;
    }
    if (rc != 0) {
      /* Any other ngtcp2_conn_open_bidi_stream failure is fatal (e.g.
       * NGTCP2_ERR_NOMEM) - fail this one call rather than block the
       * whole loop; a caller wanting retry can issue a fresh Call(). */
      magicseam_pending_call_signal(intent->pending, MAGICSEAM_ERR_IO, NULL, 0);
      free(intent->req);
      free(intent);
      intent = next;
      continue;
    }
    magicseam_call_slot *s = alloc_slot(c, stream_id);
    if (s == NULL) { /* OOM */
      magicseam_pending_call_signal(intent->pending, MAGICSEAM_ERR_IO, NULL, 0);
      free(intent->req);
      free(intent);
      intent = next;
      continue;
    }
    s->out_buf = intent->req; /* ownership of req transfers to the slot */
    s->out_len = intent->req_len;
    s->out_fin = 1;
    s->is_handshake = intent->is_handshake;
    s->pending = intent->pending;
    free(intent);
    intent = next;
  }

  if (retry_head != NULL) {
    pthread_mutex_lock(&c->mu);
    retry_tail->next = c->open_intents;
    c->open_intents = retry_head;
    pthread_mutex_unlock(&c->mu);
  }
}

/* drain_reply_intents: for a SERVER connection, apply a worker thread's
 * completed handler result onto its call_slot as outbound bytes (tag
 * byte + optional payload frame), so write_side sends it. */
static void drain_reply_intents(magicseam_conn *c) {
  pthread_mutex_lock(&c->mu);
  magicseam_reply_intent *intent = c->reply_intents;
  c->reply_intents = NULL;
  pthread_mutex_unlock(&c->mu);

  while (intent != NULL) {
    magicseam_reply_intent *next = intent->next;
    magicseam_call_slot *s = find_slot(c, intent->stream_id);
    if (s != NULL) {
      size_t out_len = 1 + (intent->tag == MAGICSEAM_TAG_OK ? 4 + intent->payload_len : 0);
      uint8_t *buf = malloc(out_len);
      if (buf != NULL) {
        buf[0] = (uint8_t)intent->tag;
        if (intent->tag == MAGICSEAM_TAG_OK) {
          magicseam_frame_encode(buf + 1, intent->payload, intent->payload_len);
        }
        s->out_buf = buf;
        s->out_len = out_len;
        s->out_fin = 1;
      }
    }
    free(intent->payload);
    free(intent);
    intent = next;
  }
}

/* write_side considers ONE call_slot with unsent outbound bytes per
 * ngtcp2_conn_writev_stream call (a deliberate simplification over
 * NGTCP2_WRITE_STREAM_FLAG_MORE's multi-stream coalescing - correct,
 * just not maximally packet-efficient, which is the right tradeoff for
 * this control-plane-sized RPC protocol, not a bulk transfer). Returns
 * -1 on a fatal ngtcp2 error, 0 otherwise. */
static int write_side(magicseam_conn *c) {
  ngtcp2_path path;
  build_path(c, &path);
  uint8_t out[NGTCP2_MAX_UDP_PAYLOAD_SIZE];

  for (;;) {
    magicseam_call_slot *pick = NULL;
    for (size_t i = 0; i < c->nslots; i++) {
      magicseam_call_slot *s = &c->slots[i];
      if (s->stream_id == -1 || s->out_buf == NULL) {
        continue;
      }
      int have_unsent_bytes = s->out_offset < s->out_len;
      int have_unsent_fin = s->out_offset >= s->out_len && s->out_fin && !s->out_fin_sent;
      if (have_unsent_bytes || have_unsent_fin) {
        pick = s;
        break;
      }
    }

    ngtcp2_vec vec;
    uint32_t flags = NGTCP2_WRITE_STREAM_FLAG_NONE;
    int64_t stream_id = -1;
    size_t vcnt = 0;
    if (pick != NULL) {
      stream_id = pick->stream_id;
      vec.base = pick->out_buf + pick->out_offset;
      vec.len = pick->out_len - pick->out_offset;
      vcnt = 1;
      if (pick->out_fin) {
        flags |= NGTCP2_WRITE_STREAM_FLAG_FIN;
      }
    }

    ngtcp2_ssize datalen = -1;
    ngtcp2_ssize n = ngtcp2_conn_writev_stream(c->conn, &path, NULL, out, sizeof(out),
                                                &datalen, flags, stream_id,
                                                pick ? &vec : NULL, vcnt, magicseam_now_ns());
    if (n == 0) {
      break; /* nothing more to send right now */
    }
    if (n == NGTCP2_ERR_STREAM_DATA_BLOCKED || n == NGTCP2_ERR_STREAM_NOT_FOUND ||
        n == NGTCP2_ERR_STREAM_SHUT_WR) {
      /* This particular stream can't make progress (flow control, or it
       * no longer exists) - try once more with no stream data to at
       * least flush any other pending frame (ACKs etc.), then stop for
       * this pass UNCONDITIONALLY (send the flush packet here and break,
       * rather than falling through to the loop-back-to-top code below).
       * pick's out_offset/out_len are untouched by this blocked stream,
       * so looping back would just re-select the SAME still-blocked
       * stream, hit this exact branch again, and repeat - nothing about
       * the block clears until a NEW inbound packet arrives (e.g. a
       * MAX_STREAM_DATA update), which the next magicseam_io_run_once
       * pass picks up, not this one. Confirmed live via tcpdump: without
       * this break, a permanently-blocked stream free-runs this into an
       * ACK/retransmission storm between both peers (~63,000 pkt/s,
       * never settling) instead of yielding back to poll() - see
       * done/2026-07-16_c-sdk-live-validation.md. */
      n = ngtcp2_conn_writev_stream(c->conn, &path, NULL, out, sizeof(out), &datalen,
                                     NGTCP2_WRITE_STREAM_FLAG_NONE, -1, NULL, 0,
                                     magicseam_now_ns());
      if (n > 0) {
        ssize_t sent = sendto(c->fd, out, (size_t)n, 0, (struct sockaddr *)&c->remote_addr,
                               c->remote_addrlen);
        (void)sent;
      }
      break;
    }
    if (n < 0) {
      return -1;
    }

    if (datalen > 0 && pick != NULL) {
      pick->out_offset += (size_t)datalen;
      if (pick->out_offset >= pick->out_len && pick->out_fin) {
        pick->out_fin_sent = 1;
      }
    }

    ssize_t sent = sendto(c->fd, out, (size_t)n, 0, (struct sockaddr *)&c->remote_addr,
                           c->remote_addrlen);
    (void)sent; /* a dropped UDP datagram is exactly what QUIC's own loss
                 * recovery exists to handle - not this loop's job to retry */
  }
  return 0;
}

/* server_scan_requests looks at every slot with a fully-received inbound
 * frame not yet acted on: the handshake stream gets its accept+served-
 * version reply staged directly (purely local string work, no worker
 * pool needed - this package always accepts, matching every other
 * magic-seam SDK's "gating is the consumer's job" convention); a call
 * stream's request is handed to magicseam_server_dispatch (server.c's
 * worker pool) so the io_thread itself never runs application code.
 * Returns -1 on a protocol violation (caller should tear down). */
static int server_scan_requests(magicseam_conn *c) {
  for (size_t i = 0; i < c->nslots; i++) {
    magicseam_call_slot *s = &c->slots[i];
    if (s->stream_id == -1 || s->handler_dispatched) {
      continue;
    }
    size_t req_off = 0, req_len = 0;
    int rc = s->is_handshake ? magicseam_try_parse_handshake_server(s)
                             : magicseam_try_parse_call_server(s, &req_off, &req_len);
    if (rc < 0) {
      return -1;
    }
    if (rc == 0) {
      continue;
    }
    s->handler_dispatched = 1;
    if (s->is_handshake) {
      size_t vlen = strlen(c->local_version);
      uint8_t *out = malloc(1 + 4 + vlen);
      if (out == NULL) {
        return -1;
      }
      out[0] = 1; /* always accept - see this function's own doc comment */
      magicseam_frame_encode(out + 1, (const uint8_t *)c->local_version, vlen);
      s->out_buf = out;
      s->out_len = 1 + 4 + vlen;
      s->out_fin = 1;
    } else {
      /* The REQUEST body only - not the caller frame, and not the request's
       * own length prefix. Passing `in_buf + 4` handed the handler the
       * caller's bytes; see magicseam_try_parse_call_server. */
      magicseam_server_dispatch(c, s->stream_id, s->in_buf + req_off, req_len);
    }
  }
  return 0;
}

uint64_t magicseam_io_run_once(magicseam_conn *c) {
  ngtcp2_path path;
  build_path(c, &path);

  /* 1. Feed ngtcp2 whatever new inbound data is available. CLIENT
   * connections own a private connected UDP fd and read it directly;
   * SERVER connections instead drain c->pkt_queue, since c->fd is the
   * listener's single shared socket and only the accept thread ever
   * reads it (see magicseam_conn_feed_pkt / server.c). */
  if (c->is_server) {
    pthread_mutex_lock(&c->mu);
    magicseam_pkt *pkt = c->pkt_queue;
    c->pkt_queue = NULL;
    c->pkt_queue_tail = NULL;
    pthread_mutex_unlock(&c->mu);

    while (pkt != NULL) {
      magicseam_pkt *next = pkt->next;
      ngtcp2_pkt_info pi;
      memset(&pi, 0, sizeof(pi));
      int rc = ngtcp2_conn_read_pkt(c->conn, &path, &pi, pkt->data, pkt->len, magicseam_now_ns());
      free(pkt->data);
      free(pkt);
      if (rc != 0) {
        atomic_store(&c->state, MAGICSEAM_CONN_CLOSING);
        for (pkt = next; pkt != NULL;) {
          magicseam_pkt *n2 = pkt->next;
          free(pkt->data);
          free(pkt);
          pkt = n2;
        }
        return (uint64_t)-1;
      }
      pkt = next;
    }
  } else {
    uint8_t buf[65536];
    for (;;) {
      struct sockaddr_storage peer;
      socklen_t peerlen = sizeof(peer);
      ssize_t n = recvfrom(c->fd, buf, sizeof(buf), MSG_DONTWAIT, (struct sockaddr *)&peer, &peerlen);
      if (n < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
          break;
        }
        return (uint64_t)-1;
      }
      if (n == 0) {
        continue;
      }
      ngtcp2_pkt_info pi;
      memset(&pi, 0, sizeof(pi));
      /* c->remote_addr is set once at dial time and never changes for
       * the lifetime of this connection (no connection migration
       * support - out of scope for this SDK's synchronous, single-path
       * use case); peer is read but not used to update the path,
       * matching that simplification deliberately. */
      int rc = ngtcp2_conn_read_pkt(c->conn, &path, &pi, buf, (size_t)n, magicseam_now_ns());
      if (rc != 0) {
        /* NGTCP2_ERR_DRAINING/_CLOSING: expected during teardown, not
         * fatal - just stop processing further packets and let the
         * caller observe the connection is on its way out via c->state.
         * Anything else: treat as fatal for this simple synchronous
         * transport (fail closed rather than attempt Retry/version-
         * negotiation recovery, which this SDK's fixed single-version
         * intra-cluster deployment should never need in practice). */
        atomic_store(&c->state, MAGICSEAM_CONN_CLOSING);
        return (uint64_t)-1;
      }
    }
  }

  /* 2. SERVER: stage handshake replies / dispatch newly-complete calls
   * now that conn has seen all currently-available incoming data. */
  if (c->is_server && server_scan_requests(c) != 0) {
    atomic_store(&c->state, MAGICSEAM_CONN_CLOSING);
    return (uint64_t)-1;
  }

  /* 3. Apply queued application intents (open new client streams / stage
   * server handler results). */
  if (c->is_server) {
    drain_reply_intents(c);
  } else {
    drain_open_intents(c);
  }

  /* 4. Write everything ngtcp2 now wants to send. */
  if (write_side(c) != 0) {
    atomic_store(&c->state, MAGICSEAM_CONN_CLOSING);
    return (uint64_t)-1;
  }

  if (c->handshake_done && atomic_load(&c->state) == MAGICSEAM_CONN_HANDSHAKING) {
    atomic_store(&c->state, MAGICSEAM_CONN_UP);
  }

  return ngtcp2_conn_get_expiry2(c->conn);
}

void *magicseam_io_thread_main(void *arg) {
  magicseam_conn *c = (magicseam_conn *)arg;
  for (;;) {
    if (atomic_load(&c->state) == MAGICSEAM_CONN_CLOSING) {
      /* Best-effort: let ngtcp2 emit a CONNECTION_CLOSE if it hasn't
       * already (write_side will naturally do nothing if the conn is
       * already past that point). */
      write_side(c);
      break;
    }

    uint64_t expiry = magicseam_io_run_once(c);
    if (expiry == (uint64_t)-1) {
      break;
    }

    uint64_t now = magicseam_now_ns();
    int timeout_ms = expiry <= now ? 0 : (int)((expiry - now) / 1000000ull);
    if (timeout_ms > 60000) {
      timeout_ms = 60000; /* bound the poll so a close request is never starved for long */
    }

    /* CLIENT connections poll their own private fd directly alongside
     * the wakeup pipe; SERVER connections must NOT poll c->fd - it's the
     * listener's single socket shared by every accepted connection, and
     * only the accept thread ever reads it (see server.c) - a per-
     * connection thread here only needs its own wakeup pipe, poked by
     * magicseam_conn_feed_pkt/drain_reply_intents/close-request. */
    struct pollfd pfds[2];
    nfds_t npfds;
    if (c->is_server) {
      pfds[0].fd = c->wakeup_fds[0];
      pfds[0].events = POLLIN;
      pfds[0].revents = 0;
      npfds = 1;
    } else {
      pfds[0].fd = c->fd;
      pfds[0].events = POLLIN;
      pfds[0].revents = 0;
      pfds[1].fd = c->wakeup_fds[0];
      pfds[1].events = POLLIN;
      pfds[1].revents = 0;
      npfds = 2;
    }
    int rc = poll(pfds, npfds, timeout_ms);
    if (rc < 0 && errno != EINTR) {
      break;
    }
    struct pollfd *wakeup_pfd = &pfds[npfds - 1];
    if (rc > 0 && (wakeup_pfd->revents & POLLIN)) {
      uint8_t drain[64];
      while (read(c->wakeup_fds[0], drain, sizeof(drain)) > 0) {
        /* drain every queued wakeup byte so a burst of Call()s only
         * costs one extra loop iteration, not one poll() return per byte */
      }
    }
    if (rc == 0) {
      /* Timed out: ngtcp2's own expiry (idle/loss-detection/PTO) has
       * passed - this is the exact continuous servicing this whole
       * background-thread design exists for (see io_internal.h's own
       * doc comment): without this, the connection would silently die
       * between application calls. */
      ngtcp2_conn_handle_expiry(c->conn, magicseam_now_ns());
      write_side(c);
    }
  }
  atomic_store(&c->state, MAGICSEAM_CONN_DEAD);
  /* Wake every blocked Call()/dial() waiter so nothing hangs forever
   * past this point. */
  for (size_t i = 0; i < c->nslots; i++) {
    if (c->slots[i].stream_id != -1 && c->slots[i].pending != NULL) {
      magicseam_pending_call *pc = c->slots[i].pending;
      c->slots[i].pending = NULL;
      magicseam_pending_call_signal(pc, MAGICSEAM_ERR_IO, NULL, 0);
    }
  }
  return NULL;
}
