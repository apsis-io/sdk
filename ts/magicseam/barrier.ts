// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// COORDINATED-CHECKPOINT MARKERS for a provider written in TypeScript
// (ADR-0032, docs/magic-seam-quic-protocol.md §8).
//
// A marker is how a consumer quiesces a provider it does not run. Without it
// this SDK's providers cannot join a coordinated checkpoint at all: the consumer
// drains its own in-flight calls while this provider keeps serving through the
// snapshot instant, producing a torn cut that nothing detects.
//
// go/magicseam/barrier.go is the reference implementation and
// trail's marker handling is the consumer side; all three are implementations
// of one written protocol and must agree on the wire, not on their internals.
//
// # The contract, and the part that is easy to get wrong
//
// THE ACK MEANS "MY CHANNEL IS EMPTY", NOT "I RECEIVED YOUR MARKER". It is sent
// only once in-flight calls reach zero. A consumer's own in-flight count says
// nothing about what this provider is still processing - which is the entire
// reason the marker exists - so acking on receipt hands the coordinator a false
// quiesce and the torn cut the protocol prevents.

/** How long a drain may take before the marker FAILS (§8 rule 2). Matches
 *  go/magicseam's DefaultDrainTimeout and trail's own bound, so both ends of
 *  a barrier give up at the same point rather than one waiting on the other's
 *  already-abandoned attempt. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000

/** How long an arm survives with no resume.
 *
 *  MUST stay below the Go SDK's DefaultLeaseTimeout (2m) and above trail's
 *  consumer lease (90s)? No - it must simply bound an ABANDONED arm. The
 *  consumer gives up first at 90s and sends a Resume; this is the fallback for a
 *  consumer that is GONE and can never send one, exactly as
 *  go/magicseam/barrierlease.go describes. Measured there: without a lease a
 *  provider armed by a consumer that died refused every caller forever, cleared
 *  only by a restart. */
export const DEFAULT_LEASE_MS = 120_000

/** Returned by arm() when in-flight calls did not reach zero in time. Distinct
 *  from a transport failure because the coordinator's response differs: a lost
 *  peer versus a peer that is present and busy. */
export class DrainTimeoutError extends Error {
  constructor(inFlight: number, timeoutMs: number) {
    super(
      `magicseam: ${inFlight} in-flight call(s) did not drain in ${timeoutMs}ms - this channel ` +
        `cannot be quiesced, so the coordinator must abort rather than snapshot a torn cut`,
    )
    this.name = "DrainTimeoutError"
  }
}

/**
 * A provider's quiesce state. The zero state ("not armed, nothing in flight") is
 * what a fresh instance has, so a provider that never takes a barrier behaves
 * exactly as it did before markers existed.
 */
export class Barrier {
  #armed = false
  #inFlight = 0
  #armedAt = 0
  readonly #leaseMs: number

  constructor(leaseMs: number = DEFAULT_LEASE_MS) {
    this.#leaseMs = leaseMs
  }

  /**
   * Whether new calls should be refused.
   *
   * Also where the arm LEASE is enforced, at READ time rather than by a timer:
   * nothing to leak, nothing to cancel, and no path where the releasing
   * mechanism is itself wedged. An arm that has outlived its lease was abandoned
   * by a consumer that can no longer send a Resume - the Resume travels on that
   * consumer's own connection and no other party knows the barrier exists.
   */
  get armed(): boolean {
    if (!this.#armed) return false
    if (this.#armedAt !== 0 && Date.now() - this.#armedAt > this.#leaseMs) {
      const heldMs = Date.now() - this.#armedAt
      this.#armed = false
      this.#armedAt = 0
      console.error(
        `[magicseam][barrier] LEASE EXPIRED: armed ${Math.round(heldMs / 1000)}s ago with no ` +
          `Resume - releasing and admitting calls again. The coordinator that armed this ` +
          `provider is gone; without this the provider would refuse every caller forever.`,
      )

      return false
    }

    return true
  }

  /** How long this barrier has been armed, or 0 if it is not.
   *
   *  A SECOND, INDEPENDENT READER: it never runs the lease release, so a lease
   *  that silently fails to fire is still visible. Readiness checks must use
   *  this rather than `armed`, or the lease becomes its own alibi - released
   *  nothing, reports not-armed, health green, provider serving nobody. */
  get armedForMs(): number {
    return this.#armedAt === 0 ? 0 : Date.now() - this.#armedAt
  }

  get inFlight(): number {
    return this.#inFlight
  }

  /** Mark a call as started; the returned function marks it finished. Held for
   *  the call's WHOLE lifetime, or a marker arriving mid-call sees zero and acks
   *  a channel that still has work in it. */
  enter(): () => void {
    this.#inFlight++
    let done = false

    return () => {
      if (done) return
      done = true
      this.#inFlight--
    }
  }

  /**
   * Stop admitting new calls and wait for in-flight ones to drain.
   *
   * Throws DrainTimeoutError if they do not, and leaves the barrier ARMED when
   * it does (§8 rule 3): the caller must not ack, and the coordinator's abort
   * path sends the Resume. Un-arming here would silently resume a provider the
   * coordinator still believes it is negotiating with.
   */
  async arm(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    this.#armed = true
    // Stamped on EVERY arm, including a re-arm: a coordinator that re-arms is
    // one that is still alive, and the lease exists only to catch one that is not.
    this.#armedAt = Date.now()

    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.#inFlight === 0) return
      if (Date.now() > deadline) throw new DrainTimeoutError(this.#inFlight, timeoutMs)
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  /** Release the barrier. NEVER waits to drain: resuming is not a quiescence
   *  claim, and the abort path exists precisely for a provider that is busy. */
  resume(): void {
    this.#armed = false
    this.#armedAt = 0
  }
}
