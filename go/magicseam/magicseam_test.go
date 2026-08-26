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
// IT CITED. *** This read "mirroring cmd/trail/src/remote_simple.rs's Client
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
