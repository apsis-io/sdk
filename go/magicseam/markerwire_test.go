// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"context"
	"encoding/binary"
	"io"
	"slices"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
)

// THE GO PROVIDER, DRIVEN BY A HAND-ROLLED CONSUMER THAT SPEAKS THE SPEC.
//
// Every opcode and frame here is written literally, from
// docs/magic-seam-quic-protocol.md, NOT from this package's own constants. That
// is the point: a test using opMarker would pass if someone renumbered the
// opcode on both sides, and the wire is exactly what must not move. If the spec
// says a marker is byte 2, this test says 2.
//
// WHAT THIS DOES AND DOES NOT PROVE, stated because the difference is the whole
// value of the exercise. It proves the GO PROVIDER answers bytes written from the
// specification by something that is not the SDK. It does NOT prove trail-binary-
// to-Go-binary interop: both ends here are in one process, and trail's agreement
// with the same spec is pinned separately by its own end-to-end test
// (remote_quic.rs::quic_marker_arms_the_provider_and_acks). Two implementations
// each pinned to the same written spec is weaker than running them against each
// other, and stronger than either one testing itself.

// writeWireFrame writes a u32-LE length prefix and the body - the framing from
// the spec, spelled out rather than borrowed from writeFrame.
func writeWireFrame(w io.Writer, body []byte) error {
	var l [4]byte
	binary.LittleEndian.PutUint32(l[:], uint32(len(body)))
	if _, err := w.Write(l[:]); err != nil {
		return err
	}
	_, err := w.Write(body)

	return err
}

func readWireFrame(t *testing.T, r io.Reader) []byte {
	t.Helper()
	var l [4]byte
	if _, err := io.ReadFull(r, l[:]); err != nil {
		t.Fatalf("read frame length: %v", err)
	}
	body := make([]byte, binary.LittleEndian.Uint32(l[:]))
	if _, err := io.ReadFull(r, body); err != nil {
		t.Fatalf("read frame body: %v", err)
	}

	return body
}

// handshake performs the six-step exchange from the spec and returns the
// provider's advertised capability frame.
func handshake(t *testing.T, conn *quic.Conn, required string) []byte {
	t.Helper()
	s, err := conn.OpenStreamSync(t.Context())
	if err != nil {
		t.Fatalf("open handshake stream: %v", err)
	}
	if err := writeWireFrame(s, []byte(required)); err != nil {
		t.Fatalf("write required version: %v", err)
	}
	// The consumer's own caps. "barrier" so the provider agrees to speak markers.
	if err := writeWireFrame(s, []byte("stream,status,barrier")); err != nil {
		t.Fatalf("write caps: %v", err)
	}
	s.Close()

	// Frame 3 is a BARE byte, not a frame - the single most likely thing a new
	// implementation gets wrong, so it is asserted rather than skipped.
	var accept [1]byte
	if _, err := io.ReadFull(s, accept[:]); err != nil {
		t.Fatalf("read accept byte: %v", err)
	}
	if accept[0] != 1 {
		t.Fatalf("provider rejected version %q (accept byte %d)", required, accept[0])
	}
	readWireFrame(t, s) // served version
	caps := readWireFrame(t, s)

	return caps
}

