/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * Real loopback QUIC integration tests - real UDP sockets on 127.0.0.1,
 * real mTLS handshakes, real streams, only the handler is a trivial
 * mock. Mirrors go/magicseam/quic_test.go and
 * ts/magicseam/quic.test.ts's own three tests exactly (same test
 * names/shape, same generous timing bound) - this is the one that
 * actually proves the background-io_thread design (io_internal.h's own
 * doc comment) is real, not accidentally degraded to serial.
 */
#define _POSIX_C_SOURCE 200809L

#include "magicseam_quic.h"
#include "io_internal.h"

#include <pthread.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int g_failures = 0;

#define CHECK(cond, msg)                                                     \
  do {                                                                       \
    if (!(cond)) {                                                          \
      fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, (msg));       \
      g_failures++;                                                         \
    }                                                                        \
  } while (0)

static uint64_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}

/* sleep_ms uses nanosleep rather than usleep - usleep was dropped from
 * POSIX.1-2008 and glibc only declares it under _XOPEN_SOURCE/_DEFAULT_SOURCE,
 * neither of which this file defines (just the strict _POSIX_C_SOURCE
 * needed for clock_gettime/CLOCK_MONOTONIC). */
static void sleep_ms(long ms) {
  struct timespec ts = {.tv_sec = ms / 1000, .tv_nsec = (ms % 1000) * 1000000};
  nanosleep(&ts, NULL);
}

/* gen_test_certs mints a throwaway CA + one leaf (CN/SAN = MAGICSEAM_QUIC_SNI)
 * via the openssl CLI (same approach as quic.test.ts's own generateTestCerts -
 * simplest, no C cert-gen helper needed) - both client and server use the
 * SAME leaf, matching this SDK's fixed-SAN design. */
static void gen_test_certs(char *cert_out, char *key_out, char *ca_out, size_t cap) {
  char dir[] = "/tmp/magicseam-quic-test-XXXXXX";
  CHECK(mkdtemp(dir) != NULL, "mkdtemp");

  char ca_key[512], ca_cert[512], leaf_key[512], leaf_csr[512], leaf_cert[512], ext_file[512];
  snprintf(ca_key, sizeof(ca_key), "%s/ca.key", dir);
  snprintf(ca_cert, sizeof(ca_cert), "%s/ca.pem", dir);
  snprintf(leaf_key, sizeof(leaf_key), "%s/leaf.key", dir);
  snprintf(leaf_csr, sizeof(leaf_csr), "%s/leaf.csr", dir);
  snprintf(leaf_cert, sizeof(leaf_cert), "%s/leaf.pem", dir);
  snprintf(ext_file, sizeof(ext_file), "%s/ext.cnf", dir);

  char cmd[4096];
  snprintf(cmd, sizeof(cmd), "openssl ecparam -name prime256v1 -genkey -noout -out %s >/dev/null 2>&1", ca_key);
  CHECK(system(cmd) == 0, "gen ca key");
  snprintf(cmd, sizeof(cmd),
           "openssl req -x509 -new -key %s -days 1 -out %s -subj \"/CN=test-trail-ca\" >/dev/null 2>&1",
           ca_key, ca_cert);
  CHECK(system(cmd) == 0, "gen ca cert");
  snprintf(cmd, sizeof(cmd), "openssl ecparam -name prime256v1 -genkey -noout -out %s >/dev/null 2>&1", leaf_key);
  CHECK(system(cmd) == 0, "gen leaf key");
  snprintf(cmd, sizeof(cmd), "openssl req -new -key %s -out %s -subj \"/CN=%s\" >/dev/null 2>&1", leaf_key,
           leaf_csr, MAGICSEAM_QUIC_SNI);
  CHECK(system(cmd) == 0, "gen leaf csr");

  FILE *f = fopen(ext_file, "w");
  CHECK(f != NULL, "open ext file");
  if (f != NULL) {
    fprintf(f, "subjectAltName=DNS:%s\n", MAGICSEAM_QUIC_SNI);
    fclose(f);
  }
  snprintf(cmd, sizeof(cmd),
           "openssl x509 -req -in %s -CA %s -CAkey %s -CAcreateserial -days 1 -out %s -extfile %s "
           ">/dev/null 2>&1",
           leaf_csr, ca_cert, ca_key, leaf_cert, ext_file);
  CHECK(system(cmd) == 0, "sign leaf cert");

  snprintf(cert_out, cap, "%s", leaf_cert);
  snprintf(key_out, cap, "%s", leaf_key);
  snprintf(ca_out, cap, "%s", ca_cert);
}

