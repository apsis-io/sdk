// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Host wiring for the node drainer. The program is in `drainer.ts`.

import {
  type Outcome,
  type Handler,
  type EnsureValue,
  runStepAsync,
  known,
  absent,
  unknown,
} from '@apsis-io/perseid/perseid.js'
import { type Effs, drainerStep, NODE } from './drainer.js'
import { wakeable } from '@apsis-io/perseid/wake.js'

import { get as hostGet } from 'perseid:reconcile/observe@0.1.0'
import { get as hostGetCluster } from 'perseid:reconcile/observe-cluster@0.1.0'
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

/**
 * ⛔ ***THE DISPATCH THIS PROGRAM NEEDS AND THE OTHER EXAMPLES DO NOT.***
 *
 * `Handler` is keyed on the OP alone, and `observe.get` and `observeCluster.get`
 * share it. Every other Perseid here reads only one scope, so its single `get`
 * routes to one import and the sharing is invisible. This one reads a NODE and a
 * DEPLOYMENT, so the same handler must reach two different host functions - and
 * the only thing that distinguishes them is the path.
 *
 * ***`/namespaces/` IS THE DISCRIMINATOR, WHICH IS THE HOST'S OWN RULE***
 * (`aperture.ScopeOf`). Getting it wrong is not a crash: sending a cluster path
 * to `hostGet` returns ABSENT - a namespaced read of a path outside the grant -
 * and the drainer would then believe the node does not exist and refuse to
 * drain. Fail-safe, and silent, which is why it is worth a named function and a
 * comment rather than an inline ternary.
 */
const isNamespaced = (p: string): boolean => p.includes('/namespaces/')

const hostHandler: Handler<Effs> = {
  // ***AWAITED, BECAUSE BOTH READS ARE `async func`.*** Reading `.tag` off the
  // unawaited promise yields `undefined`, which falls through to `unknown` - so
  // the program would observe nothing and yield forever, looking healthy.
  get: async (p) => {
    const raw = String(p)
    const o = isNamespaced(raw) ? await hostGet(raw) : await hostGetCluster(raw)

    return o.tag === 'known' ? known(o.val) : o.tag === 'absent' ? absent : unknown
  },
  ensure: (args) => {
    // The scalar form is what these programs yield; the body form narrows out.
    if ('value' in args) hostEnsure(args.path, args.field, lower(args.value))
  },
  status: (condition) =>
    hostSet({ ...condition, status: condition.status.toLowerCase() as HostCondStatus }),
}

const wake = wakeable()

const stepEntry = {
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(drainerStep, hostHandler).then((o) => o satisfies Outcome),
      wake.signalled().then(() => ({ o: 'yield' }) as unknown as Outcome),
    ])

    return JSON.stringify(outcome)
  },
}
const signalEntry = wake.handler()
export { stepEntry as step, signalEntry as signal }

export const run = {
  run(): void {
    console.log(`perseid-drainer: watching ${NODE} for a drain request`)
  },
}