// TestGoProviderAnswersSpecWrittenMarkers is the cross-check: a consumer written
// from the spec arms the Go provider, observes it REFUSE a call while armed, and
// releases it.
func TestGoProviderAnswersSpecWrittenMarkers(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	ctx := t.Context()
	var barrier Barrier
	echo := func(_ Caller, request []byte) ([]byte, error) { return request, nil }
	go func() {
		_ = ServeQUICWithBarrier(ctx, "tcp:127.0.0.1:19733",
			providerCert, providerKey, providerCA, "0.1.0", echo, &barrier)
	}()
	time.Sleep(150 * time.Millisecond)

	conn := dialRaw(t, ctx, "127.0.0.1:19733", consumerCert, consumerKey, consumerCA)
	defer conn.CloseWithError(0, "")

	caps := handshake(t, conn, "0.1.0")
	if !containsToken(string(caps), "barrier") {
		t.Fatalf("provider caps %q do not advertise \"barrier\" - a coordinator would treat every "+
			"provider built on this SDK as unable to join a coordinated checkpoint", caps)
	}

	// ARM: opcode 2, then the barrier-ID frame.
	ms, err := conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open marker stream: %v", err)
	}
	if _, err := ms.Write([]byte{2}); err != nil {
		t.Fatalf("write marker opcode: %v", err)
	}
	if err := writeWireFrame(ms, []byte("barrier-1")); err != nil {
		t.Fatalf("write barrier id: %v", err)
	}
	ms.Close()

	var ack [1]byte
	if _, err := io.ReadFull(ms, ack[:]); err != nil {
		t.Fatalf("read marker ack: %v", err)
	}
	if ack[0] != 3 {
		t.Fatalf("ack opcode = %d, want 3 (OP_MARKER_ACK per the spec)", ack[0])
	}
	if got := string(readWireFrame(t, ms)); got != "barrier-1" {
		t.Errorf("echoed barrier id = %q, want %q - a consumer must be able to discard an ack for "+
			"a barrier it is no longer taking", got, "barrier-1")
	}

	if !barrier.Armed() {
		t.Fatal("the ack came back but the provider was never armed - the coordinator would " +
			"believe the channel was quiesced while it kept admitting calls")
	}

	// AND IT MUST NOW REFUSE CALLS. This is the assertion that distinguishes a
	// real quiesce from a provider that acks and keeps serving - the exact bug
	// found in trail, and unobservable from the ack alone.
	cs, err := conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open call stream: %v", err)
	}
	if _, err := cs.Write([]byte{0}); err != nil { // opCall
		t.Fatalf("write call opcode: %v", err)
	}
	_ = writeWireFrame(cs, []byte("ns\tpod\tuid\tcomp"))
	_ = writeWireFrame(cs, []byte("payload"))
	cs.Close()
	var tag [1]byte
	if _, err := io.ReadFull(cs, tag[:]); err != nil {
		t.Fatalf("read call tag while armed: %v", err)
	}
	if tag[0] == 0 {
		t.Error("an ARMED provider served a call - the 'channel is empty' ack it already sent is " +
			"a lie, and the snapshot taken on the strength of it is torn")
	}

	// RESUME: opcode 4.
	rs, err := conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open resume stream: %v", err)
	}
	if _, err := rs.Write([]byte{4}); err != nil {
		t.Fatalf("write resume opcode: %v", err)
	}
	_ = writeWireFrame(rs, []byte("barrier-1"))
	rs.Close()
	if _, err := io.ReadFull(rs, ack[:]); err != nil {
		t.Fatalf("read resume ack: %v", err)
	}
	if ack[0] != 3 {
		t.Fatalf("resume ack opcode = %d, want 3", ack[0])
	}
	if barrier.Armed() {
		t.Error("resume acked without releasing the provider - it would stay quiesced forever, " +
			"and the connection is the only channel a release could arrive by")
	}
}

func containsToken(caps, token string) bool {
	return slices.Contains(splitComma(caps), token)
}

func splitComma(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == ',' {
			out = append(out, cur)
			cur = ""

			continue
		}
		cur += string(r)
	}

	return append(out, cur)
}

// dialRaw opens a QUIC connection with the spec's ALPN and SNI, without going
// through DialQUIC - so the handshake under test is the one on the wire.
func dialRaw(t *testing.T, ctx context.Context, hostPort, cert, key, ca string) *quic.Conn {
	t.Helper()
	tlsCfg, err := loadQUICTLSConfig(cert, key, ca, false)
	if err != nil {
		t.Fatalf("tls config: %v", err)
	}
	tlsCfg.NextProtos = []string{"trail-quic"}
	tlsCfg.ServerName = "trail-quic-peer"
	conn, err := quic.DialAddr(ctx, hostPort, tlsCfg, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	return conn
}

// THE FAIL-CLOSED FLOOR: a provider with NO barrier must not ack a marker.
//
// capsOffered already omits "barrier" for a nil barrier, so a consumer that
// honours capabilities never gets here. This is what happens when one doesn't -
// and the answer has to be a refusal, because "no barrier" is not "nothing to
// drain". The provider is serving handler calls right now, with nothing counting
// them and nothing to stop admitting more. An ack would tell the coordinator its
// channel was empty, and the snapshot taken on the strength of that is torn.
func TestABarrierlessProviderRefusesMarkers(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	ctx := t.Context()
	echo := func(_ Caller, request []byte) ([]byte, error) { return request, nil }
	go func() {
		// Plain ServeQUIC: no barrier, which is the whole point.
		_ = ServeQUIC(ctx, "tcp:127.0.0.1:19734",
			providerCert, providerKey, providerCA, "0.1.0", echo)
	}()
	time.Sleep(150 * time.Millisecond)

	conn := dialRaw(t, ctx, "127.0.0.1:19734", consumerCert, consumerKey, consumerCA)
	defer conn.CloseWithError(0, "")

	caps := handshake(t, conn, "0.1.0")
	if containsToken(string(caps), "barrier") {
		t.Fatalf("caps %q advertise \"barrier\" with no barrier behind them - a coordinator would "+
			"treat this provider as quiescible and snapshot it mid-call", caps)
	}

	// Send one anyway, as a consumer that ignored the capabilities would.
	ms, err := conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open marker stream: %v", err)
	}
	if _, err := ms.Write([]byte{2}); err != nil {
		t.Fatalf("write marker opcode: %v", err)
	}
	if err := writeWireFrame(ms, []byte("barrier-1")); err != nil {
		t.Fatalf("write barrier id: %v", err)
	}
	ms.Close()

	var ack [1]byte
	if _, err := io.ReadFull(ms, ack[:]); err == nil {
		t.Errorf("a barrierless provider ACKED a marker (opcode %d) - the ack means \"my channel "+
			"is empty\", and this one never stopped serving", ack[0])
	}
}
