// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"bytes"
	"io"
	"testing"

	"github.com/quic-go/quic-go"
	"time"
)

// A REAL h3 CONNECTION, mTLS and all. The handler tests prove the mapping; this
// proves the transport actually carries it - ALPN, certificates, the fixed SNI,
// and a round trip - because "the translation is right" and "it connects" are
// different claims and only one of them was tested above.
func TestH3RoundTripOverARealConnection(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	ctx := t.Context()
	var barrier Barrier
	echo := func(c Caller, req []byte) ([]byte, error) {
		if c.PodName != "consumer-pod" {
			t.Errorf("caller identity did not survive the wire: %+v", c)
		}

		return append([]byte("echo:"), req...), nil
	}
	go func() {
		_ = ServeH3(ctx, "tcp:127.0.0.1:19751",
			providerCert, providerKey, providerCA, "0.1.0", echo, &barrier)
	}()
	time.Sleep(300 * time.Millisecond)

	client, err := DialH3(ctx, "tcp:127.0.0.1:19751",
		consumerCert, consumerKey, consumerCA, "0.1.0",
		Caller{Namespace: "ns", PodName: "consumer-pod", PodUID: "uid", Component: "comp"})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	got, err := client.Call(ctx, []byte("hello"))
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if !bytes.Equal(got, []byte("echo:hello")) {
		t.Fatalf("response = %q, want echo:hello", got)
	}

	// The provider's identity arrived WITHOUT a handshake - on the answer itself.
	if client.ServedVersion() != "0.1.0" {
		t.Errorf("served version = %q, want 0.1.0 (learned from the answer, not a handshake)",
			client.ServedVersion())
	}
	var sawBarrier bool
	for _, c := range client.Caps() {
		if c == CapBarrier {
			sawBarrier = true
		}
	}
	if !sawBarrier {
		t.Errorf("caps = %v, want the barrier capability advertised", client.Caps())
	}

	// ...and the marker protocol over the same connection.
	if err := client.Marker(ctx, "b1"); err != nil {
		t.Fatalf("marker: %v", err)
	}
	if !barrier.Armed() {
		t.Fatal("marker acked without arming")
	}
	if _, err := client.Call(ctx, []byte("x")); err == nil {
		t.Error("an armed provider served a call over h3")
	}
	if err := client.Resume(ctx, "b1"); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if barrier.Armed() {
		t.Error("resume did not release the barrier")
	}
}

