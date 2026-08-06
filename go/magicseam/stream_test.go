// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"testing"
)

// The compatibility property this whole mechanism exists for: a consumer that
// sends no capability frame must land on "classic only", never on "assume yes".
// Guessing yes would make this provider expect an opcode the consumer never
// writes, misframing every call on the connection.
func TestAbsentOrEmptyCapsMeansNoStreaming(t *testing.T) {
	if streamsAgreed(nil) {
		t.Error("no caps frame at all must not negotiate streaming")
	}
	if streamsAgreed(parseCaps(nil)) {
		t.Error("an absent frame must not negotiate streaming")
	}
	if streamsAgreed(parseCaps([]byte(""))) {
		t.Error("an empty frame must not negotiate streaming")
	}
}

func TestStreamingNegotiatesWhenAdvertised(t *testing.T) {
	if !streamsAgreed(parseCaps([]byte(CapStream))) {
		t.Error("a peer advertising stream must negotiate it")
	}
}

// A newer peer advertising tokens this build has never heard of must still
// negotiate the ones it does - otherwise adding a capability later becomes a
// breaking change, which is exactly what negotiation is here to prevent.
func TestUnknownTokensDoNotBreakAKnownOne(t *testing.T) {
	if !streamsAgreed(parseCaps([]byte("stream,quantum-teleport,zip"))) {
		t.Error("unknown tokens must not mask a known one")
	}
	if streamsAgreed(parseCaps([]byte("quantum-teleport"))) {
		t.Error("unknown tokens alone must not negotiate streaming")
	}
}

func TestCapsParsingTolerateStraySeparators(t *testing.T) {
	caps := parseCaps([]byte(" stream , , "))
	if len(caps) != 1 || caps[0] != CapStream {
		t.Errorf("parseCaps = %v, want exactly [%s] - empty tokens must be dropped", caps, CapStream)
	}
}

// This SDK must advertise what it can actually serve. Advertising nothing
// would silently leave every Go provider classic-only; advertising something
// it cannot serve would misframe calls.
func TestThisSDKAdvertisesTheBulkSeam(t *testing.T) {
	if !streamsAgreed(parseCaps([]byte(capsOffered(true)))) {
		t.Errorf("capsOffered(true) = %q, which does not advertise %q", capsOffered(true), CapStream)
	}
}

// The opcodes must differ, or every streaming call routes into the classic
// handler and vice versa.
func TestOpcodesAreDistinct(t *testing.T) {
	if opCall == opStream {
		t.Fatal("opCall and opStream must differ")
	}
}
