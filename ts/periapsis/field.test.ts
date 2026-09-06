// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import { field, sel } from './field.js'

test('a bare path is dotted', () => {
  expect(field('spec', 'replicas')).toBe('spec.replicas')
  expect(field('status')).toBe('status')
})

// ⭐ THE ONE THE DRAINER GOT WRONG BY HAND. It wrote a BACKSLASH escape, which
// the host does not have: `fieldSegments` splits on `.` with no escape, so
// `drain\.apsis/requested` walks to `drain\` then `apsis/requested` and reads
// ABSENT. Declared and unused for a day, so it never failed.
test('a key with punctuation is subscripted, not escaped', () => {
  expect(field('metadata', 'annotations', 'drain.apsis/requested')).toBe(
    'metadata.annotations["drain.apsis/requested"]',
  )
  expect(field('metadata', 'labels', 'app.kubernetes.io/name')).toBe(
    'metadata.labels["app.kubernetes.io/name"]',
  )
  // ...and a quote inside the key is JSON-escaped, the same dialect the host
  // decodes with.
  expect(field('m', 'a"b')).toBe('m["a\\"b"]')
})

test('a selector renders as the host parses it', () => {
  expect(field('status', 'conditions', sel('type', 'Ready'), 'status')).toBe(
    'status.conditions[?type=Ready].status',
  )
  expect(field('spec', 'taints', sel('key', 'node.kubernetes.io/not-ready'))).toBe(
    'spec.taints[?key=node.kubernetes.io/not-ready]',
  )
})

// ⛔ THE OPERATOR THAT DOES NOT EXIST. `[?k!=v]` PARSED until 2026-09-06, as a
// field called `k!`, and answered Absent about a field nothing has. The host
// refuses it now; refusing here makes it a BUILD error instead.
test('sel refuses an operator the aperture does not have', () => {
  for (const bad of ['key!', 'a=b', 'a&b', '*']) {
    expect(() => sel(bad, 'v')).toThrow(/plain name|operator/)
  }
  // ...and a legitimately dotted/slashed field is still fine, or this refuses
  // far more than it should.
  expect(sel('app.kubernetes.io/name', 'web')).toEqual({
    selKey: 'app.kubernetes.io/name',
    selVal: 'web',
  })
})

test('sel refuses a value it cannot express', () => {
  expect(() => sel('k', 'a]b')).toThrow(/runs to the first/)
})

// ⛔ A SUBSCRIPT CANNOT OPEN A PATH - the host refuses it, so the builder must
// too rather than emitting something that reads Unknown at evaluation.
test('a subscripted key cannot be the first segment', () => {
  expect(() => field('a.b')).toThrow(/FIRST segment/)
  expect(() => field('')).toThrow(/names nothing/)
  expect(() => field()).toThrow(/at least one/)
})
