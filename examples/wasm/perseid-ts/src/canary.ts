// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ===========================================================================
// A METRIC-GATED CANARY.
//
// A Deployment can roll its own ReplicaSet, but it cannot make one workload's
// scale conditional on another workload's observed status. This program owns
// two Deployments and makes that cross-object edge explicit:
//
//   stable ready at TOTAL -> start canary at PROBE replicas
//   canary ready at PROBE -> grow canary to TOTAL replicas
//   canary ready at TOTAL + stable still healthy -> drain stable to zero
//
// The final edge is deliberately safety-first. A permanently degraded stable
// retains both workloads at full scale rather than removing the fallback. That
// can hold double capacity indefinitely; Ready=False/StableNotReady makes the
// blocked promotion explicit instead of silently choosing availability policy.
//
// ⭐ AND BOTH PROMOTIONS ARE GATED ON A MEASUREMENT THIS PROGRAM DID NOT TAKE.
//
// `probe.ts` watches the same candidate and publishes a rolling availability on
// its own `status.carry`; this program reads that object and decides. Two
// programs, because "who measured" and "who acted" should be separately
// answerable - and because a program that both measures and acts cannot be
// audited by the thing it is measuring.
//
// ***THAT IS THE EDGE `status.readyReplicas` CANNOT EXPRESS.*** A one-replica
// probe that came up thirty seconds ago and is ready RIGHT NOW is
// indistinguishable, by any reading of the present, from one that has been
// serving cleanly for three minutes.
//
// # MEASURED END TO END, 2026-09-05, TWO PROGRAMS, ONE CLUSTER
//
// `canary-demo` (this program) and `probe-demo` communicating only through
// `status.carry`. The candidate's image was broken, then restored at t=0:
//
//	          candidate   probe          canary
//	 t+30s     1/1 READY   0.167 degr.    MetricGate     <- ***HELD***
//	 t+60s     1/1 READY   0.333 degr.    MetricGate
//	 t+90s     1/1 READY   0.500 degr.    MetricGate
//	 t+120s    1/1 READY   0.667 degr.    MetricGate
//	 t+150s    1/1 READY   0.833 degr.    MetricGate
//	 t+180s    3/3         1.000 healthy  (promoting)
//	 t+210s    3/3         1.000 healthy  CanaryPromoted
//
// ⭐ ***FOR 150 SECONDS THE CANDIDATE WAS READY AND THE PROMOTION WAS BLOCKED.***
// Every readiness gate above is satisfied at t+30s; a readiness-gated canary
// promotes there. This one waited for the MEASUREMENT to recover, which is a
// fact about the recent past that no observation of the present contains.
//
// ⚠ ***THIS PARAGRAPH SAID THE OPPOSITE UNTIL 2026-09-05*** - "a metrics-backed
// value gate is now expressible ... but this component deliberately does not
// implement one", which was an honest scope note while it was true and a false
// description of the program the moment the gate landed. Kept as a marker
// because the header is what a reader trusts and is the last thing anybody
// edits.
//
// This is the PURE half. It imports no `perseid:reconcile/*` module, so tests can
// drive a complete pass with a fake handler. `canary-main.ts` is the only host
// wiring half.
// ===========================================================================

import {
  type ApiPath,
  type EffectsOf,
  path,
  reconcile,
  carriedBy,
  defineStep,
  yieldStep,
  quiesce,
  anyOf,
  objectExists,
  fieldNe,
  backstop,
} from '@apsis-io/perseid/perseid.js'

const observe = reconcile.observe<string>()
const ensure = reconcile.ensure()
const report = reconcile.status()
// ***THE HOST'S CLOCK, NOT THE GUEST'S.*** `Date.now()` in a step is the
// component's own notion of time and is used below only for park DEADLINES,
// which are rendered into a resume the host re-evaluates. A FRESHNESS
// COMPARISON is different: it is subtracting a timestamp another program
// stamped, so both sides must come from the same clock or the difference is
// meaningless. `observe.now` is the host's, which is also what stamped the
// probe's `updated`.
const now = reconcile.now()

const STABLE = path.ns('default').deployments('canary-stable')
const CANARY = path.ns('default').deployments('canary-candidate')

/**
 * ***THE MEASURING PROGRAM, READ AS AN OBJECT.***
 *
 * `probe.ts` watches the same candidate and publishes a rolling availability on
 * its own `status.carry`; this program reads it and decides. Two programs
 * because "who measured" and "who acted" should be separately answerable, and
 * because a step that both measures and acts has no way to be audited by the
 * thing it is measuring.
 *
 * Reading it needs `perseid:reconcile/observe-perseids@0.1.0`, which is a
 * different grant from `observe` - see the path builder.
 */
const METRIC_PROBE = path.ns('default').perseids('probe-demo')

