// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A PERSEID WHOSE VERDICT IS A COMPONENT THE OPERATOR WIRED AT LAUNCH.
//
// It reads a Deployment, hands a projection of it to a child component called
// `check`, and publishes what that child says. Swapping the policy is
// `--exec-with check=<other>.wasm` at pod launch - not a rebuild of this program,
// which never names the artifact and cannot.
//
// ⭐ ***THE SPAWN IS AN EFFECT, NOT A CALL, AND THAT IS THE WHOLE REASON THIS
// FILE IS TESTABLE.*** `sdk/ts/periapsis/exec.ts` gives a perfectly good
// `await exec(name, args, input)`, and calling it HERE would make the step a
// function of the host rather than of its observations - no `runStep(step,
// fakeHandler)`, no `execcheck.test.ts`. So the step YIELDS a request and
// `execcheck-main.ts` performs it, exactly as `observe` and `status` already
// work. The seam is new; the shape is not.
//
// The allowlist is `spec.execWith` on the Perseid:
//
//     spec:
//       execWith:
//         check: /var/lib/apsis/wasm-exec/perseid-exec-checker.wasm
//
// ⚠ ***THAT FIELD DID NOT EXIST UNTIL 2026-09-08.*** `--exec-with` comes from the
// `trail.apsis/exec-with` pod annotation and radiant builds a Perseid's pod
// itself, so there was no route for an allowlist to reach a Perseid at all -
// `periapsis:host/exec` was admissible in `spec.capabilities` and every spawn
// still returned `not-allowed`. Paths are confined to `/var/lib/apsis/wasm-exec`
// because a Perseid author may not hold pod-create; see `ExecWithRoot` in
// internal/trailop/perseidpod.go and ../../perseid-exec/README.md.
//
// ⛔ ***DECLARING NOTHING NO LONGER REACHES THE `unavailable` ARM - IT FAILS AT
// INSTANTIATION*** (engi, 2026-09-08, and this file said otherwise for a day).
// trail's `step_linker` withholds `periapsis:host/exec` from the linker unless
// the allowlist is non-empty, so a Perseid importing exec with no `spec.execWith`
// is refused with *"component imports instance `periapsis:host/exec@0.1.0`, but a
// matching implementation was not found in the linker"* - loudly, before a pass
// runs, which is the point: a silent `not-allowed` is indistinguishable from
// "nobody wired a checker".
//
// ⚠ ***THE ARM IS STILL REACHABLE, AND BY THE CASE THAT MATTERS.*** With a
// non-empty allowlist that does not contain THIS name - `spec.execWith` declares
// `audit` and the program spawns `check` - exec IS linked and `spawn` returns
// `not-allowed`. That is a misconfiguration a program should survive and report
// rather than crash on, so the branch below is live, not defensive padding.

import {
  type EffectsOf,
  path,
  reconcile,
  reader,
  defineStep,
  wakeCause,
  defineEffect,
  quiesce,
  anyOf,
  backstop,
  ready,
  unready,
  unsure,
  objectExists,
  objectGone,
  fieldNoLonger,
} from '@apsis-io/perseid/perseid.js'
import { asDeployment } from '@apsis-io/perseid/k8s.js'
import { stringToBytes } from '@apsis-io/periapsis-sdk/codec.js'

const observe = reconcile.observe<string>()
const report = reconcile.status()

/** The exec seam, as an effect. The id is what puts it in the derived world. */
export const WIT_EXEC = 'periapsis:host/exec@0.1.0'

/** What the step asks for: an allowlist NAME, never a path. */
export interface CheckRequest {
  readonly name: string
  readonly input: string
}

/**
 * What comes back.
 *
 * ⛔ ***THREE-VALUED, LIKE A READ, AND FOR THE SAME REASON.*** `unavailable` is
 * not a failing check - it is the absence of one. The SDK's `exec` THROWS on
 * `not-allowed`, and a step that let that throw would turn "nobody wired a
 * checker" into a crashed pass; a step that caught it and reported `unready`
 * would announce a workload unhealthy on the strength of its own missing
 * configuration. Neither is true, so the handler maps it to a value the step
 * must branch on.
 */
