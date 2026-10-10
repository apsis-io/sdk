// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// A MEASURING PROGRAM: DERIVE A METRIC OVER TIME AND PUBLISH IT AS DATA.
//
// ***THE HALF OF THE METRIC GATE THAT PRODUCES THE NUMBER*** (engi, 2026-09-05:
// "one perseid do metrics and writes them as data on itself, another reads
// them"). `canary.ts` is the consumer; this is the producer, and the channel
// between them is `status.carry` plus the `observe-perseids` capability.
//
// # WHY THIS CANNOT BE A SCRAPE
//
// A step performs NO I/O of its own (ADR-0075) - it observes through
// `perseid:reconcile/observe*` and emits obligations, and the host serves those.
// So there is no HTTP client here and there cannot be one. The metric is
// DERIVED from the same observations any other program makes, and the thing that
// makes it a metric rather than a reading is that it is accumulated ACROSS
// PASSES: a window of samples, kept in the program's carry.
//
// ***THAT IS THE PROPERTY WORTH SHOWING.*** A single `status.readyReplicas` is
// what `canary.ts` already gates on, and it is a level, not a measurement - it
// says nothing about whether the workload has been flapping. Availability over a
// window does, and it needs memory across passes, which is exactly what a
// Deployment has nowhere to put.
//
// # WHY THE WINDOW IS IN CARRY AND NOT IN A MODULE GLOBAL
//
// A module global would survive within one pod and vanish on every recycle,
// silently - the program would report `warming` forever on a node that restarts
// it, and look fine everywhere else. `internal/reconcilehost/carry.go` argues
// the general case; here it is also the only version that the CONSUMER can see,
// because a global is not on the object.
//
// # MEASURED LIVE, 2026-09-05, AND THE LAST ROW IS THE WHOLE ARGUMENT
//
// `probe-demo` on kas-sqlite watching a 2-replica Deployment. Its image was
// changed to an unpullable tag, then changed back:
//
//	         subject      availability   verdict
//	 t+0      2/2 ready       1.000       healthy
//	 t+30s    2/0             0.833       degraded    <- one bad sample
//	 t+90s    2/0             0.500       degraded
//	 t+180s   2/0             0.000       degraded    <- ring fully turned over
//	 --- image restored ---
//	 t+30s    2/2 READY       0.167       degraded    <- ***THIS ROW***
//	 t+180s   2/2 ready       1.000       healthy
//
// ⭐ ***AT THAT ROW THE WORKLOAD IS FULLY HEALTHY AND THE MEASUREMENT IS NOT.***
// The outage is over; the MEMORY of it is not, and will not be for three more
// minutes. A gate on `status.readyReplicas` promotes at that instant. A gate on
// this does not, and that difference is the entire reason to run a program that
// remembers - a candidate that just finished flapping is exactly the one you must
// not promote, and it is indistinguishable from a healthy one by any reading of
// the present.
//
// The GRADIENT is also the proof this is a metric rather than a reading: a point
// observation goes 1 -> 0 in one step. Six intermediate values are six samples
// aging out of a twelve-slot ring, which is only observable because the ring
// survives between passes.
//
// ***THE PURE HALF.*** No `perseid:reconcile/*` imports; the wiring is in
// `probe-main.ts`.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type Carry,
  type EffectsOf,
  carryOf,
  path,
  reconcile,
  defineStep,
  yieldStep,
  quiesce,
  anyOf,
  objectExists,
  deadlineIn,
  remember,
  forget,
} from '@apsis-io/perseid/perseid.js'

const observe = reconcile.observe<string>()
const report = reconcile.status()
const carry = reconcile.carry()

/** The workload this probe measures. */
const SUBJECT = path.ns('default').deployments('canary-candidate')

/** How often a sample is taken. The park deadline IS the sampling interval. */
const SAMPLE_MS = 15_000

/**
 * How many samples the window holds.
 *
 * ***BOUNDED BECAUSE THE CARRY IS AN APISERVER WRITE.*** `MaxCarryBytes` is
 * 4 KiB and the SDK refuses more, but the real reason to keep this small is that
 * every changed carry is a write to the Perseid object - so a window is a
 * ring, never a history. Twelve samples at 15 s is three minutes of evidence,
 * which is the timescale a promotion decision cares about.
 */
const WINDOW = 12

