// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Host wiring for the measuring program. The program is in `probe.ts`; keeping
// every `perseid:reconcile/*` import here is what lets its decision table run
// under an ordinary TypeScript test runner, since those modules exist only
// inside the component runtime.

import {
  type Outcome,
  type Handler,
  runStepAsync,
  known,
  absent,
  unknown,
} from '@apsis-io/perseid/perseid.js'
import { type Effs, SAMPLE_MS, SUBJECT, probeProgram } from './probe.js'
import { wakeable } from '@apsis-io/perseid/wake.js'

import { get as hostGet } from 'perseid:reconcile/observe@0.1.0'
import { carry as hostCarry } from 'perseid:reconcile/carry@0.1.0'
import { status as hostSet, type ConditionStatus as HostCondStatus } from 'perseid:reconcile/status@0.1.0'

const hostHandler: Handler<Effs> = {
  // ***AWAITED, BECAUSE `observe.get` IS `async func`.*** Reading `.tag` off the
  // unawaited promise yields `undefined`, which falls through to `unknown` - so
  // the program would observe nothing and yield forever, looking healthy.
  get: async (path) => {
    const o = await hostGet(path)

    return o.tag === 'known' ? known(o.val) : o.tag === 'absent' ? absent : unknown
  },
  status: (condition) =>
    hostSet({ ...condition, status: condition.status.toLowerCase() as HostCondStatus }),
  // ***NOT AWAITED, BECAUSE `carry.get` IS A SYNC `func`.*** It answers from a
  // string the host already holds on the step's store - there is no round trip
  // to radiant to wait for, which is exactly why it could be sync in the
  // contract. Awaiting a non-promise is harmless; the note is here because the
  // handler beside it MUST await and the two look alike.
  //
  // ⚠ The SDK's op for this is `carry`, not `get`: `Handler` is keyed on the op
  // alone, so a third `get` would collide with `observe`'s and this function
  // would be handed a path. See `reconcile.carry`'s doc in the SDK.
  carry: () => hostCarry(),
}

const wake = wakeable()

const stepEntry = {
  // ***ASYNC BECAUSE ITS IMPORTS ARE, AND RACED SO IT CAN BE FREED.*** A step
  // blocked in a read cannot be stopped from outside; racing the wake future is
  // the only thing that frees it (ADR-0106).
  //
  // ⛔ ***A WOKEN PASS YIELDS AND SAYS NOTHING ABOUT THE CARRY, WHICH MATTERS
  // MORE HERE THAN ANYWHERE ELSE.*** `{o:'yield'}` carries no `carry` key, and
  // an absent key KEEPS the previous value - so a probe freed mid-pass loses one
  // sample and nothing else. Returning an outcome with an empty carry instead
  // would wipe the whole window every time a pass ran long, which is precisely
  // when a measurement is most worth having.
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(probeProgram, hostHandler).then((o) => o satisfies Outcome),
      wake.signalled().then(() => ({ o: 'yield' }) as unknown as Outcome),
    ])

    return JSON.stringify(outcome)
  },
}
const signalEntry = wake.handler()
export { stepEntry as step, signalEntry as signal }

export const run = {
  run(): void {
    console.log(`perseid-probe: measuring ${SUBJECT} every ${SAMPLE_MS}ms`)
  },
}