export type CheckOutcome =
  | { readonly t: 'verdict'; readonly exitCode: number; readonly stdout: string }
  /**
   * ⛔ ***`kind` IS DECIDED WHERE THE ERROR OBJECT IS, NOT RE-DERIVED FROM
   * `reason`.*** This branched on `reason.includes('not-allowed')` - a substring
   * match against a host message - so a rephrasing in the linker or the SDK
   * wrapper would silently reclassify a MISCONFIGURED SPEC as a broken artifact
   * on the node, sending an operator to the wrong machine.
   *
   * The handler holds the thrown value and its tagged payload; it is the only
   * place that can classify without guessing, so it does.
   */
  | {
      readonly t: 'unavailable'
      readonly kind: 'not-allowed' | 'failed'
      readonly reason: string
    }

export const runCheck = defineEffect<CheckRequest, CheckOutcome>()(WIT_EXEC, 'exec')

export const SUBJECT = path.ns('default').deployments('exec-demo')

/** The allowlist NAME. Which artifact it is, is a launch-time decision. */
export const CHECKER = 'check'

/**
 * ***BOUNDED BECAUSE THE PIPE IS.*** trail's duplex pipe is `BUF_CAP = 8192`
 * bytes and the SDK's `exec` writes stdin to completion BEFORE draining stdout.
 * That is safe only while the payload fits: a larger one blocks mid-write while
 * the child fills its own stdout with nobody draining it, and both ends stop - a
 * deadlock, not an error. A real object's raw JSON would hit this routinely
 * (`managedFields` alone usually clears 8 KB), which is why this program sends a
 * PROJECTION. A program that genuinely needs to stream more must interleave the
 * write with the read (`spawn` + `Promise.all`, per exec.ts) rather than raise
 * this number.
 */
export const MAX_STDIN = 4096

interface Deployment {
  metadata?: { name?: string; resourceVersion?: string }
  spec?: { replicas?: number }
  status?: {
    replicas?: number
    readyReplicas?: number
    availableReplicas?: number
    conditions?: unknown
  }
}

// ⛔ ***`asDeployment`, NOT A BARE `JSON.parse` CAST.*** `reader`'s `get` calls
// the decoder WITHOUT a try/catch, so a body that does not parse threw straight
// out of the step - crashing the pass instead of degrading to `unknown`, which
// is the one thing the three-valued read exists to prevent. The SDK decoder
// catches, and also refuses a body that parses to a scalar or array, where the
// cast handed every accessor `undefined` and read as a real object at defaults.
const read = reader(observe, asDeployment)

/**
 * What the checker is given: a PROJECTION of the subject, not the subject.
 *
 * Two reasons, and the second is the interesting one. It keeps the payload under
 * `MAX_STDIN`; and it makes the contract between this program and a swappable
 * checker EXPLICIT, so replacing the checker cannot silently start depending on
 * a field nobody meant to expose.
 */
export function project(d: Deployment): string {
  return JSON.stringify({
    name: d.metadata?.name ?? null,
    // ⚠ Kubernetes OMITS `readyReplicas` at zero, and zero is the failure a
    // checker exists for. `?? null` keeps ABSENT distinguishable from 0 on the
    // wire instead of quietly manufacturing a number the apiserver never sent.
    spec: { replicas: d.spec?.replicas ?? null },
    status: {
      replicas: d.status?.replicas ?? null,
      readyReplicas: d.status?.readyReplicas ?? null,
      availableReplicas: d.status?.availableReplicas ?? null,
      conditions: d.status?.conditions ?? null,
    },
  })
}

/**
 * What to wake on.
 *
 * ⚠ Written in the ABSENT-OR-DIFFERENT shape (`fieldNoLonger`) rather than a
 * plain `!=`: an absent operand propagates as *unknown*, not true, so a bare
 * inequality would never fire on the object being deleted. `objectGone` covers
 * the deletion explicitly anyway, because that is the case an operator most wants
 * a condition for. The host renders `(<this>) || Backstop()` around the whole
 * thing (`aperture/eval.go`'s `WithBackstop`), so `backstop()` here is this
 * program's own declared arm rather than the bound.
 */
function parkOn(rv: string | undefined) {
  return rv === undefined
    ? anyOf(objectGone(SUBJECT), backstop())
    : anyOf(objectGone(SUBJECT), fieldNoLonger(SUBJECT, 'metadata.resourceVersion', rv), backstop())
}

