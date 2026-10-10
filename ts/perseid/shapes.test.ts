// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// ***THE VALUE-PARAM SHAPE TABLE, ENFORCED BY THE COMPILER.***
//
// The monorepo's `sdksymbolparity_test` gates the shared vocabulary at the
// NAME level; it cannot see this file's class, which is the one that bit on
// 2026-10-10: `fieldNe` took a number ts-side and rust's `field_ne` still
// takes an i64 - the symbol exists in both, the SIGNATURE drifted, and every
// string-field predicate died at compile time in programs that did nothing
// wrong. So this file pins the value-param shapes of the shared resume
// builders, one positive and one negative probe per row, and `tsc --noEmit`
// (the publish workflow runs it) is the enforcer.
//
// ⚠ THE RUST TWIN of this table lives in `rust/perseid/src/resume.rs`'s
// `shapes_match_the_declared_table` test. When a row changes here, change it
// there in the same commit - the two tables are the two producers of one
// vocabulary, and this header is the notice that travels with either edit.
//
// Current declared rows (ts view):
//
//   fieldNe        path, field, value: string | boolean | number
//   fieldIs        path, field, value: string | boolean
//   fieldNoLonger  path, field, value: string | boolean | number
//   pinned         hops[].value: string | boolean | number
//   countNe        selector, n: number
//   anyFieldNe     collection, selector, field, want: number
//   allFieldsAre   collection, selector, field, want: number
//
// Rust view (same rows, rust idioms): field_ne numeric, field_is ScalarValue,
// field_no_longer FieldValue, pinned Hop{FieldValue}, count_ne i64,
// count_ne_field i64, any_field_ne/all_fields_are i64.

import { expect, test } from 'bun:test'
import {
  allFieldsAre,
  anyFieldNe,
  countNe,
  fieldIs,
  fieldNe,
  fieldNoLonger,
  path,
  pinned,
} from './perseid.js'

const DEP = path.ns('default').deployments('web')
const CM = path.ns('default').configmaps('app-config')

test('fieldNe accepts every scalar and rejects non-scalars', () => {
  expect(String(fieldNe(DEP, 'spec.replicas', 2))).toContain('!= 2')
  expect(String(fieldNe(CM, 'data.mode', 'stream'))).toContain('!= "stream"')
  expect(String(fieldNe(CM, 'data.flag', true))).toContain('!= true')
  // @ts-expect-error - a non-scalar value has no field meaning
  fieldNe(DEP, 'spec.replicas', { nested: true })
})

test('fieldIs takes strings and booleans, and refuses numbers (fieldNe is the numeric home)', () => {
  expect(String(fieldIs(CM, 'data.mode', 'stream'))).toContain('== "stream"')
  expect(String(fieldIs(DEP, 'spec.paused', false))).toContain('== false')
  // @ts-expect-error - numbers go through fieldNe, where the numeric
  // comparator and the omitted-at-zero trap are handled
  fieldIs(DEP, 'spec.replicas', 2)
})

test('fieldNoLonger accepts every scalar, carrying the exists arm', () => {
  expect(String(fieldNoLonger(DEP, 'spec.replicas', 2))).toContain('.exists')
  expect(String(fieldNoLonger(CM, 'data.mode', 'stream'))).toContain('!= "stream"')
  // @ts-expect-error - a non-scalar value has no field meaning
  fieldNoLonger(DEP, 'spec.replicas', { nested: true })
})

test('pinned hop values take every scalar', () => {
  const step = pinned(
    [
      { path: DEP, field: 'spec.replicas', value: 2 },
      { path: CM, field: 'data.mode', value: 'stream' },
      { path: CM, field: 'data.flag', value: false },
    ],
    fieldIs(DEP, 'spec.paused', false),
  )
  expect(String(step)).toContain('!= 2')
  expect(String(step)).toContain('!= "stream"')
  expect(String(step)).toContain('!= false')
  // @ts-expect-error - a hop value is a scalar, not an object
  pinned([{ path: DEP, field: 'spec.replicas', value: { nested: true } }], fieldIs(DEP, 'spec.paused', false))
})

test('the count and quantifier builders stay numeric', () => {
  expect(String(countNe('app=api', 3))).toContain('!= 3')
  expect(String(anyFieldNe(DEPS(), 'tier=web', 'status.readyReplicas', 3))).toContain('.min != 3')
  expect(String(allFieldsAre(DEPS(), 'tier=web', 'status.readyReplicas', 3))).toContain('.max == 3')
  // @ts-expect-error - counts are numbers; a string count is a typo
  countNe('app=api', '3')
  // @ts-expect-error - quantifier bounds are numbers
  anyFieldNe(DEPS(), 'tier=web', 'status.readyReplicas', '3')
})

function DEPS() {
  return path.ns('default').collectionOf('apps', 'v1', 'deployments')
}
