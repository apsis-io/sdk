/* Copyright (C) 2025-2026 Malformed C. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * The ngtcp2 I/O layer: one dedicated thread per connection drives the
 * ngtcp2_conn state machine (recv -> feed ngtcp2 -> drain app intents ->
 * write -> poll bounded by ngtcp2's own expiry timer), since ngtcp2_conn
 * is single-threaded and has an idle/loss-detection timer that must be
 * serviced continuously or the connection silently dies between calls -
 * see magicseam_io_thread_main's own doc comment for why a blocking,
 * poll-only-inside-Call() design does not work here.
 *
 * client.c and server.c each own a magicseam_conn (one per QUIC
 * connection) and only ever touch it through the intent-queue /
 * call-slot API below - conn/ssl/ossl_ctx are the io_thread's alone.
 */
#ifndef MAGICSEAM_IO_INTERNAL_H
#define MAGICSEAM_IO_INTERNAL_H

#include <pthread.h>
#include <stdatomic.h>
#include <sys/socket.h>

#include <ngtcp2/ngtcp2.h>
#include <ngtcp2/ngtcp2_crypto.h>
#include <ngtcp2/ngtcp2_crypto_ossl.h>
#include <openssl/ssl.h>

#include "magicseam_quic.h"

/* magicseam_pending_call is the ONE synchronization object an application
 * thread blocked in magicseam_quic_call/dial actually waits on - always
 * stack-allocated by the blocked caller (its stack frame is guaranteed
 * live for exactly as long as the wait, so no heap/lifetime management
 * needed) and never copied or moved once queued. The io_thread is the
 * only other party that ever touches it (under its own mu), so this
 * mutex+cond pair is never shared/aliased/copied - avoiding the earlier,
 * broken design where a live pthread_cond_t got struct-assigned between
 * two different slot objects (undefined behavior: a cond var's identity
 * is its address, waiters block against that address specifically). */
typedef struct magicseam_pending_call {
  pthread_mutex_t mu;
  pthread_cond_t cv;
  int done;
  magicseam_status status;
  uint8_t *resp;     /* handshake: served-version bytes; call: response payload */
  size_t resp_len;
} magicseam_pending_call;

void magicseam_pending_call_init(magicseam_pending_call *pc);
void magicseam_pending_call_destroy(magicseam_pending_call *pc);
/* magicseam_pending_call_signal delivers a result and wakes the blocked
 * waiter - safe to call from the io_thread even if the caller hasn't
 * started waiting yet (mutex-guarded, like any other condvar signal). */
void magicseam_pending_call_signal(magicseam_pending_call *pc, magicseam_status status,
                                    uint8_t *resp, size_t resp_len);
/* magicseam_pending_call_wait blocks until signaled. */
void magicseam_pending_call_wait(magicseam_pending_call *pc);

/* One in-flight call on a connection - shared shape for both the
 * client's OWN calls (Call()) and the server's per-stream inbound
 * assembly + outbound handler result. Indexed by ngtcp2 stream_id in a
 * simple growable array (call volume per connection is expected to be
 * modest - hundreds, not millions, of concurrent streams). io_thread-
 * only: no lock needed for the array/slot contents themselves, only the
 * intent queues below (which cross the app<->io_thread boundary) and
 * each slot's own `pending` pointer target (magicseam_pending_call has
 * its own lock) are ever touched by an application thread. */
typedef struct magicseam_call_slot {
  int64_t stream_id;    /* -1 = free slot */
  int is_handshake;     /* the first client-opened stream on this conn */

  /* Outbound (what THIS side wants to send on the stream - the request
   * frame for a client call, or the response frame+tag for a server
   * call). Freed once fully acked (acked_stream_data_offset). */
  uint8_t *out_buf;
  size_t out_len;
  size_t out_acked;   /* bytes of out_buf ngtcp2 has confirmed delivered */
  size_t out_offset;  /* bytes of out_buf already handed to ngtcp2 (queued, not yet acked) */
  int out_fin;        /* finish the send side once out_buf is exhausted */
  int out_fin_sent;

  /* Inbound (what the peer has sent us so far - the length prefix then
   * body for a request, or the tag+response for a call reply).
   * Growable buffer. */
  uint8_t *in_buf;
  size_t in_len;
  int in_fin;         /* peer finished sending (FIN bit seen) */

  /* CLIENT side only: the app thread waiting on this call/handshake, if
   * any - NULL once signaled (so a stream that later gets more spurious
   * data, or closes, never double-signals). */
  magicseam_pending_call *pending;

  /* SERVER side only: has the request been fully parsed and handed to
   * the application handler yet (so we don't invoke it twice if more
   * stream-open/data events arrive)? */
  int handler_dispatched;
} magicseam_call_slot;

