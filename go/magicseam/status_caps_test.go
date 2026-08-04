// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import "testing"

// Adding a second capability must not break the first. The frame is now a list,
// and streaming negotiation has to keep working against a peer that sends both.
func TestStreamAndStatusCoexistInOneFrame(t *testing.T) {
	caps := parseCaps([]byte(capsOffered()))

	if !streamsAgreed(caps) {
		t.Error("advertising status broke stream negotiation - the two must coexist")
	}
	if !StatusServed(caps) {
		t.Error("status is not advertised by capsOffered")
	}
}

// The pre-status provider: advertises only streaming. A consumer must read that
// as "no status" rather than assuming, which is the whole reason to advertise.
func TestAnOlderPeerAdvertisesStreamButNotStatus(t *testing.T) {
	old := parseCaps([]byte(CapStream))

	if StatusServed(old) {
		t.Error("a stream-only peer must not read as serving status")
	}
	if !streamsAgreed(old) {
		t.Error("a stream-only peer must still negotiate streaming")
	}
}

// Never assume-yes on silence, matching the streaming rule.
func TestAbsentCapsMeansNoStatus(t *testing.T) {
	for _, frame := range [][]byte{nil, []byte(""), []byte("   "), []byte("stream,")} {
		if StatusServed(parseCaps(frame)) {
			t.Errorf("frame %q must not read as serving status", frame)
		}
	}
}
