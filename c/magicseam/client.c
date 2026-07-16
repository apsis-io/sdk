/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * Client-side magic-seam QUIC API: dial, call, close. Everything ngtcp2/
 * TLS-specific lives in io.c/tls.c - this file only builds the initial
 * ngtcp2_conn + SSL objects, starts the background io_thread (io.c's
 * magicseam_io_thread_main), and translates magicseam_quic_call/dial into
 * the intent-queue protocol io.c's io_thread drains.
 */
#include "magicseam_quic.h"
#include "io_internal.h"
#include "tls_internal.h"
#include "frame.h"

#include <errno.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <openssl/rand.h>

struct magicseam_quic_client {
  magicseam_conn *conn;
  SSL_CTX *ssl_ctx;
};

static void random_cid(ngtcp2_cid *cid, size_t len) {
  uint8_t buf[NGTCP2_MAX_CIDLEN];
  RAND_bytes(buf, (int)len);
  ngtcp2_cid_init(cid, buf, len);
}

/* TEMPORARY diagnostic (MAGICSEAM_NGTCP2_LOG env-gated) - see server.c's
 * own copy of this function for why. */
static void dbg_ngtcp2_log(void *user_data, char *msg, size_t len) {
  (void)user_data;
  fprintf(stderr, "[ngtcp2][client] %.*s\n", (int)len, msg);
  fflush(stderr);
}

/* dial_state tracks how far magicseam_quic_dial got, so a single
 * teardown path (dial_fail) can unwind exactly the resources actually
 * allocated so far - avoiding the alternative of N different partial-
 * cleanup blocks copy-pasted at each failure point (error-prone: easy to
 * free the wrong subset, or drift out of sync across edits). */
typedef struct {
  int fd;
  int fd_owned;
  magicseam_quic_client *client;
  magicseam_conn *c;
  SSL *ssl;
  int ossl_created;
  int ngconn_created;
  int io_thread_started;
} dial_state;

static magicseam_status dial_fail(dial_state *s, magicseam_status status) {
  if (s->io_thread_started) {
    magicseam_conn_request_close(s->c);
    pthread_join(s->c->io_thread, NULL);
  }
  if (s->ngconn_created) {
    ngtcp2_conn_del(s->c->conn);
  }
  if (s->ossl_created) {
    ngtcp2_crypto_ossl_ctx_del(s->c->ossl);
  }
  if (s->ssl != NULL) {
    SSL_free(s->ssl);
  }
  if (s->client != NULL && s->client->ssl_ctx != NULL) {
    SSL_CTX_free(s->client->ssl_ctx);
  }
  if (s->c != NULL) {
    magicseam_conn_free(s->c);
  }
  if (s->fd_owned) {
    close(s->fd);
  }
  free(s->client);
  return status;
}

