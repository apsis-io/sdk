// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import {
  defineEffect,
  group,
  where,
  runStepAsync,
  type GroupEff,
  type Handler,
  type Step,
} from './perseid.js'

// ═══════════════════════════════════════════════════════════════════════════
// `where` - THE NAMED SIBLING OF `group`.
//
// ⚠ ***THE FIRST VERSION OF THIS FILE TYPED ITS GENERATORS `: any` AND `bun
// test` PASSED ALL FOUR ARMS.*** bun strips types without checking them, so the
// suite was green while `tsc` had six errors in this very file - the disjoint
// blind spots CLAUDE.md names, met an hour after they were written down. The
// annotations below are load-bearing: `Step<Composed, …>` is what makes the
// assertions about SHAPE mean anything.
// ═══════════════════════════════════════════════════════════════════════════

const WIT = 'radiant:reconcile/observe@0.1.0' as const
const read = defineEffect<string, string>()(WIT, 'get')

type Effs = ReturnType<typeof read> extends Step<infer E, unknown> ? E : never
// A step using a COMBINATOR yields the combinator's own record too - `where` is
// `@group` underneath, so its yield union is the same one `group` produces.
type Composed = Effs | GroupEff

const handler = {
  get: async (p: string) => {
    await new Promise((r) => setTimeout(r, p === 'slow' ? 20 : 0))

    return `v:${p}`
  },
} as unknown as Handler<Effs>

test('where binds results to names', async () => {
  function* both(): Step<Composed, { a: string; b: string }> {
    return yield* where({ a: read('slow'), b: read('fast') })
  }

  expect(await runStepAsync(both, handler)).toEqual({ a: 'v:slow', b: 'v:fast' })
})

// ⭐ THE ARMS RUN CONCURRENTLY, exactly as `group` does. `where` is a naming
// layer over the same effect, not a sequential rewrite of it - two 20ms arms
// finish in ~20ms, not ~40ms.
test('where runs its arms concurrently, like group', async () => {
  function* w(): Step<Composed, { a: string; b: string }> {
    return yield* where({ a: read('slow'), b: read('slow') })
  }

  const t0 = Date.now()
  await runStepAsync(w, handler)
  expect(Date.now() - t0).toBeLessThan(40)
})

// ⭐ ***REORDERING THE BINDINGS CHANGES NOTHING, WHICH IS THE WHOLE REASON THIS
// EXISTS.*** With `group`, moving an arm silently moves a result into a
// different variable - a wrong ANSWER rather than a crash, which is what the
// positional-ordering guard beside `group` already warns about.
test('reordering bindings does not move a result', async () => {
  function* a(): Step<Composed, { x: string; y: string }> {
    return yield* where({ x: read('one'), y: read('two') })
  }
  function* b(): Step<Composed, { x: string; y: string }> {
    return yield* where({ y: read('two'), x: read('one') })
  }

  expect(await runStepAsync(a, handler)).toEqual(await runStepAsync(b, handler))
  // ...and the values are the ones each NAME asked for, or the equality above
  // holds on two identically-wrong results.
  expect((await runStepAsync(a, handler)).x).toBe('v:one')
})

// ANTI-REGRESSION: `group` is untouched and still positional. `where` adds a
// vocabulary; it must not quietly change the one that exists.
test('group is unchanged and still positional', async () => {
  function* g(): Step<Composed, string[]> {
    return (yield* group(read('one'), read('two'))) as string[]
  }

  expect(await runStepAsync(g, handler)).toEqual(['v:one', 'v:two'])
})
