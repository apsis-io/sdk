// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"context"
	"crypto/tls"
	"fmt"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
)

// 0-RTT CONNECTION ESTABLISHMENT FOR THE SEAM, and the reason only ONE thing
// ever rides early data.
//
// # What a seam dial costs, and why 0-RTT is worth anything at all
//
// Establishing a seam connection is TWO round trips, not one:
//
//	RTT 1  QUIC/TLS handshake
//	RTT 2  the seam's own handshake - write required version, read the accept
//	       byte + served version + caps + status (DialQUIC)
//
// 0-RTT collapses that to one. On a resumed session the client may send
// application data in its very first flight, so the seam handshake travels
// WITH the TLS ClientHello and the provider answers both together.
//
// This is the opposite of the finding for HTTP/3 (docs/benchmarks/
// seam-transport-20260803.md), and the difference is worth naming because the
// earlier conclusion reads as if it should apply here. It does not: HTTP/3
// restricts early data to safe, idempotent METHODS (GET/HEAD), and every seam
// operation is a POST. That is an HTTP semantic rule, and raw QUIC has no
// methods to be restricted by. The replay PROBLEM the rule exists to solve is
// still real; we just have to solve it ourselves, which is the rest of this
// comment.
//
// # Only the handshake rides early data, and that is STRUCTURAL
//
// 0-RTT data is replayable by design: an attacker who captures the first flight
// can send it again, and the server cannot tell. So early data is only ever safe
// for operations that are harmless to repeat.
//
// Of the seam's operations, exactly one qualifies:
//
//   - the HANDSHAKE - writes a version string, reads the provider's answer. It
//     mutates nothing. Replaying it costs the provider one stream and tells the
//     attacker what it already saw.
//   - `Call` - dispatches arbitrary handler code. Never safe to assume.
//   - markers (`OP_MARKER`/`OP_RESUME`) - explicitly NOT idempotent. They ARM and
//     RELEASE a barrier; a replayed arm quiesces a pod nobody asked to quiesce.
//
// The rule is therefore "handshake only", and it is enforced by CONSTRUCTION
// rather than by remembering it: DialQUICEarly does not return the client until
// `HandshakeComplete()` has fired. By the time any caller holds a *QUICClient
// and can invoke Call or a marker, the connection is fully established and
// early-data keys are gone. There is no code path that could put a call in early
// data, so there is no rule for a future change to violate.
//
// Waiting costs nothing: the seam handshake already blocks on the provider's
// reply, and the TLS handshake completes alongside it.
//
// NOT COVERED BY A TEST, and deliberately recorded as such rather than left to
// look covered. A guard was written and MUTATION-TESTED: removing the wait
// entirely left it green. The reason is that seamHandshake reads the provider's
// reply, and on loopback the TLS handshake has always completed by the time that
// read returns - so the property holds incidentally whether or not this code
// asks for it, and no assertion from outside can tell the two apart.
//
// The wait stays because "holds incidentally today" is not a guarantee: it
// depends on the provider answering no earlier than its own handshake completes,
// which is a property of the peer and the network, not of this code. But a
// future change that deleted it would NOT be caught by the suite. Anyone
// touching this should re-derive the argument rather than trust a green run.
//
// # Where this actually pays
//
// NOT on the per-call path - a seam connection is long-lived and every call
// after the first is on an established connection either way. It pays exactly
// where connections are MADE:
//
//   - HEALING (quicheal.go). A redial after a provider restart is a fresh
//     connection on a hot path, with a caller blocked on it.
//   - SHORT-LIVED CONSUMERS. tools/seamstatus and internal/trailop's probers
//     dial, ask one question, and exit. They pay full establishment for a single
//     call, which is the worst possible ratio.
//
// # It is an OPTIMISATION, never a requirement
//
// Every failure mode degrades to the ordinary path. No ticket cached yet (the
// first dial to any provider, always) means a normal 1-RTT handshake. A provider
// that does not offer tickets, or refuses the early data, means the same. A
// caller cannot tell the difference except in latency, which is why DialQUIC and
// DialQUICEarly return the same type and DialQUICEarly is safe as a drop-in.

