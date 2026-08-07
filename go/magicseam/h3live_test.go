// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"bytes"
	"testing"
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
