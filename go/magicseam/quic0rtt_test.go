// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"bytes"
	"testing"
	"time"
)

// waitForSessionTicket blocks until the provider's ticket is actually IN the
// cache.
//
// The ticket arrives asynchronously, AFTER the handshake - so closing the
// warm-up connection straight away can beat it, and the next dial then finds an
// empty cache and cannot resume. That failure looks exactly like "0-RTT is
// broken" while being pure test timing, so this waits on the thing itself
// rather than sleeping and hoping.
func waitForSessionTicket(t *testing.T, addr string) {
	t.Helper()
	hostPort, err := parseQUICAddr(addr)
	if err != nil {
		t.Fatalf("parsing %s: %v", addr, err)
	}
	cache := sessionCacheFor(hostPort)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, ok := cache.Get(TrailQUICSNI); ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("provider at %s never issued a session ticket - without one there is "+
				"nothing to resume from and 0-RTT cannot happen at all", addr)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// dialEarlyWhenUp is dialQUICWhenUp's 0-RTT sibling: retry until the provider
// accepts, then return an early-dialled client.
func dialEarlyWhenUp(t *testing.T, addr, cert, key, ca string) *QUICClient {
	t.Helper()
	// One ordinary dial first proves the provider is actually up, so a failure
	// below is about resumption rather than about racing the listener.
	warm := dialQUICWhenUp(t, addr, cert, key, ca)
	waitForSessionTicket(t, addr)
	if err := warm.Close(); err != nil {
		t.Fatalf("closing the warm-up connection: %v", err)
	}
	client, err := DialQUICEarly(t.Context(), addr, cert, key, ca, "0.1.0")
	if err != nil {
		t.Fatalf("early dial: %v", err)
	}

	return client
}

// A COLD CACHE MUST NOT CLAIM 0-RTT - the positive control.
//
// Without this, TestASecondDialResumesWith0RTT proves nothing: an implementation
// where Used0RTT always returned true would pass it. This is the run that has to
// come back FALSE for the true one to mean anything.
func TestAColdCacheDoesNotUse0RTT(t *testing.T) {
	ca := generateTestCA(t)
	pc, pk, pca := writeTestLeaf(t, ca, t.TempDir())
	cc, ck, cca := writeTestLeaf(t, ca, t.TempDir())

	addr := serveQUICEcho(t, pc, pk, pca)
	// A provider nothing in this process has ever dialled, so no ticket exists.
	client := dialQUICWhenUp(t, addr, cc, ck, cca)
	defer client.Close()

	if client.Used0RTT() {
		t.Error("a FIRST dial reported 0-RTT - there was no cached ticket to resume from, so " +
			"either the report is meaningless or resumption is happening from somewhere unexpected")
	}
}

// THE ACTUAL WIN: a second dial to the same provider resumes, carrying the seam
// handshake in the first flight instead of after a completed TLS handshake.
func TestASecondDialResumesWith0RTT(t *testing.T) {
	ca := generateTestCA(t)
	pc, pk, pca := writeTestLeaf(t, ca, t.TempDir())
	cc, ck, cca := writeTestLeaf(t, ca, t.TempDir())

	addr := serveQUICEcho(t, pc, pk, pca)
	client := dialEarlyWhenUp(t, addr, cc, ck, cca)
	defer client.Close()

	if !client.Used0RTT() {
		t.Fatal("a second dial to the same provider did NOT resume with 0-RTT - the ticket was " +
			"either never cached or never offered, and every dial keeps paying two round trips")
	}
	// Resumed connections must still actually work, which is a separate claim
	// from "it resumed" - a 0-RTT connection that cannot carry a call is worse
	// than no 0-RTT at all.
	reply, err := client.Call(t.Context(), []byte("resumed"))
	if err != nil {
		t.Fatalf("call over a resumed connection: %v", err)
	}
	if !bytes.Equal(reply, []byte("resumed")) {
		t.Errorf("resumed call returned %q, want the echo back", reply)
	}
}

// EACH PROVIDER NEEDS ITS OWN CACHE. crypto/tls keys the session cache by
// ServerName, and every seam connection uses the SAME fixed SNI - so one shared
// cache gives every provider one key, and they evict each other.
//
// The failure is invisible: offering provider A's ticket to provider B just
// fails to decrypt and falls back to a full handshake. Nothing errors, resumption
// simply stops happening for anyone talking to more than one provider. Only a
// test that dials A, then B, then A again can see it.
func TestEachProviderKeepsItsOwnSessionTicket(t *testing.T) {
	ca := generateTestCA(t)
	pcA, pkA, pcaA := writeTestLeaf(t, ca, t.TempDir())
	pcB, pkB, pcaB := writeTestLeaf(t, ca, t.TempDir())
	cc, ck, cca := writeTestLeaf(t, ca, t.TempDir())

	addrA := serveQUICEcho(t, pcA, pkA, pcaA)
	addrB := serveQUICEcho(t, pcB, pkB, pcaB)

	// Prime A, then dial B in between - with a single shared cache, B's ticket
	// lands on the same key and displaces A's.
	first := dialQUICWhenUp(t, addrA, cc, ck, cca)
	waitForSessionTicket(t, addrA)
	_ = first.Close()
	primeB := dialQUICWhenUp(t, addrB, cc, ck, cca)
	waitForSessionTicket(t, addrB)
	_ = primeB.Close()
	againB, err := DialQUICEarly(t.Context(), addrB, cc, ck, cca, "0.1.0")
	if err != nil {
		t.Fatalf("second dial to B: %v", err)
	}
	_ = againB.Close()

	// A must STILL be able to resume, despite B having been dialled since.
	againA, err := DialQUICEarly(t.Context(), addrA, cc, ck, cca, "0.1.0")
	if err != nil {
		t.Fatalf("second dial to A: %v", err)
	}
	defer againA.Close()

	if !againA.Used0RTT() {
		t.Error("provider A could not resume after provider B was dialled - their tickets share " +
			"a cache key (the fixed SNI), so they evict each other and resumption silently stops " +
			"working for any consumer with more than one provider")
	}
}