// PER-CALL OVERHEAD, which is the number the spike exists to produce: h3 adds
// header encode/decode (QPACK) per call where the raw wire had a byte and two
// length prefixes. Negligible for the bulk seam; the question is whether it is
// tolerable for small calls, which is what the seam mostly carries.
func BenchmarkH3Call(b *testing.B) {
	ca := generateTestCA(b)
	providerCert, providerKey, providerCA := writeTestLeaf(b, ca, b.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(b, ca, b.TempDir())

	ctx := b.Context()
	echo := func(_ Caller, req []byte) ([]byte, error) { return req, nil }
	go func() {
		_ = ServeH3(ctx, "tcp:127.0.0.1:19752",
			providerCert, providerKey, providerCA, "0.1.0", echo, nil)
	}()
	time.Sleep(300 * time.Millisecond)

	client, err := DialH3(ctx, "tcp:127.0.0.1:19752",
		consumerCert, consumerKey, consumerCA, "0.1.0", Caller{Namespace: "ns", PodName: "p"})
	if err != nil {
		b.Fatalf("dial: %v", err)
	}
	defer client.Close()

	payload := []byte("a small request, which is what the seam mostly carries")
	b.ResetTimer()
	for b.Loop() {
		if _, err := client.Call(ctx, payload); err != nil {
			b.Fatalf("call: %v", err)
		}
	}
}

// THE BASELINE. A per-call number for h3 alone says nothing - the question the
// spike exists to answer is what the translation COSTS, and that needs the raw
// transport measured the same way: same CA, same loopback, same payload, same
// loop.
func BenchmarkQUICCall(b *testing.B) {
	ca := generateTestCA(b)
	providerCert, providerKey, providerCA := writeTestLeaf(b, ca, b.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(b, ca, b.TempDir())

	ctx := b.Context()
	echo := func(_ Caller, req []byte) ([]byte, error) { return req, nil }
	go func() {
		_ = ServeQUIC(ctx, "tcp:127.0.0.1:19753",
			providerCert, providerKey, providerCA, "0.1.0", echo)
	}()
	time.Sleep(300 * time.Millisecond)

	client, err := DialQUIC(ctx, "tcp:127.0.0.1:19753",
		consumerCert, consumerKey, consumerCA, "0.1.0")
	if err != nil {
		b.Fatalf("dial: %v", err)
	}
	defer client.Close()

	payload := []byte("a small request, which is what the seam mostly carries")
	b.ResetTimer()
	for b.Loop() {
		if _, err := client.Call(ctx, payload); err != nil {
			b.Fatalf("call: %v", err)
		}
	}
}

// RECONNECTION COST, which is what 0-RTT would have addressed and cannot (see
// h3.go: early data is GET/HEAD only, and every seam op is POST).
//
// What IS available is TLS session resumption: a resumed handshake skips the
// certificate exchange, so it is cheaper than a cold one even without early
// data. This measures a full dial+call, so the handshake is NOT amortised - the
// opposite of BenchmarkH3Call, and the number that matters when a provider
// restarts or a pod migrates.
// addr is a parameter because both variants otherwise bind the same port: run in
// sequence, the second fails with address-in-use while the first benchmark's
// server is still up. That looked like "resumption is broken" and was a flake in
// the harness.
func benchmarkH3Dial(b *testing.B, withCache bool, addr string) {
	ca := generateTestCA(b)
	providerCert, providerKey, providerCA := writeTestLeaf(b, ca, b.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(b, ca, b.TempDir())

	ctx := b.Context()
	echo := func(_ Caller, req []byte) ([]byte, error) { return req, nil }
	go func() {
		_ = ServeH3(ctx, addr,
			providerCert, providerKey, providerCA, "0.1.0", echo, nil)
	}()
	time.Sleep(300 * time.Millisecond)

	caller := Caller{Namespace: "ns", PodName: "p"}
	// One warm dial so the cache (when enabled) actually holds a ticket - an
	// empty cache measures a cold handshake whatever the flag says.
	warm, err := dialH3WithCache(ctx, addr,
		consumerCert, consumerKey, consumerCA, "0.1.0", caller, withCache)
	if err != nil {
		b.Fatalf("warm dial: %v", err)
	}
	if _, err := warm.Call(ctx, []byte("warm")); err != nil {
		b.Fatalf("warm call: %v", err)
	}

	b.ResetTimer()
	for b.Loop() {
		c, err := dialH3WithCache(ctx, addr,
			consumerCert, consumerKey, consumerCA, "0.1.0", caller, withCache)
		if err != nil {
			b.Fatalf("dial: %v", err)
		}
		if _, err := c.Call(ctx, []byte("x")); err != nil {
			b.Fatalf("call: %v", err)
		}
		_ = c.Close()
	}
	b.StopTimer()
	_ = warm.Close()
}

func BenchmarkH3DialCold(b *testing.B)    { benchmarkH3Dial(b, false, "tcp:127.0.0.1:19754") }
func BenchmarkH3DialResumed(b *testing.B) { benchmarkH3Dial(b, true, "tcp:127.0.0.1:19755") }

// THE MISSING BASELINE: a bare QUIC stream with NO protocol on it at all.
//
// "h3 is 2.3x slower than QUIC" was the wrong framing and it was mine. Both
// transports run on the SAME quic-go; what the comparison actually measures is
// our bespoke framing against a general-purpose HTTP stack. Without a
// no-protocol floor there is no way to say how much of either number is QUIC
// itself - and if QUIC dominates, the protocol choice matters far less than the
// ratio suggests.
//
// Open a bidi stream, write a payload, close the write side, read the echo. That
// is the least any request/response can cost on this stack.
func BenchmarkBareQUICStream(b *testing.B) {
	ca := generateTestCA(b)
	providerCert, providerKey, providerCA := writeTestLeaf(b, ca, b.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(b, ca, b.TempDir())

	ctx := b.Context()
	srvTLS, err := loadQUICTLSConfig(providerCert, providerKey, providerCA, true)
	if err != nil {
		b.Fatal(err)
	}
	srvTLS.NextProtos = []string{"bare-bench"}
	ln, err := quic.ListenAddr("127.0.0.1:19756", srvTLS, nil)
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
	conn, err := quic.DialAddr(ctx, "127.0.0.1:19756", cliTLS, nil)
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

// PAYLOAD SWEEP: is the h3 delta a fixed extra ROUND TRIP, or per-byte work?
//
// The two answers demand opposite responses. A constant delta across payload
// sizes means an extra round trip - a property of the stack, not tunable from
// here. A growing delta means per-byte processing, which is.
//
// This is the experiment that decides whether "optimise h3" is a real avenue.
func benchSweep(b *testing.B, h3 bool, size int, addr string) {
	ca := generateTestCA(b)
	pc, pk, pca := writeTestLeaf(b, ca, b.TempDir())
	cc, ck, cca := writeTestLeaf(b, ca, b.TempDir())

	ctx := b.Context()
	echo := func(_ Caller, req []byte) ([]byte, error) { return req, nil }
	go func() {
		if h3 {
			_ = ServeH3(ctx, addr, pc, pk, pca, "0.1.0", echo, nil)
		} else {
			_ = ServeQUIC(ctx, addr, pc, pk, pca, "0.1.0", echo)
		}
	}()
	time.Sleep(300 * time.Millisecond)

	payload := make([]byte, size)
	var call func() error
	if h3 {
		cl, err := DialH3(ctx, addr, cc, ck, cca, "0.1.0", Caller{Namespace: "ns", PodName: "p"})
		if err != nil {
			b.Fatal(err)
		}
		defer cl.Close()
		call = func() error { _, err := cl.Call(ctx, payload); return err }
	} else {
		cl, err := DialQUIC(ctx, addr, cc, ck, cca, "0.1.0")
		if err != nil {
			b.Fatal(err)
		}
		defer cl.Close()
		call = func() error { _, err := cl.Call(ctx, payload); return err }
	}

	b.ResetTimer()
	for b.Loop() {
		if err := call(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkSweepQUIC64(b *testing.B)  { benchSweep(b, false, 64, "tcp:127.0.0.1:19760") }
func BenchmarkSweepH364(b *testing.B)    { benchSweep(b, true, 64, "tcp:127.0.0.1:19761") }
func BenchmarkSweepQUIC64K(b *testing.B) { benchSweep(b, false, 64<<10, "tcp:127.0.0.1:19762") }
func BenchmarkSweepH364K(b *testing.B)   { benchSweep(b, true, 64<<10, "tcp:127.0.0.1:19763") }
