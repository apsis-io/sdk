// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import { wakeable, WOKEN } from './wake'

// ***A STAND-IN FOR THE RUNTIME'S `wit` GLOBAL.***
//
// It is deliberately a REAL promise that only settles when `write` is called,
// because that is the property this helper is responsible for: `signalled()`
// must not resolve until the handler completes the future. It cannot reproduce
// the thing that makes a WIT future special - re-entering a suspended guest
// task - and no test outside a wasm host can. That half is measured in
// cmd/trail (`a_wedged_step_is_freed_only_by_a_waitable`), against a real guest
// wedged on a real host read, with an AbortController arm that must NOT be
// freed. Asserted here: the wiring. Asserted there: the mechanism.
function installFakeWit(): { writes: number[] } {
  const writes: number[] = []
  ;(globalThis as unknown as { wit: unknown }).wit = {
    U32: 7,
    Future(type: number) {
      expect(type).toBe(7) // the helper must ask for the u32 future, not another
      let settle: (v: unknown) => void
      const p = new Promise((resolve) => {
        settle = resolve
      })

      return {
        readable: { read: () => p },
        writable: {
          write(v: unknown) {
            writes.push(v as number)
            settle(v)
          },
        },
      }
    },
  }
  ;(globalThis as unknown as { wit: { Future: { U32: number } } }).wit.Future.U32 = 7

  return { writes }
}

test('the handler completes the future the step is waiting on', async () => {
  const { writes } = installFakeWit()
  const wake = wakeable()

  const waiting = wake.signalled()
  const handler = wake.handler()

  // ***THE HANDLER IS SYNC AND MUST STAY SYNC.*** It runs on a stack with no
  // task state while `run` is suspended, so it cannot await. A helper that
  // returned a promise here would typecheck against the WIT and trap at runtime.
  const state = handler.signal(1)
  expect(state).toBe('terminating')
  expect(state).not.toBeInstanceOf(Promise)

  expect(await waiting).toBe(WOKEN)
  expect(writes).toEqual([1]) // the code is passed through, not invented
})

// ***A STEP THAT NEVER RACED CANNOT BE WOKEN, AND MUST SAY SO.***
//
// Exporting `signal` is not the same as being wakeable: a program can export it
// and await nothing else, and then the honest answer is `running`. Reporting
// `terminating` there would tell the host a wind-up is underway that will never
// happen - and the host's only remaining lever is to stop waiting, so a false
// `terminating` buys a longer hang.
test('a program that never called signalled() reports running, not terminating', () => {
  installFakeWit()
  const wake = wakeable()

  expect(wake.handler().signal(1)).toBe('running')
})

// The state is the PROGRAM's to decide - the host reports it and does not obey
// it - so a program that knows it is finished can say so.
test('the reported state is the program’s choice', () => {
  installFakeWit()
  const wake = wakeable()
  void wake.signalled()

  expect(wake.handler(() => 'terminated').signal(9)).toBe('terminated')
})

// ⛔ `wake-carrier` is never called by anything, which is exactly why it is easy
// to drop - and dropping it fails at INSTANTIATION, not at a call, so every pass
// of the program dies with a missing-export error rather than one read failing.
test('the handler supplies the never-called wake-carrier export', () => {
  installFakeWit()
  const h = wakeable().handler()

  expect(typeof h.wakeCarrier).toBe('function')
  expect(h.wakeCarrier()).toBeDefined()
})

// ═══════════════════════════════════════════════════════════════════════════
// THE SHAPE EVERY PORTED COMPONENT NOW USES.
//
// The 2026-09-04 port put this race in all six example entry modules:
//
//     await Promise.race([runStepAsync(step, handler), wake.signalled()])
//
// If it is wrong, it is wrong in every Perseid at once - so it is worth pinning
// here rather than only in the components. These use a stand-in for the step
// (an ordinary promise) because what is under test is the RACE, not the runner;
// the runner has its own file.
// ═══════════════════════════════════════════════════════════════════════════

const YIELD = { o: 'yield' }

test('an unsignalled pass returns the step outcome, not the wake', async () => {
  // ***THE ARM THAT MUST NOT FIRE.*** A `signalled()` that resolved eagerly - on
  // creation, or on a stray write - would make every pass yield, and a program
  // that always yields looks exactly like one that is working and waiting.
  installFakeWit()
  const wake = wakeable()

  const decided = Promise.resolve({ o: 'terminate' })
  const outcome = await Promise.race([decided, wake.signalled()])

  expect(outcome).toEqual({ o: 'terminate' })
})

test('a signal mid-pass wins the race and the pass yields', async () => {
  installFakeWit()
  const wake = wakeable()
  const handler = wake.handler()

  // A step that never finishes - the wedge, in miniature.
  const wedged = new Promise<unknown>(() => {})
  const raced = Promise.race([wedged, wake.signalled().then(() => YIELD)])

  handler.signal(1)

  expect(await raced).toEqual(YIELD)
})

test('the handler answers running once the pass has already finished', async () => {
  // ***THE ORDER THAT ACTUALLY HAPPENS ON A HEALTHY PASS.*** The step returns,
  // the host may still signal (its backstop timer does not know), and the honest
  // answer is `running` - there is nothing left to wind up. Reporting
  // `terminating` would tell the host a wind-up is underway that will never
  // arrive, and its only lever is to wait longer.
  installFakeWit()
  const wake = wakeable()
  const handler = wake.handler()

  // No `signalled()` call at all: the pass never needed to race.
  expect(handler.signal(1)).toBe('running')
})
