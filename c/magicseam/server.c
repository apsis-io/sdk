/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * Server-side magic-seam QUIC API: one shared bound UDP socket serving
 * many connections, demuxed by Connection ID. Three thread roles:
 *  - the ACCEPT thread: owns the shared socket, reads every datagram,
 *    demuxes by CID to an existing magicseam_conn (magicseam_conn_feed_pkt)
 *    or accepts a brand-new one (ngtcp2_accept + ngtcp2_conn_server_new).
 *  - each connection's own IO thread (io.c's magicseam_io_thread_main,
 *    is_server=1): drains its pkt_queue, stages handshake replies, hands
 *    calls to the worker pool, writes outbound packets - never runs
 *    application code (a slow handler must never stall other
 *    connections' packet processing).
 *  - the WORKER pool: runs the application handler for each completed
 *    call, then queues the result back onto the owning connection's
 *    reply_intents for its own IO thread to send.
 */
#include "magicseam_quic.h"
#include "io_internal.h"
#include "tls_internal.h"
#include "frame.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <openssl/rand.h>

/* Every server-chosen Connection ID is this length - fixed so the
 * accept thread's CID demux (ngtcp2_pkt_decode_version_cid's
 * short_dcidlen parameter) never needs to guess. */
#define MAGICSEAM_SERVER_CIDLEN 8
#define MAGICSEAM_SERVER_WORKERS 8

/* conn_entry is demuxed by TWO keys, either of which routes a packet to
 * this connection: `scid` (our own fixed-length CID, chosen at accept
 * time - what the client uses once it has processed our first reply and
 * switched over, and what every post-handshake short-header/1-RTT packet
 * always carries) and `orig_dcid` (the CLIENT's own arbitrary-length CID
 * from ITS first Initial packet - what every packet the client sends
 * BEFORE learning our scid still carries, including retransmissions of
 * that same first flight). Without the second key, a duplicate/
 * retransmitted Initial packet - which legitimately still carries the
 * client's original dcid, not yet our scid - fails to match this already-
 * in-progress connection and gets misrouted through accept_thread_main's
 * "unrecognized CID" path into a second, throwaway ngtcp2_accept +
 * accept_new_conn, leaking a connection/thread per duplicate. */
typedef struct conn_entry {
  uint8_t scid[MAGICSEAM_SERVER_CIDLEN];
  uint8_t orig_dcid[NGTCP2_MAX_CIDLEN];
  size_t orig_dcidlen;
  magicseam_conn *conn;
  struct conn_entry *next;
} conn_entry;

typedef struct work_item {
  magicseam_conn *conn;
  int64_t stream_id;
  uint8_t *req; /* this work_item's OWN copy - see magicseam_server_dispatch */
  size_t req_len;
  struct work_item *next;
} work_item;

struct magicseam_quic_server {
  int fd; /* shared by every accepted connection - only the accept thread reads it */
  SSL_CTX *ssl_ctx;
  char version[256];
  magicseam_handler handler;
  void *user_data;

  pthread_t accept_thread;
  int accept_thread_started;
  int wakeup_fds[2];
  atomic_int closing;

  pthread_mutex_t conns_mu;
  conn_entry *conns;

  pthread_t workers[MAGICSEAM_SERVER_WORKERS];
  size_t nworkers;
  pthread_mutex_t work_mu;
  pthread_cond_t work_cv;
  work_item *work_head;
  work_item *work_tail;
  int workers_stop;
};

static void wake_fd(int fd) {
  uint8_t b = 0;
  ssize_t n = write(fd, &b, 1);
  (void)n;
}

/* TEMPORARY diagnostic (MAGICSEAM_NGTCP2_LOG env-gated): dumps ngtcp2's own
 * internal debug log (PTO firing, congestion window, stream flow control,
 * loss detection) to stderr - see
 * done/2026-07-16_c-sdk-live-validation.md's "residual issue" section for
 * why plain printf instrumentation in this SDK's own callbacks wasn't
 * enough to pin down the sustained-volume degradation. */
static void dbg_ngtcp2_log(void *user_data, char *msg, size_t len) {
  (void)user_data;
  fprintf(stderr, "[ngtcp2][server] %.*s\n", (int)len, msg);
  fflush(stderr);
}

void magicseam_server_dispatch(magicseam_conn *c, int64_t stream_id, const uint8_t *req,
                                size_t req_len) {
  magicseam_quic_server *s = c->owner;
  work_item *item = malloc(sizeof(*item));
  if (item == NULL) {
    return; /* drop - equivalent to a lost datagram; the caller's Call() has no timeout in
              * this v1, but an OOM server is not a case worth over-engineering recovery for */
  }
  item->req = req_len > 0 ? malloc(req_len) : NULL;
  if (req_len > 0 && item->req == NULL) {
    free(item);
    return;
  }
  if (req_len > 0) {
    memcpy(item->req, req, req_len);
  }
  item->req_len = req_len;
  item->conn = c;
  item->stream_id = stream_id;
  item->next = NULL;

  pthread_mutex_lock(&s->work_mu);
  if (s->work_tail != NULL) {
    s->work_tail->next = item;
  } else {
    s->work_head = item;
  }
  s->work_tail = item;
  pthread_cond_signal(&s->work_cv);
  pthread_mutex_unlock(&s->work_mu);
}

static void *worker_main(void *arg) {
  magicseam_quic_server *s = (magicseam_quic_server *)arg;
  for (;;) {
    pthread_mutex_lock(&s->work_mu);
    while (s->work_head == NULL && !s->workers_stop) {
      pthread_cond_wait(&s->work_cv, &s->work_mu);
    }
    if (s->work_head == NULL) { /* workers_stop and queue drained */
      pthread_mutex_unlock(&s->work_mu);
      break;
    }
    work_item *item = s->work_head;
    s->work_head = item->next;
    if (s->work_head == NULL) {
      s->work_tail = NULL;
    }
    pthread_mutex_unlock(&s->work_mu);

    uint8_t *resp = NULL;
    size_t resp_len = 0;
    magicseam_status status = s->handler(s->user_data, item->req, item->req_len, &resp, &resp_len);
    free(item->req);

    magicseam_reply_intent *reply = malloc(sizeof(*reply));
    if (reply != NULL) {
      reply->stream_id = item->stream_id;
      if (status == MAGICSEAM_OK) {
        reply->tag = MAGICSEAM_TAG_OK;
        reply->payload = resp;
        reply->payload_len = resp_len;
      } else {
        reply->tag = magicseam_status_to_tag(status);
        reply->payload = NULL;
        reply->payload_len = 0;
        free(resp); /* a non-OK return should leave resp untouched, but free defensively */
      }
      reply->next = NULL;

      magicseam_conn *c = item->conn;
      pthread_mutex_lock(&c->mu);
      reply->next = c->reply_intents;
      c->reply_intents = reply;
      pthread_mutex_unlock(&c->mu);
      magicseam_wakeup(c);
    } else {
      free(resp);
    }
    free(item);
  }
  return NULL;
}

/* find_conn_locked matches EITHER key a conn_entry is registered under -
 * see conn_entry's own doc comment for why both are needed (our own scid
 * for post-switch/1-RTT traffic, the client's original dcid for
 * duplicate/retransmitted pre-switch Initial packets). */
static conn_entry *find_conn_locked(magicseam_quic_server *s, const uint8_t *dcid, size_t dcidlen) {
  for (conn_entry *e = s->conns; e != NULL; e = e->next) {
    if (dcidlen == MAGICSEAM_SERVER_CIDLEN && memcmp(e->scid, dcid, MAGICSEAM_SERVER_CIDLEN) == 0) {
      return e;
    }
    if (dcidlen == e->orig_dcidlen && memcmp(e->orig_dcid, dcid, dcidlen) == 0) {
      return e;
    }
  }
  return NULL;
}

/* accept_new_conn builds a brand-new magicseam_conn for an unrecognized
 * CID's Initial packet (hd, already decoded+validated by ngtcp2_accept),
 * starts its own IO thread, and registers it in s->conns under a fresh
 * server-chosen CID (the demux key every later packet from this peer
 * will carry as its Destination Connection ID). Returns NULL (nothing
 * registered, nothing to free by the caller) on any failure - the
 * client's Initial simply goes unanswered and it will retry/time out,
 * same as a lost datagram. */
static magicseam_conn *accept_new_conn(magicseam_quic_server *s, const ngtcp2_pkt_hd *hd,
                                        const struct sockaddr *peer_addr, socklen_t peer_addrlen) {
  magicseam_conn *c = magicseam_conn_new();
  if (c == NULL) {
    return NULL;
  }
  c->fd = s->fd;
  c->is_server = 1;
  c->reap_wakeup_fd = s->wakeup_fds[1]; /* so the io_thread can prompt the sweep */
  c->owner = s;
  memcpy(c->local_version, s->version, sizeof(c->local_version) - 1);
  c->local_version[sizeof(c->local_version) - 1] = '\0';
  memcpy(&c->remote_addr, peer_addr, peer_addrlen);
  c->remote_addrlen = peer_addrlen;
  c->local_addrlen = sizeof(c->local_addr);
  if (getsockname(s->fd, (struct sockaddr *)&c->local_addr, &c->local_addrlen) != 0) {
    magicseam_conn_free(c);
    return NULL;
  }

  SSL *ssl = magicseam_tls_ssl_new_server(s->ssl_ctx);
  if (ssl == NULL) {
    magicseam_conn_free(c);
    return NULL;
  }
  c->ssl = ssl;

  if (ngtcp2_crypto_ossl_ctx_new(&c->ossl, ssl) != 0) {
    SSL_free(ssl);
    magicseam_conn_free(c);
    return NULL;
  }
  if (ngtcp2_crypto_ossl_configure_server_session(ssl) != 0) {
    ngtcp2_crypto_ossl_ctx_del(c->ossl);
    SSL_free(ssl);
    magicseam_conn_free(c);
    return NULL;
  }
  SSL_set_app_data(ssl, &c->conn_ref);

  uint8_t cidbuf[MAGICSEAM_SERVER_CIDLEN];
  RAND_bytes(cidbuf, MAGICSEAM_SERVER_CIDLEN);
  ngtcp2_cid our_scid;
  ngtcp2_cid_init(&our_scid, cidbuf, MAGICSEAM_SERVER_CIDLEN);

  ngtcp2_path path;
  ngtcp2_addr_init(&path.local, (ngtcp2_sockaddr *)&c->local_addr, c->local_addrlen);
  ngtcp2_addr_init(&path.remote, (ngtcp2_sockaddr *)&c->remote_addr, c->remote_addrlen);
  path.user_data = NULL;

  ngtcp2_callbacks cb;
  magicseam_io_fill_callbacks(&cb, 1);

  ngtcp2_settings settings;
  ngtcp2_settings_default(&settings);
  settings.initial_ts = magicseam_now_ns();
  if (getenv("MAGICSEAM_NGTCP2_LOG") != NULL) {
    settings.log_write = dbg_ngtcp2_log;
  }

  ngtcp2_transport_params params;
  ngtcp2_transport_params_default(&params);
  params.initial_max_data = 16u << 20;
  params.initial_max_stream_data_bidi_local = 4u << 20;
  params.initial_max_stream_data_bidi_remote = 4u << 20;
  params.initial_max_streams_bidi = 1000;
  params.initial_max_streams_uni = 0;
  params.max_idle_timeout = magicseam_server_idle_timeout_ns;
  params.original_dcid = hd->dcid;
  params.original_dcid_present = 1;

  /* dcid here is the Connection ID that appeared in the client's Initial
   * packet as ITS OWN Source Connection ID (hd.scid) - see
   * ngtcp2_conn_server_new's own doc comment; our_scid is the CID WE
   * choose, which becomes the Destination Connection ID the client uses
   * in every subsequent packet (the demux key registered below). */
  if (ngtcp2_conn_server_new(&c->conn, &hd->scid, &our_scid, &path, hd->version, &cb, &settings,
                              &params, NULL, c) != 0) {
    ngtcp2_crypto_ossl_ctx_del(c->ossl);
    SSL_free(ssl);
    magicseam_conn_free(c);
    return NULL;
  }
  ngtcp2_conn_set_tls_native_handle(c->conn, c->ossl);

  conn_entry *entry = malloc(sizeof(*entry));
  if (entry == NULL) {
    ngtcp2_conn_del(c->conn);
    ngtcp2_crypto_ossl_ctx_del(c->ossl);
    SSL_free(ssl);
    magicseam_conn_free(c);
    return NULL;
  }
  memcpy(entry->scid, cidbuf, MAGICSEAM_SERVER_CIDLEN);
  entry->orig_dcidlen = hd->dcid.datalen;
  memcpy(entry->orig_dcid, hd->dcid.data, hd->dcid.datalen);
  entry->conn = c;

  if (pthread_create(&c->io_thread, NULL, magicseam_io_thread_main, c) != 0) {
    free(entry);
    ngtcp2_conn_del(c->conn);
    ngtcp2_crypto_ossl_ctx_del(c->ossl);
    SSL_free(ssl);
    magicseam_conn_free(c);
    return NULL;
  }
  c->started = 1;

  pthread_mutex_lock(&s->conns_mu);
  entry->next = s->conns;
  s->conns = entry;
  pthread_mutex_unlock(&s->conns_mu);

  return c;
}

/* reap_finished_conns unlinks and frees every connection whose io_thread has
 * exited, and it is the missing half of this server's connection lifecycle.
 *
 * WITHOUT IT A SERVER CONNECTION IS IMMORTAL. magicseam_conn_free is called
 * only on accept-time setup failures, so every connection that ever SUCCEEDED
 * kept its conn_entry AND its per-connection io_thread forever - a thread per
 * connection ever accepted, for the life of the process. Measured on engix99
 * 2026-08-15: magic-echo-c, up 27h, 74 finished connections still holding
 * threads, none blocked in the kernel, together burning ~4 cores. The peer in
 * every case was radiant's reachability prober, which dials each QUIC
 * SeamProvider every 5s and closes cleanly - the client side was correct
 * throughout; nothing here ever collected the remains.
 *
 * UNLINK UNDER THE LOCK, JOIN AND FREE OUTSIDE IT. pthread_join while holding
 * conns_mu would stall every packet demux (find_conn_locked takes the same
 * lock) for as long as a thread takes to wind down, and turns any future lock
 * taken by an io_thread into a deadlock. Same shape the shutdown path below
 * already uses, for the same reasons. */
uint64_t magicseam_server_idle_timeout_ns = 30 * NGTCP2_SECONDS;

size_t magicseam_server_live_conns(magicseam_quic_server *s) {
  pthread_mutex_lock(&s->conns_mu);
  size_t n = 0;
  for (conn_entry *e = s->conns; e != NULL; e = e->next) {
    n++;
  }
  pthread_mutex_unlock(&s->conns_mu);

  return n;
}

static void reap_finished_conns(magicseam_quic_server *s) {
  conn_entry *dead = NULL;

  pthread_mutex_lock(&s->conns_mu);
  conn_entry **link = &s->conns;
  while (*link != NULL) {
    conn_entry *e = *link;
    if (e->conn != NULL && atomic_load(&e->conn->io_done)) {
      *link = e->next;
      e->next = dead;
      dead = e;
      continue;
    }
    link = &e->next;
  }
  pthread_mutex_unlock(&s->conns_mu);

  while (dead != NULL) {
    conn_entry *next = dead->next;
    magicseam_conn *c = dead->conn;
    if (c->started) {
      pthread_join(c->io_thread, NULL); /* already returned - io_done says so */
    }
    SSL *ssl = c->ssl;
    ngtcp2_crypto_ossl_ctx *ossl = c->ossl;
    ngtcp2_conn *ngconn = c->conn;
    magicseam_conn_free(c); /* never touches c->fd - it is s->fd, owned by the server */
    if (ngconn != NULL) {
      ngtcp2_conn_del(ngconn);
    }
    if (ossl != NULL) {
      ngtcp2_crypto_ossl_ctx_del(ossl);
    }
    if (ssl != NULL) {
      SSL_free(ssl);
    }
    free(dead);
    dead = next;
  }
}

static void *accept_thread_main(void *arg) {
  magicseam_quic_server *s = (magicseam_quic_server *)arg;
  uint8_t buf[65536];

  for (;;) {
    if (atomic_load(&s->closing)) {
      break;
    }

    /* Collect finished connections. Cheap - one list walk of the live set -
     * and this thread already wakes on every packet and every close request,
     * so no timer is needed to make it run. */
    reap_finished_conns(s);

    struct pollfd pfds[2];
    pfds[0].fd = s->fd;
    pfds[0].events = POLLIN;
    pfds[0].revents = 0;
    pfds[1].fd = s->wakeup_fds[0];
    pfds[1].events = POLLIN;
    pfds[1].revents = 0;
    /* A bounded timeout even with nothing to read is defense in depth
     * for noticing s->closing promptly - the wakeup pipe is the primary
     * mechanism (magicseam_quic_server_close pokes it directly). */
    int rc = poll(pfds, 2, 1000);
    if (rc < 0 && errno != EINTR) {
      break;
    }
    if (rc > 0 && (pfds[1].revents & POLLIN)) {
      uint8_t drain[64];
      while (read(s->wakeup_fds[0], drain, sizeof(drain)) > 0) {
      }
    }
    if (atomic_load(&s->closing)) {
      break;
    }
    if (!(rc > 0 && (pfds[0].revents & POLLIN))) {
      continue;
    }

    for (;;) {
      struct sockaddr_storage peer;
      socklen_t peerlen = sizeof(peer);
      ssize_t n = recvfrom(s->fd, buf, sizeof(buf), MSG_DONTWAIT, (struct sockaddr *)&peer, &peerlen);
      if (n < 0) {
        break; /* EAGAIN/EWOULDBLOCK (drained) or any other error - either way, stop this pass */
      }
      if (n == 0) {
        continue;
      }

      ngtcp2_version_cid vc;
      if (ngtcp2_pkt_decode_version_cid(&vc, buf, (size_t)n, MAGICSEAM_SERVER_CIDLEN) != 0) {
        continue; /* garbled, or a version-negotiation request this fixed single-version
                    * intra-cluster deployment doesn't implement - drop either way */
      }

      pthread_mutex_lock(&s->conns_mu);
      conn_entry *e = find_conn_locked(s, vc.dcid, vc.dcidlen);
      magicseam_conn *matched = e != NULL ? e->conn : NULL;
      pthread_mutex_unlock(&s->conns_mu);

      if (matched != NULL) {
        magicseam_conn_feed_pkt(matched, buf, (size_t)n, (struct sockaddr *)&peer, peerlen);
        continue;
      }

      ngtcp2_pkt_hd hd;
      if (ngtcp2_accept(&hd, buf, (size_t)n) != 0) {
        continue; /* not an acceptable first packet for a new connection - drop */
      }
      magicseam_conn *c = accept_new_conn(s, &hd, (struct sockaddr *)&peer, peerlen);
      if (c == NULL) {
        continue;
      }
      magicseam_conn_feed_pkt(c, buf, (size_t)n, (struct sockaddr *)&peer, peerlen);
    }
  }
  return NULL;
}

/* serve_state / serve_fail mirror client.c's dial_state / dial_fail: one
 * teardown path that unwinds exactly the resources actually allocated so
 * far, rather than N copy-pasted partial-cleanup blocks. */
typedef struct {
  int fd;
  int fd_owned;
  magicseam_quic_server *s;
  int wakeup_created;
  int sync_created;
  size_t workers_started;
  int accept_started;
} serve_state;

static magicseam_status serve_fail(serve_state *st, magicseam_status status) {
  if (st->accept_started) {
    atomic_store(&st->s->closing, 1);
    wake_fd(st->s->wakeup_fds[1]);
    pthread_join(st->s->accept_thread, NULL);
  }
  if (st->s != NULL && st->workers_started > 0) {
    pthread_mutex_lock(&st->s->work_mu);
    st->s->workers_stop = 1;
    pthread_cond_broadcast(&st->s->work_cv);
    pthread_mutex_unlock(&st->s->work_mu);
    for (size_t i = 0; i < st->workers_started; i++) {
      pthread_join(st->s->workers[i], NULL);
    }
  }
  if (st->s != NULL && st->s->ssl_ctx != NULL) {
    SSL_CTX_free(st->s->ssl_ctx);
  }
  if (st->sync_created) {
    pthread_mutex_destroy(&st->s->conns_mu);
    pthread_mutex_destroy(&st->s->work_mu);
    pthread_cond_destroy(&st->s->work_cv);
  }
  if (st->wakeup_created) {
    close(st->s->wakeup_fds[0]);
    close(st->s->wakeup_fds[1]);
  }
  free(st->s);
  if (st->fd_owned) {
    close(st->fd);
  }
  return status;
}

magicseam_status magicseam_quic_serve(const char *addr, const char *cert_path,
                                       const char *key_path, const char *ca_path,
                                       const char *version, magicseam_handler handler,
                                       void *user_data, magicseam_quic_server **out) {
  if (addr == NULL || cert_path == NULL || key_path == NULL || ca_path == NULL ||
      version == NULL || handler == NULL || out == NULL) {
    return MAGICSEAM_ERR_ARG;
  }
  *out = NULL;

  char host[256];
  char port[32];
  magicseam_status pst = magicseam_parse_tcp_addr(addr, host, sizeof(host), port, sizeof(port));
  if (pst != MAGICSEAM_OK) {
    return pst;
  }

  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_DGRAM;
  hints.ai_flags = AI_PASSIVE;
  struct addrinfo *res = NULL;
  /* "0.0.0.0"/"::" are ordinary literal hosts here (getaddrinfo resolves
   * them like any other), so no special-casing is needed for the common
   * tcp:0.0.0.0:PORT listen address this SDK's own doc comment shows. */
  if (getaddrinfo(host, port, &hints, &res) != 0 || res == NULL) {
    return MAGICSEAM_ERR_DIAL;
  }

  serve_state st;
  memset(&st, 0, sizeof(st));
  st.fd = socket(res->ai_family, SOCK_DGRAM, 0);
  if (st.fd < 0) {
    freeaddrinfo(res);
    return MAGICSEAM_ERR_DIAL;
  }
  st.fd_owned = 1;
  if (bind(st.fd, res->ai_addr, res->ai_addrlen) != 0) {
    freeaddrinfo(res);
    return serve_fail(&st, MAGICSEAM_ERR_DIAL);
  }
  freeaddrinfo(res);

  st.s = calloc(1, sizeof(*st.s));
  if (st.s == NULL) {
    return serve_fail(&st, MAGICSEAM_ERR_ARG);
  }
  st.s->fd = st.fd;
  memcpy(st.s->version, version, strnlen(version, sizeof(st.s->version) - 1));
  st.s->handler = handler;
  st.s->user_data = user_data;
  st.s->wakeup_fds[0] = st.s->wakeup_fds[1] = -1;

  if (pipe(st.s->wakeup_fds) != 0) {
    return serve_fail(&st, MAGICSEAM_ERR_IO);
  }
  st.wakeup_created = 1;
  /* Non-blocking read end is required - see magicseam_conn_new's own
   * (identical) fix in io.c for why: accept_thread_main's drain loop
   * would otherwise wedge forever on the second read() once the pipe
   * empties. */
  if (fcntl(st.s->wakeup_fds[0], F_SETFL, O_NONBLOCK) != 0 ||
      fcntl(st.s->wakeup_fds[1], F_SETFL, O_NONBLOCK) != 0) {
    return serve_fail(&st, MAGICSEAM_ERR_IO);
  }

  pthread_mutex_init(&st.s->conns_mu, NULL);
  pthread_mutex_init(&st.s->work_mu, NULL);
  pthread_cond_init(&st.s->work_cv, NULL);
  st.sync_created = 1;
  atomic_init(&st.s->closing, 0);

  st.s->ssl_ctx = magicseam_tls_ctx_new_server(cert_path, key_path, ca_path);
  if (st.s->ssl_ctx == NULL) {
    return serve_fail(&st, MAGICSEAM_ERR_TLS);
  }

  st.s->nworkers = MAGICSEAM_SERVER_WORKERS;
  for (st.workers_started = 0; st.workers_started < st.s->nworkers; st.workers_started++) {
    if (pthread_create(&st.s->workers[st.workers_started], NULL, worker_main, st.s) != 0) {
      /* Fail closed rather than run with fewer workers than the
       * "concurrent calls never serialize" guarantee this SDK documents
       * assumes. */
      return serve_fail(&st, MAGICSEAM_ERR_IO);
    }
  }

  if (pthread_create(&st.s->accept_thread, NULL, accept_thread_main, st.s) != 0) {
    return serve_fail(&st, MAGICSEAM_ERR_IO);
  }
  st.s->accept_thread_started = 1;
  st.accept_started = 1;

  *out = st.s;
  return MAGICSEAM_OK;
}

void magicseam_quic_server_close(magicseam_quic_server *s) {
  if (s == NULL) {
    return;
  }

  atomic_store(&s->closing, 1);
  wake_fd(s->wakeup_fds[1]);
  if (s->accept_thread_started) {
    pthread_join(s->accept_thread, NULL);
  }

  /* Stop every worker BEFORE tearing down any connection: a worker mid-
   * handler-call still holds a bare magicseam_conn* (item->conn) with no
   * refcount of its own, so a connection must not be freed while a
   * worker could still touch it via reply_intents/mu. Draining first
   * guarantees no worker is running once we start freeing connections
   * below. */
  pthread_mutex_lock(&s->work_mu);
  s->workers_stop = 1;
  pthread_cond_broadcast(&s->work_cv);
  pthread_mutex_unlock(&s->work_mu);
  for (size_t i = 0; i < s->nworkers; i++) {
    pthread_join(s->workers[i], NULL);
  }

  pthread_mutex_lock(&s->conns_mu);
  conn_entry *e = s->conns;
  s->conns = NULL;
  pthread_mutex_unlock(&s->conns_mu);

  while (e != NULL) {
    conn_entry *next = e->next;
    magicseam_conn *c = e->conn;
    magicseam_conn_request_close(c);
    if (c->started) {
      pthread_join(c->io_thread, NULL);
    }
    SSL *ssl = c->ssl;
    ngtcp2_crypto_ossl_ctx *ossl = c->ossl;
    ngtcp2_conn *ngconn = c->conn;
    magicseam_conn_free(c); /* never touches c->fd - it's s->fd, owned/closed below */
    if (ngconn != NULL) {
      ngtcp2_conn_del(ngconn);
    }
    if (ossl != NULL) {
      ngtcp2_crypto_ossl_ctx_del(ossl);
    }
    if (ssl != NULL) {
      SSL_free(ssl);
    }
    free(e);
    e = next;
  }

  close(s->fd);
  SSL_CTX_free(s->ssl_ctx);
  pthread_mutex_destroy(&s->conns_mu);
  pthread_mutex_destroy(&s->work_mu);
  pthread_cond_destroy(&s->work_cv);
  close(s->wakeup_fds[0]);
  close(s->wakeup_fds[1]);
  free(s);
}
