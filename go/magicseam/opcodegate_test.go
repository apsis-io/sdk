// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"io"
	"testing"
	"time"
)

// BARRIER DOES NOT IMPLY STREAM, and the wire says so.
//
// The spec (docs/magic-seam-quic-protocol.md §5) defines `barrier` as two-sided
// like `stream`, and says nothing about one requiring the other. So a conforming
// consumer may advertise `barrier` WITHOUT `stream` - it wants markers, it does
// not want bulk calls.
//
// The opcode byte is what both use. Gating the read on `stream` alone means such
// a consumer's OP_MARKER is never read as an opcode: it is consumed as the first
// byte of the caller-frame length instead, and the marker becomes a garbled call.
// That is precisely the failure §5 cites as the REASON barrier is two-sided,
// arriving by the other door.
//
// It is not reachable from this SDK's own client (capsOffered always includes
// stream), which is why it has gone unnoticed - but it is reachable from any
// conforming peer, and trail's own consumer decides its caps independently.
func TestBarrierWithoutStreamStillReadsTheOpcode(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	ctx := t.Context()
	var barrier Barrier
	echo := func(_ Caller, request []byte) ([]byte, error) { return request, nil }
	go func() {
		_ = ServeQUICWithBarrier(ctx, "tcp:127.0.0.1:19741",
			providerCert, providerKey, providerCA, "0.1.0", echo, &barrier)
	}()
	time.Sleep(150 * time.Millisecond)

	conn := dialRaw(t, ctx, "127.0.0.1:19741", consumerCert, consumerKey, consumerCA)
	defer conn.CloseWithError(0, "")

	// A consumer that wants markers but NOT bulk calls. Legal per §5.
	s, err := conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open handshake stream: %v", err)
	}
	_ = writeWireFrame(s, []byte("0.1.0"))
	_ = writeWireFrame(s, []byte("barrier"))
	s.Close()
	var accept [1]byte
	if _, err := io.ReadFull(s, accept[:]); err != nil {
		t.Fatalf("read accept byte: %v", err)
	}
	readWireFrame(t, s) // served version
	caps := readWireFrame(t, s)
	if !containsToken(string(caps), "barrier") {
		t.Fatalf("provider did not offer barrier (%q); the test proves nothing", caps)
	}

	// Now send a marker. If the opcode is not read, byte 2 is consumed as part of
	// the caller frame's length and no ack ever comes.
	ms, err := conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open marker stream: %v", err)
	}
	if _, err := ms.Write([]byte{opMarker}); err != nil {
		t.Fatalf("write marker opcode: %v", err)
	}
	_ = writeWireFrame(ms, []byte("b-nostream"))
	ms.Close()

	done := make(chan byte, 1)
	go func() {
		var ack [1]byte
		if _, err := io.ReadFull(ms, ack[:]); err == nil {
			done <- ack[0]
		}
		close(done)
	}()
	select {
	case ack, ok := <-done:
		if !ok || ack != opMarkerAck {
			t.Fatalf("marker was not acked (ok=%v ack=%d) - the opcode was consumed as caller-frame "+
				"bytes, so a consumer that advertises barrier without stream cannot quiesce this "+
				"provider at all", ok, ack)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no marker ack: the opcode byte was never read as an opcode, so the marker was " +
			"parsed as a garbled call - the exact failure §5 makes barrier two-sided to prevent")
	}
	if !barrier.Armed() {
		t.Error("acked but never armed")
	}
}

// ...and the gate must not open on the peer's word alone. A consumer may
// advertise `barrier` to a provider that has none - it is an advertisement, not
// a contract (§5). This provider then does NOT advertise barrier back, so a
// conforming consumer sends no marker and no opcode.
//
// If barrierAgreed ignored our own side, the gate would open anyway and the
// first byte of the caller frame would be eaten as an opcode: an ordinary call
// garbled by a capability neither end is using.
func TestAPeersBarrierClaimAloneDoesNotOpenTheOpcodeGate(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	ctx := t.Context()
	echo := func(_ Caller, request []byte) ([]byte, error) { return request, nil }
	go func() {
		// Plain ServeQUIC: NO barrier on this side.
		_ = ServeQUIC(ctx, "tcp:127.0.0.1:19742",
			providerCert, providerKey, providerCA, "0.1.0", echo)
	}()
	time.Sleep(150 * time.Millisecond)

	conn := dialRaw(t, ctx, "127.0.0.1:19742", consumerCert, consumerKey, consumerCA)
	defer conn.CloseWithError(0, "")

	s, err := conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open handshake stream: %v", err)
	}
	_ = writeWireFrame(s, []byte("0.1.0"))
	_ = writeWireFrame(s, []byte("barrier")) // claimed, but unusable here
	s.Close()
	var accept [1]byte
	if _, err := io.ReadFull(s, accept[:]); err != nil {
		t.Fatalf("read accept byte: %v", err)
	}
	readWireFrame(t, s)
	if caps := readWireFrame(t, s); containsToken(string(caps), "barrier") {
		t.Fatalf("a barrierless provider advertised barrier (%q)", caps)
	}

	// A CLASSIC call - no opcode byte, because neither end is using one.
	cs, err := conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open call stream: %v", err)
	}
	_ = writeWireFrame(cs, []byte("ns\tpod\tuid\tcomp"))
	_ = writeWireFrame(cs, []byte("hello"))
	cs.Close()

	// DEADLINE, so the failure is the ASSERTION below rather than a 30s hang.
	// The bug this guards eats the caller frame's first byte, which desynchronises
	// the framing and leaves the read blocked forever - so without a deadline the
	// test still fails, but by timeout, 30s later, saying only "timeout" instead
	// of naming the gate. Noticed by peri-sonnet-5 while mutation-verifying it.
	if err := cs.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	var tag [1]byte
	if _, err := io.ReadFull(cs, tag[:]); err != nil {
		t.Fatalf("no reply to a classic call (%v) - the opcode gate opened on the peer's claim "+
			"alone and ate the caller frame's first byte, desynchronising the framing", err)
	}
	if tag[0] != tagOK {
		t.Fatalf("classic call answered tag %d, want %d - the opcode gate opened on the peer's "+
			"claim alone and ate the caller frame's first byte", tag[0], tagOK)
	}
	if got := string(readWireFrame(t, cs)); got != "hello" {
		t.Errorf("echo = %q, want hello", got)
	}
}