static magicseam_status echo_handler(void *user_data, const uint8_t *req, size_t req_len,
                                      uint8_t **resp, size_t *resp_len) {
  (void)user_data;
  *resp = req_len > 0 ? malloc(req_len) : NULL;
  if (req_len > 0) {
    memcpy(*resp, req, req_len);
  }
  *resp_len = req_len;
  return MAGICSEAM_OK;
}


/* THE LEAK THAT BURNED FOUR CORES: a server connection was immortal.
 *
 * magicseam_conn_free ran only on accept-time setup failures, so every
 * connection that ever SUCCEEDED kept its conn_entry and its per-connection
 * io_thread for the life of the process - and each finished one busy-polled,
 * because ngtcp2's expiry stays in the past once the peer is gone and the loop
 * used a 0ms poll timeout for that case. Measured on node-1 2026-08-15:
 * magic-echo-c, up 27h, 74 dead connections still holding threads, wchan=0 on
 * every one, ~4 cores. The peer was radiant's reachability prober, dialling
 * every QUIC SeamProvider every 5s and closing CORRECTLY each time.
 *
 * Counts the process's own threads, because that is the resource that was
 * exhausted and the number an operator sees. Without the reap this rises by one
 * per connection and never falls; the assertion is that it comes back down. */
static int thread_count(void) {
  DIR *d = opendir("/proc/self/task");
  if (d == NULL) {
    return -1;
  }
  int n = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (e->d_name[0] != '.') {
      n++;
    }
  }
  closedir(d);
  return n;
}

static void test_finished_connections_are_reaped(const char *cert, const char *key, const char *ca) {
  magicseam_quic_server *srv = NULL;
  magicseam_status st = magicseam_quic_serve("tcp:127.0.0.1:19823", cert, key, ca, "0.1.0",
                                              echo_handler, NULL, &srv);
  CHECK(st == MAGICSEAM_OK, "serve");
  sleep_ms(150);

  int before = thread_count();
  CHECK(before > 0, "/proc/self/task readable - without it this test proves nothing");

  /* Enough connections that a per-connection leak is unmistakable against
   * scheduler noise, and cheap enough to stay a unit test. */
  for (int i = 0; i < 12; i++) {
    magicseam_quic_client *client = NULL;
    st = magicseam_quic_dial("tcp:127.0.0.1:19823", cert, key, ca, "0.1.0", &client, NULL, 0);
    CHECK(st == MAGICSEAM_OK, "dial");
    magicseam_quic_close(client);
  }

  /* The sweep runs on the accept thread, which wakes on packets and on the
   * close request - the CONNECTION_CLOSE from each client above is itself the
   * wakeup, so this is bounded settling, not a poll for an event that needs
   * prompting. */
  int after = before;
  for (int i = 0; i < 100; i++) {
    sleep_ms(50);
    after = thread_count();
    if (after <= before + 2) {
      break;
    }
  }

  /* THE THREAD COUNT ABOVE CANNOT SEE A REAP FAILURE, so this is the arm that
   * does. Verified by mutation 2026-08-15: deleting reap_finished_conns's call
   * leaves the thread-count assertion GREEN, because an exited pthread drops
   * out of /proc/self/task whether or not anyone joined it. What leaks then is
   * the conn list itself - one entry, one unjoined thread descriptor and one
   * conn struct per connection, forever. */
  size_t live = magicseam_server_live_conns(srv);
  if (live > 1) {
    fprintf(stderr, "  server still holds %zu connections\n", live);
  }
  CHECK(live <= 1,
        "the server still holds connections after every client closed - "
        "reap_finished_conns is not unlinking them, so the list and their thread "
        "descriptors grow without bound");

  CHECK(after <= before + 2,
        "finished connections were not reaped - threads never come back down, and each "
        "dead one busy-polls an expired timer");

  magicseam_quic_server_close(srv);
}

/* A PEER THAT VANISHES WITHOUT CLOSING MUST STILL BE REAPED.
 *
 * The CONNECTION_CLOSE fix handles the peer that says goodbye. This is the one
 * that does not: a lost close datagram, a killed process, an abandoned probe.
 * Before this, ngtcp2_conn_handle_expiry's return value was DISCARDED, so
 * NGTCP2_ERR_IDLE_CLOSE never terminated anything and such a connection looped
 * forever. Measured live after the close fix shipped: magic-echo-c's threads
 * still grew ~70/hour, sleeping rather than spinning only because of the
 * backoff - cheap, and unbounded.
 *
 * The client here is deliberately NEVER closed. That is the whole scenario.
 */
