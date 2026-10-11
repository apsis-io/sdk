// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// A PERSEID THAT CREATES A POD.
//
// ***THIS EXISTS TO PROVE A COMPOSITION, NOT TO BE USEFUL.*** Every gate in the
// chain was measured separately on 2026-09-01; this is the end-to-end run, which
// is a different claim:
//
//   1. the aperture refuses pods only for a BORROWED credential
//      (bounds.go: `a == Write && f.grant.BorrowsRadiantIdentity()`)
//   2. `spec.writes` names the pod, so the write boundary permits it
//   3. radiant derives RBAC granting `create pods`, bounded by radiant's own
//      grants via Kubernetes' escalation check
//   4. seam-binding-vap.yaml governs the resulting create, because the identity
//      is no longer the one it exempts
//
// ***WHY A POD AT ALL: IT WAS REFUSED OUTRIGHT UNTIL TODAY.*** `unwritableKinds`
// banned the KIND to compensate for the CREDENTIAL - a Perseid applying as
// radiant could have stamped `radiant.apsis/link` through the one identity the
// policy lets past. With a per-program identity the premise is false, so the
// question becomes an ordinary one about RBAC and `spec.writes`.
//
// ⚠ ***WHAT THIS PROGRAM DOES NOT DEMONSTRATE, AND A READER WILL ASSUME IT
// DOES.***
//
//   - `create` IS KIND-LEVEL. RBAC cannot scope a create by name - the name is
//     in the request BODY, so authorization sees an empty one and a
//     `resourceNames` rule matches nothing. So declaring ONE pod grants create on
//     ALL pods in this namespace. `Ensure` and `Delete` on that pod stay
//     object-scoped; create is the widening, and it is Kubernetes', not ours.
//   - THE VAP GUARDS FIVE ANNOTATION KEYS, NOT POD CONTENT. It stops
//     `radiant.apsis/link|remote|ipc|bound|bound-by`. It does not care what image
//     runs. What bounds that is `spec.writes` plus the namespace's own
//     PodSecurity admission.
//   - A BARE POD HAS NO CONTROLLER. Nothing reschedules it if its node goes
//     away. ⛔ ***AND THIS SAID "what brings it back is this program re-declaring
//     it next pass" - MEASURED FALSE 2026-09-01.*** The program re-declares it
//     every pass and the pod stayed absent for ~33 minutes and ~150 passes, with
//     `Ready=True PodDeclared` asserted throughout; a radiant restart brought it
//     back in 13 seconds. The write is suppressed by `reconcile.Tracker` holding
//     the obligation outstanding, silently. Full measurement at the `quiesce`
//     below - and read it before writing a program that depends on this.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type EffectsOf,
  path,
  reconcile,
  defineStep,
  quiesce,
  anyOf,
  backstop,
  objectGone,
} from '@apsis-io/perseid/perseid.js'

const create = reconcile.create()
const report = reconcile.status()

// The pod this program owns. A `const` for the reason every target path in these
// examples is one: it is the program's identity, not an input.
const POD = path.ns('perseid-demo').pods('podmaker-proof')

// Re-check cadence. The step is total, so it re-declares the pod every pass and
// the applier treats AlreadyExists as success - this only bounds how long the
// program sleeps between confirmations.
// ⛔ There was a `const RECHECK_MS = 30_000` here. Its number did not go away -
// it moved into `podmaker-backstop.ts`, where a bound belongs: readable off the
// artifact, refusable at admission, and adjustable without touching the step.
// The park operand it fed is gone and the effective bound is unchanged.

const step = defineStep(function* () {
  // ***DECLARED EVERY PASS, NOT ONCE.*** A total step has no memory. It states
  // what should exist and the applier reconciles; AlreadyExists is success for
  // the same level-triggered reason NotFound is success for a delete.
  yield* create({
    path: POD,
    body: [
      // ⚠ ***BOTH ARE `text`, AND A POD'S SCHEMA IS THE AUTHOR'S TO KNOW.***
      // janitor.ts pays for this twice - a ConfigMap's `data` is
      // map[string]string and a Service port is an int32. No layer between here
      // and the apiserver knows the target's schema, so a wrong variant surfaces
      // as a logged refusal at apply that re-declares next pass.
      { path: 'spec.containers[0].name', value: 'proof' },
      { path: 'spec.containers[0].image', value: 'busybox:1.36' },
      { path: 'spec.containers[0].command[0]', value: 'sleep' },
      { path: 'spec.containers[0].command[1]', value: '3600' },
      // ***RestartPolicy MATTERS FOR A BARE POD.*** The default is Always, which
      // would restart the container forever after `sleep` exits. This program
      // owns a pod nothing else manages, so it says what should happen when the
      // process ends rather than inheriting a Deployment's assumption.
      { path: 'spec.restartPolicy', value: 'Never' },
      { path: 'metadata.labels.managed-by', value: 'perseid' },
    ],
  })

  yield* report({
    type: 'Ready',
    status: 'True',
    reason: 'PodDeclared',
    message: 'the pod is declared; a Perseid may create one because it applies ' +
      'as its own ServiceAccount rather than as radiant',
  })

  // Park until the pod goes away, or the deadline - whichever first.
  //
  // ⛔ ***THIS COMMENT SAID "if somebody deletes it, this wakes and re-creates
  // it, which is the whole point of a total step". MEASURED 2026-09-01: IT DOES
  // NOT.***
  //
  //	pod deleted            17:07:48Z
  //	still absent           17:41:29Z   ~33 min, ~150 passes
  //	Create declared        every one of those passes ("declared 2 obligation(s)")
  //	status                 Parked, Ready=True PodDeclared, throughout
  //	radiant restarted      17:41:29Z
  //	pod re-created         17:41:42Z   THIRTEEN SECONDS after the restart
  //
  // The program does wake - it wakes constantly, because `!exists` is already
  // true when it parks - and it re-declares the Create every pass. The write is
  // suppressed downstream: `reconcile.Tracker` holds the obligation OUTSTANDING
  // (keyed on the expression text) and returns ServiceDeduped, which
  // servicing.go logs nowhere because "a dedup is the steady state of a converged
  // program". Restarting radiant builds a fresh tracker and the same declaration
  // is authorised in 13 s.
  //
  // ***WHAT THAT MEASURES AND WHAT IT DOES NOT.*** A restart is an INTERVENTION:
  // it proves the block is in-memory tracker state, and rules out the applier
  // (never refused), RBAC (no forbidden) and the guest (declared every pass). It
  // does NOT measure the TTL - `--perseid-ttl` defaults to an hour and
  // tracker_test.go pins the expiry with an injected clock, but no live run has
  // timed it. The experiment that would have was destroyed by a deploy.
  //
  // ⚠ NO REMEDY IS ASSERTED HERE ON PURPOSE. Whether the tracker or the idiom is
  // wrong is engi's call: the tracker exists so a converged fleet does not write
  // once per pass per program, and ADR-0075 asks for exactly the memoryless step
  // that gets suppressed. Recording the measurement without deciding the design
  // is the only thing this file is entitled to do.
  //
  // Found by perseid-prog, who deleted the pod to test this sentence.
  return quiesce(anyOf(objectGone(POD), backstop()))
})

export type Effs = EffectsOf<typeof step>
export { step as podmakerStep, POD }
