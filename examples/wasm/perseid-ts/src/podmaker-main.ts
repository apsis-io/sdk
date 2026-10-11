// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The wiring half of podmaker. The PURE half is podmaker.ts, and the split is
// what lets derive-wit read the program's demand from the logic rather than from
// the imports somebody happened to write here.

import { wakeable } from '@apsis-io/perseid/wake.js'
import {
  type Outcome,
  type Handler,
  type EnsureValue,
  runStepAsync,
} from '@apsis-io/perseid/perseid.js'
import { type Effs, podmakerStep, POD } from './podmaker.js'
import { create as hostCreate } from 'perseid:reconcile/create@0.1.0'
// ***`Value` COMES FROM ensure, NOT create.*** One value type serves every
// generalized write; create declares it locally and does not re-export it.
import { type Value as HostValue } from 'perseid:reconcile/ensure@0.1.0'
import { status as hostSet, type ConditionStatus as HostCondStatus } from 'perseid:reconcile/status@0.1.0'

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

// ***NO `get` HANDLER, AND THE TYPE SYSTEM IS WHAT SAID SO.*** The step never
// reads: `objectGone(POD)` is a RESUME expression the HOST evaluates while the
// program is parked, not an effect the guest performs. `Handler<Effs>` is derived
// from the step's actual demand, so writing a `get` here is a type error rather
// than dead code.
//
// ***AND THE PARK STILL NEEDS A READ THE COMPILER CANNOT SEE - IT IS JUST NOT THE
// MANIFEST'S JOB ANY MORE.*** `Handler<Effs>` is derived from what the STEP
// performs; `objectGone(POD)` is evaluated by the HOST after the step returns. So
// the compiler is right that no `get` handler belongs here, AND the program still
// requires authority to read that pod. Two questions that look identical from
// inside the guest, with different answers.
//
// ⛔ THIS COMMENT HAS HELD THREE ANSWERS IN ONE DAY (2026-09-01), so trust the
// date rather than the confidence:
//
//	1. "resumeCaps confers pod reads on every parked program"    TRUE, then not
//	2. "so spec.capabilities must grant `observe`"               a WORKAROUND
//	3. a declared WRITE confers the park-only read (9dcbbcfe3)   current
//
// (1) was true when written and falsified hours later by resumeCapsFor, which
// evaluates a resume with the program's own read capabilities. What that produced
// on the cluster is the shape worth recognising, because every marker was green:
//
//	Applied         Create(".../pods/podmaker-proof")   the write LANDED
//	podmaker-proof  1/1 Running                         the pod came UP
//	PerseidFailed   unresolved identifier: "Get"        parking FAILED
//
// ***THE STEP SUCCEEDS AND THE PROGRAM DIES PARKING.*** A reader watching only
// whether the write landed sees a complete success.
//
// (3) is why podmaker.yaml grants no `observe`: this program declares the pod in
// spec.writes, and perseidrun.DerivedRules already grants `get` on everything
// there - so refusing the read was the aperture refusing what the apiserver would
// serve to this program's own ServiceAccount.
const hostHandler: Handler<Effs> = {
  create: ({ path, body }) =>
    hostCreate(path, body.map((f) => ({ path: f.path, value: lower(f.value) }))),
  status: (condition) =>
    hostSet({ ...condition, status: condition.status.toLowerCase() as HostCondStatus }),
}

const wake = wakeable()

const stepEntry = {
  // ***ASYNC BECAUSE ITS IMPORTS ARE, AND RACED SO IT CAN BE FREED.*** A step
  // blocked in a read cannot be stopped from outside; racing the wake future is
  // the only thing that frees it (ADR-0106). If the signal wins, the pass yields
  // rather than reporting a decision it never finished making.
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(podmakerStep, hostHandler),
      wake.signalled().then(() => ({ o: 'yield' }) as never),
    ])

    return JSON.stringify(outcome)
  },
}

const signalEntry = wake.handler()
export { stepEntry as step, signalEntry as signal }

export const run = {
  run(): void {
    console.log(`perseid-podmaker: declares ${POD}`)
  },
}