// ⚠ NAMED `step` BECAUSE `derive-wit.ts` LOOKS FOR THAT SYMBOL, and exported
// under a qualified name below because `-main.ts` and the test import it
// alongside other programs' steps. Same split as `sentinel.ts`.
const step = defineStep(function* () {
  const seen = yield* read.get(SUBJECT)

  // ⛔ ***`unknown` IS NOT `absent`, AND REPORTING `unready` HERE WOULD BE THE
  // MOST REPEATED DEFECT IN THIS CODEBASE.*** The read failed; the subject may be
  // in perfect health. `unsure` is what this pass actually established.
  if (seen.t === 'unknown') {
    yield* report(unsure('ReadFailed', `could not read ${SUBJECT}`))

    return quiesce(anyOf(objectExists(SUBJECT), backstop()))
  }

  if (seen.t === 'absent') {
    yield* report(unready('SubjectAbsent', `${SUBJECT} does not exist`))

    return quiesce(anyOf(objectExists(SUBJECT), backstop()))
  }

  const park = parkOn(seen.v.metadata?.resourceVersion)
  const input = project(seen.v)

  // ⛔ ***BYTES, NOT `String.length`, AND THE OLD MESSAGE SAID "bytes" WHILE
  // COUNTING UTF-16 CODE UNITS.*** A JS string's length is code units, so any
  // multi-byte character makes the check UNDERCOUNT: a projection of 4096
  // two-byte characters passes a 4096 "byte" bound and writes 8192 bytes -
  // exactly the pipe capacity this bound exists to stay under, which is a
  // DEADLOCK rather than an error. Kubernetes object fields carry arbitrary
  // UTF-8 (a condition message, an annotation), so this is reachable.
  //
  // Measured with `stringToBytes` - the SAME encoder `exec.ts` writes the child's
  // stdin with - so the number checked here and the number written cannot
  // disagree. A second encoder would be two things that must agree.
  const inputBytes = stringToBytes(input).length
  if (inputBytes > MAX_STDIN) {
    yield* report(
      unsure('ProjectionTooLarge', `projection is ${inputBytes} bytes, over the ${MAX_STDIN}-byte stdin bound`),
    )

    return quiesce(park)
  }

  const out = yield* runCheck({ name: CHECKER, input })

  // Nothing about the subject was established, so nothing about it is claimed.
  //
  // ⛔ ***`not-allowed` AND `spawn-failed` ARE DIFFERENT PLACES TO LOOK, AND THIS
  // REPORTED BOTH AS `NoChecker` UNTIL IT WAS MEASURED.*** Both are three-valued
  // `unsure` and that half was right; the REASON is what an operator navigates
  // by, and `NoChecker` says "your spec.execWith is wrong".
  //
  //     not-allowed   the name is not in the allowlist   -> fix spec.execWith
  //     spawn-failed  the name IS allowed and the path   -> fix the NODE
  //                   did not load
  //
  // Measured live 2026-09-08 by moving the checker out of
  // /var/lib/apsis/wasm-exec on the node: the grant was perfectly correct and
  // the program said `NoChecker`, which would have sent somebody to re-read a
  // spec that had nothing wrong with it. The message carried `spawn-failed` all
  // along - but a reason travels and a message gets truncated.
  if (out.t === 'unavailable') {
    const wired = out.kind === 'not-allowed'
    yield* report(
      unsure(
        wired ? 'NoChecker' : 'CheckerUnavailable',
        `\`${CHECKER}\` did not run: ${out.reason}` +
          (wired
            ? ` - it is not in this pod's allowlist (spec.execWith)`
            : ` - it IS allowed, so the artifact on the node is what failed to load`),
      ),
    )

    return quiesce(park)
  }

  // ***THE EXIT CODE IS THE VERDICT, THE STDOUT IS THE EXPLANATION.*** This
  // program does not interpret the text - that is the checker's job, and reading
  // it here would put half the policy back in the operator.
  const said = out.stdout.trim() === '' ? '(no output)' : out.stdout.trim()
  // ***THE WAKE CAUSE IS CONTEXT IN THE MESSAGE, NEVER THE VERDICT.*** The status
  // describes the WORLD - what the checker said about the subject - and `why`
  // describes why this pass ran. `simple.ts` records the same rule after shipping
  // it backwards once: a wake says why we RAN, not what is TRUE now.
  //
  // Reported at all because it is the only way to tell, from outside, a program
  // that is WATCHING from one that is merely polling - and because it is what
  // makes `woke.cause` observable on a live cluster rather than only in a test.
  const why = yield* wakeCause()

  yield* report(
    out.exitCode === 0
      ? ready('CheckPassed', `${said}; woke on ${why}`)
      : unready('CheckFailed', `\`${CHECKER}\` exited ${out.exitCode}: ${said}; woke on ${why}`),
  )

  return quiesce(park)
})

export type Effs = EffectsOf<typeof step>

export { step as execStep }
