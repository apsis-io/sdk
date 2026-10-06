// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test'
import { anyFieldNe, allFieldsAre, anyPods, noPods, allOf, fieldNoLonger, path } from './perseid.js'

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

// ⭐ ***THE LITERAL-SELECTOR CONTRACT, PINNED AS TEXT.*** The selector must
// appear verbatim - it IS the subject the wake index keys on (§6); a selector
// hidden behind an expression is the PodsOf shape §10 declined.
test('anyPods/noPods ask the count question of a literal selector', () => {
  expect(String(anyPods('app=frontend,tier=api'))).toBe(
    'ListPods("app=frontend,tier=api").length > 0',
  )
  expect(String(noPods('app=frontend,tier=api'))).toBe(
    'ListPods("app=frontend,tier=api").length == 0',
  )
})

test('a set park root-guards the workload that supplied the selector', () => {
  const dep = path.ns('default').deployments('frontend')
  expect(String(allOf(fieldNoLonger(dep, 'metadata.generation', 5), anyPods('app=frontend')))).toBe(
    `((!Get("/apis/apps/v1/namespaces/default/deployments/frontend", "metadata.generation").exists) || (Get("/apis/apps/v1/namespaces/default/deployments/frontend", "metadata.generation") != 5)) && (ListPods("app=frontend").length > 0)`,
  )
})

// ⛔ THE LITERAL-BY-CONSTRUCTION GUARANTEE, PINNED AT THE TYPE LEVEL. The
// goldens pin the text; this pins the REFUSAL. A selector that arrives as a
// mere `string` - computed, passed through, read off an object - cannot reach
// ListPods, because a selector the static walk cannot see is a park that polls
// while looking subscribed (§6; the shape §10 declined).
test('a selector that is not a literal is refused at the type level', () => {
  const computed: string = `app=${'frontend'}`
  expect(String(anyPods('app=frontend'))).toContain('app=frontend')
  void computed
  // @ts-expect-error - a plain `string` is not a LabelSelector, on purpose
  anyPods(computed)
})
