// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * ***THE ONLY THING THAT FREES A STEP BLOCKED IN A HOST READ.***
 *
 * A step that awaits a read nobody answers cannot be stopped from outside. Both
 * obvious levers are measured closed (2026-09-04, in trail, both arms):
 *
 *   - the HOST cannot cancel a future it has handed over;
 *   - the GUEST cannot free itself with a JS promise. `AbortController`,
 *     `Promise.race` and a hand-rolled promise all live in the JS job queue,
 *     which a componentized guest drains only while resuming a task - and a task
 *     resumes only for a WAITABLE IN ITS OWN SET. The handler runs, `abort()`
 *     fires, the promise RESOLVES, and the continuation is scheduled and never
 *     drained.
 *
 * A WIT future is a waitable. Completing one re-enters the guest, the queue
 * drains, the race settles, and `run` returns through the normal path - with its
 * outcome and its declared writes, which a step killed while wedged loses
 * entirely.
 *
 * ⚠ ***SO `AbortController` IS NOT A SUBSTITUTE HERE, AND IT LOOKS LIKE ONE.***
 * It is present in the runtime, `abort()` works, the listener runs. Everything
 * observable at the JS level succeeds and the step still hangs. That is why this
 * helper exists rather than a note in a doc.
 *
 * # USING IT
 *
 *     const wake = wakeable()
 *
 *     export const step = {
 *       run: async () => {
 *         const seen = await Promise.race([observe.get(path), wake.signalled()])
 *         if (seen === WOKEN) return JSON.stringify({ o: 'yield' })
 *         ...
 *       },
 *     }
 *     export const signal = wake.handler(() => 'terminating')
 *
 * The step must ALSO declare a `radiant:backstop`, or nothing will ever signal
 * it - the host signals a step only when it outlives its own declared bound. See
 * `backstop.ts`.
 */

/**
 * What `signalled()` resolves to when the host asks the program to wind up.
 *
 * A distinct object rather than a string so a step cannot confuse it with a
 * value a read returned - `observe.get` yields strings, and a race between the
 * two hands you one or the other.
 */
export const WOKEN = Symbol('woken-by-signal')

/** The guest's answer to being signalled, mirroring `enum state` in the WIT. */
export type SignalState = 'running' | 'terminating' | 'terminated'

/** What the runtime exposes to build component-model values. Untyped by dwarf. */
declare const wit: {
  Future: { (type: number): { readable: { read(): Promise<unknown> }; writable: { write(v: unknown): void } }; U32: number }
}

/** The exports a signallable program must provide, ready to re-export. */
export interface Wakeable {
  /**
   * Await this alongside the reads a pass makes. Resolves to {@link WOKEN} when
   * the host signals.
   *
   * ⛔ ***CALL IT INSIDE `run`, NOT AT MODULE SCOPE.*** Top-level code runs
   * during the componentizer's snapshot, where there is no task context, and the
   * BUILD fails with a bare `wasm trap: unreachable` naming nothing. Calling it
   * here is also correct on the merits: the read has to register in the waitable
   * set of the task that will be suspended.
   */
  signalled(): Promise<typeof WOKEN>
  /**
   * The `signal` export. Pass a function to decide what to report; the default
   * says `terminating`, which is true of a program that races `signalled()`.
   *
   * ⚠ It is SYNC and must stay sync: it runs on a stack with no task state while
   * `run` is suspended, so it cannot await. Completing a future whose reader is
   * already waiting does not need to.
   */
  handler(state?: (code: number) => SignalState): {
    signal(code: number): SignalState
    wakeCarrier(): unknown
  }
}

/**
 * Build the wake channel for one program.
 *
 * ***THE FUTURE AND ITS WRITE END ARE OWNED HERE, NOT BY THE AUTHOR.*** A
 * hand-rolled version needs a module-level `let waker` that `run` fills and the
 * handler reads - exactly the hidden mutable program state that
 * `internal/reconcilehost/carry.go` argues at length must never exist in a step,
 * arriving by the back door because the mechanism requires two exports to share
 * one object. Keeping it closed over means an author writes a race and never a
 * global.
 */
export function wakeable(): Wakeable {
  let write: ((v: unknown) => void) | undefined

  return {
    signalled(): Promise<typeof WOKEN> {
      const f = wit.Future(wit.Future.U32)
      write = (v) => f.writable.write(v)
      // Started HERE so the read is in this task's waitable set before anything
      // can complete it.
      return f.readable.read().then(() => WOKEN)
    },

    handler(state = () => 'terminating' as SignalState) {
      return {
        signal(code: number): SignalState {
          if (write === undefined) {
            // The step never called `signalled()`, so there is nothing to wake.
            // A true answer: this program cannot wind up.
            return 'running'
          }
          write(code)

          return state(code)
        },

        // ⛔ NEVER CALLED. `wake-carrier` exists so `future<u32>` appears in a
        // function, which is the only form that registers the type - but the
        // world EXPORTS it, so a guest that omits it fails at instantiation
        // rather than at a call. See `interface signal` in reconcile.wit.
        wakeCarrier(): unknown {
          const f = wit.Future(wit.Future.U32)
          f.writable.write(0)

          return f.readable
        },
      }
    },
  }
}
