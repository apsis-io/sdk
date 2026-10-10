// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ***THE FIRST COMPONENT THAT CLEANS UP AFTER ITSELF.***
//
// The finalize entrypoint landed host-side on 2026-08-30 and nothing could
// implement it: the vendored WIT guests compile against had no `interface
// finalize` until e298961a8, and the SDK had no outcome vocabulary until
// eb751d377. So `done` and `retry` have never executed anywhere - the live probe
// that verified the deployment answered `absent`, which is what EVERY component
// answers and always would have. This is the program that makes those two paths
// real.
//
// # WHAT IT DOES, AND WHY THIS PARTICULAR SHAPE
//
//	step      hold a Deployment at WANT replicas. An ordinary scaler.
//	finalize  drain it to ZERO, then WAIT until the pods are actually gone
//	          before letting the Perseid be deleted.
//
// ***THE DRAIN IS THE ONLY CLEANUP A GUEST CAN EXPRESS TODAY, AND SAYING SO IS
// PART OF THE EXAMPLE.*** The guest effect vocabulary is `observe`, `count`,
// `now`, `scale` and `report` (perseid.ts's `reconcile` namespace) - there is no
// delete, no ensure and no create. A finalizer therefore cannot remove a
// downstream object; it can scale a workload and it can report. That is a real
// limit, it is not obvious from the host side where `Delete(...)` obligations
// exist in the expression language, and a reader who assumes otherwise will
// write a finalizer that cannot do what they meant.
//
// # WHY IT IS A GOOD DEMONSTRATION RATHER THAN A STUB
//
// A finalizer that returns `done` immediately proves nothing - the host cannot
// tell it from a component with no finalizer at all, which is why `NoFinalizer`
// and `Finalized` are separate verdicts. This one has a genuine reason to WAIT:
// scaling to zero is asynchronous, so the first attempt asks for the drain and
// the object must be held until the cluster catches up.
//
// ***THAT IS WHAT MAKES `retry` MEANINGFUL AND WHAT MAKES THE BOUND MATTER.***
// The host holds the object while this retries and releases it at
// `-perseid-finalize-deadline` (10m) whether or not the drain finished, with a
// Warning saying the cleanup did not complete. A Deployment whose pods will not
// terminate therefore delays a delete and never wedges it.

import {
  type EffectsOf,
  path,
  reconcile,
  defineStep,
  defineFinalize,
  yieldStep,
  quiesce,
  anyOf,
  fieldNe,
  backstop,
  cleanupDone,
  retry,
} from '@apsis-io/perseid/perseid.js'

const observe = reconcile.observe<string>()
// ***`ensure`, NOT `scale` - the generalized write*** (engi, 2026-08-31: "we
// deprecated workloads.scale and status.set"). `ensure(p, 'spec.replicas',
// {num: n})` renders the identical obligation the deprecated `scale(p, n)` did:
// `Ensure(p, "spec.replicas", n)`. Same text, same ledger key, same boundary.
//
// ⚠ AND IT COSTS THIS PROGRAM SOME BOUNDING, which is worth seeing in the one
// example that demonstrates the migration. `perseid:reconcile/workloads@0.1.0`
// is scoped by the aperture to `spec.replicas` ALONE;
// `perseid:reconcile/ensure@0.1.0` writes ANY field. This program still only
// ever writes `spec.replicas`, but its GRANT no longer says so - what keeps it
// honest is now `spec.writes` naming one object, rather than the capability
// naming one field.
const ensure = reconcile.ensure()
// ***CREATE AND DELETE - THE OTHER TWO GENERALIZED EFFECTS.*** Together with
// `ensure` these are the whole write vocabulary a guest has as of 2026-08-31;
// before that a program could scale a workload and report a condition, and
// nothing else.
const create = reconcile.create()
const del = reconcile.delete()
const report = reconcile.status()

// The workload this program owns. A `const`, because it is the program's
// identity rather than a runtime choice - and the Perseid's `spec.writes` must
// name the same path or every obligation below is refused at the boundary.
const TARGET = path.ns('default').deployments('janitor-demo')

// ***THE OBJECT THIS PROGRAM OWNS OUTRIGHT.*** The Deployment above exists
// independently and the janitor only scales it; this ConfigMap is CREATED by the
// program and must therefore be REMOVED by it - which is what makes the finalizer
// a real teardown rather than a scale-to-zero.
//
// A ConfigMap and not a workload, because the expression language has no array
// literal: `{"spec": {"containers": [...]}}` does not parse, so a Deployment body
// is not expressible today. Measured, and recorded at the WIT's `create`.
const MARKER = path.ns('default').core('v1', 'configmaps', 'janitor-marker')