const PROBE: number = 1
const TOTAL: number = 3
// ⛔ There was a `const RECHECK_MS = 60_000` here and it was DEAD once the
// `deadline(Date.now() + RECHECK_MS)` operands became `backstop()`. The bound
// this program actually runs under is the one it DECLARES - see its
// `-backstop.ts` - and the host takes the MINIMUM of that and its own flag
// (`internal/perseidrun/assemble.go`, `backstopFor`), so the declared value was
// already tighter and the operand could never fire first.
//
// A knob that looks adjustable and adjusts nothing is worse than no knob.

/**
 * How stale a measurement may be and still gate a promotion.
 *
 * ⛔ ***WITHOUT THIS, A DEAD PROBE IS A PERMANENT `healthy`.*** The last thing a
 * probe ever published stays on its object forever - the carry is durable, which
 * is the whole point of it - so a probe that was deleted, wedged or refused
 * leaves behind a measurement that reads exactly like a current one. A gate with
 * no freshness bound therefore FAILS OPEN at the moment the measuring half
 * breaks, which is the direction that promotes a bad version.
 *
 * 90s is six of the probe's 15s samples: enough that a missed pass or a pod
 * recycle does not block a promotion, short enough that a stopped probe closes
 * the gate within two minutes.
 */
const METRIC_MAX_AGE_MS = 90_000

type Workload = { spec: number; ready: number }

