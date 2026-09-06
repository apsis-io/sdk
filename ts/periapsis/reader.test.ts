// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import {
  type GroupEff,
  type Handler,
  type Obs,
  type Outcome,
  type Step,
  defineEffect,
  reader,
  runStep,
  runStepAsync,
  where,
  known,
  absent,
  unknown,
  quiesce,
  terminate,
  yieldStep,
  fieldNe,
  path,
} from './perseid.js'

// ═══════════════════════════════════════════════════════════════════════════
// `reader` - the three-valued unwrap, once, instead of 36 times by hand.
//
// ⚠ ***TYPE THE GENERATORS.*** `bun test` strips types without checking them,
// so a suite written with `: any` is green while `tsc` is red - measured in
// where.test.ts. Every step below is annotated so both checkers see it.
// ═══════════════════════════════════════════════════════════════════════════

const read = defineEffect<string, Obs<string>>()('radiant:reconcile/observe@0.1.0', 'get')
type Effs = ReturnType<typeof read> extends Step<infer E, unknown> ? E : never

const TARGET = path.ns('default').deployments('demo')

/** A world of one path, plus a log of what the step actually did. */
function drive(answer: Obs<string>, step: () => Step<Effs, Outcome>) {
  const seen: string[] = []
  const handler = {
    get: (p: unknown) => {
      seen.push(String(p))

      return answer
    },
  } as unknown as Handler<Effs>

  return { outcome: runStep(step, handler), seen }
}

const r = reader(read as unknown as (p: string) => Step<Effs, Obs<string>>)

test('need unwraps and decodes a known read', () => {
  const step = function* (): Step<Effs, Outcome> {
    const dep = yield* r.need('a')
    expect(dep['kind']).toBe('Deployment')

    return quiesce(fieldNe(TARGET, 'spec.replicas', 2))
  }
  const { outcome } = drive(known(JSON.stringify({ kind: 'Deployment' })), step)
  expect(outcome.o).toBe('quiesce')
})

// ⛔ THE POINT OF `need`: the lines AFTER it must not run. A helper that merely
// returned `null` would let the step carry on with a hole in it.
test('need SHORT-CIRCUITS: nothing after it runs', () => {
  let reachedTheEnd = false
  const step = function* (): Step<Effs, Outcome> {
    yield* r.need('a')
    reachedTheEnd = true

    return yieldStep
  }
  const { outcome } = drive(absent, step)
  expect(outcome).toEqual(terminate)
  expect(reachedTheEnd).toBe(false)
})

test('the defaults are absent->terminate and unknown->yield, and they differ', () => {
  const step = function* (): Step<Effs, Outcome> {
    yield* r.need('a')

    return yieldStep
  }
  expect(drive(absent, step).outcome).toEqual(terminate)
  expect(drive(unknown, step).outcome).toEqual(yieldStep)
})

test('the policy is an argument, not a claim about your program', () => {
  const step = function* (): Step<Effs, Outcome> {
    yield* r.need('a', { absent: yieldStep })

    return quiesce(fieldNe(TARGET, 'spec.replicas', 2))
  }
  expect(drive(absent, step).outcome).toEqual(yieldStep)
})

// ⚠ A body we cannot decode is UNKNOWN, never ABSENT - we got an answer and
// could not read it, which is not a statement that the object is gone.
test('an undecodable body takes the unknown path, not the absent one', () => {
  const step = function* (): Step<Effs, Outcome> {
    yield* r.need('a')

    return quiesce(fieldNe(TARGET, 'spec.replicas', 2))
  }
  expect(drive(known('}{ not json'), step).outcome).toEqual(yieldStep)
  // A JSON ARRAY is not an object either, and decoding one into a record would
  // hand the program `{0: …}`.
  expect(drive(known('[1,2]'), step).outcome).toEqual(yieldStep)
})

test('get stays three-valued and decodes', () => {
  const step = function* (): Step<Effs, Outcome> {
    const o = yield* r.get('a')
    expect(o.t).toBe('known')
    if (o.t === 'known') expect(o.v['kind']).toBe('Deployment')

    return yieldStep
  }
  drive(known(JSON.stringify({ kind: 'Deployment' })), step)

  const undecodable = function* (): Step<Effs, Outcome> {
    const o = yield* r.get('a')
    // NOT 'absent'.
    expect(o.t).toBe('unknown')

    return yieldStep
  }
  drive(known('}{'), undecodable)
})

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ THE CASE THAT CHOSE THE IMPLEMENTATION.
//
// A bail is a THROW, not a `@bail` effect, because `driveSync` RECURSES for each
// `@group` arm - an effect would be returned as that arm's VALUE and the step
// would continue holding an `Outcome` where an observation belongs. Silent, and
// typed. A throw unwinds the recursion.
// ═══════════════════════════════════════════════════════════════════════════
test('a bail inside a where/group arm short-circuits the WHOLE step', () => {
  let reachedTheEnd = false
  // The union carries `GroupEff` because `where` yields one - and `bun test`
  // would have passed this typed as `Effs`, while tsc reds. Two checkers, one
  // file, disjoint blind spots.
  const step = function* (): Step<Effs | GroupEff, Outcome> {
    yield* where({ dep: r.need('a') })
    reachedTheEnd = true

    return yieldStep
  }
  const { outcome } = drive(absent, step as unknown as () => Step<Effs, Outcome>)
  expect(outcome).toEqual(terminate)
  expect(reachedTheEnd).toBe(false)
})

// ⚠ `return await` in runStepAsync is load-bearing: a bare `return driveAsync(…)`
// settles the promise outside the try, the catch never runs, and a bail reaches
// the host as a crash. This is the arm that proves it.
test('the ASYNC runner catches a bail too', async () => {
  const step = function* (): Step<Effs, Outcome> {
    yield* r.need('a')

    return yieldStep
  }
  const handler = { get: () => absent } as unknown as Handler<Effs>
  expect(await runStepAsync(step, handler)).toEqual(terminate)
})

test('a real error is NOT swallowed by the bail catch', () => {
  const step = function* (): Step<Effs, Outcome> {
    yield* r.need('a')

    throw new Error('boom')
  }
  expect(() => drive(known('{}'), step)).toThrow('boom')
})
