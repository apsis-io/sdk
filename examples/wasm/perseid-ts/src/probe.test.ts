// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Runtime guards for the measuring program. Same shape as `canary.test.ts`:
//
//	bun -e 'import("./src/probe.test.ts").then((m) => m.runtimeGuards())'

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
  type Sample,
  HEALTHY_AVAILABILITY,
  MIN_SAMPLES,
  WINDOW,
  availabilityOf,
  observedOf,
  probeStep,
  publish,
  rolled,
  verdictOf,
  windowOf,
} from './probe.js'

const deployment = (spec: number, ready: number): Obs<string> =>
  known(JSON.stringify({ spec: { replicas: spec }, status: { readyReplicas: ready } }))

// The carry as it appears ON THE WIRE. The step returns an `Outcome` whose
// `carry` property is exactly what the host writes to `status.carry`, so this
// drives the same round trip production does.
type Driven = { outcome: Outcome; acts: string[]; carry: string | undefined }

function drive(subject: Obs<string>, carryIn: string, now: number): Driven {
  const acts: string[] = []
  // ***THE CARRY ARRIVES THROUGH THE HANDLER, LIKE EVERY OTHER EFFECT.*** It is
  // `carry.get()` in production, so a test that injected it as a constructor
  // argument would be driving a path the component does not have - and would
  // still pass if the program stopped asking for it at all.
  const handler: Handler<Effs> = {
    get: () => subject,
    status: (condition) => acts.push(`set(${condition.type}=${condition.status}/${condition.reason})`),
    carry: () => carryIn,
  }
  const outcome = runStep(probeStep(() => now), handler)

  return { outcome, acts, carry: (outcome as { carry?: string }).carry }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Run n passes, feeding each pass the previous one's published carry. */
function passes(n: number, at: (i: number) => Obs<string>): Driven {
  let carry = ''
  let last: Driven | null = null
  for (let i = 0; i < n; i++) {
    last = drive(at(i), carry, 1_000 + i * 15_000)
    // ***THE HOST'S FOLD, REPRODUCED: absent KEEPS, empty CLEARS, else SETS.***
    // Collapsing the first two here would make every arm below pass while
    // production erased a probe's memory on every silent pass.
    if (last.carry !== undefined) carry = last.carry
  }
  assert(last !== null, 'passes(0) measures nothing')

  return last
}

const published = (d: Driven) => JSON.parse(d.carry!) as ReturnType<typeof publish>

export function runtimeGuards(): void {
  // ═══════════════════════════════════════════════════════════════════════════
  // The measurement itself.
  // ═══════════════════════════════════════════════════════════════════════════

  // A window accumulates ACROSS passes, which is the whole reason this program
  // exists. One pass is not a measurement.
  {
    const one = passes(1, () => deployment(3, 3))
    assert(published(one).samples === 1, 'a single pass did not record its sample')
    assert(published(one).verdict === 'warming', 'a single sample produced a verdict')

    const many = passes(MIN_SAMPLES, () => deployment(3, 3))
    assert(
      published(many).samples === MIN_SAMPLES,
      `expected ${MIN_SAMPLES} samples, got ${published(many).samples}`,
    )
    assert(published(many).verdict === 'healthy', 'a fully-ready workload did not read healthy')
  }

  // ***THE ARM THAT SEPARATES A METRIC FROM A READING.*** At the final pass the
  // workload is FULLY READY - so anything that looked only at the current state
  // would say healthy. The window remembers that it was not.
  {
    const flapping = passes(MIN_SAMPLES + 2, (i) =>
      i % 2 === 0 ? deployment(3, 0) : deployment(3, 3),
    )
    const p = published(flapping)
    assert(p.window[p.window.length - 1]![1] === 3, 'the last sample was not fully ready')
    assert(
      p.verdict === 'degraded',
      `a workload that was down half the window read ${p.verdict} while its LAST sample was healthy`,
    )
  }

  // The ring is bounded: the carry is an apiserver write, not a history.
  {
    const long = passes(WINDOW + 5, () => deployment(2, 2))
    assert(
      published(long).window.length === WINDOW,
      `window grew to ${published(long).window.length}, past the ${WINDOW} bound`,
    )
    // ANTI-VACUITY on the bound: it must be the NEWEST samples that survive.
    // A `slice(0, WINDOW)` keeps the count correct and the measurement frozen
    // at the program's first three minutes, forever.
    const ts = published(long).window.map((s) => s[0])
    assert(
      ts[ts.length - 1]! > ts[0]!,
      'the window is not ordered oldest-to-newest, so the ring dropped the wrong end',
    )
    assert(
      ts[0]! > 1_000,
      'the ring kept the OLDEST samples: the measurement can never change again',
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The carry protocol. These are the arms that would silently destroy state.
  // ═══════════════════════════════════════════════════════════════════════════

  // A pass that cannot parse its subject says NOTHING about the carry, so the
  // window survives. Absent key, not empty string.
  {
    const before = passes(MIN_SAMPLES, () => deployment(3, 3)).carry!
    const bad = drive(known('{not json'), before, 99_000)
    assert(bad.carry === undefined, 'an unreadable observation overwrote the window')
    assert(bad.acts.some((a) => a.includes('SubjectUnreadable')), 'no gate was reported')
  }

  // ⚠ AND `unknown` IS THE OTHER ONE: the host could not answer. It must not be
  // read as "zero ready", which would punch a false outage into the window.
  {
    const before = passes(MIN_SAMPLES, () => deployment(3, 3)).carry!
    const unk = drive(unknown, before, 99_000)
    assert(unk.carry === undefined, 'an UNKNOWN observation was recorded as a sample')
    assert(unk.acts.length === 0, 'an unknown observation reported a verdict it did not have')
  }

  // A vanished subject CLEARS, deliberately - the empty string, not an absent
  // key. This is the only place the two differ in effect and the one that a
  // consumer's gate depends on: a stale `healthy` about a deleted workload is
  // exactly what a promotion must not read.
  {
    const before = passes(MIN_SAMPLES, () => deployment(3, 3)).carry!
    const gone = drive(absent, before, 99_000)
    assert(
      gone.carry === '',
      `a vanished subject left the measurement as ${JSON.stringify(gone.carry)}; ` +
        'undefined would KEEP the stale window',
    )
    assert(gone.acts.some((a) => a.includes('SubjectMissing')), 'no gate was reported')
  }

  // A carry this program cannot read starts a fresh window rather than failing
  // the pass forever. The version field is the discriminator.
  {
    // ***THE CARRY IS AN OBJECT NOW, so the unreadable shapes are shapes rather
    // than unparseable text - `carryOf` already turned junk text into `{}` before
    // this sees it. The version field is still the discriminator.
    for (const junk of [{}, { v: 2, window: [[1, 1, 1]] }, { v: 1 }, { window: [[1, 2, 3]] }]) {
      assert(windowOf(junk).length === 0, `an unreadable carry was accepted: ${JSON.stringify(junk)}`)
    }
    // ...and a well-formed one IS read, or the line above passes vacuously.
    assert(windowOf({ v: 1, window: [[1, 2, 3]] }).length === 1, 'a valid carry was discarded')
    // A window with a malformed member keeps the members that parse.
    assert(
      windowOf({ v: 1, window: [[1, 2, 3], 'nope', [4, 5]] }).length === 1,
      'malformed samples were not filtered out of an otherwise valid window',
    )
    // ⭐ AND A KEY BESIDE IT IS UNDISTURBED - the reason for the object.
    assert(windowOf({ v: 1, window: [[1, 2, 3]], $on: ['x'] }).length === 1,
      'a reserved SDK key broke the program\'s own window')
  }

  // An unchanged measurement must produce an unchanged STRING, or the probe
  // writes the Perseid object on every pass forever.
  {
    const w: Sample[] = [
      [1, 2, 3],
      [2, 2, 3],
    ]
    assert(
      JSON.stringify(publish(w, 5)) === JSON.stringify(publish(w, 5)),
      'publish is not deterministic',
    )
    // 2/3 is 0.6666..., which is exactly the value that would wander if the
    // rounding were removed. This is the arm that fails if it is.
    assert(
      String(publish(w, 5).availability).length <= 5,
      `availability ${publish(w, 5).availability} is not rounded, so its digits will churn`,
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The pure functions, at their boundaries.
  // ═══════════════════════════════════════════════════════════════════════════

  // A DRAINED workload is not an unavailable one - the consumer of this metric
  // drains things, so reading spec=0 as 0% would make it gate on its own action.
  assert(availabilityOf([[1, 0, 0]]) === 1, 'a deliberately drained workload read as unavailable')

  // The verdict boundary, both sides, because a `>` for a `>=` is invisible.
  {
    const at = (ready: number, spec: number): Sample[] =>
      Array.from({ length: MIN_SAMPLES }, (_, i) => [i, ready, spec] as Sample)
    assert(availabilityOf(at(19, 20)) === HEALTHY_AVAILABILITY, 'the fixture is not at the boundary')
    assert(verdictOf(at(19, 20)) === 'healthy', 'exactly at the threshold did not read healthy')
    assert(verdictOf(at(18, 20)) === 'degraded', 'below the threshold read healthy')
  }

  // One sample short of the minimum is `warming`, not a verdict on thin evidence.
  {
    const short: Sample[] = Array.from(
      { length: MIN_SAMPLES - 1 },
      (_, i) => [i, 0, 3] as Sample,
    )
    assert(verdictOf(short) === 'warming', 'a verdict was issued below the sample minimum')
  }

  // The parser keeps Kubernetes' distinction: omitted readiness is zero, an
  // omitted desired count is unknown. Same guard as canary.ts, same reason.
  assert(
    observedOf(JSON.stringify({ spec: { replicas: 3 }, status: {} }))?.ready === 0,
    'omitted readyReplicas is not interpreted as zero',
  )
  for (const bad of [{ replicas: '3' }, { replicas: null }, {}]) {
    assert(
      observedOf(JSON.stringify({ spec: bad, status: {} })) === null,
      `a non-numeric spec.replicas was accepted: ${JSON.stringify(bad)}`,
    )
  }

  // `rolled` is the ring, in isolation.
  assert(rolled([], [1, 1, 1]).length === 1, 'the first sample was dropped')

  console.log('probe.test.ts: runtime guards pass')
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
