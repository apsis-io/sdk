// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { test } from 'bun:test'
import {
  type Handler,
  type Obs,
  type Outcome,
  runStep,
  known,
  absent,
  unknown,
} from '@apsis-io/perseid/perseid.js'
import {
  type Effs,
  canaryStep,
  metricBlocks,
  metricOf,
  STABLE,
  CANARY,
  METRIC_PROBE,
  METRIC_MAX_AGE_MS,
  PROBE,
  TOTAL,
  workloadOf,
} from './canary.js'

const deployment = (spec: number, ready: number): Obs<string> =>
  known(JSON.stringify({ spec: { replicas: spec }, status: { readyReplicas: ready } }))

// A frozen clock, so `updated: NOW` is a measurement taken this instant and an
// age is whatever the fixture says it is rather than whatever the test machine
// took to get here.
const NOW = 1_700_000_000_000

// The probe's Perseid object, as this program observes it. `passes` is here
// because the metric park reads it; `carry` is the published document.
const probeObject = (carry: unknown, passes = 42): Obs<string> =>
  known(
    JSON.stringify({
      status: { passes, ...(carry === undefined ? {} : { carry: JSON.stringify(carry) }) },
    }),
  )

// ***THE DEFAULT IS A HEALTHY, FRESH MEASUREMENT***, so every pre-existing case
// below exercises the readiness logic it was written for rather than stopping at
// the new gate. The gate's own arms pass an explicit metric.
const healthyMetric = {
  v: 1,
  updated: NOW,
  samples: 12,
  availability: 1,
  verdict: 'healthy',
  window: [],
}

