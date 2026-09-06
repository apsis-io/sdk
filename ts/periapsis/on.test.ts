// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import {
  on,
  reconcile,
  runStep,
  anyOf,
  allOf,
  backstop,
  untilBackstop,
  fieldIs,
  fieldNoLonger,
  topLevelOrCount,
  ready,
  unready,
  unsure,
  path,
  type Handler,
} from './perseid.js'

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
      yield* on(
        // eslint-disable-next-line require-yield
        [A, function* () { ran.push('A') }],
        // eslint-disable-next-line require-yield
        [B, function* () { ran.push('B') }],
      ),
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
    yield* on(
      [
        A,
        function* () {
          yield* nsRead(POD)
          ran.push('ns')
        },
      ],
      [
        B,
        function* () {
          yield* clusterRead(path.nodes('n1'))
          ran.push('cluster')
        },
      ],
    )

    return { o: 'yield' as const }
  }
  runStep(step as never, {
    held: () => [1],
    get: () => ({ t: 'absent' }),
    getCluster: () => ({ t: 'absent' }),
  } as unknown as Handler<never>)

  expect(ran).toEqual(['cluster'])
})

// ⛔⛔ ***AN ARM THAT IS ITSELF A DISJUNCTION SHIFTS EVERY HOST INDEX AFTER IT.***
//
// `HeldDisjuncts` flattens `||` recursively - it must, because the host wraps the
// resume as `(<own>) || Backstop()`. It cannot distinguish that from an arm's own
// nesting, and `fieldNoLonger` is nested by necessity: `(!exists) || (!= v)`.
//
// MEASURED LIVE on `sentinel-demo`: four `fieldNoLonger` arms became EIGHT
// operands, the host reported an index into the eight, `keys[i]` was undefined
// and the program dispatched nothing - `via 4 of 4, no dispatch` - while its park
// had correctly fired. `on()` now maps the flat index through each arm's width.
const NODE = path.nodes('n1')
const WIDE_A = fieldNoLonger(POD, 'status.phase', 'Running') // (!exists) || (!=)
const WIDE_B = fieldNoLonger(NODE, 'spec.unschedulable', true)

test('topLevelOrCount counts what the host flattens', () => {
  expect(topLevelOrCount(String(A))).toBe(1) // fieldIs: one comparison
  expect(topLevelOrCount(String(WIDE_A))).toBe(2) // fieldNoLonger: !exists || !=
  // ***QUOTE-AWARE.*** A field path is a quoted string and may contain anything;
  // a naive split would see an operand that is not there.
  expect(topLevelOrCount('Get("a", "b || c") == "x"')).toBe(1)
  // ***AND PAREN-AWARE.*** Only TOP-level bars separate operands.
  expect(topLevelOrCount('((a || b)) || c')).toBe(2)
})

function driveWide(heldArms: number[]): string[] {
  const ran: string[] = []
  const step = function* () {
    yield* on(
      // eslint-disable-next-line require-yield
      [WIDE_A, function* () { ran.push('A') }],
      // eslint-disable-next-line require-yield
      [WIDE_B, function* () { ran.push('B') }],
    )

    return { o: 'yield' as const }
  }
  runStep(step as never, { held: () => heldArms } as unknown as Handler<never>)

  return ran
}

test('a flat index lands in the right ARM when arms are two operands wide', () => {
  // Arm A occupies host indices 0..1, arm B occupies 2..3.
  expect(driveWide([0])).toEqual(['A'])
  expect(driveWide([1])).toEqual(['A'])
  expect(driveWide([2])).toEqual(['B'])
  expect(driveWide([3])).toEqual(['B'])
  // Past the end is still skipped rather than wrapped.
  expect(driveWide([4])).toEqual([])
})

// ⛔ ONCE PER ARM, NOT ONCE PER OPERAND. Both halves of `(!exists) || (!= v)` can
// hold at the same wake - an absent field satisfies the first and is `!=`
// anything - and the program declared ONE handler for that condition.
test('both operands of one arm run its handler once', () => {
  expect(driveWide([0, 1])).toEqual(['A'])
  expect(driveWide([2, 3])).toEqual(['B'])
  expect(driveWide([0, 1, 2, 3])).toEqual(['A', 'B'])
})

