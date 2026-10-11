// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// A DEPENDENCY DAG: BRING STAGE N+1 UP ONLY ONCE STAGE N IS *READY*.
//
// ***THE PURE HALF.*** No `perseid:reconcile/*` imports live here, and that is
// what makes the step testable: those modules exist only inside the component
// runtime, so anything importing them cannot be loaded by a test runner. The
// wiring is next door in `dag-main.ts`, which is the only file that touches a
// host.
//
// Gemini's criticism of the scaler was exact and worth answering rather than
// arguing with: *"a scaler does what a Deployment already does"*. It is true.
// `spec.replicas: 3` on a Deployment reconciles to three replicas without any
// Perseid, so the scaler demonstrates the MACHINERY and nothing about the
// CAPABILITY.
//
// This is the smallest program that a Deployment cannot be. Not because it is
// bigger - it is smaller - but because it makes one object's write conditional
// on ANOTHER object's observed status, and nothing in the built-in controller
// set has an edge between two workloads. A Deployment does not know that
// `worker` exists; a StatefulSet's ordinal ordering is WITHIN one object; an
// initContainer orders containers inside one pod. There is no built-in that
// says "not until that one is serving".
//
// # WHAT MAKES IT A DAG RATHER THAN A SCRIPT
//
// The step is TOTAL and re-derives from a fresh observation every pass
// (ADR-0075). It does not "run the stages"; it looks at the world, finds the
// FIRST unsatisfied edge, acts on exactly that one, and parks on the condition
// that would change its mind. Run it from any starting state - stage 3 already
// up, stage 1 deleted, everything converged - and it does the right thing,
// because there is no progress variable anywhere in it.
//
// That is why the ordering below is data and not control flow: `STAGES` is a
// linear chain here because a chain is the smallest DAG that shows the
// property, and a fan-out is the same loop with a different predecessor set.
//
// # THE LINE THAT NEEDS THE 2026-08-30 WORK
//
//	fieldNe(stage.path, 'status.readyReplicas', want)
//
// Parking on `status.readyReplicas` of an object this program does not write.
// Until `Get(path, field)` replaced the eight per-kind read symbols, the only
// readable workload field was `spec.replicas` through `Replicas(name)` - the
// DESIRED count, which is set the instant anyone asks and says nothing about
// whether a single pod is serving. A DAG built on it would advance to stage
// N+1 the moment stage N was *requested*, which is precisely the bug it exists
// to prevent, and it would look like it worked.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type EffectsOf,
  path,
  reconcile,
  defineStep,
  runStep,
  known,
  absent,
  unknown,
  yieldStep,
  quiesce,
  anyOf,
  fieldNe,
  objectExists,
  backstop,
} from '@apsis-io/perseid/perseid.js'

const observe = reconcile.observe<string>()
// ***`ensure`, NOT `workloads.scale`, SINCE 2026-09-01.*** e75c8c392 removed the
// last specialized write: `IfaceWorkloads` conferred `Ensure` narrowed to
// `spec.replicas` and now confers nothing. The import still links, so a component
// built against it instantiates and then has every obligation refused - which is
// what happened to this program's own `dag-demo` on the cluster.
const ensure = reconcile.ensure()
const report = reconcile.status()

// ***THE DAG, AS DATA.*** Order is the dependency: nothing in `STAGES[i]` is
// touched until every `STAGES[j < i]` reports `want` READY replicas.
//
// Paths are BUILT, never typed. `ApiPath` is branded with no string
// constructor, so a hand-written path is not assignable - which is what stops
// the `namespaces` segment being forgotten or the kind being wrong, the two
// mistakes that produce a well-formed path to an object that does not exist.
// ***ITS OWN OBJECTS, AND THE REASON IS AN ADMISSION REFUSAL WORTH KEEPING.***
// These named `api` and `worker` first, and radiant refused the Perseid:
//
//	FAILED conflict: default/scaler-v4 already claims
//	                 /apis/apps/v1/namespaces/default/deployments/api
//
// That is `spec.writes` doing the one job it exists for - two programs claiming
// one object is an outage nobody can debug from either side - and it is exactly
// the guarantee a FIELD-scoped write boundary would have destroyed: under
// field-scoping the scaler's `spec.replicas` and a DAG's `spec.replicas` on the
// same Deployment stop looking like a conflict.
const STAGES = [
  { name: 'dag-a', path: path.ns('default').deployments('dag-a'), want: 2 },
  { name: 'dag-b', path: path.ns('default').deployments('dag-b'), want: 1 },
] as const

// How long a stage may sit un-ready before the program re-checks regardless.
//
// A BACKSTOP, NOT A TIMEOUT: it does not fail the stage, it re-runs the step.
// Every park below folds it in with `anyOf`, because a conjunction of watched
// conditions with no time bound has nothing to fall back on if the wake index
// misses - and "asleep on a condition nobody will satisfy" is the failure
// ADR-0075 is named for.
// ⛔ There was a `const RECHECK_MS = 60_000` here. Its number did not go away -
// it moved into `dag-backstop.ts`, where a bound belongs: readable off the
// artifact, refusable at admission, and adjustable without touching the step.
// The park operand it fed is gone and the effective bound is unchanged.

