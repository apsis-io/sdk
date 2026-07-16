/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * TLS setup shared by client.c/server.c - builds the SSL_CTX (mutual TLS,
 * TLS 1.3 only, CA-only trust, ALPN, host-pinning) and per-connection SSL
 * objects io.c wires into ngtcp2 via ngtcp2_crypto_ossl. All standard
 * OpenSSL; the ngtcp2<->OpenSSL glue itself lives in io.c (that's what
 * ngtcp2_crypto_ossl_configure_{client,server}_session is for).
 */
#ifndef MAGICSEAM_TLS_INTERNAL_H
#define MAGICSEAM_TLS_INTERNAL_H

#include <openssl/ssl.h>

/* magicseam_tls_ctx_new_client builds an SSL_CTX for a client connection:
 * TLS 1.3 only, presents cert_path/key_path as its own identity, trusts
 * ONLY ca_path's bundle (never system roots), offers ALPN
 * "trail-quic". Returns NULL on any load/config failure. */
SSL_CTX *magicseam_tls_ctx_new_client(const char *cert_path, const char *key_path,
                                       const char *ca_path);

/* magicseam_tls_ctx_new_server builds an SSL_CTX for a server connection:
 * same as the client side, plus SSL_VERIFY_PEER|SSL_VERIFY_FAIL_IF_NO_PEER_CERT
 * (mutual TLS - a client without a trail-CA-signed cert is refused) and an
 * ALPN-select callback requiring "trail-quic" (fails the handshake on any
 * other/no offer). Returns NULL on any load/config failure. */
SSL_CTX *magicseam_tls_ctx_new_server(const char *cert_path, const char *key_path,
                                       const char *ca_path);

/* magicseam_tls_ssl_new_client creates a per-connection SSL object from
 * ctx, sets connect state, SNI ("trail-quic-peer"), and host-pinning
 * (the peer's leaf must carry that same SAN - every trail-CA-signed leaf
 * does, by construction). Returns NULL on failure. */
SSL *magicseam_tls_ssl_new_client(SSL_CTX *ctx);

/* magicseam_tls_ssl_new_server creates a per-connection SSL object from
 * ctx, sets accept state and host-pinning (the peer's leaf must carry the
 * fixed "trail-quic-peer" SAN). Returns NULL on failure. */
SSL *magicseam_tls_ssl_new_server(SSL_CTX *ctx);

#endif /* !defined(MAGICSEAM_TLS_INTERNAL_H) */
