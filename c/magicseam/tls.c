/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 */
#include "tls_internal.h"

#include "magicseam_quic.h"

#include <string.h>

#include <openssl/err.h>
#include <openssl/x509v3.h>

/* The ALPN protocol byte string in OpenSSL's wire format: one length byte
 * followed by that many bytes, repeated per protocol (RFC 7301). We only
 * ever offer/accept the one fixed "trail-quic" string - must match
 * trail's QUIC transport's ALPN_PROTOCOL and every other SDK's
 * own ALPN constant exactly (a real interop bug found and fixed this
 * session came from one SDK omitting ALPN once a peer offered it). */
static const unsigned char kAlpnProtos[] = "\x0atrail-quic";
#define MAGICSEAM_ALPN_LEN (sizeof(kAlpnProtos) - 1) /* -1: drop the NUL */

static int load_identity_and_ca(SSL_CTX *ctx, const char *cert_path,
                                 const char *key_path, const char *ca_path) {
  if (SSL_CTX_use_certificate_chain_file(ctx, cert_path) != 1) {
    return -1;
  }
  if (SSL_CTX_use_PrivateKey_file(ctx, key_path, SSL_FILETYPE_PEM) != 1) {
    return -1;
  }
  if (SSL_CTX_check_private_key(ctx) != 1) {
    return -1;
  }
  /* Trust ONLY ca_path's bundle - deliberately never call
   * SSL_CTX_set_default_verify_paths, so the system root store never
   * enters the picture. A fresh SSL_CTX's verify store starts empty. */
  if (SSL_CTX_load_verify_locations(ctx, ca_path, NULL) != 1) {
    return -1;
  }
  return 0;
}

/* alpn_select_cb: the server side of ALPN negotiation - require the
 * client to have offered "trail-quic" exactly; fail the handshake
 * otherwise (SSL_TLSEXT_ERR_ALERT_FATAL), matching quiche/quic-go's own
 * hard-fail-on-no-match behavior once a peer offers anything at all. */
static int alpn_select_cb(SSL *ssl, const unsigned char **out,
                           unsigned char *outlen, const unsigned char *in,
                           unsigned int inlen, void *arg) {
  (void)ssl;
  (void)arg;
  /* SSL_select_next_proto(out, outlen, server_list, server_list_len,
   * client_list, client_list_len) - "server" here is OUR supported list
   * (kAlpnProtos), "client" is the peer's offered list (in/inlen). */
  if (SSL_select_next_proto((unsigned char **)out, outlen, kAlpnProtos,
                             MAGICSEAM_ALPN_LEN, in, inlen) != OPENSSL_NPN_NEGOTIATED) {
    return SSL_TLSEXT_ERR_ALERT_FATAL;
  }
  return SSL_TLSEXT_ERR_OK;
}

static SSL_CTX *new_ctx(const SSL_METHOD *method, const char *cert_path,
                         const char *key_path, const char *ca_path, int is_server) {
  SSL_CTX *ctx = SSL_CTX_new(method);
  if (ctx == NULL) {
    return NULL;
  }
  if (SSL_CTX_set_min_proto_version(ctx, TLS1_3_VERSION) != 1 ||
      SSL_CTX_set_max_proto_version(ctx, TLS1_3_VERSION) != 1) {
    SSL_CTX_free(ctx);
    return NULL;
  }
  if (load_identity_and_ca(ctx, cert_path, key_path, ca_path) != 0) {
    SSL_CTX_free(ctx);
    return NULL;
  }
  /* Mutual TLS: verify the peer's cert against ca_path either way. Only
   * the server additionally REQUIRES the peer to present one at all -
   * a client's own peer verification of the server is implied by
   * SSL_VERIFY_PEER regardless of FAIL_IF_NO_PEER_CERT (a TLS server
   * always sends a cert). */
  int verify_mode = SSL_VERIFY_PEER;
  if (is_server) {
    verify_mode |= SSL_VERIFY_FAIL_IF_NO_PEER_CERT;
  }
  SSL_CTX_set_verify(ctx, verify_mode, NULL);

  if (is_server) {
    SSL_CTX_set_alpn_select_cb(ctx, alpn_select_cb, NULL);
  } else if (SSL_CTX_set_alpn_protos(ctx, kAlpnProtos, MAGICSEAM_ALPN_LEN) != 0) {
    /* SSL_CTX_set_alpn_protos returns 0 on success (unlike most of the
     * OpenSSL API) - non-zero here is the actual failure. */
    SSL_CTX_free(ctx);
    return NULL;
  }
  return ctx;
}

SSL_CTX *magicseam_tls_ctx_new_client(const char *cert_path, const char *key_path,
                                       const char *ca_path) {
  return new_ctx(TLS_client_method(), cert_path, key_path, ca_path, 0);
}

SSL_CTX *magicseam_tls_ctx_new_server(const char *cert_path, const char *key_path,
                                       const char *ca_path) {
  return new_ctx(TLS_server_method(), cert_path, key_path, ca_path, 1);
}

/* pin_peer_host requires the peer's leaf to carry the fixed
 * "trail-quic-peer" SAN - every trail-CA-signed leaf does by
 * construction (see periapsis's pod-launch TLS wiring); a pod's own address
 * is neither known at cert-mint time nor stable across a migration, so
 * per-peer hostname verification would be both impossible and pointless -
 * the real trust boundary is "signed by our trail CA," not which specific
 * peer presents it (mirrors remote_quic.rs's own module doc comment). */
static void pin_peer_host(SSL *ssl) {
  X509_VERIFY_PARAM *param = SSL_get0_param(ssl);
  X509_VERIFY_PARAM_set1_host(param, MAGICSEAM_QUIC_SNI, strlen(MAGICSEAM_QUIC_SNI));
}

SSL *magicseam_tls_ssl_new_client(SSL_CTX *ctx) {
  SSL *ssl = SSL_new(ctx);
  if (ssl == NULL) {
    return NULL;
  }
  SSL_set_connect_state(ssl);
  SSL_set_tlsext_host_name(ssl, MAGICSEAM_QUIC_SNI);
  pin_peer_host(ssl);
  return ssl;
}

SSL *magicseam_tls_ssl_new_server(SSL_CTX *ctx) {
  SSL *ssl = SSL_new(ctx);
  if (ssl == NULL) {
    return NULL;
  }
  SSL_set_accept_state(ssl);
  pin_peer_host(ssl);
  return ssl;
}