static void test_idle_connections_are_reaped(const char *cert, const char *key, const char *ca) {
  /* 30s is right in production and untestable here. Restored below so the
   * short timeout cannot leak into another test's connections. */
  uint64_t saved = magicseam_server_idle_timeout_ns;
  magicseam_server_idle_timeout_ns = 700ull * 1000ull * 1000ull;

  magicseam_quic_server *srv = NULL;
  magicseam_status st = magicseam_quic_serve("tcp:127.0.0.1:19823", cert, key, ca, "0.1.0",
                                              echo_handler, NULL, &srv);
  CHECK(st == MAGICSEAM_OK, "serve");
  sleep_ms(150);

  magicseam_quic_client *client = NULL;
  char served[64] = {0};
  st = magicseam_quic_dial("tcp:127.0.0.1:19823", cert, key, ca, "0.1.0", &client, served, sizeof(served));
  CHECK(st == MAGICSEAM_OK, "dial");

  /* Positive control: it must be HERE before we assert it goes away, or a
   * server that never registered the connection would pass vacuously. */
  CHECK(magicseam_server_live_conns(srv) >= 1,
        "the server never registered the connection, so its later absence would "
        "prove nothing");

  size_t live = 1;
  for (int i = 0; i < 100; i++) { /* ~5s, against a 700ms idle timeout */
    sleep_ms(50);
    live = magicseam_server_live_conns(srv);
    if (live == 0) {
      break;
    }
  }
  CHECK(live == 0,
        "a connection whose peer went away WITHOUT a CONNECTION_CLOSE was never "
        "reaped - handle_expiry's NGTCP2_ERR_IDLE_CLOSE is being discarded, so the "
        "thread loops forever");

  magicseam_quic_close(client);
  magicseam_quic_server_close(srv);
  magicseam_server_idle_timeout_ns = saved;
}

static void test_loopback_roundtrip(const char *cert, const char *key, const char *ca) {
  magicseam_quic_server *srv = NULL;
  magicseam_status st = magicseam_quic_serve("tcp:127.0.0.1:19820", cert, key, ca, "0.1.0",
                                              echo_handler, NULL, &srv);
  CHECK(st == MAGICSEAM_OK, "serve");
  sleep_ms(150);

  magicseam_quic_client *client = NULL;
  char served[64] = {0};
  st = magicseam_quic_dial("tcp:127.0.0.1:19820", cert, key, ca, "0.1.0", &client, served, sizeof(served));
  CHECK(st == MAGICSEAM_OK, "dial");
  CHECK(strcmp(served, "0.1.0") == 0, "served version");

  const char *msg = "hello quic c";
  uint8_t *resp = NULL;
  size_t resp_len = 0;
  st = magicseam_quic_call(client, (const uint8_t *)msg, strlen(msg), &resp, &resp_len);
  CHECK(st == MAGICSEAM_OK, "call ok");
  CHECK(resp_len == strlen(msg), "resp len");
  CHECK(resp != NULL && memcmp(resp, msg, resp_len) == 0, "resp content");
  magicseam_free(resp);

  magicseam_quic_close(client);
  magicseam_quic_server_close(srv);
}

static magicseam_status slow_echo_handler(void *user_data, const uint8_t *req, size_t req_len,
                                           uint8_t **resp, size_t *resp_len) {
  (void)user_data;
  sleep_ms(200);
  *resp = req_len > 0 ? malloc(req_len) : NULL;
  if (req_len > 0) {
    memcpy(*resp, req, req_len);
  }
  *resp_len = req_len;
  return MAGICSEAM_OK;
}

typedef struct {
  magicseam_quic_client *client;
  uint8_t byte;
  magicseam_status status;
} call_thread_arg;

static void *call_thread_main(void *arg) {
  call_thread_arg *a = (call_thread_arg *)arg;
  uint8_t *resp = NULL;
  size_t resp_len = 0;
  a->status = magicseam_quic_call(a->client, &a->byte, 1, &resp, &resp_len);
  magicseam_free(resp);
  return NULL;
}

