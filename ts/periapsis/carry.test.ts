// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import {
  MAX_CARRY_BYTES,
  carriedBy,
  forget,
  nextPoll,
  quiesce,
  remember,
  terminate,
  yieldStep,
  type Outcome,
} from './perseid'

// ═══════════════════════════════════════════════════════════════════════════
// ***THE ASSERTIONS ARE ABOUT THE SERIALIZED FORM, NOT THE OBJECT.***
//
// The host reads a POINTER off the wire (`Carry *string`, podstep.go): key
// ABSENT keeps the previous value, `""` clears it, anything else sets it. So an
// object with `carry: undefined` and an object with no `carry` key at all are
// the same TS value by `toEqual` and DIFFERENT only after `JSON.stringify` -
// except they are not, and that is the property worth pinning rather than
// assuming.
//
// Every test here goes through `wire()` for that reason. Asserting on the object
// would pass identically if the key serialized wrongly, which is the one failure
// that silently erases a program's memory.
// ═══════════════════════════════════════════════════════════════════════════
const wire = (o: Outcome): Record<string, unknown> => JSON.parse(JSON.stringify(o))

test('an ordinary outcome carries NO key, so the host keeps the previous value', () => {
  // THE COMMON CASE AND THE DANGEROUS ONE. Most passes of most probes change
  // nothing; if a bare outcome serialized `"carry": ""` every one of them would
  // wipe the program's memory, and the object would simply stop carrying what it
  // used to with nothing logged anywhere.
  expect('carry' in wire(yieldStep)).toBe(false)
  expect('carry' in wire(quiesce(nextPoll))).toBe(false)
  expect('carry' in wire(terminate)).toBe(false)
})

test('remember sets the value and preserves the outcome it wraps', () => {
  const o = remember(quiesce(nextPoll), '{"n":1}')

  // ⭐ `resume` COMES OUT AS A STRING, AND THAT IS THE PROPERTY THAT LETS A
  // RESUME BE A TREE. `wire` is `JSON.parse(JSON.stringify(o))` - the real path
  // a program's `-main.ts` takes - so this asserts that `ResumeNode.toJSON`
  // renders, and therefore that the host and the WIT contract see exactly what
  // they saw when a resume was a string.
  expect(wire(o)).toEqual({ o: 'quiesce', resume: String(nextPoll), carry: '{"n":1}' })
})

test('remember works on every outcome variant', () => {
  // The type says `O extends Outcome`; this is the arm that would catch a
  // spread that dropped a variant's own fields.
  expect(wire(remember(yieldStep, 'a'))).toEqual({ o: 'yield', carry: 'a' })
  expect(wire(remember(terminate, 'b'))).toEqual({ o: 'terminate', carry: 'b' })
})

test('forget sends the EMPTY STRING, which is the only way to reset a streak', () => {
  const w = wire(forget(yieldStep))

  // Both halves matter: the key must be PRESENT (absent would mean "keep") and
  // its value must be exactly empty (anything else is a new value).
  expect('carry' in w).toBe(true)
  expect(w.carry).toBe('')
})

test('remember refuses an empty value at runtime, because the host would accept it', () => {
  // ***THE DISTINCTION FROM `quiesce('')`.*** There the host refuses too, so the
  // type only moves WHEN you find out. Here `""` is a legal answer meaning
  // "forget everything" - so an accidental empty is a SUCCESSFUL pass that
  // destroyed state, and nothing downstream can flag it.
  expect(() => remember(yieldStep, '' as 'x')).toThrow(/empty value/)
  expect(() => remember(yieldStep, '' as 'x')).toThrow(/forget/)
})

test('remember refuses more than the host bound, naming it', () => {
  const justUnder = 'x'.repeat(MAX_CARRY_BYTES)
  expect(wire(remember(yieldStep, justUnder)).carry).toBe(justUnder)

  expect(() => remember(yieldStep, 'x'.repeat(MAX_CARRY_BYTES + 1))).toThrow(/MaxCarryBytes/)
})

test('the bound is in BYTES, not characters', () => {
  // A window of samples is ASCII and would never notice; a message field is not.
  // The host measures `len(*c.Data)`, which is bytes, so a JS length check would
  // pass here and be refused one process away with a count the author cannot
  // reconcile against anything they can see.
  const multibyte = 'é'.repeat(MAX_CARRY_BYTES / 2 + 1) // 2 bytes each

  expect(multibyte.length).toBeLessThanOrEqual(MAX_CARRY_BYTES) // passes a naive check
  expect(() => remember(yieldStep, multibyte)).toThrow(/exceeds the host bound/)
})

// ---------------------------------------------------------------------------
// The reading half.

test('carriedBy pulls a published value out of an observed Perseid', () => {
  const obj = JSON.stringify({
    apiVersion: 'radiant.apsis/v1',
    kind: 'Perseid',
    metadata: { name: 'probe' },
    status: { phase: 'Running', passes: 12, carry: '{"availability":0.99}' },
  })

  expect(carriedBy(obj)).toBe('{"availability":0.99}')
})

test('every not-a-measurement shape reads null, and that is the point', () => {
  // ***A PROBE THAT HAS NOT SPOKEN AND ONE THAT PUBLISHED GARBAGE ARE BOTH
  // null.*** The reader's correct response to either is to not act on a
  // measurement it does not have. A gate that could tell them apart would be
  // tempted to proceed on one of them.
  expect(carriedBy('not json')).toBeNull()
  expect(carriedBy(JSON.stringify({}))).toBeNull()
  expect(carriedBy(JSON.stringify({ status: {} }))).toBeNull()
  expect(carriedBy(JSON.stringify({ status: { carry: '' } }))).toBeNull()
  expect(carriedBy(JSON.stringify({ status: { carry: 42 } }))).toBeNull()
  expect(carriedBy(JSON.stringify({ status: { carry: null } }))).toBeNull()
})

test('a round trip: what remember writes is what carriedBy reads', () => {
  // ***THE TWO HALVES ARE WRITTEN IN THIS FILE AND CONNECTED BY THE HOST***, so
  // nothing else checks that they agree on the encoding. radiant copies the
  // reply's `carry` onto `status.carry` verbatim (perseidpasses.go), which is
  // what this simulates - and if it ever wrapped or trimmed the value, this is
  // the assertion that would still pass while production broke. Stated so the
  // next reader knows what it does NOT cover.
  const published = JSON.stringify({ availability: 0.97, samples: 8 })
  const onTheWire = wire(remember(yieldStep, published)).carry as string
  const observed = JSON.stringify({ status: { carry: onTheWire } })

  expect(carriedBy(observed)).toBe(published)
  expect(JSON.parse(carriedBy(observed)!)).toEqual({ availability: 0.97, samples: 8 })
})
