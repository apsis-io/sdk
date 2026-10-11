// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Host wiring for the readiness-gated canary. The program remains in
// `canary.ts`; keeping every `perseid:reconcile/*` import here makes its decision
// table loadable by an ordinary TypeScript test runner.

import {
  type Outcome,
  type Handler,
  type EnsureValue,
  runStepAsync,
  known,
  absent,
  unknown,
} from '@apsis-io/perseid/perseid.js'
import { type Effs, canaryStep, STABLE, CANARY, PROBE, TOTAL } from './canary.js'
import { wakeable } from '@apsis-io/perseid/wake.js'

import { get as hostGet, now as hostNow } from 'perseid:reconcile/observe@0.1.0'
import { ensure as hostEnsure, type Value as HostValue } from 'perseid:reconcile/ensure@0.1.0'
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

const hostHandler: Handler<Effs> = {
  // ***AWAITED, BECAUSE `observe.get` IS `async func`.*** Reading `.tag` off the
  // unawaited promise yields `undefined`, which falls through to `unknown` - so
  // the program would observe nothing and yield forever, looking healthy.
  get: async (path) => {
    const o = await hostGet(path)
    return o.tag === 'known' ? known(o.val) : o.tag === 'absent' ? absent : unknown
  },
  ensure: (args) => {
    // The scalar form is what these programs yield; the body form narrows out.
    if ('value' in args) hostEnsure(args.path, args.field, lower(args.value))
  },
  status: (condition) =>
    hostSet({ ...condition, status: condition.status.toLowerCase() as HostCondStatus }),
  // ***THE HOST'S CLOCK, AND THE FRESHNESS GATE DEPENDS ON IT BEING THE SAME
  // ONE THE PROBE USED.*** `observe.now` is answered by radiant, which is also
  // what the probe's `Date.now()` runs against inside its own pod - two
  // machines, one cluster, and a skew between them shows up as a measurement
  // that reads stale or future-stamped. Answering this from the guest's own
  // clock would make the two sides of the subtraction incomparable.
  now: async () => Number(await hostNow()),
}

const wake = wakeable()

const stepEntry = {
  // ***ASYNC BECAUSE ITS IMPORTS ARE, AND RACED SO IT CAN BE FREED.*** A step
  // blocked in a read cannot be stopped from outside; racing the wake future is
  // the only thing that frees it (ADR-0106). If the signal wins, the pass yields
  // rather than reporting a decision it never finished making.
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(canaryStep, hostHandler).then((o) => o satisfies Outcome),
      wake.signalled().then(() => ({ o: 'yield' }) as unknown as Outcome),
    ])

    return JSON.stringify(outcome)
  },
}
const signalEntry = wake.handler()
export { stepEntry as step, signalEntry as signal }

export const run = {
  run(): void {
    console.log(
      `perseid-canary: ${STABLE}=${TOTAL} -> ${CANARY}=${PROBE} -> ${CANARY}=${TOTAL}`,
    )
  },
}
