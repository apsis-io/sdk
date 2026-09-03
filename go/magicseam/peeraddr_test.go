// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"net"
	"strings"
	"testing"
	"time"
)

// Caller.PeerAddr exists to be trusted MORE than the asserted fields, so the
// two properties that make that safe are the ones worth testing: the wire
// cannot set it, and a real connection does.

// The security property. A peer controls every byte of the caller frame, so if
// any frame shape could populate PeerAddr the whole distinction collapses and a
// provider comparing it against a podIP would be checking the attacker's own
// claim.
func TestPeerAddrCannotBeInjectedFromTheWire(t *testing.T) {
	frames := [][]byte{
		[]byte("ns\tpod\tuid\tcomp\t192.0.2.1:1234"),          // a 5th field
		[]byte("ns\tpod\tuid\tcomp\t\t\t192.0.2.1:1234"),      // padded further
		[]byte("192.0.2.1:1234\tpod\tuid\tcomp"),              // first field
		[]byte("ns\tpod\tuid\tcomp"),                          // exact arity
		[]byte(""),                                            // empty
		[]byte("ns\tpod\tuid\tcomp\nPeerAddr=192.0.2.1:1234"), // newline smuggling
	}
	for _, f := range frames {
		if got := decodeCaller(f); got.PeerAddr != "" {
			t.Errorf("decodeCaller(%q) set PeerAddr=%q - the wire must never populate it", f, got.PeerAddr)
		}
	}
}

// encodeCaller must not emit it either: a Go CONSUMER that sets PeerAddr on its
// own Caller (harmlessly, by mistake) must not have that value travel and be
// mistaken for an observation on the far side.
func TestPeerAddrIsNotSentOnTheWire(t *testing.T) {
	c := Caller{Namespace: "ns", PodName: "pod", PodUID: "uid", Component: "comp", PeerAddr: "192.0.2.1:1234"}
	if wire := string(encodeCaller(c)); strings.Contains(wire, "192.0.2.1") {
		t.Fatalf("encodeCaller emitted PeerAddr: %q", wire)
	}
	// ...and the round trip drops it, rather than shifting the other fields.
	back := decodeCaller(encodeCaller(c))
	if back.PeerAddr != "" {
		t.Errorf("round trip carried PeerAddr=%q", back.PeerAddr)
	}
	if back.Namespace != "ns" || back.PodName != "pod" || back.PodUID != "uid" || back.Component != "comp" {
		t.Errorf("round trip corrupted the asserted fields: %+v", back)
	}
}

// The liveness property: a real handshake must actually populate it, or a
// provider that fails closed on an empty PeerAddr would refuse every call.
// Asserts it matches the CLIENT's own local address, not merely that it is
// non-empty - "127.0.0.1:0" would pass a non-empty check and be useless.
func TestPeerAddrIsPopulatedByARealConnection(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())
	ctx := t.Context()

	// EPHEMERAL, NOT 19741 — which opcodegate_test.go also used, so two files in
	// one package shared a port. See converse_test.go's `freeAddr`.
	addr := "tcp:" + freeAddr(t)
	seen := make(chan string, 1)
	go func() {
		_ = ServeQUIC(ctx, addr, providerCert, providerKey, providerCA, "0.1.0",
			func(c Caller, _ []byte) ([]byte, error) {
				select {
				case seen <- c.PeerAddr:
				default:
				}
				return []byte("ok"), nil
			})
	}()
	time.Sleep(200 * time.Millisecond)

	client, err := DialQUIC(ctx, addr, consumerCert, consumerKey, consumerCA, "0.1.0")
	if err != nil {
		t.Fatalf("DialQUIC: %v", err)
	}
	defer client.Close()
	if _, err := client.Call(ctx, []byte("x")); err != nil {
		t.Fatalf("Call: %v", err)
	}

	var got string
	select {
	case got = <-seen:
	case <-time.After(3 * time.Second):
		t.Fatal("handler never ran")
	}
	host, port, err := net.SplitHostPort(got)
	if err != nil {
		t.Fatalf("PeerAddr %q is not host:port: %v", got, err)
	}
	if host != "127.0.0.1" {
		t.Errorf("PeerAddr host = %q, want the dialing side's address 127.0.0.1", host)
	}
	if port == "" || port == "0" {
		t.Errorf("PeerAddr port = %q, want the client's real source port", port)
	}
}