// ---------------------------------------------------------------------------
// Reading a workload out of what `observe.get` returns.
//
// ***THE HOST HANDS BACK THE WHOLE OBJECT AS JSON.*** It used to hand back a
// narrowed replica count, because `observe.get` on a deployment went through a
// per-kind read surface. One generic read replaced the eight per-kind ones and
// a generic read cannot know which field a step wants, so it returns the object
// and the step names its own fields - which is what `observe-cluster` has
// always done.

/** What this program needs off a workload: what was asked for, and what serves. */
type Workload = { spec: number; ready: number }

// ***TOTAL, AND NaN IS THE POINT RATHER THAN A CONCESSION.*** A throw here
// escapes into the step and fails the pass. NaN makes every comparison false,
// so an unreadable shape leaves the stage looking un-ready - the program waits
// instead of advancing, which is the safe direction for a DAG. An unparseable
// object must never read as "ready".
//
// `status.readyReplicas` is ABSENT on a Deployment with zero ready replicas -
// the apiserver omits it rather than writing 0 - so a missing field is read as
// 0 and not as unknown. That distinction is the whole reason this is not
// `Number(o.status.readyReplicas)`.
const workloadOf = (raw: string): Workload => {
  try {
    const o = JSON.parse(raw) as {
      spec?: { replicas?: unknown }
      status?: { readyReplicas?: unknown }
    }

    return {
      spec: Number(o?.spec?.replicas),
      ready: o?.status?.readyReplicas === undefined ? 0 : Number(o.status.readyReplicas),
    }
  } catch {
    return { spec: NaN, ready: NaN }
  }
}

// ---------------------------------------------------------------------------
// The step.

const step = defineStep(function* () {
  for (const stage of STAGES) {
    const seen = yield* observe(stage.path)

    // ***AN ABSENT STAGE STOPS THE DAG; IT DOES NOT SKIP IT.*** A missing
    // predecessor is not a satisfied predecessor. Parking on its
    // (non-)existence is what makes the program resume by itself when somebody
    // creates it, rather than needing a nudge.
    if (seen.t === 'absent') {
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'StageMissing',
        message: `${stage.name} does not exist, so nothing after it may start`,
      })

      // ⚠ ***`objectExists`, NOT `objectGone`, AND THE WRONG ONE IS A HOT
      // LOOP RATHER THAN A WRONG ANSWER.*** `quiesce` sleeps until the resume
      // becomes TRUE. The stage is absent right now, so parking on "it is
      // gone" parks on something already true: the host evaluates it before
      // the first tick - deliberately, so a condition already satisfied costs
      // no interval - wakes immediately, re-runs the step, and parks on it
      // again. Nothing errors; the program simply spins at the pass rate.
      //
      // What this wants is "wake when it APPEARS", which is `objectExists`.
      // Caught by reading the deployed state before deploying: `worker` did
      // not exist, so this arm was the FIRST one that would have run.
      return quiesce(anyOf(objectExists(stage.path), backstop()))
    }

    // ***UNKNOWN IS NOT ABSENT AND MUST NOT ADVANCE THE DAG.*** "I could not
    // read it" is a fact about the apiserver, not about the stage. Yielding
    // re-runs the step on the next tick with no park and no claim.
    if (seen.t === 'unknown') return yieldStep

    const have = workloadOf(seen.v)

    // EDGE 1: the stage has not been ASKED for `want` yet. This program owns
    // that field, so it writes it - and the write is ABSOLUTE rather than a
    // delta, so two passes before the obligation lands do not apply it twice.
    if (have.spec !== stage.want) {
      yield* ensure({ path: stage.path, field: 'spec.replicas', value: stage.want })

      return yieldStep
    }

    // ═══════════════════════════════════════════════════════════════════
    // EDGE 2: ***THE DEPENDENCY ITSELF.*** The stage has been asked for
    // `want` and is not yet SERVING `want`, so nothing after it may start.
    //
    // Parking here rather than yielding is what makes this cheap: the host
    // indexes the park by the object it names, so this program sleeps until
    // `worker`'s readiness actually moves instead of polling. `spec.replicas`
    // would have been readable for years; `status.readyReplicas` is what
    // needed a generic read.
    // ═══════════════════════════════════════════════════════════════════
    if (have.ready !== stage.want) {
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'WaitingForStage',
        message: `${stage.name} is ${have.ready}/${stage.want} ready`,
      })

      return quiesce(
        anyOf(
          fieldNe(stage.path, 'status.readyReplicas', have.ready),
          backstop(),
        ),
      )
    }
  }

  // Every stage asked for and serving its target.
  yield* report({
    type: 'Ready',
    status: 'True',
    reason: 'AllStagesReady',
    message: STAGES.map((s) => `${s.name}=${s.want}`).join(' -> '),
  })

  // ***PARK ON EVERY STAGE AT ONCE, NOT ON THE LAST ONE.*** Converged means
  // every edge holds, so any edge ceasing to hold is a reason to wake - and a
  // predecessor losing a replica must re-derive the whole chain rather than
  // being noticed only when the tail drifts.
  return quiesce(
    anyOf(
      ...STAGES.flatMap((s) => [
        fieldNe(s.path, 'spec.replicas', s.want),
        fieldNe(s.path, 'status.readyReplicas', s.want),
      ]),
      backstop(),
    ),
  )
})


export type Effs = EffectsOf<typeof step>
export { step as dagStep, workloadOf, STAGES }
export type { Workload }