/* A pending "please open a new bidi stream and send this" request from
 * an application thread (client Call()/dial's handshake) to the
 * io_thread - queued because only the io_thread may touch ngtcp2_conn.
 * pending is the caller's own stack-allocated sync object (see
 * magicseam_pending_call's own doc comment) - the io_thread wires it
 * onto the REAL call_slot it allocates (after opening the stream), never
 * onto a caller-owned scratch slot. */
typedef struct magicseam_open_intent {
  uint8_t *req;
  size_t req_len;
  int is_handshake;
  magicseam_pending_call *pending;
  struct magicseam_open_intent *next;
} magicseam_open_intent;

/* A pending "here is the result for a call you already read the request
 * for" from a server worker thread back to the io_thread. */
typedef struct magicseam_reply_intent {
  int64_t stream_id;
  int tag;               /* MAGICSEAM_TAG_* */
  uint8_t *payload;      /* only meaningful for MAGICSEAM_TAG_OK */
  size_t payload_len;
  struct magicseam_reply_intent *next;
} magicseam_reply_intent;

/* A raw datagram queued for a SERVER connection by the shared
 * accept-thread's CID demux (magicseam_conn_feed_pkt) - a copy, since
 * the accept thread's own receive buffer is reused for the next
 * recvfrom immediately. */
typedef struct magicseam_pkt {
  uint8_t *data;
  size_t len;
  struct magicseam_pkt *next;
} magicseam_pkt;

/* Cap for the io_thread's stuck-expiry backoff (io.c). 100ms bounds a
 * connection whose ngtcp2 timer never advances to ~10 wakeups/sec instead of a
 * spin, while staying far below the 60s close-request bound so a close is
 * still serviced promptly. */
#define MAGICSEAM_STUCK_BACKOFF_MAX_MS 100

/* magicseam_conn: the per-QUIC-connection state the io_thread owns.
 * Shared by client and server (the server keeps one of these per
 * accepted connection, demuxed by CID in server.c). */
typedef struct magicseam_conn {
  int fd;                       /* connected (client) or bound (server, shared) UDP socket */
  int is_server;
  /* Set by the io_thread immediately before it returns, so the SERVER can tell
   * a finished connection from a live one and reap it (server.c's sweep). A
   * server connection is otherwise immortal: magicseam_conn_free is called
   * only on accept-time setup failures, so every connection that ever
   * SUCCEEDED kept its thread and its conn_entry forever. */
  atomic_int io_done;
  /* The SERVER's wakeup pipe write end, or -1 on a client. The io_thread pokes
   * it after setting io_done so the accept thread wakes and sweeps.
   *
   * WITHOUT THIS THE SWEEP IS CORRECT MACHINERY THAT NEVER RUNS: it sits at the
   * top of the accept loop, so it only executes on a wakeup - and the LAST
   * connection to finish sets io_done after the packet that woke the accept
   * thread has already been handled. Nothing else arrives, poll blocks, and the
   * connection is never collected. Caught by
   * test_finished_connections_are_reaped, which failed with the sweep in
   * place. */
  int reap_wakeup_fd;
  ngtcp2_conn *conn;             /* io_thread-only */
  ngtcp2_crypto_ossl_ctx *ossl;   /* io_thread-only */
  SSL *ssl;                       /* io_thread-only */
  ngtcp2_crypto_conn_ref conn_ref;

  struct sockaddr_storage local_addr;
  socklen_t local_addrlen;
  struct sockaddr_storage remote_addr;
  socklen_t remote_addrlen;

  pthread_t io_thread;
  int started;
  int wakeup_fds[2];  /* self-pipe: write a byte to interrupt poll() */

  pthread_mutex_t mu;
  magicseam_open_intent *open_intents;   /* client: pending Call() opens */
  magicseam_reply_intent *reply_intents; /* server: pending handler results */

  magicseam_call_slot *slots;
  size_t nslots;

  atomic_int state; /* see MAGICSEAM_CONN_* below */
  int handshake_done;
  char served_version[256]; /* CLIENT only: the peer's self-reported version */
  char local_version[256];  /* SERVER only: OUR OWN version, sent on handshake accept */

  /* SERVER only: incoming datagrams matched to this connection by the
   * shared accept-thread's CID demux (see server.c) - fed via
   * magicseam_conn_feed_pkt, since a server connection's fd is the
   * listener's shared bound socket, not a private connected one (unlike
   * the client, whose io_thread reads its own fd directly - see
   * magicseam_io_run_once's own doc comment). FIFO (head=oldest,
   * tail=newest) - packets MUST be fed to ngtcp2_conn_read_pkt in
   * arrival order (a client's very first flight is routinely split
   * across 2+ UDP datagrams; ngtcp2's Initial/Handshake crypto-stream
   * processing depends on that order, and processing them reversed
   * corrupts the handshake). */
  magicseam_pkt *pkt_queue;
  magicseam_pkt *pkt_queue_tail;

  /* SERVER only: application handler to invoke for each completed
   * request, dispatched on the worker pool (never on the io_thread). */
  magicseam_handler handler;
  void *handler_user_data;
  struct magicseam_quic_server *owner; /* back-pointer, for the worker pool */
} magicseam_conn;