// seamMaxIdleTimeout / seamKeepAlivePeriod hold an idle seam connection open.
//
// MUST STAY IN STEP WITH trail's remote_quic.rs seam_transport_config, which
// sets the same 10s/60s: the effective idle timeout is the MINIMUM of what the
// two peers advertise, so the shorter side silently wins. quic-go's default is
// 30s with no keep-alive at all, which is what let an idle consumer come back to
// a connection the provider had already dropped.
//
// Keep-alive and healing are NOT redundant. Healing recovers a connection that
// died; keep-alive stops an idle one from being killed in the first place.
// Without it every quiet period ends in a heal, and a heal costs one failed call
// plus a fresh handshake.
const (
	seamMaxIdleTimeout  = 60 * time.Second
	seamKeepAlivePeriod = 10 * time.Second
)

// Session tickets, held PER PROVIDER ADDRESS so a later dial can resume.
//
// # Why not one shared cache
//
// crypto/tls keys the client session cache by `ServerName` when one is set
// (handshake_client.go's clientSessionCacheKey), and EVERY seam connection sets
// the same fixed SNI - TrailQUICSNI, which is an identity, not a hostname
// (§1 of docs/magic-seam-quic-protocol.md explains why it is deliberately not
// the dial address).
//
// So a single shared cache would give every provider in the process the same
// key. They would overwrite each other's tickets, and each dial would offer the
// PREVIOUS provider's ticket to a different provider, which cannot decrypt it.
// Resumption would silently almost never happen for any consumer talking to
// more than one provider - visible only as latency, never as an error. Giving
// each address its own cache is what makes the fixed SNI harmless here.
//
// PROCESS-WIDE (rather than per-client) on purpose: a heal constructs a fresh
// client and a prober's whole job is to dial repeatedly, so a per-client cache
// would be empty at exactly the moments 0-RTT exists to serve.
var (
	sessionCachesMu sync.Mutex
	sessionCaches   = map[string]tls.ClientSessionCache{}
)

// maxSessionCaches bounds the per-address map for a consumer that dials many
// distinct providers over a long life.
//
// On overflow the whole map is dropped rather than evicted one entry at a time.
// Crude deliberately: a cold cache costs one round trip and nothing else, so the
// simplest bound that cannot leak is the right one. An LRU-of-LRUs would be more
// machinery guarding a purely latency-shaped downside.
const maxSessionCaches = 64

func sessionCacheFor(addr string) tls.ClientSessionCache {
	sessionCachesMu.Lock()
	defer sessionCachesMu.Unlock()

	if cache, ok := sessionCaches[addr]; ok {
		return cache
	}
	if len(sessionCaches) >= maxSessionCaches {
		sessionCaches = map[string]tls.ClientSessionCache{}
	}
	cache := tls.NewLRUClientSessionCache(4)
	sessionCaches[addr] = cache

	return cache
}

// seamInitialPacketSize is the QUIC spec floor, and it is set because quic-go's
// DEFAULT DOES NOT FIT A 1280-MTU PATH.
//
// # The measurement (comet-main, 2026-08-27, on the aphelion0 tailnet)
//
// A Go dial across aphelion0 timed out against every peer, while a Rust probe
// completed the whole conversation against the SAME address with the SAME
// credential in the same window - so it was never the peer, the cert or ALPN.
//
//	aphelion0 mtu 1280  ->  max UDP payload with DF set = 1252
//	payload 1252 + 28 = 1280  SENT
//	payload 1256 + 28 = 1284  EMSGSIZE
//	payload 1280 + 28 = 1308  EMSGSIZE   <- quic-go's default
//
// quic-go sets DF and defaults InitialPacketSize to 1280 (protocol.InitialPacketSize).
// With a 20-byte IP and 8-byte UDP header that is 1308 on the wire, so the KERNEL
// refuses every Initial locally and nothing reaches the peer at all. The symptom
// is "timeout: no recent network activity" - a peer-shaped error for a failure
// that never left the host, which is why it read as a device problem for an hour.
//
// quinn (trail's Rust side) uses 1200 and fits, which is exactly why only the Go
// side saw it. Two implementations of one protocol with different defaults, and
// the seam runs both.
//
// # Why 1200, and why this is not a cap
//
// 1200 is the minimum every conformant QUIC path must carry (RFC 9000 §14.1) and
// quic-go's own documented lower limit - "values below 1200 are invalid". Path
// MTU discovery stays ENABLED, so a fatter path is still discovered and used;
// this only lowers the size of the packets sent BEFORE anything is known about
// the path. On a 1500-MTU cluster link nothing changes, which is why every
// in-cluster seam worked while the tailnet one could not handshake.
//
// ⚠ THIS CONFIG FEEDS quic.ListenEarly AS WELL AS THE TWO DIAL PATHS, so it is
// the SERVER's handshake response as much as the client's Initial. A provider
// reached over a 1280-MTU path would have failed to answer for the same reason,
// and that half was never measured because the dial never got far enough to
// provoke it.
const seamInitialPacketSize = 1200

