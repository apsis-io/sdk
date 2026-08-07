// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
)

// WHAT trail-quic COSTS OVER THE BARE TRANSPORT IT RUNS ON.
//
// # The number these exist to keep honest
//
// The seam's framing (a byte and two u32-LE length prefixes) is hand-rolled, and
// hand-rolled framing invites a recurring question: would a standard protocol be
// better? Answering it needs a floor - a QUIC stream carrying NO protocol at all -
// because without one there is no way to say how much of any measured number is
// QUIC itself rather than the protocol on top of it.
//
// The answer is that QUIC dominates and the seam's protocol is nearly lost in the
// noise of it. See docs/benchmarks/seam-transport-20260803.md for the measured
// figures, the run-to-run spread, and the HTTP/3 comparison that made the
// question concrete (summarised in docs/magic-seam-quic-protocol.md §2).
// Deliberately NOT restated here: a hardware-specific number pasted into a source
// comment is one nobody re-runs and everybody quotes.
//
// # Why these stayed after the h3 spike was deleted
//
// They do not measure h3. They measure OUR protocol against the transport floor,
// which is a standing property of the seam - the thing to re-run when the framing
// changes, when quic-go is bumped, or when the question comes back. Without them
// the decision doc's numbers are a claim nobody can re-check, and a doc whose
// numbers cannot be reproduced decays into folklore.
//
// # Reading them honestly
//
// Loopback, single connection, uncontended, one machine. The floor and the seam
// call must be compared WITHIN a run, never across runs: absolute values move
// >15% with machine load (several agents share this host), while the gap between
// the two is stable. Use -count to get a spread rather than trusting one sample:
//
//	go test ./sdk/go/magicseam -run XXX -bench QUIC -benchtime 1000x -count=5

// freeLoopbackUDPPort reserves a free loopback UDP port and releases it.
//
// EPHEMERAL, NOT FIXED, because these benchmarks are meant to be run under
// -count and fixed ports make that impossible: the previous iteration's listener
// is still bound when the next starts, so runs 2..N die with address-in-use. That
// presented as "the benchmark fails intermittently" and was purely the harness -
// the same flake that once read as "session resumption is broken".
//
// There is a race between closing here and re-binding in the caller, which is why
// this is a benchmark helper and not a general utility. It is the standard trade
// for a listener that takes an address string rather than a socket: ServeQUIC
// blocks and never reports what it bound, so port 0 cannot be discovered.
func freeLoopbackUDPPort(tb testing.TB) int {
	tb.Helper()
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		tb.Fatalf("reserving a loopback port: %v", err)
	}
	port := c.LocalAddr().(*net.UDPAddr).Port
	if err := c.Close(); err != nil {
		tb.Fatalf("releasing the reserved port: %v", err)
	}

	return port
}

