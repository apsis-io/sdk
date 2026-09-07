// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// `watch` - declare the conditions, ask which held, act yourself.
//
// ***THIS FILE REPLACED `on.test.ts` (2026-09-07), AND ROUGHLY A THIRD OF THAT
// FILE IS NOT REPRODUCED HERE.*** Those tests were about ARMS RUNNING: a plain
// function arm, a bare Step arm needing no `function*`, a LIST arm running in
// order, an unheld list arm running nothing, and arms with different effect
// types unifying rather than fixing on the first. Every one of them tested a
// mechanism that exists because a condition CARRIED CODE. Nothing carries code
// now, so there is nothing left to assert - the program writes its own `if`.
//
// What is kept is everything about MATCHING and about the PARK, because that is
// the part that survived the redesign unchanged.
// ═══════════════════════════════════════════════════════════════════════════

import { expect, test } from 'bun:test'
import {
  watch,
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

/**
 * The `n`th LEAF of a condition, as the host would report it.
 *
 * ***THE HOST ANSWERS WITH OPERAND TEXT, AND A CONDITION MAY OWN SEVERAL.***
 * `fieldNoLonger` renders `(!exists) || (!= v)`, so it has two leaves and either
 * one holding means that condition held. This is how a test says "the host
 * reported THIS operand" without knowing or caring where it sat.
 */
const leafOf = (c: Resume, n: number): string => {
  const out: string[] = []
  const walk = (x: Resume): void => {
    if (x.of.length > 0) x.of.forEach(walk)
    else out.push(x.render())
  }
  walk(c)
  const got = out[n]
  if (got === undefined) throw new Error(`leafOf: no leaf ${n} (has ${out.length})`)

  return got
}

/**
 * One pass over a two-condition set, with the host reporting `texts`.
 *
 * Returns which NAMES the step saw as held - the program's own `if`s do the
 * pushing, which is exactly the point: this harness contains the control flow
 * that used to live inside `on`.
 */
function drive(texts: string[]): { named: string[]; resume: Resume | null; size: number } {
  const named: string[] = []
  // ***THE NODE, NOT ITS RENDERING.*** A resume is a tree; keeping it lets the
  // assertions below compare STRUCTURE, which is what `watch` is responsible for
  // building. Rendering here would put the tests back on the text the SDK
  // stopped reasoning about.
  const out: { resume: Resume | null; size: number } = { resume: null, size: 0 }
  const step = function* () {
    const W = watch({ a: A, b: B })
    const held = yield* W.held()
    if (held.has('a')) named.push('a')
    if (held.has('b')) named.push('b')
    out.resume = W.resume
    out.size = held.size

    return { o: 'yield' as const }
  }
  runStep(step as never, { held: () => texts } as unknown as Handler<never>)

  return { named, resume: out.resume, size: out.size }
}

// ⭐ THE CONDITION THAT HELD IS NAMED, AND ONLY IT.
test('the held condition is named', () => {
  expect(drive([A.render()]).named).toEqual(['a'])
  expect(drive([B.render()]).named).toEqual(['b'])
})

// ***EVERY CONDITION THAT HELD, NOT THE FIRST.*** Two can be true at one wake
// and the program declared a branch for each; a `switch` would drop one.
test('every held condition is named, not the first', () => {
  expect(drive([A.render(), B.render()]).named).toEqual(['a', 'b'])
})

// ⛔ THE FALLBACK'S PRECONDITION. Empty is what a backstop tick, a first pass and
// a host without `woke` all produce, and it must name nothing rather than
// guessing.
test('nothing held names nothing', () => {
  const got = drive([])
  expect(got.named).toEqual([])
  expect(got.size).toBe(0)
})

// ***AN OPERAND NO CONDITION OWNS IS AN HONEST NOTHING.*** The set changed since
// the park was built, so what held is something this pass no longer watches.
// Naming a neighbour would report a condition nobody asserted - which is exactly
// what an INDEX did silently, and the reason the wire format is text.
test('an operand no condition owns names nothing rather than the wrong one', () => {
  const stranger = fieldIs(path.ns('default').core('v1', 'pods', 'other'), 'status.phase', 'Failed')
  expect(drive([stranger.render()]).named).toEqual([])
})

test('the resume is every condition, in order', () => {
  expect(drive([]).resume).toEqual(anyOf(A, B))
})

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-OPERAND CONDITIONS - the case that broke dispatch when it used indices.
// ═══════════════════════════════════════════════════════════════════════════

const D1 = path.ns('default').deployments('one')
const D2 = path.ns('default').deployments('two')
const W1 = fieldNoLonger(D1, 'status.readyReplicas', 2)
const W2 = fieldNoLonger(D2, 'status.readyReplicas', 1)

function driveWide(texts: string[]): string[] {
  const named: string[] = []
  const step = function* () {
    const held = yield* watch({ one: W1, two: W2 }).held()
    if (held.has('one')) named.push('one')
    if (held.has('two')) named.push('two')

    return { o: 'yield' as const }
  }
  runStep(step as never, { held: () => texts } as unknown as Handler<never>)

  return named
}

// ⛔ ***THE LIVE DEFECT, PINNED.*** `fieldNoLonger` renders `(!exists) || (!= v)`,
// so two conditions are FOUR operands to the host. Under indices, a wake on the
// second condition's operands landed inside the first's range and published a
// healthy verdict about a Deployment with no pods. By text there is no range to
// land in.
test('an operand of the SECOND condition names the second, not the first', () => {
  expect(driveWide([leafOf(W2, 0)])).toEqual(['two'])
  expect(driveWide([leafOf(W2, 1)])).toEqual(['two'])
})

// ***ONCE PER CONDITION, NOT ONCE PER OPERAND.*** Both halves can hold at one
// wake - an absent field satisfies `!exists` and, being absent, is also `!=`
// anything - and the program declared ONE name for it.
test('both operands of one condition name it once', () => {
  expect(driveWide([leafOf(W1, 0), leafOf(W1, 1)])).toEqual(['one'])
})

// ═══════════════════════════════════════════════════════════════════════════
// `.each` - subjects keyed by the ITEM, so a mapped list needs no names.
// ═══════════════════════════════════════════════════════════════════════════

const SUBJECTS = [
  { name: 'x', at: path.ns('default').deployments('x'), want: 1 },
  { name: 'y', at: path.ns('default').deployments('y'), want: 2 },
] as const

const condOf = (s: (typeof SUBJECTS)[number]): Resume =>
  fieldNoLonger(s.at, 'status.readyReplicas', s.want)

function driveEach(texts: string[]): { hit: string[]; resume: Resume | null } {
  const hit: string[] = []
  const out: { resume: Resume | null } = { resume: null }
  const step = function* () {
    const W = watch({ node: A }).each(SUBJECTS, condOf)
    const held = yield* W.held()
    if (held.has('node')) hit.push('node')
    for (const s of SUBJECTS) if (held.hasItem(s)) hit.push(s.name)
    out.resume = W.resume

    return { o: 'yield' as const }
  }
  runStep(step as never, { held: () => texts } as unknown as Handler<never>)

  return { hit, resume: out.resume }
}

// ⭐ ***IDENTITY, NOT A NAME STRING.*** The subject list is never transcribed, so
// it cannot disagree with itself - which is what naming N subjects reintroduces.
test('hasItem finds the condition derived for that item', () => {
  expect(driveEach([leafOf(condOf(SUBJECTS[0]), 1)]).hit).toEqual(['x'])
  expect(driveEach([leafOf(condOf(SUBJECTS[1]), 1)]).hit).toEqual(['y'])
})

// ***THE NAMED HALF AND THE ITEM HALF DO NOT COLLIDE.*** Items are appended
// after the names, so `hasItem` must offset by however many names there are -
// get that wrong and item 0 answers for the first NAME.
test('a named condition and an item condition are told apart', () => {
  expect(driveEach([A.render()]).hit).toEqual(['node'])
  expect(driveEach([A.render(), leafOf(condOf(SUBJECTS[1]), 0)]).hit).toEqual(['node', 'y'])
})

test('each contributes every subject to the resume', () => {
  expect(driveEach([]).resume).toEqual(anyOf(A, condOf(SUBJECTS[0]), condOf(SUBJECTS[1])))
})

test('each adds one condition per item, in order', () => {
  expect(driveEach([]).resume?.of.length).toBe(1 + SUBJECTS.length)
})

// ═══════════════════════════════════════════════════════════════════════════
// THE PARK ITSELF - unchanged by the redesign, and still the thing that decides
// what the host evaluates.
// ═══════════════════════════════════════════════════════════════════════════

test('operands counts what the host flattens', () => {
  // `fieldNoLonger` is itself a disjunction, so two of them flatten to four.
  expect(anyOf(W1, W2).operands).toBe(4)
  expect(anyOf(A, B).operands).toBe(2)
  // Associativity: nesting must not change the count the host will see.
  expect(anyOf(anyOf(A, B), W1).operands).toBe(anyOf(A, B, W1).operands)
})

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

// ***A FOLDED BACKSTOP CHANGES NO MATCHING.*** Under indices this mattered
// because an extra operand shifted every arm after it. It no longer can - an
// operand no condition owns simply matches nothing - so this asserts the weaker,
// true thing: saying `backstop()` costs no operand.
test('a backstop operand costs nothing in the park', () => {
  expect(anyOf(A, backstop(), B).operands).toBe(anyOf(A, B).operands)
})

test('a park of nothing but backstops is the backstop-only park', () => {
  expect(anyOf(backstop(), backstop())).toEqual(untilBackstop)
})

// ⛔ ***`allOf` MUST NOT FOLD.*** `X || false` is `X`; `X && false` is `false`,
// so eliding there would silently turn a park into one that can never hold.
test('allOf does NOT fold a backstop', () => {
  expect(allOf(A, backstop())).not.toEqual(A)
})

// ═══════════════════════════════════════════════════════════════════════════
// Condition values - unrelated to `watch`, kept from on.test.ts because this is
// where they were asserted and deleting the file would have dropped them.
// ═══════════════════════════════════════════════════════════════════════════

test('ready/unready/unsure differ only in status, and Unknown is not False', () => {
  const r = ready('R', 'm')
  const u = unready('R', 'm')
  const s = unsure('R', 'm')
  expect(r.reason).toBe(u.reason)
  expect(r.message).toBe(u.message)
  expect(new Set([r.status, u.status, s.status]).size).toBe(3)
})