// seamQUICConfig is the transport config both ends of the seam use.
//
// allow0RTT is server-side only: it lets a provider ACCEPT early data. A client
// passes false - whether it SENDS early data is decided by which dial function
// it calls and whether a ticket happens to be cached.
func seamQUICConfig(allow0RTT bool) *quic.Config {
	return &quic.Config{
		MaxIdleTimeout:    seamMaxIdleTimeout,
		KeepAlivePeriod:   seamKeepAlivePeriod,
		Allow0RTT:         allow0RTT,
		InitialPacketSize: seamInitialPacketSize,
	}
}

// DialQUICEarly is DialQUIC that resumes a cached TLS session when it can,
// sending the seam handshake as 0-RTT early data and saving a round trip.
//
// Identical in every observable way to DialQUIC except latency: same arguments,
// same *QUICClient, same errors, same version gate. When no ticket is cached, or
// the provider will not resume, this silently performs an ordinary handshake -
// so it is a safe drop-in and there is no "did it work?" for a caller to handle.
//
// Use Used0RTT to find out after the fact, for metrics or a test.
func DialQUICEarly(ctx context.Context, addr, certPath, keyPath, caPath, requiredVersion string) (*QUICClient, error) {
	hostPort, err := parseQUICAddr(addr)
	if err != nil {
		return nil, err
	}
	tlsCfg, err := loadQUICTLSConfig(certPath, keyPath, caPath, false)
	if err != nil {
		return nil, err
	}
	tlsCfg.ClientSessionCache = sessionCacheFor(hostPort)

	// DialAddrEarly returns as soon as 0-RTT keys exist, so the seam handshake
	// written below travels in the first flight instead of after a completed
	// handshake. With no cached ticket this behaves exactly like DialAddr.
	conn, err := quic.DialAddrEarly(ctx, hostPort, tlsCfg, seamQUICConfig(false))
	if err != nil {
		return nil, fmt.Errorf("magicseam: QUIC early dial %s: %w", addr, err)
	}

	// NOT ADVERTISING: the 0-RTT path keeps the framing it has always had.
	client, err := seamHandshake(ctx, conn, requiredVersion, false)
	if err != nil {
		return nil, err
	}

	// THE STRUCTURAL GUARANTEE described at the top of this file: do not hand
	// back a client that could still write early data. Once this returns, the
	// 0-RTT keys are gone and every Call and marker is on an established
	// connection, so no future change can put a non-idempotent op in a
	// replayable flight.
	select {
	case <-conn.HandshakeComplete():
	case <-ctx.Done():
		conn.CloseWithError(0, "handshake did not complete")

		return nil, fmt.Errorf("magicseam: QUIC handshake did not complete: %w", ctx.Err())
	}

	return client, nil
}

// Used0RTT reports whether this connection resumed a session with early data.
//
// Purely observational - for metrics and tests. Behaviour never depends on it,
// because a caller that BRANCHED on it would be treating an optimisation as a
// contract, and the answer is false for legitimate reasons (a cold cache) far
// more often than for interesting ones.
func (c *QUICClient) Used0RTT() bool {
	return c.conn.ConnectionState().Used0RTT
}
