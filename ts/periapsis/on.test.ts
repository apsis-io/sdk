// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import { on, runStep, fieldIs, path, type Handler, type Resume } from './perseid.js'

const POD = path.ns('default').core('v1', 'pods', 'web')
const A = fieldIs(POD, 'status.phase', 'Running')
const B = fieldIs(POD, 'spec.hostNetwork', true)

// drive runs one pass of a step whose only content is an `on()` dispatch, with
// the host reporting `heldArms`.
function drive(heldArms: number[]): { ran: string[]; resume: string } {
  const ran: string[] = []
  let resume = ''
  const step = function* () {
    resume = String(
      yield* on({
        // eslint-disable-next-line require-yield
        [A]: function* () { ran.push('A') },
        // eslint-disable-next-line require-yield
        [B]: function* () { ran.push('B') },
      }),
    )

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
test('the resume is every key, in order', () => {
  const r = drive([]).resume
  expect(r).toContain(String(A))
  expect(r).toContain(String(B))
  expect(r.indexOf(String(A))).toBeLessThan(r.indexOf(String(B)))
  expect(r).toContain('||')
})
