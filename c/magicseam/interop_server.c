/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * A minimal echo provider for the CROSS-IMPLEMENTATION test (interop_test.sh).
 *
 * WHY THIS EXISTS SEPARATELY FROM magicseam_quic_test.c. That test drives this
 * SDK's server with this SDK's own client, which is exactly why it could not
 * catch the 2026-07-31 wire change: the caller frame was added to the protocol,
 * neither side of this SDK learned about it, and C-to-C stayed green for two
 * weeks while C-against-trail was dead. A suite that only ever talks to itself
 * cannot detect the wire moving underneath it.
 *
 * So this binary exists to be talked to by TRAIL - the reference implementation
 * - rather than by us. It takes its TLS material as arguments instead of
 * hardcoding examples/c/magic-echo-c's /var/run/periapsis/tls mount path, so the
 * test needs no root and does not depend on the example being deployable.
 *
 *   interop_server <tcp:host:port> <cert.pem> <key.pem> <ca.pem>
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "magicseam_quic.h"

static volatile sig_atomic_t g_stop = 0;

static void on_term(int sig) {
  (void)sig;
  g_stop = 1;
}

/* Echo, so any corruption of the request shows up as a corrupted reply rather
 * than as a plausible-looking answer. */
static magicseam_status echo_handler(void *user_data, const uint8_t *req, size_t req_len,
                                      uint8_t **resp, size_t *resp_len) {
  (void)user_data;
  uint8_t *out = req_len > 0 ? malloc(req_len) : malloc(1);
  if (out == NULL) {
    return MAGICSEAM_ERR_ARG;
  }
  if (req_len > 0) {
    memcpy(out, req, req_len);
  }
  *resp = out;
  *resp_len = req_len;

  return MAGICSEAM_OK;
}

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: %s <tcp:host:port> <cert.pem> <key.pem> <ca.pem>\n", argv[0]);
    return 2;
  }
  signal(SIGTERM, on_term);
  signal(SIGINT, on_term);

  magicseam_quic_server *server = NULL;
  magicseam_status st = magicseam_quic_serve(argv[1], argv[2], argv[3], argv[4], "0.1.0",
                                              echo_handler, NULL, &server);
  if (st != MAGICSEAM_OK) {
    fprintf(stderr, "interop_server: magicseam_quic_serve failed: %d\n", (int)st);
    return 1;
  }
  fprintf(stderr, "interop_server: serving %s\n", argv[1]);
  while (!g_stop) {
    pause();
  }
  magicseam_quic_server_close(server);

  return 0;
}
