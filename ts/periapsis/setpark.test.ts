// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import { anyFieldNe, allFieldsAre, path } from './perseid.js'

const DEPS = path.ns('default').collectionOf('apps', 'v1', 'deployments')

// ⭐ ***ONE PARK OVER A WHOLE KIND.*** Before `min`/`max` the only question a
// park could ask of a set was its SIZE, so a program watching N objects had to
// name all N - `sentinel.ts` hard-codes four subjects and `drainer.ts` one node
// for exactly that reason.
test('anyFieldNe asks a question about EVERY matching object', () => {
  const r = String(anyFieldNe(DEPS, 'tier=web', 'status.readyReplicas', 3))

  // BOTH extremes, or it is not a quantifier: `min != 3` alone misses an object
  // scaled ABOVE the target, and `max != 3` alone misses one scaled below.
  expect(r).toContain('.min != 3')
  expect(r).toContain('.max != 3')
  expect(r).toContain('||')
  // The set is named ONCE per extreme, by collection and selector - which is
  // what makes it one subject to the wake index however many objects match.
  expect(r).toContain('tier=web')
  expect(r).toContain('status.readyReplicas')
})

test('allFieldsAre is the convergence half', () => {
  const r = String(allFieldsAre(DEPS, 'tier=web', 'status.readyReplicas', 3))
  expect(r).toContain('.min == 3')
  expect(r).toContain('.max == 3')
  expect(r).toContain('&&')
})

// ⛔ ***THEY ARE NOT NEGATIONS OF EACH OTHER AND MUST NOT BE WRITTEN AS ONE.***
// `any != n` is `min!=n || max!=n`; `all == n` is `min==n && max==n`. On a
// non-empty set those are complements, but the EMPTY set makes both an error
// rather than making one true - so a program cannot get the other by negating.
test('the two builders render different operators, not one negated', () => {
  const a = String(anyFieldNe(DEPS, '', 'status.readyReplicas', 1))
  const b = String(allFieldsAre(DEPS, '', 'status.readyReplicas', 1))
  expect(a).not.toBe(b)
  expect(a).toContain('!=')
  expect(b).toContain('==')
  expect(a).not.toContain('&&')
  expect(b).not.toContain('||')
})