function drive(
  stable: Obs<string>,
  canary: Obs<string>,
  metric: Obs<string> = probeObject(healthyMetric),
): { outcome: Outcome; acts: string[] } {
  const acts: string[] = []
  const handler: Handler<Effs> = {
    get: (path) =>
      String(path) === String(STABLE)
        ? stable
        : String(path) === String(CANARY)
          ? canary
          : String(path) === String(METRIC_PROBE)
            ? metric
            : absent,
    ensure: (args) => {
      if (!('value' in args)) return
      const rendered = typeof args.value === 'string' ? JSON.stringify(args.value) : String(args.value)
      acts.push(`ensure(${args.path},${args.field},${rendered})`)
    },
    status: (condition) => acts.push(`set(${condition.type}=${condition.status}/${condition.reason})`),
    now: () => NOW,
  }
  return { outcome: runStep(canaryStep, handler), acts }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function has(acts: string[], text: string, message: string): void {
  assert(acts.includes(text), `${message}: ${acts.join(', ')}`)
}

export function runtimeGuards(): void {
  // The stable Deployment is the first gate and is touched before the candidate.
  {
    const { acts } = drive(deployment(TOTAL - 1, TOTAL - 1), deployment(0, 0))
    has(acts, `ensure(${STABLE},spec.replicas,${TOTAL})`, 'stable baseline is established')
    assert(!acts.some((a) => a.includes(String(CANARY))), 'candidate changed before stable baseline')
  }

  // Desired stable replicas are insufficient: readiness is the actual gate.
  {
    const { acts } = drive(deployment(TOTAL, PROBE), deployment(0, 0))
    assert(acts.some((a) => a.includes('StableNotReady')), 'unready stable did not report the gate')
    assert(!acts.some((a) => a.includes(String(CANARY))), 'candidate changed while stable was unready')
  }

  // Stable readiness permits only the one-replica probe.
  {
    const { acts } = drive(deployment(TOTAL, TOTAL), deployment(0, 0))
    has(acts, `ensure(${CANARY},spec.replicas,${PROBE})`, 'candidate starts at probe size')
  }

  // Probe readiness permits promotion to the full candidate population.
  {
    const { acts } = drive(deployment(TOTAL, TOTAL), deployment(PROBE, PROBE))
    has(acts, `ensure(${CANARY},spec.replicas,${TOTAL})`, 'candidate is promoted only after probe readiness')
  }

  // Full candidate readiness permits draining a HEALTHY stable workload.
  {
    const { acts } = drive(deployment(TOTAL, TOTAL), deployment(TOTAL, TOTAL))
    has(acts, `ensure(${STABLE},spec.replicas,0)`, 'stable is drained after candidate readiness')
  }

  // Safety-first policy: a fully ready candidate is not permission to remove a
  // degraded fallback. Both workloads remain at full scale and the condition
  // names the blocked gate.
  {
    const { acts } = drive(deployment(TOTAL, TOTAL - 1), deployment(TOTAL, TOTAL))
    assert(acts.some((a) => a.includes('StableNotReady')), 'degraded stable did not report the gate')
    assert(!acts.includes(`ensure(${STABLE},spec.replicas,0)`), 'degraded stable was drained')
  }

  // Missing and unknown observations never become permission to promote.
  {
    const missing = drive(absent, deployment(TOTAL, TOTAL))
    assert(missing.outcome.o === 'quiesce', 'missing stable did not park')
    assert(!missing.acts.some((a) => a.includes(String(CANARY))), 'missing stable promoted candidate')
    const unreadable = drive(unknown, deployment(TOTAL, TOTAL))
    assert(unreadable.outcome.o === 'yield', 'unknown stable did not yield')
    assert(!unreadable.acts.some((a) => a.includes(String(CANARY))), 'unknown stable promoted candidate')
  }

  // A fully promoted world is STABLE: it reports success and writes nothing.
  // Without this the suite never drives the terminal state, so a step that kept
  // re-declaring after promotion would pass every case above.
  {
    const { acts } = drive(deployment(0, 0), deployment(TOTAL, TOTAL))
    assert(acts.some((a) => a.includes('CanaryPromoted')), 'a promoted canary did not report success')
    assert(!acts.some((a) => a.startsWith('ensure(')), 'a promoted canary kept writing')
  }

  // Draining is not yet drained: stable is at zero DESIRED but still serving.
  {
    const { acts } = drive(deployment(0, TOTAL), deployment(TOTAL, TOTAL))
    assert(acts.some((a) => a.includes('StableDraining')), 'a draining stable was reported as promoted')
  }

  // The parser preserves the Kubernetes distinction between omitted readiness
  // (zero) and an omitted desired replica count (unknown).
  const parsed = workloadOf(JSON.stringify({ spec: { replicas: TOTAL }, status: {} }))
  assert(parsed?.ready === 0, 'omitted readyReplicas is not interpreted as zero')
  assert(workloadOf(JSON.stringify({ status: {} })) === null, 'omitted spec.replicas was guessed')

  // ***THE LINE ABOVE PASSES WITHOUT THE `typeof` GUARD, AND FOR THE WRONG
  // REASON.*** With `spec` entirely absent, `o.spec.replicas` THROWS and the
  // try/catch returns null on its own — so deleting the guard leaves that
  // assertion green. Measured: removing `typeof o.spec?.replicas !== 'number'`
  // and running this file still exited 0 before these three cases existed.
  //
  // The guard's actual job is a replicas field that is PRESENT and not a number,
  // which the apiserver will not send but a fake, a proxy or a hand-written
  // fixture will. It matters because `spec` is compared with `!==` against a
  // number: a string "3" is never equal to 3, so the step would re-declare
  // `ensure(spec.replicas, 3)` on every pass forever, writing a value the
  // cluster already holds and never converging.
  for (const bad of [{ replicas: '3' }, { replicas: null }, { replicas: true }]) {
    const raw = JSON.stringify({ spec: bad, status: { readyReplicas: 3 } })
    assert(workloadOf(raw) === null, `a non-numeric spec.replicas was accepted: ${raw}`)
  }

  // ═════════════════════════════════════════════════════════════════════════
  // THE METRIC GATE. Every arm here is about the FAIL-CLOSED direction, because
  // that is the one a gate is removed for and the one nobody writes first.
  // ═════════════════════════════════════════════════════════════════════════

  // The promotion this gate exists to stop: the candidate probe is READY, so
  // every readiness check above is satisfied, and the measurement says it has
  // been flapping. This is the live 2026-09-05 shape - `2/2 READY` at
  // availability 0.167 - reduced to a fixture.
  {
    const degraded = { ...healthyMetric, availability: 0.167, verdict: 'degraded' }
    const { acts } = drive(
      deployment(TOTAL, TOTAL),
      deployment(PROBE, PROBE),
      probeObject(degraded),
    )
    assert(
      acts.some((a) => a.includes('MetricGate')),
      `a degraded measurement did not report the gate: ${acts.join(', ')}`,
    )
    assert(
      !acts.some((a) => a.startsWith('ensure(')),
      `a READY probe was promoted while the measurement said degraded: ${acts.join(', ')}`,
    )
  }

  // ...and the same world with a healthy measurement DOES promote. Without this
  // the arm above passes for a program that never promotes at all.
  {
    const { acts } = drive(deployment(TOTAL, TOTAL), deployment(PROBE, PROBE))
    has(
      acts,
      `ensure(${CANARY},spec.replicas,${TOTAL})`,
      'a healthy measurement did not permit promotion, so the gate blocks everything',
    )
  }

  // ⛔ A DEAD PROBE MUST NOT READ AS HEALTHY. The carry is durable, so the last
  // thing a probe published stays on its object forever - this is the arm that
  // makes the gate close when the MEASURING half breaks rather than when the
  // workload does.
  {
    const stale = { ...healthyMetric, updated: NOW - METRIC_MAX_AGE_MS - 1 }
    const { acts } = drive(
      deployment(TOTAL, TOTAL),
      deployment(PROBE, PROBE),
      probeObject(stale),
    )
    assert(
      !acts.some((a) => a.startsWith('ensure(')),
      `a measurement older than the freshness bound promoted: ${acts.join(', ')}`,
    )
    // ...and one sample INSIDE the bound still promotes, or the bound is really
    // "never promote" and the arm above proves nothing about the boundary.
    const fresh = { ...healthyMetric, updated: NOW - METRIC_MAX_AGE_MS + 1 }
    const ok = drive(deployment(TOTAL, TOTAL), deployment(PROBE, PROBE), probeObject(fresh))
    has(
      ok.acts,
      `ensure(${CANARY},spec.replicas,${TOTAL})`,
      'a measurement just inside the freshness bound was rejected',
    )
  }

  // Every unreadable shape blocks. A consumer reads a document a DIFFERENT
  // program wrote, so these are the ordinary cases, not the exotic ones.
  {
    for (const [what, metric] of [
      ['a probe that does not exist', absent],
      ['a host that could not answer', unknown],
      ['a probe that never published', probeObject(undefined)],
      ['a probe that CLEARED its carry', known(JSON.stringify({ status: { carry: '' } }))],
      ['a document from a future version', probeObject({ ...healthyMetric, v: 2 })],
      ['a document missing its verdict', probeObject({ v: 1, updated: NOW, samples: 3, availability: 1 })],
      ['a carry that is not JSON', known(JSON.stringify({ status: { carry: 'not json' } }))],
    ] as const) {
      const { acts } = drive(
        deployment(TOTAL, TOTAL),
        deployment(PROBE, PROBE),
        metric as Obs<string>,
      )
      assert(
        !acts.some((a) => a.startsWith('ensure(')),
        `${what} promoted the candidate: ${acts.join(', ')}`,
      )
    }
  }

  // ⛔ THE DRAIN EDGE IS GATED TOO, AND IT IS THE IRREVERSIBLE ONE. Once stable
  // is at zero the fallback is gone. A gate that ran only at the earlier edge
  // was evaluated minutes before this moment, at a different candidate scale.
  {
    const degraded = { ...healthyMetric, availability: 0.5, verdict: 'degraded' }
    const { acts } = drive(
      deployment(TOTAL, TOTAL),
      deployment(TOTAL, TOTAL),
      probeObject(degraded),
    )
    assert(
      !acts.some((a) => a === `ensure(${STABLE},spec.replicas,0)`),
      `the fallback was drained while the measurement said degraded: ${acts.join(', ')}`,
    )
    // The control: the identical world with a healthy measurement DOES drain.
    const ok = drive(deployment(TOTAL, TOTAL), deployment(TOTAL, TOTAL))
    has(ok.acts, `ensure(${STABLE},spec.replicas,0)`, 'a healthy measurement did not drain stable')
  }

  // A future-stamped measurement is a broken input, not a very fresh one -
  // otherwise a skewed clock on the probe's node opens the gate permanently.
  assert(
    metricBlocks({ verdict: 'healthy', availability: 1, samples: 12, updated: NOW + 10 * METRIC_MAX_AGE_MS }, NOW) !== null,
    'a measurement stamped far in the future was accepted as fresh',
  )

  // The parser, at the boundary the step cannot reach: a well-formed document
  // must actually parse, or every arm above passes because NOTHING parses.
  {
    const raw = JSON.stringify({ status: { carry: JSON.stringify(healthyMetric) } })
    const m = metricOf(raw)
    assert(m !== null, 'a well-formed published document did not parse')
    assert(m.verdict === 'healthy' && m.samples === 12, `parsed the wrong fields: ${JSON.stringify(m)}`)
    assert(metricBlocks(m, NOW) === null, 'a fresh healthy measurement was reported as blocking')
  }

  console.log('canary.test.ts: runtime guards pass')
}

// ⭐ ***WIRED INTO `bun test`, BECAUSE UNTIL 2026-09-06 IT RAN NOWHERE.***
//
// `runtimeGuards` was exported and called only by a hand-typed `bun -e` line in
// the header comment. `bun test` collects files by their `test()` blocks and
// this file declared none, so bun loaded it, found nothing to run, and reported
// SUCCESS - `0 pass, 0 fail, Ran 0 tests across 5 files`, exit 0. An exit code
// that means "nothing ran" is indistinguishable from one that means "all
// passed" unless you read the count.
//
// The SDK had the identical defect and fixed it in 0f2f5ad3a; this is that fix,
// applied to the examples, which nobody had pointed it at.
test('runtime guards', runtimeGuards)