// A missing readyReplicas field means zero ready pods in the Deployment status.
// A missing spec is different: Kubernetes defaults it, so guessing would let a
// malformed observation advance the promotion.
const workloadOf = (raw: string): Workload | null => {
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

// ═══════════════════════════════════════════════════════════════════════════
// THE METRIC GATE.
//
// A measurement this program did not take, read off another program's object.
// ═══════════════════════════════════════════════════════════════════════════

/** The fields of `probe.ts`'s published document that this program acts on. */
type Metric = { verdict: string; availability: number; samples: number; updated: number }

/**
 * ***A GATE, NOT A PARSE: EVERY UNRECOGNISED SHAPE IS `null` AND `null` DOES NOT
 * PROMOTE.***
 *
 * The consumer of a cross-program measurement is reading a document a DIFFERENT
 * program wrote, at a version it does not control, possibly written by a build
 * that no longer exists. So this validates rather than casts, and the failure
 * direction is the safe one in every branch:
 *
 *	not JSON / wrong version / missing field   ->  null, promotion paused
 *	a probe that has never published            ->  null, promotion paused
 *	a probe that CLEARED its carry              ->  null, promotion paused
 *
 * ⚠ The last one is the interesting case and it is deliberate. `probe.ts` clears
 * its carry when its SUBJECT VANISHES, precisely so a stale `healthy` cannot
 * outlive the thing it measured - and `carriedBy` reads an empty carry as `null`,
 * so that clear arrives here as "no measurement" rather than as a bad one. The
 * two programs agree on that meaning through the SDK, not by convention.
 */
export const metricOf = (rawPerseid: string): Metric | null => {
  const carry = carriedBy(rawPerseid)
  if (carry === null) return null
  try {
    const o = JSON.parse(carry) as Record<string, unknown>
    if (o.v !== 1) return null
    if (
      typeof o.verdict !== 'string' ||
      typeof o.availability !== 'number' ||
      typeof o.samples !== 'number' ||
      typeof o.updated !== 'number'
    ) {
      return null
    }

    return {
      verdict: o.verdict,
      availability: o.availability,
      samples: o.samples,
      updated: o.updated,
    }
  } catch {
    return null
  }
}

/** Why a promotion is blocked, or `null` when the metric permits it. */
export const metricBlocks = (m: Metric | null, nowMs: number): string | null => {
  if (m === null) return 'no usable measurement has been published'
  // ⛔ FRESHNESS BEFORE VERDICT. A carry is durable, so a probe that died leaves
  // its last `healthy` on the object forever - and a gate that checked the
  // verdict first would read it and promote. This is the arm that makes the gate
  // fail CLOSED when the measuring half breaks.
  const age = nowMs - m.updated
  if (age > METRIC_MAX_AGE_MS) {
    return `the measurement is ${Math.round(age / 1000)}s old (max ${METRIC_MAX_AGE_MS / 1000}s)`
  }
  // A clock that disagrees is not a fresh measurement either. A negative age
  // means the probe stamped the future, which is a broken input, not a very new
  // reading - and treating it as fresh is how a bad clock opens the gate.
  if (age < -METRIC_MAX_AGE_MS) {
    return `the measurement is stamped ${Math.round(-age / 1000)}s in the future`
  }
  if (m.verdict !== 'healthy') {
    return `the measured verdict is ${m.verdict} (availability ${m.availability} over ${m.samples} sample(s))`
  }

  return null
}

/**
 * The probe's pass counter, for the park below.
 *
 * ***PARK ON `status.passes`, NOT ON `status.carry`.*** A resume compares a
 * NUMBER; the carry is an opaque string this program deliberately does not ask
 * the host to interpret. The pass counter changes on every probe pass, which is
 * a superset of "the measurement changed" - so this wakes slightly more often
 * than strictly needed and never misses a change, which is the correct
 * direction for a gate.
 *
 * Zero for an unreadable probe: a resume that says "wake when passes != 0" fires
 * as soon as the probe records anything at all, which is exactly what a blocked
 * promotion is waiting for.
 */
const metricPasses = (seen: { t: string; v?: string }): number => {
  if (seen.t !== 'known' || seen.v === undefined) return 0
  try {
    const o = JSON.parse(seen.v) as { status?: { passes?: unknown } }

    return typeof o.status?.passes === 'number' ? o.status.passes : 0
  } catch {
    return 0
  }
}

const waitForObject = (target: ApiPath) =>
  quiesce(anyOf(objectExists(target), backstop()))

const waitForReady = (target: ApiPath, ready: number) =>
  quiesce(anyOf(fieldNe(target, 'status.readyReplicas', ready), backstop()))

const waitForConvergence = (stable: Workload, canary: Workload) =>
  quiesce(
    anyOf(
      fieldNe(STABLE, 'spec.replicas', stable.spec),
      fieldNe(STABLE, 'status.readyReplicas', stable.ready),
      fieldNe(CANARY, 'spec.replicas', canary.spec),
      fieldNe(CANARY, 'status.readyReplicas', canary.ready),
      backstop(),
    ),
  )

const missing = function* (name: string, target: ApiPath) {
  yield* report({
    type: 'Ready',
    status: 'False',
    reason: 'WorkloadMissing',
    message: `${name} does not exist; canary promotion is paused`,
  })
  return waitForObject(target)
}

const unreadable = function* (name: string) {
  yield* report({
    type: 'Ready',
    status: 'False',
    reason: 'WorkloadUnreadable',
    message: `${name} status could not be parsed; canary promotion is paused`,
  })
  return yieldStep
}

const step = defineStep(function* () {
  const stableSeen = yield* observe(STABLE)
  if (stableSeen.t === 'absent') return yield* missing('stable', STABLE)
  if (stableSeen.t === 'unknown') return yieldStep

  const canarySeen = yield* observe(CANARY)
  if (canarySeen.t === 'absent') return yield* missing('canary', CANARY)
  if (canarySeen.t === 'unknown') return yieldStep

  const stable = workloadOf(stableSeen.v)
  if (stable === null) return yield* unreadable('stable')
  const canary = workloadOf(canarySeen.v)
  if (canary === null) return yield* unreadable('canary')

  // The candidate's desired scale is the phase marker, derived from the world
  // rather than remembered in the component. Before full promotion, establish
  // and hold the stable baseline. This is an absolute write, so replaying a pass
  // before its obligation lands is harmless.
  if (canary.spec !== TOTAL) {
    if (stable.spec !== TOTAL) {
      yield* ensure({ path: STABLE, field: 'spec.replicas', value: TOTAL })
      return yieldStep
    }
    if (stable.ready !== TOTAL) {
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'StableNotReady',
        message: `stable is ${stable.ready}/${TOTAL} ready; candidate remains at probe scale`,
      })
      return waitForReady(STABLE, stable.ready)
    }

    // The first cross-object edge: a healthy stable workload permits only a
    // one-replica canary probe, never an immediate full promotion.
    if (canary.spec !== PROBE) {
      yield* ensure({ path: CANARY, field: 'spec.replicas', value: PROBE })
      return yieldStep
    }
    if (canary.ready !== PROBE) {
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'CanaryProbing',
        message: `candidate probe is ${canary.ready}/${PROBE} ready`,
      })
      return waitForReady(CANARY, canary.ready)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ⭐ THE METRIC GATE, AT THE EDGE THAT MATTERS.
    //
    // The candidate's one probe replica is READY. Everything up to here is a
    // readiness gate and a Deployment could almost express it. This is where
    // it cannot: a one-replica probe that came up thirty seconds ago and is
    // ready RIGHT NOW is indistinguishable, by any reading of the present, from
    // one that has been serving cleanly for three minutes. Only a program that
    // remembers can tell them apart, and `probe.ts` is that program.
    //
    // Measured 2026-09-05: a candidate whose image was broken and then fixed
    // reads `2/2 READY` with a measured availability of 0.167 for three more
    // minutes. THAT is the promotion this gate stops.
    // ═══════════════════════════════════════════════════════════════════════
    const metricSeen = yield* observe(METRIC_PROBE)
    // ⛔ ABSENT AND UNKNOWN BOTH BLOCK, and neither is an error. `absent` is a
    // probe that does not exist or that this program may not read - the grant is
    // separate, so a missing `observe-perseids` capability arrives here and not
    // as a refusal - and `unknown` is a host that could not answer this pass.
    // Promoting on either would be promoting because the measurement is
    // MISSING, which is the failure mode a gate exists to prevent.
    const blocked =
      metricSeen.t === 'known'
        ? metricBlocks(metricOf(metricSeen.v), yield* now())
        : `the measurement could not be read (${metricSeen.t})`
    if (blocked !== null) {
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'MetricGate',
        message: `candidate holds at probe scale: ${blocked}`,
      })

      // Woken by the probe's own object changing - which is what a new
      // measurement IS - rather than by the workload's readiness, because the
      // workload is already ready and will not change again. The deadline is the
      // floor for the case where the probe stops publishing entirely, which is
      // exactly when the freshness arm needs to re-evaluate.
      return quiesce(
        anyOf(
          fieldNe(METRIC_PROBE, 'status.passes', metricPasses(metricSeen)),
          backstop(),
        ),
      )
    }

    yield* ensure({ path: CANARY, field: 'spec.replicas', value: TOTAL })
    return yieldStep
  }

  // The second edge prevents the stable workload being drained until the full
  // candidate population, not merely its first probe, is actually serving. It
  // also requires stable to remain healthy, as the safety-first header states.
  if (canary.ready !== TOTAL) {
    // A candidate that was manually moved to TOTAL still cannot promote while
    // the baseline is not healthy. Once stable has already been drained, its
    // zero readiness is expected and this check is intentionally skipped.
    if (stable.spec !== 0 && stable.ready !== TOTAL) {
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'StableNotReady',
        message: `stable is ${stable.ready}/${TOTAL} ready; candidate promotion is paused`,
      })
      return waitForReady(STABLE, stable.ready)
    }
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: 'CanaryPromoting',
      message: `candidate is ${canary.ready}/${TOTAL} ready; stable is retained`,
    })
    return waitForReady(CANARY, canary.ready)
  }

  // Promotion is safe only after the candidate is fully ready. Stable is
  // drained, rather than deleted, so this example needs no pod write authority.
  if (stable.spec !== 0 && stable.ready !== TOTAL) {
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: 'StableNotReady',
      message: `stable is ${stable.ready}/${TOTAL} ready; candidate promotion is paused`,
    })
    return waitForReady(STABLE, stable.ready)
  }
  // ⭐ THE GATE AGAIN, AND HERE IT GUARDS THE IRREVERSIBLE HALF.
  //
  // ***THE SAME CHECK AT BOTH EDGES IS NOT REDUNDANT, BECAUSE THE COSTS ARE NOT
  // SYMMETRIC.*** Above, a blocked gate leaves the candidate at one replica -
  // cheap, reversible, nothing is lost. Here it decides whether to DRAIN THE
  // FALLBACK: once stable is at zero the only thing serving is the candidate,
  // and if its measurement was about to turn there is nothing left to turn back
  // to. A gate that ran only at the earlier edge would have been evaluated
  // minutes before the moment it matters, against a candidate at a different
  // scale, and the promotion in between is exactly the window a flap fits in.
  if (stable.spec !== 0) {
    const drainSeen = yield* observe(METRIC_PROBE)
    const drainBlocked =
      drainSeen.t === 'known'
        ? metricBlocks(metricOf(drainSeen.v), yield* now())
        : `the measurement could not be read (${drainSeen.t})`
    if (drainBlocked !== null) {
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'MetricGate',
        message: `stable is retained at ${stable.spec}: ${drainBlocked}`,
      })

      return quiesce(
        anyOf(
          fieldNe(METRIC_PROBE, 'status.passes', metricPasses(drainSeen)),
          backstop(),
        ),
      )
    }
  }
  if (stable.spec !== 0) {
    yield* ensure({ path: STABLE, field: 'spec.replicas', value: 0 })
    return yieldStep
  }
  if (stable.ready !== 0) {
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: 'StableDraining',
      message: `stable is still ${stable.ready} ready after candidate promotion`,
    })
    return waitForReady(STABLE, stable.ready)
  }

  yield* report({
    type: 'Ready',
    status: 'True',
    reason: 'CanaryPromoted',
    message: `candidate is ${TOTAL}/${TOTAL} ready; stable is drained`,
  })
  return waitForConvergence(stable, canary)
})

export type Effs = EffectsOf<typeof step>
export {
  step as canaryStep,
  workloadOf,
  STABLE,
  CANARY,
  METRIC_PROBE,
  METRIC_MAX_AGE_MS,
  PROBE,
  TOTAL,
}
export type { Workload }
