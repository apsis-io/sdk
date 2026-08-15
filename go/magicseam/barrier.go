// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"errors"
	"fmt"
	"sync/atomic"
	"time"
)

// COORDINATED-CHECKPOINT MARKERS FOR A NON-NATIVE PROVIDER (ADR-0032).
//
// # Why a provider written in Go needs this at all
//
// Before markers, a provider could be quiesced only by ITS OWN trail process
// receiving SIGUSR1. A provider built on this SDK has no trail: it is an
// ordinary Go program with no signal handler and no barrier state, so nothing
// could arm it. A coordinated checkpoint of a graph containing one would drain
// the CONSUMER's in-flight calls - the consumer is trail, so it quiesces - while
// this provider served straight through the snapshot instant. A torn cut, and
// silent, because nothing in the system could observe that one member had not
// stopped.
//
// A marker is how a consumer arms a peer it does not run. Implementing the three
// ops is what makes a provider in ANY language a first-class member of a barrier
// rather than the reason one cannot be taken.
//
// # The contract, and the one part that is easy to get wrong
//
// THE ACK MEANS "MY CHANNEL IS EMPTY", NOT "I RECEIVED YOUR MARKER". It is sent
// only once in-flight calls reach zero. A consumer's own in-flight count says
// nothing about what this provider is still processing, which is the entire
// reason the marker exists - so acking on receipt would hand the coordinator a
// false quiesce and produce exactly the torn cut the protocol prevents.
//
// A provider that CANNOT drain must fail the marker rather than ack late or
// hang: the coordinator then aborts and resumes the graph, instead of every
// member sitting armed behind one stuck call.

// Barrier is a provider's quiesce state for the marker protocol.
//
// The zero value is ready to use and means "not armed, nothing in flight".
type Barrier struct {
	// Lease bounds how long an arm survives without a Resume. Zero means
	// DefaultLeaseTimeout. See barrierlease.go for what happens without one -
	// it is not a hypothetical.
	Lease time.Duration

	armed    atomic.Bool
	inFlight atomic.Int64
	// armedAt is the arm instant in unix nanos, 0 when not armed. Read on every
	// Armed() call, which is the hot path of a busy provider, so it is an atomic
	// rather than a mutex-guarded time.Time.
	armedAt atomic.Int64
}

// DefaultDrainTimeout bounds how long a provider waits for its own in-flight
// calls to drain before failing a marker. Matches trail's own bound
// (cmd/trail/src/marker.rs) so both ends of a barrier give up at the same
// point rather than one waiting on the other's already-abandoned attempt.
const DefaultDrainTimeout = 10 * time.Second

// drainPoll is how often the drain re-checks. Short, because a whole barrier is
// waiting on it.
const drainPoll = 5 * time.Millisecond

// ErrDrainTimeout is returned when in-flight calls did not reach zero in time.
// Distinct from a transport error because the coordinator's response differs: a
// transport failure is a lost peer, this is a peer that is present and busy.
var ErrDrainTimeout = errors.New("magicseam: in-flight calls did not drain")

// Armed reports whether new calls should be refused.
//
// Also where the arm LEASE is enforced: an arm that has outlived its lease is
// released here, by whoever asks. See barrierlease.go - a provider armed by a
// consumer that then died has no other way back, because the Resume can only
// arrive on that consumer's own connection.
func (b *Barrier) Armed() bool {
	if !b.armed.Load() {
		return false
	}
	if b.leaseExpired() {
		return false
	}

	return true
}

// InFlight reports how many calls are currently executing.
func (b *Barrier) InFlight() int64 { return b.inFlight.Load() }

// Enter marks a call as started and returns its completion function.
//
// Deferred by the serve path for the call's WHOLE lifetime: a marker that
// arrives while a call is mid-flight must not see zero, or it would ack a
// channel that still has work in it.
func (b *Barrier) Enter() func() {
	b.inFlight.Add(1)

	return func() { b.inFlight.Add(-1) }
}

// Arm stops admitting new calls and waits for in-flight ones to drain.
//
// Returns ErrDrainTimeout if they do not, and leaves the barrier ARMED when it
// does: the caller must not ack, and the coordinator's abort path will send a
// Resume. Un-arming here instead would silently resume a provider the
// coordinator still believes it is negotiating with.
func (b *Barrier) Arm(timeout time.Duration) error {
	b.armed.Store(true)
	// Stamped on EVERY arm, including a re-arm of an already-armed barrier: a
	// coordinator that re-arms is a coordinator that is still alive, and the
	// lease exists only to catch one that is not.
	b.armedAt.Store(time.Now().UnixNano())
	deadline := time.Now().Add(timeout)
	for {
		if b.inFlight.Load() == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%w: %d still running after %s - this channel cannot be quiesced, "+
				"so the coordinator must abort rather than snapshot a torn cut",
				ErrDrainTimeout, b.inFlight.Load(), timeout)
		}
		time.Sleep(drainPoll)
	}
}

// Resume releases the barrier. Never waits to drain: resuming is not a
// quiescence claim, and a coordinator on its abort path must be able to release
// a provider that is busy - that is precisely the case it is aborting for.
func (b *Barrier) Resume() {
	b.armed.Store(false)
	b.armedAt.Store(0)
}