enum {
  MAGICSEAM_CONN_HANDSHAKING = 0,
  MAGICSEAM_CONN_UP = 1,
  MAGICSEAM_CONN_CLOSING = 2,
  MAGICSEAM_CONN_DEAD = 3,
};

/* magicseam_io_thread_main is the client-side io_thread entry point (a
 * connection whose UDP socket is `connect()`-ed to exactly one peer, so
 * no CID demux is needed - see server.c for the server's own demuxing
 * accept-loop thread, which reuses the same per-connection loop body via
 * magicseam_io_run_once). Runs until c->state is set to
 * MAGICSEAM_CONN_DEAD or magicseam_conn_request_close is called. */
void *magicseam_io_thread_main(void *arg);

/* magicseam_conn_new allocates and zero-initializes a magicseam_conn
 * (does not touch the network or ngtcp2 - callers finish setting up fd/
 * ssl/conn themselves, since client and server construct the underlying
 * ngtcp2_conn differently). Returns NULL on allocation failure. */
magicseam_conn *magicseam_conn_new(void);

/* magicseam_conn_free releases a magicseam_conn's OWN memory (call slots,
 * intent queues, mutex/cond) - does NOT close fd or free conn/ssl/ossl
 * (callers that own those free them first, since ownership/lifecycle
 * differs between a client's single connection and a server's
 * CID-demuxed table). Safe on a partially-initialized conn (as long as
 * magicseam_conn_new succeeded). */
void magicseam_conn_free(magicseam_conn *c);

/* magicseam_conn_request_close asks the io_thread to wind the connection
 * down and exit; wakes it via the self-pipe. Does not block. */
void magicseam_conn_request_close(magicseam_conn *c);

/* magicseam_wakeup pokes c's self-pipe so a blocked poll() in the
 * io_thread returns promptly to notice new work in the intent queues. */
void magicseam_wakeup(magicseam_conn *c);

/* magicseam_send_connection_close tells the peer the connection is over.
 * Without it a close is silent on the wire and the far side leaks a thread. */
void magicseam_send_connection_close(magicseam_conn *c);

/* magicseam_server_live_conns reports how many connections the server still
 * holds. It exists because a THREAD COUNT cannot see a reap failure: an exited
 * pthread leaves /proc/self/task whether or not it was ever joined, so the
 * conn list is the only place an unreaped connection is visible. */
size_t magicseam_server_live_conns(magicseam_quic_server *s);

/* magicseam_server_idle_timeout_ns is the max_idle_timeout a newly-served
 * connection advertises. It is a variable rather than a constant ONLY so the
 * idle-reap test can pick a timeout it can wait for - 30s is correct in
 * production and untestable in a suite. Internal: not in magicseam_quic.h. */
extern uint64_t magicseam_server_idle_timeout_ns;