magicseam_status magicseam_quic_dial(const char *addr, const char *cert_path,
                                      const char *key_path, const char *ca_path,
                                      const char *required_version,
                                      magicseam_quic_client **out,
                                      char *served_buf, size_t served_buf_len) {
  if (addr == NULL || cert_path == NULL || key_path == NULL || ca_path == NULL ||
      required_version == NULL || out == NULL) {
    return MAGICSEAM_ERR_ARG;
  }
  *out = NULL;

  char host[256];
  char port[32];
  magicseam_status st = magicseam_parse_tcp_addr(addr, host, sizeof(host), port, sizeof(port));
  if (st != MAGICSEAM_OK) {
    return st;
  }

  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_DGRAM;
  struct addrinfo *res = NULL;
  if (getaddrinfo(host, port, &hints, &res) != 0 || res == NULL) {
    return MAGICSEAM_ERR_DIAL;
  }

  dial_state s;
  memset(&s, 0, sizeof(s));
  s.fd = socket(res->ai_family, SOCK_DGRAM, 0);
  if (s.fd < 0) {
    freeaddrinfo(res);
    return MAGICSEAM_ERR_DIAL;
  }
  s.fd_owned = 1;
  if (connect(s.fd, res->ai_addr, res->ai_addrlen) != 0) {
    freeaddrinfo(res);
    return dial_fail(&s, MAGICSEAM_ERR_DIAL);
  }

  s.client = calloc(1, sizeof(*s.client));
  s.c = s.client != NULL ? magicseam_conn_new() : NULL;
  if (s.c == NULL) {
    freeaddrinfo(res);
    return dial_fail(&s, MAGICSEAM_ERR_ARG);
  }
  s.c->fd = s.fd;
  s.c->is_server = 0;
  memcpy(&s.c->remote_addr, res->ai_addr, res->ai_addrlen);
  s.c->remote_addrlen = (socklen_t)res->ai_addrlen;
  freeaddrinfo(res);
  s.c->local_addrlen = sizeof(s.c->local_addr);
  if (getsockname(s.fd, (struct sockaddr *)&s.c->local_addr, &s.c->local_addrlen) != 0) {
    return dial_fail(&s, MAGICSEAM_ERR_DIAL);
  }

  s.client->ssl_ctx = magicseam_tls_ctx_new_client(cert_path, key_path, ca_path);
  s.ssl = s.client->ssl_ctx != NULL ? magicseam_tls_ssl_new_client(s.client->ssl_ctx) : NULL;
  if (s.ssl == NULL) {
    return dial_fail(&s, MAGICSEAM_ERR_TLS);
  }
  s.c->ssl = s.ssl;

  if (ngtcp2_crypto_ossl_ctx_new(&s.c->ossl, s.ssl) != 0) {
    return dial_fail(&s, MAGICSEAM_ERR_TLS);
  }
  s.ossl_created = 1;
  if (ngtcp2_crypto_ossl_configure_client_session(s.ssl) != 0) {
    return dial_fail(&s, MAGICSEAM_ERR_TLS);
  }
  SSL_set_app_data(s.ssl, &s.c->conn_ref);

  ngtcp2_cid dcid, scid;
  random_cid(&dcid, 18);
  random_cid(&scid, 8);

  ngtcp2_path path;
  ngtcp2_addr_init(&path.local, (ngtcp2_sockaddr *)&s.c->local_addr, s.c->local_addrlen);
  ngtcp2_addr_init(&path.remote, (ngtcp2_sockaddr *)&s.c->remote_addr, s.c->remote_addrlen);
  path.user_data = NULL;

  ngtcp2_callbacks cb;
  magicseam_io_fill_callbacks(&cb, 0);

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
  params.max_idle_timeout = 30 * NGTCP2_SECONDS;

  if (ngtcp2_conn_client_new(&s.c->conn, &dcid, &scid, &path, NGTCP2_PROTO_VER_V1, &cb,
                              &settings, &params, NULL, s.c) != 0) {
    return dial_fail(&s, MAGICSEAM_ERR_DIAL);
  }
  s.ngconn_created = 1;
  ngtcp2_conn_set_tls_native_handle(s.c->conn, s.c->ossl);

  if (pthread_create(&s.c->io_thread, NULL, magicseam_io_thread_main, s.c) != 0) {
    return dial_fail(&s, MAGICSEAM_ERR_IO);
  }
  s.c->started = 1;
  s.io_thread_started = 1;

  /* Queue the handshake: an open_intent carrying the required-version
   * frame, staged on the very first client-opened stream. */
  size_t req_len = strlen(required_version);
  uint8_t *req = malloc(4 + req_len);
  if (req == NULL) {
    return dial_fail(&s, MAGICSEAM_ERR_IO);
  }
  magicseam_frame_encode(req, (const uint8_t *)required_version, req_len);

  magicseam_open_intent *intent = malloc(sizeof(*intent));
  if (intent == NULL) {
    free(req);
    return dial_fail(&s, MAGICSEAM_ERR_IO);
  }
  magicseam_pending_call pc;
  magicseam_pending_call_init(&pc);
  intent->req = req;
  intent->req_len = 4 + req_len;
  intent->is_handshake = 1;
  intent->pending = &pc;
  intent->next = NULL;

  pthread_mutex_lock(&s.c->mu);
  intent->next = s.c->open_intents;
  s.c->open_intents = intent;
  pthread_mutex_unlock(&s.c->mu);
  magicseam_wakeup(s.c);

  magicseam_pending_call_wait(&pc);
  magicseam_status hs_status = pc.status;
  free(pc.resp); /* the handshake path never populates resp - see below - but free defensively */
  magicseam_pending_call_destroy(&pc);

  if (hs_status != MAGICSEAM_OK) {
    return dial_fail(&s, hs_status);
  }

  /* The served-version string was written straight into c->served_version
   * by io.c's try_parse_handshake_client (the handshake path doesn't use
   * pending->resp - that's the call-reply path's payload channel). */
  if (served_buf != NULL && served_buf_len > 0) {
    size_t n = strlen(s.c->served_version);
    size_t copy_len = n < served_buf_len - 1 ? n : served_buf_len - 1;
    memcpy(served_buf, s.c->served_version, copy_len);
    served_buf[copy_len] = '\0';
  }

  s.client->conn = s.c;
  *out = s.client;
  return MAGICSEAM_OK;
}

