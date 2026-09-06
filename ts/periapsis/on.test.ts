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
  ready,
  unready,
  unsure,
  path,
  type Handler,
  type Resume,
} from './perseid.js'

const POD = path.ns('default').core('v1', 'pods', 'web')
const A = fieldIs(POD, 'status.phase', 'Running')
const B = fieldIs(POD, 'spec.hostNetwork', true)

// drive runs one pass of a step whose only content is an `on()` dispatch, with
// the host reporting `heldArms`.
function drive(heldArms: number[]): { ran: string[]; resume: Resume | null } {
  const ran: string[] = []
  // ***THE NODE, NOT ITS RENDERING.*** A resume is a tree; keeping it lets the
  // assertions below compare STRUCTURE, which is the thing `on` is responsible
  // for building. Rendering here would put the tests back on the text the SDK
  // stopped reasoning about.
  let resume: Resume | null = null
  const step = function* () {
    resume = yield* on
      // eslint-disable-next-line require-yield
      .when(A, function* () { ran.push('A') })
      // eslint-disable-next-line require-yield
      .when(B, function* () { ran.push('B') })

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
test('the resume is every arm, in order', () => {
  const r = drive([]).resume

  // ***THE TREE, ASSERTED DIRECTLY.*** This used to be three substring checks
  // and an `indexOf` comparison over the rendered text - a way of asking about
  // ORDER without being able to see it. The disjunction's children ARE the order.
  expect(r?.kind).toBe('or')
  expect(r?.of).toEqual([A, B])
  expect(r?.operands).toBe(2)
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
    yield* on
      .when(A, function* () {
        yield* nsRead(POD)
        ran.push('ns')
      })
      .when(B, function* () {
        yield* clusterRead(path.nodes('n1'))
        ran.push('cluster')
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

// ⭐ ***THE OPERAND COUNT IS STRUCTURAL NOW, NOT SCANNED.*** This replaces
// `topLevelOrCount`, which recovered the same number from the rendered text.
// Same shapes, including the two the scanner was written to survive - they are
// kept because they are what a text-based count got WRONG, and a walk should be
// shown to handle them rather than assumed to.
test('operands counts what the host flattens', () => {
  expect(A.operands).toBe(1) // fieldIs: one comparison
  expect(WIDE_A.operands).toBe(2) // fieldNoLonger: !exists || !=

  // ***A `||` INSIDE A QUOTED PATH IS NOT AN OPERAND.*** A scanner had to know
  // about string literals to get this right; a tree never sees the text.
  const weird = fieldIs(path.ns('default').core('v1', 'pods', 'web'), 'metadata.annotations["a||b"]', 'x')
  expect(weird.operands).toBe(1)

  // ***NESTING IS SUMMED, NOT TOP-LEVEL-ONLY.*** `anyOf(anyOf(a,b), c)` is three
  // operands to the host, which flattens `||` recursively on both sides - the
  // asymmetry that made an arm's index depend on where a nested disjunction sat.
  expect(anyOf(anyOf(A, B), WIDE_A).operands).toBe(4)
  expect(anyOf(A, anyOf(B, WIDE_A)).operands).toBe(4)

  // ⛔ AND `&&` IS NOT DESCENDED INTO: the host flattens disjunction only, so a
  // conjunction of any width is ONE operand.
  expect(allOf(A, B, WIDE_A).operands).toBe(1)
})

function driveWide(heldArms: number[]): string[] {
  const ran: string[] = []
  const step = function* () {
    yield* on
      // eslint-disable-next-line require-yield
      .when(WIDE_A, function* () { ran.push('A') })
      // eslint-disable-next-line require-yield
      .when(WIDE_B, function* () { ran.push('B') })

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
  // ***THE TREE, NOT ITS RENDERING.*** Folding is a structural operation - a
  // child is dropped - so asserting it through the text would be checking a
  // consequence instead of the thing itself.
  const plain = anyOf(A, B)
  expect(anyOf(A, B, backstop())).toEqual(plain)
  // Position must not matter: folding is not "drop the last one".
  expect(anyOf(A, backstop(), B)).toEqual(plain)
  expect(anyOf(backstop(), A, B)).toEqual(plain)
  // And the fold really removed a child rather than rendering around it.
  expect(anyOf(A, B, backstop()).of).toHaveLength(2)
})

// ⭐ THE PROPERTY THAT MATTERS, STATED AS THE THING on() ACTUALLY READS.
test('a backstop operand does not shift arm indices', () => {
  expect(anyOf(A, B, backstop()).operands).toBe(anyOf(A, B).operands)
})

// Alone it IS the park: `false`, which is what untilBackstop means.
test('a park of nothing but backstops is the backstop-only park', () => {
  expect(anyOf(backstop())).toBe(untilBackstop)
  expect(anyOf(backstop(), backstop())).toBe(untilBackstop)
  // `toBe` is right HERE and nowhere else in this file: the backstop is a
  // singleton node, so folding to it should return that exact instance rather
  // than an equal-looking copy.
  expect(backstop()).toBe(untilBackstop)
})

// ⛔ NOT IN allOf. `X && false` is `false` - folding there would turn a park into
// one that can never fire, which is the opposite of the intent.
test('allOf does NOT fold a backstop', () => {
  expect(allOf(A, backstop()).of).toEqual([A, backstop()])
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
    yield* on.when(A, nsRead(POD))

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
    yield* on.when(A, [nsRead(POD), nsRead(OTHER)])

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
    yield* on.when(A, [nsRead(POD)])

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

// ═══════════════════════════════════════════════════════════════════════════
// THE FLUENT BUILDER: `.each`, and the immutability the shared root depends on.
// ═══════════════════════════════════════════════════════════════════════════

const SUBJECTS = [
  { at: path.ns('default').core('v1', 'pods', 'a'), tag: 'a' },
  { at: path.ns('default').core('v1', 'pods', 'b'), tag: 'b' },
  { at: path.ns('default').core('v1', 'pods', 'c'), tag: 'c' },
]

function driveEach(heldArms: number[]): { ran: string[]; resume: string } {
  const ran: string[] = []
  let resume = ''
  const step = function* () {
    resume = String(
      // eslint-disable-next-line require-yield
      yield* on.each(SUBJECTS, (s) => [fieldIs(s.at, 'status.phase', 'Running'),
        // eslint-disable-next-line require-yield
        function* () { ran.push(s.tag) }]),
    )

    return { o: 'yield' as const }
  }
  runStep(step as never, { held: () => heldArms } as unknown as Handler<never>)

  return { ran, resume }
}

// ⭐ ONE ARM PER ITEM, IN LIST ORDER - so an index still names a position.
test('each adds one arm per item, in order', () => {
  expect(driveEach([0]).ran).toEqual(['a'])
  expect(driveEach([1]).ran).toEqual(['b'])
  expect(driveEach([2]).ran).toEqual(['c'])
  expect(driveEach([0, 2]).ran).toEqual(['a', 'c'])
  // Past the end is skipped, not wrapped.
  expect(driveEach([3]).ran).toEqual([])
})

test('each contributes every subject to the resume', () => {
  const r = driveEach([]).resume
  for (const s of SUBJECTS) expect(r).toContain(String(s.at))
})

// ⛔⛔ ***THE SHARED ROOT MUST NOT ACCUMULATE.*** `on` is a MODULE-LEVEL value
// reached by every pass. If `.when` pushed onto its own array instead of
// returning a new builder, the root would grow by one arm per call per pass -
// the park would gain duplicate operands and every index after the first would
// shift, so the wrong handler would run. The failure is silent and cumulative:
// pass 1 is correct, pass 40 is not.
test('the shared on root is never mutated by building a chain', () => {
  const first = driveEach([]).resume
  // Build several unrelated chains off the same root, and use them.
  drive([])
  driveWide([])
  driveEach([])
  const again = driveEach([]).resume

  expect(again).toBe(first)
  // And the root itself still has no arms: a chain of one arm has no `||`.
  const solo = function* () {
    // eslint-disable-next-line require-yield
    return String(yield* on.when(A, function* () {}))
  }
  let seen = ''
  runStep(
    function* () {
      seen = yield* solo()

      return { o: 'yield' as const }
    } as never,
    { held: () => [] } as unknown as Handler<never>,
  )
  expect(seen).not.toContain('||')
})
