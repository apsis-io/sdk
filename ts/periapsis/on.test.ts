// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import { on, reconcile, runStep, fieldIs, path, type Handler, type Resume } from './perseid.js'

const POD = path.ns('default').core('v1', 'pods', 'web')
const A = fieldIs(POD, 'status.phase', 'Running')
const B = fieldIs(POD, 'spec.hostNetwork', true)

// drive runs one pass of a step whose only content is an `on()` dispatch, with
// the host reporting `heldArms`.
function drive(heldArms: number[]): { ran: string[]; resume: string } {
  const ran: string[] = []
  let resume = ''
  const step = function* () {
    resume = String(
      yield* on({
        // eslint-disable-next-line require-yield
        [A]: function* () { ran.push('A') },
        // eslint-disable-next-line require-yield
        [B]: function* () { ran.push('B') },
      }),
    )

    return { o: 'yield' as const }
  }
  runStep(step as never, { held: () => heldArms } as unknown as Handler<never>)

  return { ran, resume }
}

// ⭐ THE HANDLER FOR THE ARM THAT HELD RUNS, AND ONLY IT.
test('the held arm dispatches', () => {
  expect(drive([0]).ran).toEqual(['A'])
  expect(drive([1]).ran).toEqual(['B'])
})

// ⛔ EVERY ARM THAT HOLDS RUNS. Two conditions can be true at once and the
// program declared a handler for each; a `switch` would drop one silently and
// pick a different one on a different day.
test('every held arm runs, not the first', () => {
  expect(drive([0, 1]).ran).toEqual(['A', 'B'])
})

// ⚠ NOTHING HELD IS THE COMMON CASE - a backstop tick, or an older host that
// does not serve the interface. No handler runs and the step must still be
// correct; `on()` makes the LATE case safe, not the missing one.
test('nothing held runs nothing', () => {
  expect(drive([]).ran).toEqual([])
})

// ⛔ AN INDEX THIS MAP DOES NOT HAVE IS SKIPPED, NOT WRAPPED. If the map changed
// between passes the host's indices name arms that moved - running some OTHER
// handler would act on a condition nobody asserted.
test('an out-of-range index runs nothing rather than the wrong handler', () => {
  expect(drive([7]).ran).toEqual([])
  expect(drive([1, 7]).ran).toEqual(['B'])
})

// ***THE RESUME IS THE DISJUNCTION OF THE KEYS, IN MAP ORDER*** - which is what
// makes an index a key's position on the next pass.
test('the resume is every key, in order', () => {
  const r = drive([]).resume
  expect(r).toContain(String(A))
  expect(r).toContain(String(B))
  expect(r.indexOf(String(A))).toBeLessThan(r.indexOf(String(B)))
  expect(r).toContain('||')
})

// ⭐ ***HETEROGENEOUS ARMS MUST TYPECHECK, AND UNTIL 2026-09-06 THEY DID NOT.***
//
// `on()` took `Record<string, () => Generator<E, …>>` with a naked `E`, so
// TypeScript fixed `E` to the FIRST arm's effect and reported every other arm as
// `not assignable`. That breaks it in precisely its intended case: the reason to
// dispatch on several arms is that they watch DIFFERENT subjects, and different
// subjects are read with different effects - a namespaced `observe` against a
// cluster-scoped `observe-cluster`.
//
// ***THE FIRST PROGRAM WRITTEN TO USE `on()` FOR ITS PURPOSE DID NOT COMPILE***
// (examples/wasm/perseid-ts/src/sentinel.ts). Found by writing a real user, not
// by reading the signature - the unit tests above all use arms that yield
// NOTHING, so every one of them passed against the broken form and would pass
// against it again.
//
// ⚠ THIS IS A TYPE-LEVEL GUARD AND `bun test` STRIPS TYPES. It fails under
// `tsc --noEmit`, which is a different instrument and the only one that can see
// it - the same split that let the SDK's `tsc` sit red for three days while
// `bun test` was green. The runtime assertion below is deliberately trivial; the
// compile is the assertion.

// ⭐ ***HETEROGENEOUS ARMS MUST TYPECHECK, AND UNTIL 2026-09-06 THEY DID NOT.***
//
// `on()` took `Record<string, () => Generator<E, …>>` with a naked `E`, so
// TypeScript fixed `E` to the FIRST arm's effect and reported every other arm as
// `not assignable`. That breaks it in precisely its intended case: the reason to
// dispatch on several arms is that they watch DIFFERENT subjects, and different
// subjects are read with different effects.
//
// ***THE FIRST PROGRAM WRITTEN TO USE `on()` FOR ITS PURPOSE DID NOT COMPILE***
// (examples/wasm/perseid-ts/src/sentinel.ts). Found by writing a real user, not
// by reading the signature: every test above uses arms that yield NOTHING, so
// all of them passed against the broken form.
//
// ⛔ ***THE EFFECTS MUST BE REAL ONES FROM `reconcile`, AND THE FIRST VERSION OF
// THIS TEST WAS VACUOUS FOR MISSING THAT.*** It yielded `{...} as never` to
// satisfy the fake handler - and `never` unifies with everything, so both arms
// had the SAME yield type and the old signature accepted them. Mutation-checked:
// with `as never`, reverting `on()` to the old signature left `tsc` at rc=0.
// With the real `observe`/`observeCluster` effects below it goes red.
//
// ⚠ AND IT IS A TYPE-LEVEL GUARD, SO `bun test` CANNOT SEE IT - it strips types.
// Only `tsc --noEmit` runs this assertion; the runtime expectation is incidental.
const nsRead = reconcile.observe<string>()
const clusterRead = reconcile.observeCluster<string>()

test('arms yielding DIFFERENT effect types unify rather than fixing on the first', () => {
  const ran: string[] = []
  const step = function* () {
    yield* on({
      [A]: function* () {
        yield* nsRead(POD)
        ran.push('ns')
      },
      [B]: function* () {
        yield* clusterRead(path.nodes('n1'))
        ran.push('cluster')
      },
    })

    return { o: 'yield' as const }
  }
  runStep(step as never, {
    held: () => [1],
    get: () => ({ t: 'absent' }),
    getCluster: () => ({ t: 'absent' }),
  } as unknown as Handler<never>)

  expect(ran).toEqual(['cluster'])
})