static void test_concurrent_calls_do_not_serialize(const char *cert, const char *key, const char *ca) {
  magicseam_quic_server *srv = NULL;
  magicseam_status st =
      magicseam_quic_serve("tcp:127.0.0.1:19821", cert, key, ca, "", slow_echo_handler, NULL, &srv);
  CHECK(st == MAGICSEAM_OK, "serve");
  sleep_ms(150);

  magicseam_quic_client *client = NULL;
  st = magicseam_quic_dial("tcp:127.0.0.1:19821", cert, key, ca, "", &client, NULL, 0);
  CHECK(st == MAGICSEAM_OK, "dial");

  call_thread_arg a1 = {client, 1, MAGICSEAM_ERR_IO};
  call_thread_arg a2 = {client, 2, MAGICSEAM_ERR_IO};
  pthread_t t1, t2;
  uint64_t start = now_ms();
  pthread_create(&t1, NULL, call_thread_main, &a1);
  pthread_create(&t2, NULL, call_thread_main, &a2);
  pthread_join(t1, NULL);
  pthread_join(t2, NULL);
  uint64_t elapsed = now_ms() - start;

  CHECK(a1.status == MAGICSEAM_OK, "call 1 ok");
  CHECK(a2.status == MAGICSEAM_OK, "call 2 ok");
  /* Two 200ms handler calls that ran concurrently finish in ~200ms;
   * serialized, they'd take ~400ms. Generous bound to absorb CI/loopback
   * jitter - same bound sdk/go and sdk/ts use. */
  CHECK(elapsed < 350, "concurrent calls did not serialize");
  if (elapsed >= 350) {
    fprintf(stderr, "  elapsed=%llums (expected <350ms)\n", (unsigned long long)elapsed);
  }

  magicseam_quic_close(client);
  magicseam_quic_server_close(srv);
}

static magicseam_status faulty_handler(void *user_data, const uint8_t *req, size_t req_len,
                                        uint8_t **resp, size_t *resp_len) {
  (void)user_data;
  (void)resp;
  (void)resp_len;
  if (req_len == 6 && memcmp(req, "reject", 6) == 0) {
    return MAGICSEAM_ERR_REJECTED;
  }
  if (req_len == 8 && memcmp(req, "toolarge", 8) == 0) {
    return MAGICSEAM_ERR_TOOLARGE;
  }
  return MAGICSEAM_ERR_UNAVAIL;
}

static void test_error_tags_roundtrip(const char *cert, const char *key, const char *ca) {
  magicseam_quic_server *srv = NULL;
  magicseam_status st =
      magicseam_quic_serve("tcp:127.0.0.1:19822", cert, key, ca, "", faulty_handler, NULL, &srv);
  CHECK(st == MAGICSEAM_OK, "serve");
  sleep_ms(150);

  magicseam_quic_client *client = NULL;
  st = magicseam_quic_dial("tcp:127.0.0.1:19822", cert, key, ca, "", &client, NULL, 0);
  CHECK(st == MAGICSEAM_OK, "dial");

  uint8_t *resp = NULL;
  size_t resp_len = 0;

  st = magicseam_quic_call(client, (const uint8_t *)"reject", 6, &resp, &resp_len);
  CHECK(st == MAGICSEAM_ERR_REJECTED, "reject tag");
  magicseam_free(resp);
  resp = NULL;

  st = magicseam_quic_call(client, (const uint8_t *)"toolarge", 8, &resp, &resp_len);
  CHECK(st == MAGICSEAM_ERR_TOOLARGE, "toolarge tag");
  magicseam_free(resp);
  resp = NULL;

  st = magicseam_quic_call(client, (const uint8_t *)"other", 5, &resp, &resp_len);
  CHECK(st == MAGICSEAM_ERR_UNAVAIL, "other -> unavailable tag");
  magicseam_free(resp);

  magicseam_quic_close(client);
  magicseam_quic_server_close(srv);
}

int main(void) {
  char cert[512], key[512], ca[512];
  gen_test_certs(cert, key, ca, sizeof(cert));

  printf("-- real loopback mTLS round trip --\n");
  test_loopback_roundtrip(cert, key, ca);

  printf("-- concurrent calls do not serialize --\n");
  test_concurrent_calls_do_not_serialize(cert, key, ca);

  printf("-- rejected/too-large/other error tags round-trip --\n");
  test_error_tags_roundtrip(cert, key, ca);

  printf("-- finished connections are reaped --\n");
  test_finished_connections_are_reaped(cert, key, ca);
  printf("-- idle connections are reaped --\n");
  test_idle_connections_are_reaped(cert, key, ca);

  if (g_failures == 0) {
    printf("ALL TESTS PASSED\n");
    return 0;
  }
  fprintf(stderr, "%d CHECK(S) FAILED\n", g_failures);
  return 1;
}