/**
 * Samples required before the probe will say anything but `warming`.
 *
 * ⚠ ***A VERDICT FROM ONE SAMPLE IS THE READING `canary.ts` ALREADY HAS.*** The
 * whole point of this program is that it waits, so a low minimum would make the
 * gate an expensive way to re-read `status.readyReplicas`.
 */
const MIN_SAMPLES = 4

/** Mean availability at or above this reads `healthy`. */
const HEALTHY_AVAILABILITY = 0.95

export type Verdict = 'warming' | 'healthy' | 'degraded'

/** One observation: when, how many ready, how many wanted. */
export type Sample = readonly [t: number, ready: number, spec: number]

/**
 * What the probe publishes. This is the CONSUMER'S CONTRACT, so it is versioned
 * and its field names are part of it.
 *
 * ***`window` TRAVELS WITH THE SUMMARY ON PURPOSE.*** A reader that only gets
 * `availability` cannot tell a workload that has been at 0.96 throughout from
 * one that was at 1.0 and has just started failing - same mean, opposite
 * situations - and the second is precisely what a promotion gate must not walk
 * into. Publishing the samples costs a few hundred bytes and lets a consumer
 * disagree with this program's verdict.
 */
export type Published = {
  readonly v: 1
  readonly updated: number
  readonly samples: number
  readonly availability: number
  readonly verdict: Verdict
  readonly window: readonly Sample[]
}

type Observed = { spec: number; ready: number }

// A missing `readyReplicas` means zero ready pods; a missing `spec.replicas` is
// different, because Kubernetes defaults it and guessing would let a malformed
// observation into the window. Same rule as `canary.ts`'s `workloadOf`, and
// deliberately duplicated rather than shared: a probe that silently changed its
// parsing because a controller next door changed its own would publish a metric
// nobody could account for.
export const observedOf = (raw: string): Observed | null => {
  try {
    const o = JSON.parse(raw) as {
      spec?: { replicas?: unknown }
      status?: { readyReplicas?: unknown }
    }
    if (typeof o.spec?.replicas !== 'number') return null

    return {
      spec: o.spec.replicas,
      ready: o.status?.readyReplicas === undefined ? 0 : Number(o.status.readyReplicas),
    }
  } catch {
    return null
  }
}

/**
 * Recover the window from a carry.
 *
 * ***EVERY UNRECOGNISED SHAPE IS AN EMPTY WINDOW, NOT A THROW.*** A probe whose
 * own memory is unreadable must start measuring again, not fail its pass
 * forever: the carry survives a version of this program that no longer exists,
 * and a step that dies on it can never publish the value that would replace it.
 */
export const windowOf = (mem: Carry): readonly Sample[] => {
  // ***A KEY IN THE CARRY OBJECT.*** This took the whole carry and parsed it,
  // which is why the version tag `v` had to be invented - the value WAS the
  // envelope. A named key is its own envelope, and leaves room beside it.
  const o = mem as { v?: unknown; window?: unknown }
  try {
    if (o.v !== 1 || !Array.isArray(o.window)) return []

    return o.window.filter(
      (s): s is Sample =>
        Array.isArray(s) && s.length === 3 && s.every((n) => typeof n === 'number'),
    )
  } catch {
    return []
  }
}

/**
 * The measurement itself: mean of `ready/spec` across the window.
 *
 * A sample whose `spec` is zero contributes 1 - a workload nobody asked for is
 * not unavailable. Reading it as 0 would make a deliberately drained workload
 * indistinguishable from a broken one, and this program's consumer drains things.
 */
export const availabilityOf = (window: readonly Sample[]): number => {
  if (window.length === 0) return 0

  const total = window.reduce((acc, [, ready, spec]) => acc + (spec === 0 ? 1 : ready / spec), 0)

  return total / window.length
}

export const verdictOf = (window: readonly Sample[]): Verdict => {
  if (window.length < MIN_SAMPLES) return 'warming'

  return availabilityOf(window) >= HEALTHY_AVAILABILITY ? 'healthy' : 'degraded'
}

/** Append a sample, dropping the oldest once the ring is full. */
export const rolled = (window: readonly Sample[], sample: Sample): readonly Sample[] =>
  [...window, sample].slice(-WINDOW)

