// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME guards for the ASYNC runners — `runStepAsync` and `runFinalizeAsync`.
//
// ***THESE HAD NO TESTS AT ALL UNTIL EVERY DEPLOYED COMPONENT DEPENDED ON
// THEM.*** `perseid.test.ts` guards the TYPE surface and the sync runner; the
// async pair was added for the reconcile imports becoming `async func`, and the
// 2026-09-04 port moved all six example entry modules onto it. It is now the
// path every Perseid on the fleet takes, and nothing was watching it.
//
// The property under test throughout is the one the SDK is built on and the port
// relies on: ***THE STEP IS COLORLESS.*** It is an ordinary synchronous
// generator; only the DRIVER knows about promises. So the same pure step, given
// equivalent handlers, must produce the same answer under both runners — and a
// handler that returns a promise must be AWAITED before its value is sent back
// into the step, or the step observes a `Promise` where it expected a value.
// That last failure is exactly what broke the deployed components: `.tag` on a
// promise is `undefined`, which reads as "unknown" and yields forever.
// ═══════════════════════════════════════════════════════════════════════════

import { expect, test } from 'bun:test'
import {
  defineEffect,
  group,
  race,
  retry,
  runFinalize,
  runFinalizeAsync,
  runStep,
  runStepAsync,
  type FinalizeOutcome,
  type GroupEff,
  type Handler,
  type RaceEff,
  type Step,
} from './perseid'

const WIT = 'radiant:reconcile/observe@0.1.0' as const
const read = defineEffect<string, string>()(WIT, 'get')

type Effs = ReturnType<typeof read> extends Step<infer E, unknown> ? E : never

// ⚠ ***A STEP THAT USES `group` OR `race` YIELDS MORE THAN ITS OWN EFFECTS.***
// Both are COMBINATORS: they yield a `@group`/`@race` record the runner
// interprets, so a generator using one has that in its yield union too. Four
// annotations here said `Step<Effs, …>` and were wrong from the day the
// combinators landed - `tsc` reported it and nothing ran `tsc`.
//
// Deliberately NOT folded into `Effs`: these are structural yields, not
// capabilities, and a step's effect union is what capability tracking reads.
// Widening `Effs` would make every step look like it needs them.
type Composed = Effs | GroupEff | RaceEff

/** The same pure step both runners are given. Sees only values, never promises. */
function* readTwo(): Step<Effs, string> {
  const a = yield* read('a')
  const b = yield* read('b')

  return `${a}+${b}`
}

test('the async runner awaits a handler result before resuming the step', async () => {
  // ***THE HANDLER IS ASYNC AND THE STEP IS NOT.*** If the driver sent the
  // promise straight back, the step would concatenate "[object Promise]" - the
  // exact shape of the defect that silently turned every observation into
  // `unknown` in the deployed components.
  const handler = { get: async (p: string) => `<${p}>` } as unknown as Handler<Effs>

  expect(await runStepAsync(readTwo, handler)).toBe('<a>+<b>')
})

test('the same step gives the same answer under both runners', async () => {
  // The colorless property, asserted rather than assumed. If these ever differ,
  // a program's behaviour depends on which host runs it.
  const sync = { get: (p: string) => `<${p}>` } as unknown as Handler<Effs>
  const async_ = { get: async (p: string) => `<${p}>` } as unknown as Handler<Effs>

  expect(runStep(readTwo, sync)).toBe(await runStepAsync(readTwo, async_))
})

test('group results are ordered by POSITION, not by completion', async () => {
  // ⚠ The concurrent runner settles the slow arm last, so a driver that pushed
  // results as they arrived would silently reorder them - and a step indexing
  // `[0]` would read another effect's answer. That is a wrong ANSWER, not a
  // crash, so nothing downstream would report it.
  const handler = {
    get: async (p: string) => {
      await new Promise((r) => setTimeout(r, p === 'slow' ? 20 : 0))

      return p
    },
  } as unknown as Handler<Effs>

  function* both(): Step<Composed, string[]> {
    return (yield* group(read('slow'), read('fast'))) as string[]
  }

  expect(await runStepAsync(both, handler)).toEqual(['slow', 'fast'])
})

test('group runs its arms concurrently rather than in sequence', async () => {
  // ***OTHERWISE `group` IS A COMMENT.*** Ordering alone passes for a sequential
  // driver too, so the timing is what separates them: two 30ms arms in sequence
  // cannot finish in under 60ms.
  const handler = {
    get: async (p: string) => {
      await new Promise((r) => setTimeout(r, 30))

      return p
    },
  } as unknown as Handler<Effs>

  function* two(): Step<Composed, string[]> {
    return (yield* group(read('x'), read('y'))) as string[]
  }

  const began = Date.now()
  await runStepAsync(two, handler)

  expect(Date.now() - began).toBeLessThan(55)
})

test('race returns the arm that settled first, with its index', async () => {
  const handler = {
    get: async (p: string) => {
      await new Promise((r) => setTimeout(r, p === 'slow' ? 40 : 0))

      return p
    },
  } as unknown as Handler<Effs>

  // ⚠ NOT named `race` any more - that is the imported combinator now, and a
  // local of the same name would shadow it silently.
  function* firstToSettle(): Step<Composed, { index: number; value: unknown }> {
    return (yield* race(read('slow'), read('quick'))) as { index: number; value: unknown }
  }

  const won = await runStepAsync(firstToSettle, handler)
  expect(won.index).toBe(1)
  expect(won.value).toBe('quick')
})

test('the SYNC runner refuses race rather than picking an arm', () => {
  // ⛔ ***FAIL CLOSED.*** Under sequential execution "whichever finishes first"
  // has no meaning, so any answer would be a silent semantic difference between
  // the two runners - which is the one thing the colorless property forbids. A
  // throw is the only honest result, and it must name the remedy.
  const handler = { get: (p: string) => p } as unknown as Handler<Effs>

  function* twoArms(): Step<Composed, unknown> {
    return yield* race(read('a'), read('b'))
  }

  expect(() => runStep(twoArms, handler)).toThrow(/runStepAsync/)
})

test('runFinalizeAsync awaits, and returns a finalize outcome', async () => {
  // ***A FINALIZER READS, WHICH IS WHY `finalize.run` BECAME `async func`.***
  // The janitor drives its finalizer through the same handler as its step, so a
  // sync-only runner could not await the reads and the guest trapped with "no
  // active task state".
  const handler = { get: async (p: string) => p } as unknown as Handler<Effs>

  function* cleanup(): Step<Effs, FinalizeOutcome> {
    const seen = yield* read('still-there')

    return retry(`waiting on ${seen}`)
  }

  const outcome = await runFinalizeAsync(cleanup, handler)
  expect(outcome).toEqual({ tag: 'retry', val: 'waiting on still-there' })

  // And it agrees with the sync runner on a step that does not need awaiting.
  const sync = { get: (p: string) => p } as unknown as Handler<Effs>
  expect(runFinalize(cleanup, sync)).toEqual(outcome)
})

test('a handler that rejects surfaces the rejection rather than hanging', async () => {
  // A read that throws must not leave the pass suspended: the host is waiting on
  // this promise, and a hang here is indistinguishable from a wedged guest.
  const handler = {
    get: async () => {
      throw new Error('apiserver said no')
    },
  } as unknown as Handler<Effs>

  await expect(runStepAsync(readTwo, handler)).rejects.toThrow('apiserver said no')
})
