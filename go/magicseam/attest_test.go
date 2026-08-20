// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"errors"
	"strings"
	"testing"
)

const claimedIP = "10.0.51.33"

func claimant() PodIdentity {
	return PodIdentity{Namespace: "team-a", Name: "consumer", PodIP: claimedIP}
}

// THE IMPERSONATION THIS CLOSES, at the primitive rather than through a provider.
//
// Every field the wire frame carries can be correct - namespace, pod name, UID -
// because an attacker reads them from the cluster and none of them is a secret.
// Only the address the packets actually came from betrays it.
func TestAttestPeer_ImpersonationIsRefusedAndNamesBothAddresses(t *testing.T) {
	err := AttestPeer(claimant(), Caller{
		Namespace: "team-a", PodName: "consumer", PodUID: "uid",
		PeerAddr: "10.0.99.99:41000",
	})
	if err == nil {
		t.Fatal("a caller impersonating another pod was ACCEPTED")
	}
	// BOTH addresses, because the failure mode of this control is a LEGITIMATE
	// caller refused after a routing change, and that has to be diagnosable from
	// the message alone rather than by reading this file.
	if !strings.Contains(err.Error(), claimedIP) || !strings.Contains(err.Error(), "10.0.99.99") {
		t.Errorf("refusal names only one side: %v", err)
	}
	if !errors.Is(err, ErrRejected) {
		t.Errorf("refusal should be ErrRejected - the peer asked something false: %v", err)
	}
}

// FAIL CLOSED, AND THE REASON IS ASSERTED RATHER THAN THE REFUSAL.
//
// An empty address is ALSO caught incidentally by the address parser, so a test
// that only checked "it was refused" stays green if the fail-closed branch is
// deleted. That distinction is the point: "could not check" must be its own
// decision, not a side effect of a parse failure somebody later makes tolerant.
func TestAttestPeer_UnobservedAddressFailsClosedForItsOwnReason(t *testing.T) {
	err := AttestPeer(claimant(), Caller{Namespace: "team-a", PodName: "consumer"})
	if err == nil {
		t.Fatal("a caller with no observed peer address was ACCEPTED")
	}
	if !strings.Contains(err.Error(), "no observed peer address") {
		t.Errorf("refusal did not come from the fail-closed branch: %v", err)
	}
}

// A pod with no podIP assigned yet cannot be attested - there is nothing to
// compare against, and guessing defeats the point.
func TestAttestPeer_ClaimantWithoutAPodIPIsRefused(t *testing.T) {
	id := claimant()
	id.PodIP = ""
	err := AttestPeer(id, Caller{PeerAddr: "10.0.51.33:1"})
	if err == nil {
		t.Fatal("a claimant with no podIP was ACCEPTED")
	}
	if !strings.Contains(err.Error(), "cannot be attested") {
		t.Errorf("refusal did not name the unattestable claim: %v", err)
	}
}

// EQUIVALENT SPELLINGS ARE NOT IMPERSONATION, and this is the false-positive
// direction - the one that matters most here, because its symptom in the logs is
// indistinguishable from an attack.
func TestAttestPeer_EquivalentAddressSpellingsAreAccepted(t *testing.T) {
	for _, peer := range []string{"10.0.51.33:1", "[::ffff:10.0.51.33]:1"} {
		if err := AttestPeer(claimant(), Caller{PeerAddr: peer}); err != nil {
			t.Errorf("AttestPeer(%q) refused an equivalent spelling: %v", peer, err)
		}
	}
}

// A STRING COMPARE WOULD PASS EVERY TEST ABOVE EXCEPT THIS ONE. Pinning it so
// sameIP cannot be "simplified" back into ==.
func TestAttestPeer_ComparesAsIPsNotStrings(t *testing.T) {
	if !sameIP("10.0.51.33", "::ffff:10.0.51.33") {
		t.Error("sameIP compared as strings - an IPv4-mapped peer reads as impersonation")
	}
	if sameIP("10.0.51.33", "10.0.51.3") {
		t.Error("sameIP accepted a DIFFERENT address - a prefix must not attest")
	}
	// Garbage must not attest. ParseIP returns nil for both, and returning
	// "equal because both unparseable" would accept anything.
	if sameIP("not-an-ip", "not-an-ip") {
		t.Error("two unparseable addresses attested each other")
	}
}

func TestAttestPeer_UnparseablePeerAddrIsRefused(t *testing.T) {
	if err := AttestPeer(claimant(), Caller{PeerAddr: "garbage"}); err == nil {
		t.Fatal("an unparseable peer address was ACCEPTED")
	}
}

// The accept path, so the refusals above are not all passing because the
// function refuses everything.
func TestAttestPeer_MatchingAddressIsAttested(t *testing.T) {
	if err := AttestPeer(claimant(), Caller{
		Namespace: "team-a", PodName: "consumer", PodUID: "uid",
		PeerAddr: claimedIP + ":49152",
	}); err != nil {
		t.Fatalf("a legitimate caller was refused: %v", err)
	}
}
