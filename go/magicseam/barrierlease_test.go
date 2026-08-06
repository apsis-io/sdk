// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"testing"
	"time"
)

// THE OUTAGE, reproduced. A consumer that dies mid-barrier can never send the
// Resume - it travels on that consumer's own connection and there is no other
// party that knows the barrier exists. Without a lease the provider refuses
// every caller, from every consumer, forever.
//
// Live on 2026-08-06: exactly this, cleared only by a manual restart. perigeos
// self-heals without manual actions, so a lease is not a nicety here.
func TestAnAbandonedArmReleasesItself(t *testing.T) {
	b := Barrier{Lease: 30 * time.Millisecond}
	if err := b.Arm(time.Second); err != nil {
		t.Fatalf("arming an idle barrier failed: %v", err)
	}
	if !b.Armed() {
		t.Fatal("setup: the barrier did not arm")
	}

	time.Sleep(60 * time.Millisecond) // no Resume ever comes

	if b.Armed() {
		t.Error("an arm outlived its lease with no Resume - the provider refuses every caller " +
			"from every consumer indefinitely, and only a restart clears it")
	}
}

// ...and an arm INSIDE its lease must be untouched. Releasing a live barrier
// early is the torn cut the whole protocol exists to prevent, so the lease must
// err on the side of staying armed.
func TestAnArmInsideItsLeaseIsNotReleased(t *testing.T) {
	b := Barrier{Lease: time.Minute}
	_ = b.Arm(time.Second)

	time.Sleep(20 * time.Millisecond)

	if !b.Armed() {
		t.Error("a barrier armed 20ms ago under a 1m lease was released - the coordinator would " +
			"snapshot a provider that had gone back to serving")
	}
}

// A RE-ARM RESETS THE LEASE. A coordinator that re-arms is a coordinator that is
// still alive, and the lease exists only to catch one that is not - so a long
// but actively-maintained barrier must not be cut off.
func TestReArmingRefreshesTheLease(t *testing.T) {
	b := Barrier{Lease: 60 * time.Millisecond}
	_ = b.Arm(time.Second)

	for range 4 {
		time.Sleep(25 * time.Millisecond)
		_ = b.Arm(time.Second)
	}

	if !b.Armed() {
		t.Error("a barrier re-armed every 25ms under a 60ms lease expired anyway - a live " +
			"coordinator holding a long barrier would be cut off mid-snapshot")
	}
}

// Resume must clear the arm instant, or the NEXT arm inherits the previous one's
// age and can expire immediately.
func TestResumeClearsTheArmInstant(t *testing.T) {
	b := Barrier{Lease: 40 * time.Millisecond}
	_ = b.Arm(time.Second)
	time.Sleep(50 * time.Millisecond)
	b.Resume()

	if got := b.ArmedFor(); got != 0 {
		t.Fatalf("ArmedFor after Resume = %s, want 0", got)
	}
	_ = b.Arm(time.Second)
	if !b.Armed() {
		t.Error("a freshly armed barrier was already expired - it inherited the previous arm's " +
			"age, so every barrier after the first is released the instant it is taken")
	}
}

// ArmedFor must NOT run the lease release. It is readiness's independent reader:
// if the lease silently fails to fire, this is what still shows an ancient arm.
// Routing it through Armed() would make the lease its own alibi.
func TestArmedForDoesNotReleaseTheArm(t *testing.T) {
	b := Barrier{Lease: 20 * time.Millisecond}
	_ = b.Arm(time.Second)
	time.Sleep(40 * time.Millisecond)

	if got := b.ArmedFor(); got < 40*time.Millisecond {
		t.Errorf("ArmedFor = %s, want >= 40ms - it reported a fresh arm (or none) for one that "+
			"has been held past its lease, which is exactly the state readiness must be able to "+
			"see independently of the lease working", got)
	}
}

// The zero Barrier must get the default lease rather than an instant expiry -
// every provider on plain ServeQUICWithBarrier uses the zero value.
func TestTheZeroBarrierGetsTheDefaultLease(t *testing.T) {
	var b Barrier
	if got := b.LeaseTimeout(); got != DefaultLeaseTimeout {
		t.Errorf("zero Barrier lease = %s, want %s", got, DefaultLeaseTimeout)
	}
	_ = b.Arm(time.Second)
	if !b.Armed() {
		t.Error("a zero-value Barrier expired the instant it was armed - a lease of 0 read as " +
			"'already expired' rather than 'unset'")
	}
}
