// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ***THE WIRING HALF*** - see janitor.ts for what this program does and why.
//
// Split for the reason dag-main.ts is: `perseid:reconcile/*` are WIT imports
// that only exist inside the component runtime, so any module importing them
// cannot be loaded by a test runner. Keeping them here leaves janitor.ts pure
// and testable.

import {
  type Outcome,
  type FinalizeOutcome,
  type Handler,
  type EnsureValue,
  runStepAsync,
  runFinalizeAsync,
  known,
  absent,
  unknown,
} from '@apsis-io/perseid/perseid.js'
import { type Effs, type FinalizeEffs, janitorStep, janitorFinalize } from './janitor.js'
import { wakeable } from '@apsis-io/perseid/wake.js'
import { get as hostGet } from 'perseid:reconcile/observe@0.1.0'
import { ensure as hostEnsure, type Value as HostValue } from 'perseid:reconcile/ensure@0.1.0'
import { create as hostCreate } from 'perseid:reconcile/create@0.1.0'
import { delete as hostDelete } from 'perseid:reconcile/delete@0.1.0'
import { status as hostSet, type ConditionStatus as HostCondStatus } from 'perseid:reconcile/status@0.1.0'

// ONE HANDLER FOR BOTH ENTRYPOINTS, and that is the point rather than a saving:
// a finalizer observes and declares with exactly the vocabulary a step does.
// Being on the deletion path grants nothing extra, so a second handler would be
// a second place for the two to disagree about what the host can do.
//
// The type says so too - `Effs | FinalizeEffs` is satisfied by one object
// because both generators yield the same effect union.
const lower = (v: EnsureValue): HostValue =>
  // Dispatches on `typeof`: EnsureValue is bare (string | number | boolean).
  // The WIT variant's tag is built HERE, which is where the two representations
  // are meant to meet.
  typeof v === 'number'
    ? { tag: 'num', val: BigInt(Math.trunc(v)) }
    : typeof v === 'boolean'
      ? { tag: 'flag', val: v }
      : { tag: 'text', val: v }

const hostHandler: Handler<Effs | FinalizeEffs> = {
  // ***AWAITED, BECAUSE THE READ IS `async func`.*** Reading `.tag` off the
  // unawaited promise yields `undefined`, which falls through to `unknown` - the
  // program observes nothing and yields forever, looking healthy.
  get: async (path) => {
    const o = await hostGet(path)

    return o.tag === 'known' ? known(o.val) : o.tag === 'absent' ? absent : unknown
  },
  // ***THE SDK's VALUE SHAPE IS NOT THE WIT's, SO THIS CONVERTS.*** The SDK
  // uses `{ text } | { num }`; the WIT variant lowers to `{ tag, val }`, and
  // `s64` lowers to `bigint`. Forwarding the SDK object unchanged would compile
  // against `any` and produce a malformed variant at runtime - the same shape as
  // the lowercase-enum trap `set` pays for below.
  // ***ONE CONVERSION, THREE CALLERS.*** The SDK's value shape is `{text}|{num}|
  // {flag}` and the WIT variant lowers to `{tag, val}` with `u64` as `bigint`.
  // `ensure` and `create` both carry values, so the mapping lives in one place -
  // two copies would be two things that must agree about a shape whose wrongness
  // is silent (a malformed variant at runtime, not a type error).
  ensure: (args) => {
    // The scalar form is what these programs yield; the body form narrows out.
    if ('value' in args) hostEnsure(args.path, args.field, lower(args.value))
  },
  create: ({ path, body }) =>
    hostCreate(path, body.map((f) => ({ path: f.path, value: lower(f.value) }))),
  delete: (path) => hostDelete(path),
  // `.toLowerCase()` is not cosmetic: the SDK's ConditionStatus is 'True' |
  // 'False' | 'Unknown' and the WIT variant is lowercase, and nothing on the
  // wire rejects the wrong one - it is a string either way. See main.ts, which
  // pays for this at length.
  status: (c) => hostSet({ ...c, status: c.status.toLowerCase() as HostCondStatus }),
}

// ***EXPORTED UNDER DIFFERENT LOCAL NAMES, as main.ts and dag-main.ts are.*** The
// WIT exports must be called `step` and `finalize`; those names are already the
// generators, and derive-wit finds them BY DECLARATION NAME to read the
// capability demand out of their yield types. An ES module alias keeps both.
const wake = wakeable()

const stepEntry = {
  // `run: func() -> string` - the outcome as JSON, because a step's outcome
  // carries a resume EXPRESSION that no WIT type can describe.
  // ***ASYNC BECAUSE ITS IMPORTS ARE, AND RACED SO IT CAN BE FREED.*** A step
  // blocked in a read cannot be stopped from outside; racing the wake future is
  // the only thing that frees it (ADR-0106). If the signal wins, the pass yields
  // rather than reporting a decision it never finished making.
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(janitorStep, hostHandler),
      wake.signalled().then(() => ({ o: 'yield' }) as never),
    ])

    return JSON.stringify(outcome)
  },
}

const finalizeEntry = {
  // ***`run: func() -> outcome` - A VARIANT, NOT JSON, WHICH IS WHERE THIS
  // DIFFERS FROM `step`.*** A finalize outcome is closed and tiny, so
  // reconcile.wit declares it as a variant and the component model carries the
  // shape; there is nothing to stringify and nothing for the host to parse.
  // ***ASYNC FOR THE SAME REASON THE STEP IS.*** This finalizer decides from the
  // WORLD, through the very same handler, so it performs the same async reads -
  // and `finalize.run` became `async func` precisely because a sync one could not
  // await them.
  run: async (): Promise<FinalizeOutcome> => runFinalizeAsync(janitorFinalize, hostHandler),
}

const signalEntry = wake.handler()
export { stepEntry as step, finalizeEntry as finalize, signalEntry as signal }
