/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * QUIC transport (ADR-0043) for a genuinely non-WASM C magic-seam
 * provider/consumer - mirrors cmd/trail/src/remote_quic.rs's wire
 * protocol EXACTLY (see that file's own module doc comment, the
 * authoritative spec this was ported from, also mirrored in
 * sdk/go/magicseam/quic.go and sdk/ts/magicseam/quic.ts): mutual TLS
 * against the cluster's self-managed trail CA, one persistent connection,
 * a version handshake on the first bidirectional stream, then every
 * subsequent call opens its OWN stream (so unrelated calls never queue
 * behind each other).
 *
 * Built on libngtcp2 + libngtcp2_crypto_ossl + OpenSSL - ngtcp2 owns no
 * socket/timer/thread itself, so every magicseam_quic_client/_server
 * connection runs a dedicated background I/O thread servicing it
 * continuously (ngtcp2_conn is single-threaded and has its own idle/loss
 * timers that must be driven even between application calls, or the
 * connection silently dies - see io.c's own doc comment). Application
 * threads never touch ngtcp2 state directly; they hand requests to and
 * collect responses from that thread via a mutex-guarded call table.
 *
 * TLS material: peri.apsis/tls-quic (internal/podlaunch/builder.go)
 * bind-mounts a fresh cert/key/CA-bundle triple, signed by the trail CA,
 * into the pod at internal/podlaunch.TLSQuicMountDir - callers running as
 * a pod should point magicseam_quic_dial/_serve at those three files
 * directly.
 */
#ifndef MAGICSEAM_QUIC_H
#define MAGICSEAM_QUIC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* magicseam_status: 0 is always success; every other value is one
 * specific failure class. Mirrors the wire's own error tags
 * (unavailable/rejected/too-large - see magicseam.go's tagFor/ErrRejected/
 * ErrTooLarge) plus transport-level failure classes local to this SDK. */
typedef enum {
  MAGICSEAM_OK = 0,
  MAGICSEAM_ERR_ARG = -1,      /* bad address / null argument / buffer too small */
  MAGICSEAM_ERR_TLS = -2,      /* cert/key/CA load or handshake TLS failure */
  MAGICSEAM_ERR_DIAL = -3,     /* connect / QUIC handshake failed */
  MAGICSEAM_ERR_IO = -4,       /* connection dropped mid-call, or a socket/thread error */
  MAGICSEAM_ERR_PROTOCOL = -5, /* framing violation / oversize frame / unknown tag */
  MAGICSEAM_ERR_VERSION = -6,  /* handshake rejected (accept byte == 0) */
  MAGICSEAM_ERR_REJECTED = -7, /* call result tag 2 - wire's Rejected */
  MAGICSEAM_ERR_TOOLARGE = -8, /* call result tag 3 - wire's TooLarge */
  MAGICSEAM_ERR_UNAVAIL = -9,  /* call result tag 1 (or any unknown tag) - wire's Unavailable */
} magicseam_status;

/* TrailQUICSNI mirrors internal/podlaunch/trailtls.go's TrailQuicSNI and
 * cmd/trail/src/remote_quic.rs's SERVER_NAME exactly - every trail-CA-
 * signed leaf carries this one fixed CommonName/DNS-SAN. */
#define MAGICSEAM_QUIC_SNI "trail-quic-peer"

/* -------- client -------- */

typedef struct magicseam_quic_client magicseam_quic_client;

/* magicseam_quic_dial connects to addr ("tcp:<host:port>") and performs
 * the mTLS handshake plus the magic-seam version handshake:
 * required_version is this consumer's own required version ("" = none).
 * Blocks until the handshake completes or fails; on MAGICSEAM_OK, *out is
 * a live client (with its own background I/O thread already running) and
 * served_buf receives the provider's self-reported version (NUL-
 * terminated, truncated to served_buf_len - 1 if it doesn't fit) - this
 * SDK does not itself enforce semver compatibility, matching every other
 * magic-seam SDK's "gating is the caller's job" convention. Returns
 * MAGICSEAM_ERR_VERSION if the provider rejected required_version. */
magicseam_status magicseam_quic_dial(const char *addr, const char *cert_path,
                                      const char *key_path, const char *ca_path,
                                      const char *required_version,
                                      magicseam_quic_client **out,
                                      char *served_buf, size_t served_buf_len);

/* magicseam_quic_call opens a NEW bidirectional stream for this one
 * request - concurrent calls on the same client never serialize behind
 * each other. Blocks until the response arrives or the call fails. On
 * MAGICSEAM_OK, *resp is a malloc'd buffer of *resp_len bytes the caller
 * must free with magicseam_free(); MAGICSEAM_ERR_REJECTED / _TOOLARGE leave
 * resp and resp_len untouched (the wire's Rejected/TooLarge carry no
 * payload). Thread-safe: any number of threads may call concurrently on
 * one client. */
magicseam_status magicseam_quic_call(magicseam_quic_client *c,
                                      const uint8_t *req, size_t req_len,
                                      uint8_t **resp, size_t *resp_len);

/* magicseam_free releases a buffer this SDK allocated (a magicseam_quic_call
 * response, or a magicseam_handler's response buffer). */
void magicseam_free(void *p);

/* magicseam_quic_close ends the connection and joins its I/O thread. Any
 * call blocked in magicseam_quic_call concurrently is left to fail with
 * MAGICSEAM_ERR_IO - callers that need a graceful drain should stop
 * issuing new calls before calling this, same as any other
 * connection-oriented client. Safe to call with c == NULL (no-op). */
void magicseam_quic_close(magicseam_quic_client *c);

/* -------- server -------- */

/* magicseam_handler processes one seam call: request in, response out.
 * Return MAGICSEAM_OK and set resp (malloc'd; the SDK frees it after
 * sending) and resp_len for the wire's ok tag (0); return
 * MAGICSEAM_ERR_REJECTED / _TOOLARGE / _UNAVAIL for tags 2/3/1 respectively
 * (any OTHER non-OK return also maps to _UNAVAIL, the wire's
 * transport-neutral fail-closed default - matching magicseam.go's tagFor).
 * May run concurrently with other in-flight calls, on any thread - must
 * be reentrant. */
typedef magicseam_status (*magicseam_handler)(void *user_data,
                                               const uint8_t *req, size_t req_len,
                                               uint8_t **resp, size_t *resp_len);

typedef struct magicseam_quic_server magicseam_quic_server;

/* magicseam_quic_serve binds addr ("tcp:<host:port>", e.g.
 * "tcp:0.0.0.0:9400") and serves handler forever on its own threads
 * (non-blocking: returns once the listener is bound and its I/O thread is
 * running). version is this provider's own self-declared seam version
 * (purely informational - the connecting consumer's own gate is what
 * actually enforces compatibility against it), reported at every
 * handshake. */
magicseam_status magicseam_quic_serve(const char *addr,
                                       const char *cert_path, const char *key_path,
                                       const char *ca_path, const char *version,
                                       magicseam_handler handler, void *user_data,
                                       magicseam_quic_server **out);

/* magicseam_quic_server_close stops accepting new connections, closes
 * every live one, and joins every thread this server owns. Safe to call
 * with s == NULL (no-op). */
void magicseam_quic_server_close(magicseam_quic_server *s);

#ifdef __cplusplus
}
#endif

#endif /* !defined(MAGICSEAM_QUIC_H) */