// dialQUICWhenUp retries until the provider is accepting, or fails the benchmark.
//
// Replaces a blind `time.Sleep(300ms)`. A fixed sleep is wrong in both directions:
// too short under load and the dial fails for no reason, too long and every
// benchmark pays it. Retrying against a bounded deadline waits exactly as long as
// the server takes.
func dialQUICWhenUp(b *testing.B, addr, cert, key, ca string) *QUICClient {
	b.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		client, err := DialQUIC(b.Context(), addr, cert, key, ca, "0.1.0")
		if err == nil {
			return client
		}
		if time.Now().After(deadline) {
			b.Fatalf("provider at %s never accepted a connection: %v", addr, err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// serveQUICEcho starts an echo provider on a fresh port and returns its address.
func serveQUICEcho(b *testing.B, cert, key, ca string) string {
	b.Helper()
	addr := fmt.Sprintf("tcp:127.0.0.1:%d", freeLoopbackUDPPort(b))
	echo := func(_ Caller, req []byte) ([]byte, error) { return req, nil }
	go func() {
		_ = ServeQUIC(b.Context(), addr, cert, key, ca, "0.1.0", echo)
	}()

	return addr
}

// BenchmarkBareQUICStream is the floor: open a bidi stream, write a payload,
// close the write side, read the echo. The least any request/response can cost
// on this stack, with no seam protocol involved at all.
func BenchmarkBareQUICStream(b *testing.B) {
	ca := generateTestCA(b)
	providerCert, providerKey, providerCA := writeTestLeaf(b, ca, b.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(b, ca, b.TempDir())

	ctx := b.Context()
	srvTLS, err := loadQUICTLSConfig(providerCert, providerKey, providerCA, true)
	if err != nil {
		b.Fatal(err)
	}
	// A private ALPN: this is deliberately NOT the seam's, because a bare stream
	// speaks no seam protocol and advertising TrailQUICALPN would invite a real
	// consumer to connect to something that cannot answer it.
	srvTLS.NextProtos = []string{"bare-bench"}
	// Port 0 directly: unlike ServeQUIC, this listener reports what it bound, so
	// there is no reserve-and-release race here at all.
	ln, err := quic.ListenAddr("127.0.0.1:0", srvTLS, nil)
	if err != nil {
		b.Fatal(err)
	}
	defer ln.Close()

	go func() {
		conn, acceptErr := ln.Accept(ctx)
		if acceptErr != nil {
			return
		}
		for {
			st, streamErr := conn.AcceptStream(ctx)
			if streamErr != nil {
				return
			}
			go func() {
				buf, _ := io.ReadAll(st)
				_, _ = st.Write(buf)
				_ = st.Close()
			}()
		}
	}()

	cliTLS, err := loadQUICTLSConfig(consumerCert, consumerKey, consumerCA, false)
	if err != nil {
		b.Fatal(err)
	}
	cliTLS.NextProtos = []string{"bare-bench"}
	cliTLS.ServerName = TrailQUICSNI
	conn, err := quic.DialAddr(ctx, ln.Addr().String(), cliTLS, nil)
	if err != nil {
		b.Fatal(err)
	}
	defer conn.CloseWithError(0, "")

	payload := []byte("a small request, which is what the seam mostly carries")
	b.ResetTimer()
	for b.Loop() {
		st, streamErr := conn.OpenStreamSync(ctx)
		if streamErr != nil {
			b.Fatal(streamErr)
		}
		if _, err := st.Write(payload); err != nil {
			b.Fatal(err)
		}
		_ = st.Close()
		if _, err := io.ReadAll(st); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkQUICCall is the same round trip through the actual seam - same CA,
// same loopback, same payload, same loop - so the delta against the floor above
// is the protocol's cost and nothing else.
func BenchmarkQUICCall(b *testing.B) {
	ca := generateTestCA(b)
	providerCert, providerKey, providerCA := writeTestLeaf(b, ca, b.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(b, ca, b.TempDir())

	addr := serveQUICEcho(b, providerCert, providerKey, providerCA)
	client := dialQUICWhenUp(b, addr, consumerCert, consumerKey, consumerCA)
	defer client.Close()

	payload := []byte("a small request, which is what the seam mostly carries")
	b.ResetTimer()
	for b.Loop() {
		if _, err := client.Call(b.Context(), payload); err != nil {
			b.Fatalf("call: %v", err)
		}
	}
}

// PAYLOAD SWEEP: how the seam's per-call cost scales with body size.
//
// Kept because it is the shape of the seam's own cost curve, and because it is
// the experiment that distinguishes a fixed per-call overhead from per-byte work
// - the distinction that decided the h3 question and would decide the next one.
// 64 B and 64 KiB bracket what the seam actually carries.
func benchQUICSweep(b *testing.B, size int) {
	ca := generateTestCA(b)
	pc, pk, pca := writeTestLeaf(b, ca, b.TempDir())
	cc, ck, cca := writeTestLeaf(b, ca, b.TempDir())

	addr := serveQUICEcho(b, pc, pk, pca)
	cl := dialQUICWhenUp(b, addr, cc, ck, cca)
	defer cl.Close()

	payload := make([]byte, size)
	b.ResetTimer()
	for b.Loop() {
		if _, err := cl.Call(b.Context(), payload); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkQUICSweep64(b *testing.B)  { benchQUICSweep(b, 64) }
func BenchmarkQUICSweep64K(b *testing.B) { benchQUICSweep(b, 64<<10) }
