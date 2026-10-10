// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ***THE HOST WIRING FOR THE SENTINEL.*** The program is in `sentinel.ts`; this
// file exists to be the only one importing a `perseid:reconcile/*` module, so
// the step can be driven by a test runner with no host anywhere.
//
// ⭐ ***IT BINDS `woke`, AND IT IS THE FIRST COMPONENT IN THIS TREE THAT DOES.***
// `on()` yields a `held` effect; without a handler for it the SDK's runner sees
// an unhandled effect. The host serves it from `perseid:reconcile/woke@0.1.0`,
// which trail has served since 2026-09-06.

import { type Handler, runStepAsync, known, absent, unknown } from '@apsis-io/perseid/perseid'
import { type Effs, sentinelStep, NODE_NAME, DEPLOYMENTS } from './sentinel'

import { wakeable } from '@apsis-io/perseid/wake'
import { get as hostGet } from 'perseid:reconcile/observe@0.1.0'
import { get as hostGetCluster } from 'perseid:reconcile/observe-cluster@0.1.0'
import { held as hostHeld } from 'perseid:reconcile/woke@0.1.0'
import { status as hostSet, type ConditionStatus as HostCondStatus } from 'perseid:reconcile/status@0.1.0'

const isNamespaced = (p: string): boolean => p.includes('/namespaces/')

const hostHandler: Handler<Effs> = {
  // AWAITED, because the reads are `async func`. Reading `.tag` off an unawaited
  // promise yields `undefined`, falls through to `unknown`, and the program
  // observes nothing while looking healthy.
  // ***ONE `get`, DISPATCHING ON THE PATH SHAPE, BECAUSE BOTH READS SHARE THE OP.***
  // `observe` and `observe-cluster` are different WIT interfaces and the SDK gives
  // both the op `get`, so a Handler cannot key them apart - the drainer does
  // exactly this and for exactly this reason.
  get: async (p) => {
    const raw = String(p)
    const o = isNamespaced(raw) ? await hostGet(raw) : await hostGetCluster(raw)

    return o.tag === 'known' ? known(o.val) : o.tag === 'absent' ? absent : unknown
  },
  // ***THE HINT. An older host does not export this at all***, which is why the
  // step must be correct with no arm dispatched - see sentinel.ts's fallback.
  held: () => hostHeld(),
  status: (c) => hostSet({ ...c, status: c.status.toLowerCase() as HostCondStatus }),
}

const wake = wakeable()

const stepEntry = {
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(sentinelStep, hostHandler),
      wake.signalled().then(() => ({ o: 'yield' }) as never),
    ])

    return JSON.stringify(outcome)
  },
}
const signalEntry = wake.handler()
export { stepEntry as step, signalEntry as signal }

export const run = {
  run(): void {
    // Inside run(), NOT at module scope: dwarf's Wizer pre-init evaluates
    // top-level code at BUILD time.
    console.log(`perseid-sentinel: ${[NODE_NAME, ...DEPLOYMENTS.map((d) => d.name)].join(', ')}`)
  },
}