/* magicseam_conn_feed_pkt (SERVER only) queues a copy of one just-
 * received datagram (already demuxed to this connection by CID - see
 * server.c's accept thread) for c's own per-connection thread to feed to
 * ngtcp2_conn_read_pkt on its next magicseam_io_run_once pass, updates
 * c->remote_addr/remote_addrlen to the packet's source (this SDK does
 * not support connection migration - every packet for a CID is assumed
 * to come from the same peer path for the connection's lifetime), and
 * wakes c's thread. Safe to call from the accept thread while c's own
 * thread is running (mutex-guarded, same as the intent queues). */
void magicseam_conn_feed_pkt(magicseam_conn *c, const uint8_t *data, size_t len,
                              const struct sockaddr *peer_addr, socklen_t peer_addrlen);

/* magicseam_server_dispatch (SERVER only) hands a fully-received request
 * (already parsed out of its wire frame) to the owning
 * magicseam_quic_server's worker pool - implemented in server.c, called
 * from io.c's magicseam_io_run_once once magicseam_try_parse_call_server
 * reports a slot complete. Must not block or touch c->conn (may run on
 * c's own io_thread, which must return promptly). */
void magicseam_server_dispatch(magicseam_conn *c, int64_t stream_id,
                                const uint8_t *req, size_t req_len);

/* magicseam_now_ns returns CLOCK_MONOTONIC time in nanoseconds - the
 * ngtcp2_tstamp unit used everywhere (timers, read_pkt, writev_stream).
 * A single helper so every call site agrees on the same clock source. */
uint64_t magicseam_now_ns(void);

/* magicseam_try_parse_call_server checks whether a SERVER-side call
 * slot's inbound buffer now holds a complete request frame (a plain
 * 4-byte length prefix + body, no tag byte - the server never sends one
 * of these, only receives). Returns 1 once complete (server.c reads the
 * request straight out of s->in_buf + 4, then dispatches to its worker
 * pool and sets s->handler_dispatched so it's never dispatched twice), 0
 * if more data is needed, -1 on a protocol violation (oversize frame). */
int magicseam_try_parse_call_server(magicseam_call_slot *s, size_t *req_off,
                                     size_t *req_len);
int magicseam_try_parse_handshake_server(magicseam_call_slot *s);

/* magicseam_parse_tcp_addr splits "tcp:<host>:<port>" (the one address
 * scheme every magic-seam SDK uses for this transport - "tcp:" is just
 * the historical scheme label, the actual socket is UDP) into host/port,
 * shared by client.c's dial and server.c's serve. No IPv6 bracket
 * support - this transport only ever connects to in-cluster pod IPs
 * (IPv4), never a bracketed literal. Returns MAGICSEAM_ERR_ARG on a
 * malformed address or an over-length host/port. */
magicseam_status magicseam_parse_tcp_addr(const char *addr, char *host, size_t hostcap,
                                           char *port, size_t portcap);

/* The shared ngtcp2_callbacks table both client.c and server.c populate
 * identically (only client_initial/recv_client_initial differ by role,
 * left NULL on whichever side doesn't need them). Defined in io.c. */
void magicseam_io_fill_callbacks(ngtcp2_callbacks *cb, int is_server);

/* magicseam_io_run_once feeds ngtcp2 newly-available inbound data, drains
 * queued app intents, writes pending packets, and returns the deadline
 * (ns, absolute CLOCK_MONOTONIC) the caller should next wake by (poll
 * timeout) even with no further activity - 0 means "already expired,
 * call again immediately". Returns (uint64_t)-1 if the connection has
 * become unrecoverable (caller should tear down). This is the one loop
 * body BOTH the client io_thread and every server per-connection thread
 * share - CLIENT connections read their own private connected UDP fd
 * directly; SERVER connections instead drain c->pkt_queue (datagrams the
 * shared accept-thread's CID demux already routed to this connection via
 * magicseam_conn_feed_pkt - see server.c), since the underlying socket is
 * the listener's single shared fd, not this connection's own. For a
 * SERVER connection, this function also scans slots for a newly-complete
 * inbound request (magicseam_try_parse_call_server) and stages the
 * handshake reply directly or hands a call off to
 * magicseam_server_dispatch. */
uint64_t magicseam_io_run_once(magicseam_conn *c);

#endif /* !defined(MAGICSEAM_IO_INTERNAL_H) */
