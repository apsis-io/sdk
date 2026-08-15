// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import "testing"

// Paired with cmd/trail/src/statusframe.rs's tests on purpose: the two sides
// are separate implementations of one wire format, so the tests are what keeps
// them from drifting. Any case added here should be added there.

func TestComponentStatusRoundTrips(t *testing.T) {
	for _, c := range []ComponentStatus{
		{State: StateReady},
		{State: StateDegraded, Reason: "upstream pool exhausted"},
		{State: StateFailed, Reason: "lost db, cache, and queue"}, // commas must survive
	} {
		got, ok := DecodeComponentStatus(c.Encode())
		if !ok {
			t.Fatalf("%+v did not decode", c)
		}
		if got != c {
			t.Errorf("round trip changed it: got %+v, want %+v", got, c)
		}
	}
}

// Silence is "no opinion", never unhealthy. A provider sending nothing predates
// the frame or exports no status; marking those down would be an outage.
func TestEmptyFrameIsNoOpinion(t *testing.T) {
	for _, frame := range [][]byte{nil, []byte(""), []byte("   "), []byte("\t")} {
		if _, ok := DecodeComponentStatus(frame); ok {
			t.Errorf("frame %q decoded to an opinion", frame)
		}
	}
}

// An unknown state is also no opinion - otherwise adding a state later becomes a
// breaking change, which is what the frame format exists to avoid.
func TestUnknownStateIsNoOpinion(t *testing.T) {
	for _, frame := range []string{"quiescing", "quiescing\twhy", "READY"} {
		if _, ok := DecodeComponentStatus([]byte(frame)); ok {
			t.Errorf("%q decoded to an opinion", frame)
		}
	}
}

// Only ready is healthy. `starting` must not be: treating "not yet" as "yes"
// routes traffic at something that is not listening.
func TestOnlyReadyIsHealthy(t *testing.T) {
	if !StateReady.Healthy() {
		t.Error("ready must be healthy")
	}
	for _, s := range []ComponentState{StateStarting, StateDegraded, StateFailed, StateStopping} {
		if s.Healthy() {
			t.Errorf("%s must not read as healthy", s)
		}
	}
	// The zero value is what a caller sees if it ignores HasStatus - it must not
	// look healthy.
	var zero ComponentState
	if zero.Healthy() {
		t.Error("the zero state must not read as healthy - a caller ignoring HasStatus would pass everything")
	}
}