export const publish = (window: readonly Sample[], now: number): Published => ({
  v: 1,
  updated: now,
  samples: window.length,
  // Rounded so an unchanged measurement produces an unchanged STRING. A float
  // whose last digits wander writes the Perseid object on every single pass -
  // an apiserver write per sample, forever, for noise below what any consumer
  // could act on.
  availability: Math.round(availabilityOf(window) * 1000) / 1000,
  verdict: verdictOf(window),
  window,
})

/**
 * The step. Takes one sample per pass and republishes.
 *
 * ***`nowMs` IS A PARAMETER AND THE CARRY IS NOT, AND THE DIFFERENCE IS REAL.***
 * The clock is ambient - there is no `perseid:reconcile` interface for it that a
 * handler could answer - so injecting it is the only way a test can drive a
 * deterministic window. The carry IS an effect (`carry.get()`), so a test
 * supplies it the same way it supplies observations: through the handler. Making
 * it a parameter too would let the test drive a path production does not have.
 */
export const probeStep = (nowMs: () => number) =>
  defineStep(function* () {
    const seen = yield* observe(SUBJECT)

    if (seen.t === 'unknown') return yieldStep

    if (seen.t === 'absent') {
      // ***THE SUBJECT IS GONE, SO THE MEASUREMENT IS RETIRED - NOT KEPT.***
      // A stale window is worse than no window: the consumer's gate would go on
      // reading `healthy` from evidence about a workload that no longer exists,
      // and it would read it for as long as the probe survives. `forget` is the
      // only way to say that, and it is why the SDK gives it a spelling of its
      // own.
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'SubjectMissing',
        message: `${SUBJECT} does not exist; the measurement is discarded rather than left stale`,
      })

      return forget(quiesce(anyOf(objectExists(SUBJECT), deadlineIn(SAMPLE_MS, nowMs()))))
    }

    const observed = observedOf(seen.v)
    if (observed === null) {
      // A pass that cannot parse takes NO sample and says nothing about the
      // carry, so the window survives an unreadable observation instead of
      // being punctured by it.
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'SubjectUnreadable',
        message: `${SUBJECT} status could not be parsed; no sample was taken this pass`,
      })

      return quiesce(deadlineIn(SAMPLE_MS, nowMs()))
    }

    const now = nowMs()
    const window = rolled(windowOf(carryOf(yield* carry())), [now, observed.ready, observed.spec])
    const published = publish(window, now)

    yield* report({
      type: 'Ready',
      status: published.verdict === 'degraded' ? 'False' : 'True',
      reason: verdictReason(published.verdict),
      message:
        `availability ${published.availability} over ${published.samples} sample(s); ` +
        `subject is ${observed.ready}/${observed.spec} ready`,
    })

    // ***THE PARK IS THE SAMPLING INTERVAL, AND IT IS A DEADLINE RATHER THAN A
    // FIELD CONDITION.*** A probe woken by the subject CHANGING would sample
    // densely while it flaps and not at all while it sits broken - so its
    // window would encode the subject's edit rate, not its availability, and
    // the metric would be worse the more it was needed.
    return remember(quiesce(deadlineIn(SAMPLE_MS, now)), { ...published })
  })

// A distinct reason per verdict: `report` aggregates Events on EXACT text match,
// so a single reason with the verdict in the message would collapse three
// different situations into one Event stream.
const verdictReason = (v: Verdict): string =>
  v === 'healthy' ? 'Healthy' : v === 'degraded' ? 'Degraded' : 'Warming'

/**
 * The production instantiation: the real clock.
 *
 * ***A NAMED `step` CONST EXISTS BECAUSE `tools/derive-wit.ts` READS ONE.*** The
 * tool infers the world from a generator's yield type, which it finds by NAME -
 * a factory has no yield type to read, so `probeStep` alone would leave this
 * component's demand underived and its world unchecked against what it actually
 * asks for.
 *
 * So the factory stays for tests, which need a deterministic clock, and this is
 * the single place `Date.now` is reached. Nothing else in the program touches
 * a clock, which is what keeps the whole decision table drivable.
 */
const step = probeStep(() => Date.now())

export type Effs = EffectsOf<ReturnType<typeof probeStep>>
export { step as probeProgram, SUBJECT, SAMPLE_MS, WINDOW, MIN_SAMPLES, HEALTHY_AVAILABILITY }
