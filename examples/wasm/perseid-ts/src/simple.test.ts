// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { test } from 'bun:test'
import { type Handler, type Outcome, runStep, known, absent, unknown } from '@apsis-io/perseid/perseid.js'
import { type SimpleEffects, step, TARGET, WANT } from './simple.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const depJSON = (replicas: number) => known(JSON.stringify({ spec: { replicas } }))

type Run = { outcome: Outcome; writes: string[]; reason: string | null; message: string }

/** One pass. `held` is what the host says woke us; `[]` is a backstop tick. */
function drive(answer: ReturnType<typeof depJSON> | typeof absent | typeof unknown, held: number[] = []): Run {
  const writes: string[] = []
  let reason: string | null = null
  let message = ''

  const handler = {
    get: () => answer,
    held: () => held,
    // ***DERIVED FROM `held` HERE, WHICH IS WHAT THE SDK USED TO DO AND MUST NOT.***
    // A fixture may infer it - it is choosing both halves of one made-up world -
    // but `wakeCause()` asking the host is the whole point of `woke.cause`, so
    // this line keeps the test driving the same shape a real host answers.
    cause: () => (held.length > 0 ? 'condition' : 'backstop'),
    ensure: (a: { path: unknown; field: unknown; value: unknown }) => {
      writes.push(`ensure ${String(a.field)}=${String(a.value)}`)
    },
    status: (c: { reason?: string; message?: string }) => {
      reason = c.reason ?? null
      message = c.message ?? ''
    },
  } as unknown as Handler<SimpleEffects>

  return { outcome: runStep(step, handler), writes, reason, message }
}

export function runtimeGuards(): void {
  // ═══════════════════════════════════════════════════════════════════════
  // `need` - the three-valued unwrap, and the two answers it maps differently.
  // ═══════════════════════════════════════════════════════════════════════
  const gone = drive(absent)
  assert(gone.outcome.o === 'terminate',
    `an absent target did not terminate: ${gone.outcome.o}`)
  assert(gone.writes.length === 0, 'an absent target was written to')

  // ⛔ A FAILED READ IS NOT AN ABSENT OBJECT. It only makes us late.
  const blind = drive(unknown)
  assert(blind.outcome.o === 'yield',
    `an unreadable target did not yield: ${blind.outcome.o}`)
  assert(blind.writes.length === 0,
    `an unreadable target produced writes: ${blind.writes.join(' | ')}`)

  // ═══════════════════════════════════════════════════════════════════════
  // The repair.
  // ═══════════════════════════════════════════════════════════════════════
  const drift = drive(depJSON(0))
  assert(drift.writes.includes(`ensure spec.replicas=${WANT}`),
    `drift was not repaired: ${drift.writes.join(' | ')}`)
  assert(drift.outcome.o === 'yield',
    'a repairing pass parked on a condition its own write is about to satisfy')

  // ⭐ ═══════════════════════════════════════════════════════════════════════
  // THE PROPERTY THE WAKE CAUSE PUTS AT RISK, AND THE REASON THIS FILE EXISTS.
  //
  // held=[] means "nothing you named is true" - a backstop tick, and also what a
  // host that could not compute the answer returns. ADR-0107 forbids skipping
  // work on it. So a drifted world MUST still be repaired when nothing was
  // reported, or the program is edge-triggered in disguise.
  // ═══════════════════════════════════════════════════════════════════════
  const driftNoWake = drive(depJSON(0), [])
  assert(driftNoWake.writes.includes(`ensure spec.replicas=${WANT}`),
    'DRIFT WENT UNREPAIRED WHEN NOTHING WOKE US - the step reads the wake cause ' +
      'instead of the world, which is exactly what ADR-0107 forbids')

  // ═══════════════════════════════════════════════════════════════════════
  // Converged: the pass parks, and says WHY it ran.
  // ═══════════════════════════════════════════════════════════════════════
  const calm = drive(depJSON(WANT))
  assert(calm.outcome.o === 'quiesce', `a converged pass did not park: ${calm.outcome.o}`)
  assert(calm.writes.length === 0, 'a converged target was written to')

  // ⛔ ***THE STATUS DESCRIBES THE WORLD, NOT THE WAKE.*** Every converged pass
  // reports Converged, whatever woke it. The cause is CONTEXT in the message,
  // never the verdict.
  assert(calm.reason === 'Converged', `a converged pass reported ${String(calm.reason)}`)

  // ⚠ ***THIS PARAGRAPH SAID THE HOST CANNOT DISTINGUISH THE THREE, AND THAT
  // STOPPED BEING TRUE ON 2026-09-08.*** It read: "the time bound fired, or the
  // host could not tell, or this is the first pass. All three are `backstop`,
  // deliberately ... the host cannot distinguish them anyway." Radiant had
  // recorded the answer as `WakeReport.Fired` all along; `woke.cause` is the
  // channel that carries it, and `backstop`, `unknown` and `first-pass` are now
  // three separate answers.
  //
  // What survives unchanged is why the report exists at all: it lets an operator
  // tell a program that is WATCHING from one that is merely polling.
  assert(calm.message.includes('woke on backstop'),
    `an empty wake was not reported as backstop: ${calm.message}`)

  // ⭐ ***ANY held OPERAND IS `condition`, AND THE COARSENESS IS THE CORRECTNESS.***
  // Which arms held is `held()`'s question; this one is only "did the world move".
  // Turning it into a per-arm cause would need this pass's arm list to be the same
  // list the host evaluated, which nothing enforces.
  //
  // ⚠ The fixture passes NUMBERS here, left from the indices era - `held` carries
  // TEXT since 2026-09-07. It is inert for this loop, which asserts on `cause` and
  // never matches an arm, but it is not evidence about `held`.
  for (const held of [[0], [1], [0, 1], [7]]) {
    const woke = drive(depJSON(WANT), held)
    assert(woke.message.includes('woke on condition'),
      `held=[${held}] was not reported as condition: ${woke.message}`)
  }

  // ⛔ AND THE TWO CAUSES MUST DIFFER, or the report says the same thing always
  // and this file is asserting a constant.
  assert(!calm.message.includes('woke on condition'),
    `an empty wake reported condition: ${calm.message}`)

  // The park names both subjects; losing one means sleeping through it.
  assert(calm.outcome.o === 'quiesce', 'unreachable')
  const resume = String((calm.outcome as { resume: unknown }).resume)
  assert(resume.includes(String(TARGET)), 'the park does not name the target')
  assert(resume.includes('||'), 'the park lost an arm - both subjects must be in it')
}

test('simple.test.ts: runtime guards pass', () => {
  runtimeGuards()
})
