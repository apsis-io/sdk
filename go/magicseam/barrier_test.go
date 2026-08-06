// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// THE CONTRACT: the ack means "my channel is EMPTY", not "I received your
// marker". Arm must not return while a call is still running, because the
// coordinator treats the ack as permission to snapshot - and a snapshot taken
// with a call in flight is a torn cut, produced silently.
func TestArmDoesNotReturnWhileACallIsInFlight(t *testing.T) {
	var b Barrier
	done := b.Enter()

	errCh := make(chan error, 1)
	go func() { errCh <- b.Arm(50 * time.Millisecond) }()

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("Arm returned SUCCESS with a call still in flight - the coordinator would " +
				"snapshot a channel that still has work in it and record nothing amiss")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Arm neither drained nor timed out - a stuck call must fail the marker, not hang " +
			"the whole barrier")
	}
	done()
}

// ...and it must return promptly once the channel really is empty.
func TestArmReturnsOnceTheChannelDrains(t *testing.T) {
	var b Barrier
	done := b.Enter()
	go func() {
		time.Sleep(20 * time.Millisecond)
		done()
	}()

	if err := b.Arm(2 * time.Second); err != nil {
		t.Fatalf("Arm failed on a channel that drained: %v", err)
	}
	if !b.Armed() {
		t.Error("Arm returned but the provider is not armed - it would keep admitting calls after " +
			"telling the coordinator it had stopped")
	}
}

// A provider that cannot drain must FAIL, and the error has to say why: the
// coordinator's response (abort and resume the graph) differs from its response
// to a lost peer.
func TestArmTimesOutWithAnExplanation(t *testing.T) {
	var b Barrier
	defer b.Enter()() // held for the whole test

	err := b.Arm(30 * time.Millisecond)
	if err == nil {
		t.Fatal("Arm succeeded with a call pinned in flight")
	}
	if !errors.Is(err, ErrDrainTimeout) {
		t.Errorf("want ErrDrainTimeout so a coordinator can tell a busy peer from a lost one, got %v", err)
	}
	if !strings.Contains(err.Error(), "torn cut") {
		t.Errorf("the error must say what it protects against, not just that it timed out: %v", err)
	}
}

// A FAILED drain must leave the barrier ARMED. Un-arming would silently resume a
// provider the coordinator still believes it is negotiating with - it never got
// an ack, so it will send a Resume on its abort path.
func TestAFailedDrainLeavesTheBarrierArmed(t *testing.T) {
	var b Barrier
	defer b.Enter()()

	_ = b.Arm(20 * time.Millisecond)
	if !b.Armed() {
		t.Error("a failed drain un-armed the provider - it resumes serving while the coordinator " +
			"still thinks the barrier is in progress")
	}
}

// Resume must never wait to drain. The abort path exists precisely for a
// provider that is busy, so a Resume that blocked on the busy-ness would be
// unable to release the one case it is for.
func TestResumeNeverWaitsToDrain(t *testing.T) {
	var b Barrier
	defer b.Enter()()
	_ = b.Arm(10 * time.Millisecond)

	start := time.Now()
	b.Resume()
	if elapsed := time.Since(start); elapsed > 5*time.Millisecond {
		t.Errorf("Resume took %s - it must not wait for in-flight calls", elapsed)
	}
	if b.Armed() {
		t.Error("Resume did not release the barrier")
	}
}

// The zero value must be usable: a provider that never opts in still has to
// behave, because serveQUICMarker answers markers regardless.
func TestZeroBarrierIsUsable(t *testing.T) {
	var b Barrier
	if b.Armed() || b.InFlight() != 0 {
		t.Fatal("the zero Barrier is not the neutral state")
	}
	if err := b.Arm(time.Second); err != nil {
		t.Errorf("arming an idle barrier failed: %v", err)
	}
}

// CAP_BARRIER must be advertised, or a coordinator reads this SDK's providers as
// unquiesciable and refuses to start a barrier it could actually run.
func TestBarrierCapabilityIsAdvertised(t *testing.T) {
	if !strings.Contains(capsOffered(true), CapBarrier) {
		t.Errorf("capsOffered(true)=%q does not advertise %q - a provider that HAS a barrier would "+
			"be treated as unable to join a coordinated checkpoint", capsOffered(true), CapBarrier)
	}
}

// THE DANGEROUS DIRECTION, and the one the first version got wrong.
//
// A provider with NO barrier must NOT advertise the capability. It acks a marker
// immediately - no drain, no refusal - so a consumer that believed the
// advertisement would read that ack as "my channel is empty", snapshot, and take
// a torn cut from a provider that never stopped serving.
//
// It also defeats the guard meant to catch it: markerprop fails a barrier when a
// peer does not advertise the capability, which is precisely the case being
// misreported. Advertising something you do not implement is worse than not
// implementing it - the second fails closed, the first fails silently.
func TestNoBarrierMeansNoCapability(t *testing.T) {
	if strings.Contains(capsOffered(false), CapBarrier) {
		t.Errorf("capsOffered(false)=%q advertises %q with no barrier to honour it - every "+
			"provider on plain ServeQUIC would claim to be quiescible while acking without "+
			"draining, which is a torn cut the coordinator cannot detect",
			capsOffered(false), CapBarrier)
	}
}