// ═══════════════════════════════════════════════════════════════════════════
// `backstop()` - SAYING "and otherwise, eventually" WITHOUT SPENDING AN INDEX.
//
// The host renders `(<the whole user resume>) || Backstop()` onto every park, so
// this adds no liveness. What it must not do is COST AN OPERAND: the host
// reports which flattened operand held, so a `false` that can never hold would
// still shift every arm after it and dispatch the wrong handler.
// ═══════════════════════════════════════════════════════════════════════════

test('anyOf FOLDS a backstop operand away - X || false is X', () => {
  const plain = anyOf(A, B)
  expect(String(anyOf(A, B, backstop()))).toBe(String(plain))
  // Position must not matter: folding is not "drop the last one".
  expect(String(anyOf(A, backstop(), B))).toBe(String(plain))
  expect(String(anyOf(backstop(), A, B))).toBe(String(plain))
})

// ⭐ THE PROPERTY THAT MATTERS, STATED AS THE THING on() ACTUALLY READS.
test('a backstop operand does not shift arm indices', () => {
  expect(topLevelOrCount(String(anyOf(A, B, backstop())))).toBe(
    topLevelOrCount(String(anyOf(A, B))),
  )
})

// Alone it IS the park: `false`, which is what untilBackstop means.
test('a park of nothing but backstops is the backstop-only park', () => {
  expect(String(anyOf(backstop()))).toBe(String(untilBackstop))
  expect(String(anyOf(backstop(), backstop()))).toBe(String(untilBackstop))
})

// ⛔ NOT IN allOf. `X && false` is `false` - folding there would turn a park into
// one that can never fire, which is the opposite of the intent.
test('allOf does NOT fold a backstop', () => {
  expect(String(allOf(A, backstop()))).toContain('false')
})

// ═══════════════════════════════════════════════════════════════════════════
// ARM SHAPES: a thunk, a bare Step, or a LIST of steps.
//
// The list is what removes `function* () { yield* a; yield* b }` from an arm
// that just declares two obligations.
// ═══════════════════════════════════════════════════════════════════════════

test('a bare Step arm needs no function* wrapper', () => {
  const seen: string[] = []
  const step = function* () {
    yield* on([A, nsRead(POD)])

    return { o: 'yield' as const }
  }
  runStep(step as never, {
    held: () => [0],
    get: (p: unknown) => {
      seen.push(String(p))

      return { t: 'absent' }
    },
  } as unknown as Handler<never>)

  expect(seen).toEqual([String(POD)])
})

// ⭐ IN ORDER. An arm declares obligations; `group`/`where` are where
// concurrency is asked for explicitly. If a list interleaved, the order of two
// writes would depend on which sugar the author reached for.
test('a LIST arm runs every step, in order', () => {
  const seen: string[] = []
  const OTHER = path.ns('default').core('v1', 'pods', 'other')
  const step = function* () {
    yield* on([A, [nsRead(POD), nsRead(OTHER)]])

    return { o: 'yield' as const }
  }
  runStep(step as never, {
    held: () => [0],
    get: (p: unknown) => {
      seen.push(String(p))

      return { t: 'absent' }
    },
  } as unknown as Handler<never>)

  expect(seen).toEqual([String(POD), String(OTHER)])
})

// An arm that does not fire is never advanced - generators are lazy, so building
// the Step costs nothing but running it.
test('an unheld list arm runs nothing', () => {
  const seen: string[] = []
  const step = function* () {
    yield* on([A, [nsRead(POD)]])

    return { o: 'yield' as const }
  }
  runStep(step as never, {
    held: () => [],
    get: (p: unknown) => {
      seen.push(String(p))

      return { t: 'absent' }
    },
  } as unknown as Handler<never>)

  expect(seen).toEqual([])
})

// ═══════════════════════════════════════════════════════════════════════════
// The condition shorthands. `type: 'Ready'` was constant in 37 of 37 report()
// calls across the example programs.
// ═══════════════════════════════════════════════════════════════════════════

test('ready/unready/unsure differ only in status, and Unknown is not False', () => {
  expect(ready('Converged', 'm')).toEqual({
    type: 'Ready', status: 'True', reason: 'Converged', message: 'm',
  })
  expect(unready('Drifted', 'm').status).toBe('False')
  // ⛔ `Unknown` asserts NOTHING; `False` asserts not-ready. Collapsing them is
  // the three-valued defect arriving in what an operator is told.
  expect(unsure('Unreadable', 'm').status).toBe('Unknown')
  expect(unsure('Unreadable', 'm').status).not.toBe(unready('Unreadable', 'm').status)
})
