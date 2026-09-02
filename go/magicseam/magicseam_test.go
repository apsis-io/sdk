// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func TestParseAddr(t *testing.T) {
	cases := []struct {
		addr        string
		wantNetwork string
		wantAddress string
		wantErr     bool
	}{
		{"unix:/tmp/s.sock", "unix", "/tmp/s.sock", false},
		{"tcp:127.0.0.1:9000", "tcp", "127.0.0.1:9000", false},
		{"/tmp/s.sock", "", "", true},
		{"unix:", "", "", true},
		{"tcp:", "", "", true},
	}
	for _, tc := range cases {
		network, address, err := parseAddr(tc.addr)
		if tc.wantErr {
			if err == nil {
				t.Errorf("parseAddr(%q): want error, got none", tc.addr)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseAddr(%q): unexpected error: %v", tc.addr, err)
			continue
		}
		if network != tc.wantNetwork || address != tc.wantAddress {
			t.Errorf("parseAddr(%q) = (%q, %q), want (%q, %q)", tc.addr, network, address, tc.wantNetwork, tc.wantAddress)
		}
	}
}

func TestFrameRoundtrip(t *testing.T) {
	var buf bytes.Buffer
	if err := writeFrame(&buf, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	got, err := readFrame(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello" {
		t.Errorf("readFrame = %q, want %q", got, "hello")
	}
}

func TestTagFor(t *testing.T) {
	cases := []struct {
		err  error
		want byte
	}{
		{ErrRejected, tagRejected},
		{ErrTooLarge, tagTooLarge},
		{io.EOF, tagUnavailable},
		{nil, tagUnavailable}, // tagFor is only called with a non-nil error in serveConn, but defend anyway
	}
	for _, tc := range cases {
		if got := tagFor(tc.err); got != tc.want {
			t.Errorf("tagFor(%v) = %d, want %d", tc.err, got, tc.want)
		}
	}
}

// writeFrameRaw/readFrameRaw are a minimal hand-rolled MSK1 CLIENT used ONLY
// by this test.
//
// *** ITS JUSTIFICATION HAS INVERTED, WHICH IS WORTH MORE THAN THE DEAD PATH
// IT CITED. *** This read "mirroring trail's MSK1 transport's Client
// exactly ... the real client lives in Rust/trail; this proves Serve's
// server-side wire behavior independently of it" until 2026-08-27. ADR-0044
// removed that Client. There is no real client any more, in Rust or anywhere:
// this hand-rolled one is now the ONLY MSK1 client in the tree.
//
// So it no longer proves Serve's behavior INDEPENDENTLY of the reference - it
// IS the reference, and a test that is its own oracle cannot catch the two
// ends drifting together. It still earns its place (it pins the wire against
// accidental change to Serve, and would red if framing moved), but do not read
// a pass here as cross-implementation agreement. The only real cross-speaker
// check left is TestEverySeamSpeakerSharesOneFrameBound, and it covers exactly
// one constant.
func clientHandshakeAndCall(t *testing.T, conn net.Conn, request []byte) (accept bool, served string, response []byte, tag byte) {
	t.Helper()
	if _, err := conn.Write([]byte(preamble)); err != nil {
		t.Fatal(err)
	}
	if err := writeFrame(conn, []byte("0.1.0")); err != nil {
		t.Fatal(err)
	}
	acceptByte := make([]byte, 1)
	if _, err := io.ReadFull(conn, acceptByte); err != nil {
		t.Fatal(err)
	}
	servedBytes, err := readFrame(conn)
	if err != nil {
		t.Fatal(err)
	}
	// *** STOP ON A REFUSAL, as a real consumer does. *** quic.go's client
	// errors out at exactly this point rather than issuing the call. This helper
	// used to plough on and write the request regardless, which was harmless
	// while nothing could refuse - and the moment Serve gained a version gate it
	// turned a correct refusal into `write: broken pipe` from the TEST, blaming
	// the server for closing a connection it had just correctly declined.
	if acceptByte[0] != 1 {
		return false, string(servedBytes), nil, 0
	}
	if err := writeFrame(conn, request); err != nil {
		t.Fatal(err)
	}
	tagByte := make([]byte, 1)
	if _, err := io.ReadFull(conn, tagByte); err != nil {
		t.Fatal(err)
	}
	var resp []byte
	if tagByte[0] == tagOK {
		resp, err = readFrame(conn)
		if err != nil {
			t.Fatal(err)
		}
	}
	return acceptByte[0] == 1, string(servedBytes), resp, tagByte[0]
}

func TestServeEchoRoundTrip(t *testing.T) {
	sockPath := t.TempDir() + "/s.sock"
	addr := "unix:" + sockPath

	errCh := make(chan error, 1)
	go func() {
		errCh <- Serve(addr, "0.1.0", func(_ Caller, request []byte) ([]byte, error) {
			return request, nil // echo
		})
	}()

	// Serve's Listen happens synchronously before Accept blocks, but there is
	// still a race between this goroutine starting and the listener existing -
	// retry the dial briefly rather than a fixed sleep.
	var conn net.Conn
	var err error
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn, err = net.Dial("unix", sockPath)
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer conn.Close()

	accept, served, response, tag := clientHandshakeAndCall(t, conn, []byte("hello from the test client"))
	if !accept {
		t.Fatal("handshake was not accepted")
	}
	if served != "0.1.0" {
		t.Errorf("served version = %q, want %q", served, "0.1.0")
	}
	if tag != tagOK {
		t.Fatalf("result tag = %d, want tagOK", tag)
	}
	if string(response) != "hello from the test client" {
		t.Errorf("response = %q, want echo of the request", response)
	}
}

func TestServeErrorTags(t *testing.T) {
	sockPath := t.TempDir() + "/s.sock"
	addr := "unix:" + sockPath

	go func() {
		_ = Serve(addr, "0.1.0", func(_ Caller, request []byte) ([]byte, error) {
			switch string(request) {
			case "reject":
				return nil, ErrRejected
			case "toolarge":
				return nil, ErrTooLarge
			default:
				return nil, io.EOF // an arbitrary, un-sentinel'd error -> Unavailable
			}
		})
	}()

	dial := func() net.Conn {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			conn, err := net.Dial("unix", sockPath)
			if err == nil {
				return conn
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("dial %s: timed out", addr)
		return nil
	}

	cases := []struct {
		request []byte
		wantTag byte
	}{
		{[]byte("reject"), tagRejected},
		{[]byte("toolarge"), tagTooLarge},
		{[]byte("anything-else"), tagUnavailable},
	}
	for _, tc := range cases {
		conn := dial()
		_, _, _, tag := clientHandshakeAndCall(t, conn, tc.request)
		conn.Close()
		if tag != tc.wantTag {
			t.Errorf("request %q: tag = %d, want %d", tc.request, tag, tc.wantTag)
		}
	}
}

func TestFrameLengthPrefixIsLittleEndian(t *testing.T) {
	var buf bytes.Buffer
	if err := writeFrame(&buf, []byte("ab")); err != nil {
		t.Fatal(err)
	}
	got := buf.Bytes()[:4]
	want := []byte{2, 0, 0, 0}
	if !bytes.Equal(got, want) {
		t.Errorf("length prefix = %v, want %v (little-endian u32)", got, want)
	}
	if binary.LittleEndian.Uint32(got) != 2 {
		t.Errorf("decoded length = %d, want 2", binary.LittleEndian.Uint32(got))
	}
}

// TestVersionCompatible_MirrorsTrailExactly.
//
// *** THE TABLE IS LIFTED FROM trail's plug negotiation's version_compatible, AND
// THE 0.x ROWS ARE THE WHOLE POINT. *** A plain "served >= required" would pass
// every 1.x row here and get all four 0.x rows wrong - and 0.x is what the seam
// actually ships (periapsis:magic/handler@0.1.0). A divergence means one end
// binds a plug the other would have refused.
func TestVersionCompatible_MirrorsTrailExactly(t *testing.T) {
	for _, tc := range []struct {
		required, served string
		want             bool
		why              string
	}{
		{"1.2.3", "1.2.3", true, "identical"},
		{"1.2.3", "1.3.0", true, "higher minor satisfies 1.x"},
		{"1.2.3", "1.2.4", true, "higher patch satisfies"},
		{"1.2.3", "1.2.2", false, "lower patch does not"},
		{"1.2.3", "1.1.9", false, "lower minor does not"},
		{"1.2.3", "2.2.3", false, "major mismatch is never compatible"},
		{"2.0.0", "1.9.9", false, "major mismatch, the other way"},

		// 0.y.z: the minor is the breaking axis, so it must be EQUAL.
		{"0.1.0", "0.1.0", true, "identical 0.x"},
		{"0.1.0", "0.1.5", true, "0.x higher patch satisfies"},
		{"0.1.5", "0.1.0", false, "0.x lower patch does not"},
		{"0.1.0", "0.2.0", false, "*** 0.x HIGHER MINOR IS BREAKING, NOT SATISFYING ***"},
		{"0.2.0", "0.1.0", false, "0.x lower minor does not"},

		// 0.0.z: every patch is its own API.
		{"0.0.1", "0.0.1", true, "identical 0.0.z"},
		{"0.0.1", "0.0.2", false, "*** 0.0.z HIGHER PATCH IS BREAKING ***"},
		{"0.0.2", "0.0.1", false, "0.0.z lower patch"},

		// Unparseable accepts, matching trail's "serving unversioned".
		{"", "0.1.0", true, "no required version cannot gate"},
		{"0.1.0", "", true, "no served version cannot gate"},
		{"garbage", "0.1.0", true, "unparseable required"},
		{"0.1", "0.1.0", true, "two components is not X.Y.Z"},

		// Suffixes are ignored, so a pre-release build is not refused for its tag.
		{"0.1.0", "0.1.0-rc1", true, "pre-release suffix ignored"},
		{"0.1.0", "0.1.0+build7", true, "build suffix ignored"},
	} {
		t.Run(tc.required+"_vs_"+tc.served, func(t *testing.T) {
			if got := versionCompatible(tc.required, tc.served); got != tc.want {
				t.Errorf("versionCompatible(%q, %q) = %v, want %v - %s",
					tc.required, tc.served, got, tc.want, tc.why)
			}
		})
	}
}

// TestServe_RefusesAnIncompatibleConsumer is the arm that matters: the table
// above proves the RULE, this proves the rule is CONSULTED on the wire.
//
// Before this, serveConn read the required version and threw it away, so an
// incompatible consumer was accepted and served - the gate trail used to apply
// had been deleted with the transport and nothing replaced it.
func TestServe_RefusesAnIncompatibleConsumer(t *testing.T) {
	dir := t.TempDir()
	sockPath := dir + "/refuse.sock"
	addr := "unix:" + sockPath

	errCh := make(chan error, 1)
	go func() {
		// *** THE PROVIDER SERVES 0.2.0; clientHandshakeAndCall HARDCODES A
		// REQUIRED 0.1.0. *** The gap is deliberately on the 0.x MINOR, which is
		// the breaking axis - 0.1.0 and 0.2.0 are different APIs, so a provider
		// serving 0.2.0 must refuse a consumer that needs 0.1.0.
		//
		// The version gap is put on the PROVIDER because the shared helper's
		// required version is fixed. This test first tried to say "require
		// 0.2.0" and failed - not because the gate was broken but because the
		// helper had gone on sending 0.1.0, so the arms were compatible and the
		// failure message blamed the code for the test's own mistake.
		errCh <- Serve(addr, "0.2.0", func(_ Caller, request []byte) ([]byte, error) {
			return request, nil
		})
	}()
	// Same dial-retry as the other Serve tests: Listen happens before Accept
	// blocks, but the goroutine may not have run yet.
	var conn net.Conn
	var err error
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn, err = net.Dial("unix", sockPath)
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer conn.Close()

	accept, served, _, _ := clientHandshakeAndCall(t, conn, []byte("hello"))
	if accept {
		t.Error("a consumer requiring 0.1.0 was ACCEPTED by a provider serving 0.2.0. " +
			"The 0.x minor is the breaking axis, and nothing on this path gates it " +
			"any more - trail's --plug-remote-simple gate went with ADR-0044.")
	}
	// The served version must STILL arrive on a refusal, so the consumer's error
	// can name what it asked for AND what it was offered. A bare "rejected" sends
	// an operator to read both manifests.
	if served != "0.2.0" {
		t.Errorf("served version on a REFUSAL = %q, want %q - a refusal that does not "+
			"say what is on offer is much harder to act on", served, "0.2.0")
	}
}
