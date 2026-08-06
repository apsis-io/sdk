// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"fmt"
	"os"
	"time"
)

// THE ARM LEASE: a provider armed by a consumer that dies must release itself.
//
// # The outage this is for, which was produced rather than imagined
//
// 2026-08-06, live. A coordinated checkpoint armed this SDK's provider over
// QUIC; the marker worked exactly as designed - drain to zero, ack, refuse
// calls. The checkpoint then failed at a LATER step, the consumer pod died
// (restartPolicy: Never), and with it died the only thing that could ever send
// the Resume. The Resume travels on the consumer's own connection; there is no
// other channel it can arrive by, and no other party that knows the barrier
// exists.
//
// So the provider stayed armed. Not for the length of a checkpoint - forever.
// And it refused calls from EVERY consumer, including one with no involvement in
// the checkpoint at all, because the barrier is per-process and the refusal is
// per-call. The pod reported 1/1 Ready throughout: its readiness self-dial knows
// an armed provider refuses on purpose, so the one signal that could have shown
// it was the one deliberately taught to ignore it. Only a manual restart cleared
// it.
//
// # Why a read-time deadline rather than a timer
//
// No goroutine, no timer, no polling. The expiry is a property computed by
// whoever reads Armed(), which means there is nothing to leak, nothing to
// cancel, and no path where the releasing mechanism is itself wedged. A timer
// would need a goroutine per arm and a cancellation that is correct on every
// exit path from the marker handler - more machinery than the thing it protects.
//
// # Why the ceiling is not "however long a checkpoint takes"
//
// It is deliberately far above any real barrier (which completes in seconds -
// trail's own drain bound is 10s) and deliberately finite. It is not a deadline
// the protocol uses; it is the answer to "the coordinator is never coming back".
// Anything that legitimately needs longer should re-arm, which resets the lease -
// a coordinator that is still alive can say so, and one that is gone cannot.
//
// Raising this trades away self-healing time for tolerance of a slower
// coordinator. Lowering it risks releasing a provider mid-barrier, which is the
// torn cut the whole protocol exists to prevent - so err high.
const DefaultLeaseTimeout = 2 * time.Minute

// leaseTimeout resolves the configured lease, defaulting when unset so the zero
// Barrier stays usable.
func (b *Barrier) leaseTimeout() time.Duration {
	if b.Lease > 0 {
		return b.Lease
	}

	return DefaultLeaseTimeout
}

// leaseExpired reports whether an arm has outlived its lease, and RELEASES it if
// so - exactly once, however many readers notice simultaneously.
//
// The CompareAndSwap is what makes "exactly once" true: every caller of Armed()
// races here, and without it a busy provider would print one expiry line per
// in-flight call. The winner logs; the losers see armed already false and simply
// report not-armed.
//
// Logged LOUDLY rather than silently self-healing, because a lease that fires at
// all means a coordinator abandoned a barrier - the provider recovered, and
// something upstream still went wrong.
func (b *Barrier) leaseExpired() bool {
	at := b.armedAt.Load()
	if at == 0 {
		return false
	}
	held := time.Since(time.Unix(0, at))
	if held <= b.leaseTimeout() {
		return false
	}
	if b.armed.CompareAndSwap(true, false) {
		b.armedAt.Store(0)
		fmt.Fprintf(os.Stderr,
			"[magicseam][barrier] LEASE EXPIRED: armed %s ago with no Resume - releasing and "+
				"admitting calls again. The coordinator that armed this provider is gone (its "+
				"pod died, or its checkpoint failed without an abort); without this the provider "+
				"would refuse every caller forever while reporting healthy.\n", held.Round(time.Second))
	}

	return true
}

// ArmedFor reports how long this barrier has been armed, or 0 if it is not.
//
// A SECOND, INDEPENDENT READER, and that is the whole point of it existing
// alongside Armed(). It reads the arm instant directly and never runs the lease
// release, so a lease that silently fails to fire is still visible here.
//
// The one that needs it is readiness. An armed provider refuses calls, so a
// readiness self-dial fails, so readiness learned to exempt an armed provider -
// which is correct for a barrier that lasts seconds and catastrophic for one
// that never ends. Live on 2026-08-06 this provider reported 1/1 Ready while
// refusing every caller from every consumer, indefinitely: the one signal that
// could have shown the wedge was the one taught to ignore it.
//
// A SHORT arm must not flap readiness. An arm older than its lease is not a
// paused provider - the lease should already have released it - so it is a
// fault, and it must say so. Routing that judgement through Armed() would make
// the lease its own alibi: broken lease, released nothing, Armed() false,
// readiness green, provider serving nobody.
func (b *Barrier) ArmedFor() time.Duration {
	at := b.armedAt.Load()
	if at == 0 {
		return 0
	}

	return time.Since(time.Unix(0, at))
}

// LeaseTimeout reports the effective lease, so a caller with its own reason to
// bound an arm (readiness) can use the same number without re-deciding it.
func (b *Barrier) LeaseTimeout() time.Duration { return b.leaseTimeout() }