// ***THE OBJECT THAT EXERCISES AN INDEXED CREATE, AND IT IS A Service FOR A
// REASON.*** `create` grew `[N]` paths that lower to nested ARRAY literals, and
// until this existed nothing a Perseid could create HAD an array field -
// ConfigMaps and Secrets are both `map[string]string`. So the whole indexed
// path was unreachable on a cluster and could only be unit-tested.
//
// Not a Deployment, which is the obvious choice: a Deployment carries a POD
// TEMPLATE, and a program choosing annotations on pods it does not create aims
// at the standing pods refusal in `internal/aperture/ensure.go`. A Service
// cannot create a pod at all.
const SVC = path.ns('default').core('v1', 'services', 'janitor-svc')

const WANT = 2
// ⛔ There was a `const RECHECK_MS = 60_000` here. Its number did not go away -
// it moved into `janitor-backstop.ts`, where a bound belongs: readable off the
// artifact, refusable at admission, and adjustable without touching the step.
// The park operand it fed is gone and the effective bound is unchanged.

/** The two numbers this program reasons about, pulled out of an observation. */
type Workload = { spec: number; ready: number }

// ***PARSED DEFENSIVELY BECAUSE A MISSING FIELD IS NOT A ZERO.*** A Deployment
// that has never been scaled has no `status.readyReplicas` at all, and reading
// that absence as 0 is correct here ONLY because 0 is also what "no pods" means.
// Where the two differ - `spec.replicas` absent, which means "defaulted to 1" -
// this must not guess, so the step treats a missing spec as unknown rather than
// as zero.
function workloadOf(raw: string): Workload | null {
  try {
    const o = JSON.parse(raw) as { spec?: { replicas?: number }; status?: { readyReplicas?: number } }
    const spec = o.spec?.replicas
    if (typeof spec !== 'number') return null

    return { spec, ready: o.status?.readyReplicas ?? 0 }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// THE STEP. Ordinary: hold the Deployment at WANT.
const step = defineStep(function* () {
  const seen = yield* observe(TARGET)
  if (seen.t !== 'known') return yieldStep

  const have = workloadOf(seen.v)
  if (have === null) return yieldStep

  if (have.spec !== WANT) {
    yield* ensure({ path: TARGET, field: 'spec.replicas', value: WANT })

    return yieldStep
  }

  // ***DECLARED EVERY PASS, NOT ONCE.*** A total step has no memory, so it
  // re-declares its conclusions and the applier treats AlreadyExists as success.
  // The ledger dedups on the obligation's bytes, which is why the body's key
  // order is a contract rather than a detail.
  yield* create({
    path: MARKER,
    body: [
      { path: 'data.owner', value: 'janitor' },
      // ⚠ ***A STRING, NOT A NUMBER, AND THE FIRST LIVE RUN PROVED WHY.*** This
      // was `{ num: WANT }` and the apiserver refused the object: `json: cannot
      // unmarshal number into Go struct field ConfigMap.data of type string`.
      // A ConfigMap's `data` is `map[string]string`.
      //
      // Nothing upstream could have caught it: the value variant is typed, the
      // obligation rendered correctly, the aperture parsed and bounded it, and
      // the write boundary permitted it. The SCHEMA of the target object is
      // knowledge none of those layers has - which is the honest limit of a
      // generalized write, and the reason the failure surfaces as a logged
      // refusal at apply that re-declares next pass rather than as a corrupt
      // object.
      { path: 'data.want', value: String(WANT) },
      { path: 'metadata.labels.managed-by', value: 'perseid' },
    ],
  })

  // ***AN INDEXED CREATE: `spec.ports[0]` LOWERS TO A NESTED ARRAY.*** The body
  // renders as `{"metadata": {…}, "spec": {"ports": [{"name": "http", "port":
  // 80}]}}` - object keys sorted at every level, list order preserved from the
  // indices rather than from the order these fields are written in.
  //
  // ⚠ ***`num`, NOT `text`, AND THAT IS THE OPPOSITE OF THE MARKER ABOVE.*** A
  // Service port is an int32; a ConfigMap's `data` is `map[string]string`. Two
  // fields in one program needing different value variants for the same reason:
  // the TARGET's schema is knowledge no layer between here and the apiserver
  // has, so it is the author's to get right, and getting it wrong surfaces as a
  // logged refusal at apply that re-declares next pass.
  yield* create({
    path: SVC,
    body: [
      { path: 'spec.ports[0].port', value: 80 },
      { path: 'spec.ports[0].name', value: 'http' },
      { path: 'metadata.labels.managed-by', value: 'perseid' },
    ],
  })

  yield* report({
    type: 'Ready',
    status: 'True',
    reason: 'AtDesiredScale',
    message: `${have.ready} of ${WANT} ready`,
  })

  return quiesce(anyOf(fieldNe(TARGET, 'spec.replicas', WANT), backstop()))
})

// ---------------------------------------------------------------------------
// THE FINALIZER. Drain to zero, then wait for it to take effect.
//
// ***IT ASKS FOR THE SCALE ON EVERY ATTEMPT, NOT ONLY THE FIRST.*** A finalize
// attempt runs on a FRESH instance with no memory of the last one - trail builds
// a Store per call and drops it, which is what makes ADR-0075's totality
// structural rather than documented - so "I already asked" is not a thing this
// function can know. Re-declaring is correct and cheap: the obligation is
// idempotent, and a scale that was lost to a transport failure on attempt 1
// simply happens on attempt 2.
//
// ***AND THE RETRY REASON IS CONSTANT ON PURPOSE.*** The host emits it as a
// Kubernetes Event on every held tick, and the apiserver aggregates repeated
// Events only when the text matches EXACTLY. A reason carrying the elapsed time
// or an attempt counter produces one row per tick, and the apiserver then
// discards the message in favour of "(combined from similar events)" - measured
// on the cluster 2026-08-31 at 58 rows for one object, with the reason lost. The
// replica count is included because it is a FACT ABOUT THE WORLD that changes
// only when something really changed; the elapsed time is not, and the Event's
// own count and timestamps carry it.
const finalize = defineFinalize(function* () {
  const seen = yield* observe(TARGET)

  // ***AN ABSENT TARGET IS `done`, NOT a retry.*** The workload this program was
  // responsible for is already gone, so there is nothing to drain and nothing to
  // wait for. Retrying here would hold the object for the full deadline over a
  // cleanup that had already happened - the commonest way a finalizer turns into
  // a ten-minute delay for nothing.
  if (seen.t === 'absent') return cleanupDone

  // ⚠ ***AN UNKNOWN OBSERVATION IS A RETRY, NOT `done`.*** This is the one
  // branch where the safe-looking choice is wrong: `unknown` means the host
  // could not answer, so concluding "nothing to clean up" would release the
  // object on the strength of a failed read. Retry, and let the deadline bound
  // it - a delayed delete is recoverable and a skipped drain is not.
  if (seen.t === 'unknown') return retry('cannot read the target workload')

  const have = workloadOf(seen.v)
  if (have === null) return retry('the target workload could not be parsed')

  // ***DELETE WHAT THIS PROGRAM CREATED, FIRST.*** The object exists only
  // because the step made it, so nothing else will remove it - this is the
  // cleanup a finalizer is for, and until `delete` reached the guest a program
  // could not express it at all.
  //
  // Re-declared on every attempt for the same reason the step re-declares its
  // create: a finalize attempt runs on a FRESH instance with no memory of the
  // last one, and the applier treats NotFound as success.
  yield* del(MARKER)
  // Created by the step, so removed by the finalizer - an object that outlives
  // the program that owns it is the orphan this whole path exists to prevent.
  yield* del(SVC)

  if (have.spec !== 0) yield* ensure({ path: TARGET, field: 'spec.replicas', value: 0 })

  if (have.ready > 0) {
    // ***REPORTED ON THE OBJECT AS WELL AS RETURNED, AND THE OBJECT IS THE HALF
    // THAT SURVIVES BEING LOOKED AT LATER.*** The retry reason becomes a
    // Kubernetes Event, which is what an operator sees if they are already
    // watching; this is what they see when they run `kubectl describe perseid`
    // on something that has been Terminating for a while and want to know why.
    //
    // A deleting Perseid takes no other status write - the controller routes it
    // off the normal tick entirely so a program being deleted cannot also be
    // reconciling - so this condition is the only thing on the object saying
    // what is happening to it.
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: 'Draining',
      message: `waiting for ${have.ready} replica(s) to terminate before deletion`,
    })

    return retry(`draining the target workload: ${have.ready} replica(s) still running`)
  }

  return cleanupDone
})

export type Effs = EffectsOf<typeof step>
export type FinalizeEffs = EffectsOf<typeof finalize>
export { step as janitorStep, finalize as janitorFinalize, workloadOf, TARGET, MARKER, WANT }
export type { Workload }
