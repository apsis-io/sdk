// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * ***THE PROGRAM'S OWN BOUND ON A PARK, DECLARED ONCE AND COMPILED IN.***
 *
 * A Perseid that parks is asleep until its condition fires. If that condition is
 * too narrow, or a watch is dropped, the only thing that ever wakes it again is
 * the backstop - so every park has one, and this is how a program states its own
 * rather than taking the host's.
 *
 * # WHERE IT LIVES, AND WHY IT IS NOT A FIELD ON THE OBJECT
 *
 * It was `spec.maxSleepMs` until 2026-09-04 and is now a wasm custom section on
 * the artifact. engi: *"why cluster operator need or would change backstop at
 * all, like controller-runtime doesn't let you change runtime params"* - and
 * measured, they were right: the bound does not pace apiserver load (the poll
 * interval does, separately), it only decides how long a program that missed a
 * wake stays missed. Every Perseid on the fleet had the field owned by radiant
 * rather than by a human, most of them sitting on the default.
 *
 * ⛔ ***AND IT COULD NOT GO IN THE PARK EXPRESSION***, which was tried first. A
 * resume is assembled at RUNTIME, so admission never sees one: a bound written
 * there is invisible until the first park, and the whole point is to refuse a
 * bad one before a pod exists. A custom section is the only carrier that is both
 * compiled into the program and readable at inspection.
 *
 * # HOW IT REACHES THE HOST
 *
 * The section is attached AFTER componentization, by `tools/attach-backstop.ts`
 * - not emitted by the toolchain. That is measured rather than assumed: a
 * top-level custom section appended to a real component is read back by
 * `trail --inspect` (verified 2026-09-04 against `magic-0.1.0.wasm`), and it is
 * the one mechanism that works identically for every language, since
 * componentize-js has no way to emit one.
 *
 *     radiant:backstop  ->  trail --inspect  ->  ComponentManifest
 *       status.backstop ->  admission, and the park's actual bound
 */

/** The wasm custom section carrying the bound. A NAME, so a `const`. */
export const BACKSTOP_SECTION = 'radiant:backstop'

/**
 * The host's bound when a program declares none.
 *
 * ***EXPORTED SO A PROGRAM CAN SAY "THIS IS FINE" EXPLICITLY.*** Declaring
 * `DEFAULT_BACKSTOP_MS` is not the same as declaring nothing: the first is a
 * decision, the second is a program nobody has thought about, and the build
 * tells them apart. See `attachBackstop`'s warning.
 */
export const DEFAULT_BACKSTOP_MS = 300_000

/**
 * A number the compiler can see. A computed value widens to `number`, which
 * makes this `never` and the call a type error.
 *
 * ***THIS MIRRORS A HOST RULE RATHER THAN INVENTING ONE.*** The bound has to be
 * a property of the PROGRAM, not of when it was built - `trail` refuses a
 * fractional, zero or negative payload at decode, and a value computed at build
 * time is a bound nobody can read off the source. Enforcing it in the type
 * system moves that refusal from ingest to the author's editor.
 *
 * ⚠ `60 * 1000` IS REJECTED - TypeScript widens arithmetic to `number`. That is
 * why `seconds`/`minutes` exist: the author passes a literal and the SDK does
 * the multiplication.
 */
type Literal<N extends number> = number extends N ? never : N

/** The section payload for `ms` milliseconds: `{"ms": <n>}` as UTF-8. */
const payload = (ms: number): Uint8Array => new TextEncoder().encode(JSON.stringify({ ms }))

/**
 * Declare this program's park bound.
 *
 *     export const backstop = declareBackstop.seconds(60)
 *
 * A DURATION, never a deadline - the only form a constant can take, since an
 * absolute instant is a fact about a moment and a program compiled on Tuesday
 * cannot carry Wednesday's. The host turns it into an instant at park time.
 */
export const declareBackstop = Object.assign(
  <const Ms extends number>(ms: Literal<Ms>): BackstopDecl => ({ ms, bytes: payload(ms) }),
  {
    seconds: <const S extends number>(s: Literal<S>): BackstopDecl => ({
      ms: s * 1000,
      bytes: payload(s * 1000),
    }),
    minutes: <const M extends number>(m: Literal<M>): BackstopDecl => ({
      ms: m * 60_000,
      bytes: payload(m * 60_000),
    }),
  },
)

/** A declared bound and the bytes that carry it. */
export interface BackstopDecl {
  readonly ms: number
  readonly bytes: Uint8Array
}

/**
 * Append `decl` to a built component as a top-level custom section.
 *
 * ***APPENDING IS THE WHOLE MECHANISM.*** A wasm custom section is
 * `0x00 <leb size> <leb name-len> <name> <data>`, and a component is a wasm
 * container, so a section appended at the end is a TOP-LEVEL section - which is
 * exactly what trail reads (`depth == 0`, deliberately: it will not pick up a
 * section from a nested module a dependency dragged in).
 */
export function attachBackstop(component: Uint8Array, decl: BackstopDecl): Uint8Array {
  const name = new TextEncoder().encode(BACKSTOP_SECTION)
  const body = new Uint8Array([...leb(name.length), ...name, ...decl.bytes])

  return new Uint8Array([...component, 0x00, ...leb(body.length), ...body])
}

/** Unsigned LEB128, the length encoding every wasm section header uses. */
function leb(n: number): number[] {
  const out: number[] = []
  for (;;) {
    const b = n & 0x7f
    n >>>= 7
    if (n === 0) {
      out.push(b)

      return out
    }
    out.push(b | 0x80)
  }
}
