// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ***THE HOST WIRING FOR THE DEPENDENCY DAG.*** The program itself is in
// `dag.ts`; this file exists to be the only one that imports a
// `perseid:reconcile/*` module, because those resolve only inside the component
// runtime and anything importing them cannot be loaded by a test runner.
//
// Splitting them is what lets `dag.test.ts` drive a real pass against a fake
// handler - the step, the match, the three-valued arms and every resume builder
// exercised, with no host anywhere.

import { type Outcome, type Handler, type EnsureValue, runStepAsync, known, absent, unknown } from '@apsis-io/perseid/perseid.js'
import { type Effs, dagStep, STAGES } from './dag.js'

import { wakeable } from '@apsis-io/perseid/wake.js'
import { get as hostGet } from 'perseid:reconcile/observe@0.1.0'
import { ensure as hostEnsure, type Value as HostValue } from 'perseid:reconcile/ensure@0.1.0'
import { status as hostSet, type ConditionStatus as HostCondStatus } from 'perseid:reconcile/status@0.1.0'

// The same three-arm lowering as `main.ts` and `janitor-main.ts`: the SDK's
// `EnsureValue` is a discriminated record, WIT's is a tagged variant, and its
// `num` arm is an s64 - so the BigInt is the boundary, not decoration.
const lower = (value: EnsureValue): HostValue =>
  // ***DISPATCHES ON `typeof`, BECAUSE `EnsureValue` IS BARE.*** It used to be
  // a tagged union mirroring the WIT variant - `{text}|{num}|{flag}` - and the
  // tag bought nothing on this side: TypeScript already has a discriminant, and
  // THIS function is exactly where the two representations are meant to meet.
  // The variant's tag is load-bearing on the WIRE, which is what it is built
  // here for.
  typeof value === 'number'
    ? { tag: 'num', val: BigInt(Math.trunc(value)) }
    : typeof value === 'boolean'
      ? { tag: 'flag', val: value }
      : { tag: 'text', val: value }

const hostHandler: Handler<Effs> = {
  // ***AWAITED, BECAUSE THE READ IS `async func`.*** Reading `.tag` off the
  // unawaited promise yields `undefined`, which falls through to `unknown` - the
  // program observes nothing and yields forever, looking healthy.
  get: async (path) => {
    const o = await hostGet(path)

    return o.tag === 'known' ? known(o.val) : o.tag === 'absent' ? absent : unknown
  },
  ensure: (args) => {
    // The scalar form is what these programs yield; the body form narrows out.
    if ('value' in args) hostEnsure(args.path, args.field, lower(args.value))
  },
  // NOT A PASS-THROUGH, AND A CAST HERE WOULD COMPILE. The SDK's
  // `ConditionStatus` is Kubernetes' spelling ('True'); WIT's enum is
  // lowercase, so dwarf binds it lowercase. One `toLowerCase()` apart, rejected
  // nowhere on the wire, and `set` returns nothing so the step cannot see it.
  status: (c) => hostSet({ ...c, status: c.status.toLowerCase() as HostCondStatus }),
}

// ***THE SHAPE dwarf BINDS, AND IT IS `run` RETURNING JSON.*** The WIT is
// `perseid:reconcile/step@0.1.0` with `run: func() -> string`, so the export is
// an OBJECT with a `run` method rather than a bare function - main.ts's
// `stepEntry` is the same shape and getting it wrong fails at instantiate
// inside the pod ("no exported instance named ..."), which is a runtime failure
// the build cannot see.
const wake = wakeable()

const stepEntry = {
  // ***ASYNC BECAUSE ITS IMPORTS ARE, AND RACED SO IT CAN BE FREED.*** A step
  // blocked in a read cannot be stopped from outside; racing the wake future is
  // the only thing that frees it (ADR-0106). If the signal wins, the pass yields
  // rather than reporting a decision it never finished making.
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(dagStep, hostHandler),
      wake.signalled().then(() => ({ o: 'yield' }) as never),
    ])

    return JSON.stringify(outcome)
  },
}
const signalEntry = wake.handler()
export { stepEntry as step, signalEntry as signal }

// The `run` export keeps `wasi:cli/command` satisfiable, as main.ts's does.
export const run = {
  run(): void {
    // Inside run(), NOT at module scope: dwarf's Wizer pre-init evaluates
    // top-level code at build time.
    console.log(`perseid-dag: ${STAGES.map((s) => `${s.name}=${s.want}`).join(' -> ')}`)
  },
}