magicseam_status magicseam_quic_call(magicseam_quic_client *c, const uint8_t *req,
                                      size_t req_len, uint8_t **resp, size_t *resp_len) {
  if (c == NULL || (req == NULL && req_len > 0) || resp == NULL || resp_len == NULL) {
    return MAGICSEAM_ERR_ARG;
  }
  if (req_len > MAGICSEAM_MAX_FRAME) {
    return MAGICSEAM_ERR_PROTOCOL;
  }
  *resp = NULL;
  *resp_len = 0;

  uint8_t *buf = malloc(4 + req_len);
  if (buf == NULL) {
    return MAGICSEAM_ERR_ARG;
  }
  magicseam_frame_encode(buf, req, req_len);

  magicseam_open_intent *intent = malloc(sizeof(*intent));
  if (intent == NULL) {
    free(buf);
    return MAGICSEAM_ERR_ARG;
  }
  magicseam_pending_call pc;
  magicseam_pending_call_init(&pc);
  intent->req = buf;
  intent->req_len = 4 + req_len;
  intent->is_handshake = 0;
  intent->pending = &pc;
  intent->next = NULL;

  pthread_mutex_lock(&c->conn->mu);
  intent->next = c->conn->open_intents;
  c->conn->open_intents = intent;
  pthread_mutex_unlock(&c->conn->mu);
  magicseam_wakeup(c->conn);

  magicseam_pending_call_wait(&pc);
  magicseam_status status = pc.status;
  *resp = pc.resp;
  *resp_len = pc.resp_len;
  magicseam_pending_call_destroy(&pc);
  return status;
}

void magicseam_free(void *p) { free(p); }

void magicseam_quic_close(magicseam_quic_client *c) {
  if (c == NULL) {
    return;
  }
  magicseam_conn *conn = c->conn;
  if (conn != NULL) {
    magicseam_conn_request_close(conn);
    if (conn->started) {
      pthread_join(conn->io_thread, NULL);
    }
    SSL *ssl = conn->ssl;
    ngtcp2_crypto_ossl_ctx *ossl = conn->ossl;
    ngtcp2_conn *ngconn = conn->conn;
    int fd = conn->fd;
    magicseam_conn_free(conn);
    if (ngconn != NULL) {
      ngtcp2_conn_del(ngconn);
    }
    if (ossl != NULL) {
      ngtcp2_crypto_ossl_ctx_del(ossl);
    }
    if (ssl != NULL) {
      SSL_free(ssl);
    }
    if (fd >= 0) {
      close(fd);
    }
  }
  if (c->ssl_ctx != NULL) {
    SSL_CTX_free(c->ssl_ctx);
  }
  free(c);
}
