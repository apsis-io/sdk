// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ***THE HOST WIRING FOR execcheck.*** The program is in `execcheck.ts`; this
// file exists to be the only one importing a host module, so the step can be
// driven by a test runner with no host anywhere.
//
// ⭐ ***IT BINDS `periapsis:host/exec`, AND IT IS THE FIRST PERSEID IN THIS TREE
// THAT DOES.*** The seam was reachable from a `wasi:cli/run` component
// (`../../js-dwarf-shell`, live on a real pod) and from Rust
// (`../../exec-parent`); what is new here is calling it from a program that also
// exports `perseid:reconcile/step`.

import { type Handler, runStepAsync, known, absent, unknown } from '@apsis-io/perseid/perseid'
import { exec } from '@apsis-io/periapsis-sdk/exec'
import { type Effs, type CheckOutcome, execStep, SUBJECT, CHECKER } from './execcheck'

import { wakeable } from '@apsis-io/perseid/wake'
import { get as hostGet } from 'perseid:reconcile/observe@0.1.0'
import { cause as hostCause } from 'perseid:reconcile/woke@0.1.0'
import { status as hostSet, type ConditionStatus as HostCondStatus } from 'perseid:reconcile/status@0.1.0'

const hostHandler: Handler<Effs> = {
  // AWAITED, because the read is an `async func`. Reading `.tag` off an
  // unawaited promise yields `undefined`, falls through to `unknown`, and the
  // program observes nothing while looking healthy.
  get: async (p) => {
    const o = await hostGet(String(p))

    return o.tag === 'known' ? known(o.val) : o.tag === 'absent' ? absent : unknown
  },

  // ⛔ ***THE CATCH IS THE CONTRACT, NOT DEFENSIVE PROGRAMMING.*** The SDK's
  // `exec` THROWS on a name that is not in the pod's allowlist - its `.payload`
  // is `{ tag: "not-allowed" }` - and on this fleet that is the ONLY outcome,
  // because nothing puts `trail.apsis/exec-with` on the pod radiant builds. An
  // uncaught throw would turn "nobody wired a checker" into a crashed pass, which
  // reports as an error about the OPERATOR rather than about its configuration.
  //
  // So the failure is converted into a value the step must branch on, and the
  // step's `unavailable` arm is what makes the distinction survive: a check that
  // did not RUN is not a check that FAILED.
  exec: async ({ name, input }): Promise<CheckOutcome> => {
    try {
      const { exitCode, stdout } = await exec(name, [], input)

      return { t: 'verdict', exitCode, stdout }
    } catch (e) {
      // The tagged payload when there is one, the message otherwise - so a
      // `not-allowed` is named as such in the published condition instead of
      // arriving as a bare "Error".
      // ***CLASSIFIED HERE, WHERE THE THROWN VALUE IS.*** The step used to
      // re-derive this by substring-matching the message, which a rephrasing
      // upstream would have broken silently - reporting a misconfigured
      // spec.execWith as a broken artifact on the node.
      //
      // ⚠ BOTH CHANNELS, because the tagged payload is not always populated:
      // measured live 2026-09-08, a real `not-allowed` arrived with no
      // `payload.tag` and only `Error: not-allowed` as its message. Reading the
      // tag alone would have classified the commonest case as `failed`.
      const tag = (e as { payload?: { tag?: string } })?.payload?.tag
      const text = tag ?? String(e)
      const kind = text.includes('not-allowed') ? 'not-allowed' : 'failed'

      return { t: 'unavailable', kind, reason: text }
    }
  },

  // The COARSE wake reason, straight from the host. NOT derived from `held`
  // being empty - that inference reported a first pass and an unevaluable
  // attribution as a healthy timed re-check, which is why `woke.cause` exists.
  cause: () => hostCause(),
  status: (c) => hostSet({ ...c, status: c.status.toLowerCase() as HostCondStatus }),
}

const wake = wakeable()

const stepEntry = {
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(execStep, hostHandler),
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
    // top-level code at BUILD time, so a host call up here would run against no
    // host at all.
    console.log(`perseid-execcheck: ${SUBJECT} via \`${CHECKER}\``)
  },
}
