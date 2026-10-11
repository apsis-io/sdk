// THE SMALLEST PERSEID THAT IS STILL A REAL ONE.
//
// It keeps one Deployment at one replica count. That is the whole program, and
// the body below is six lines.
//
// `warden.ts` is the reference for BREADTH - every capability once. This is the
// reference for SHAPE: what you cannot avoid writing. Everything here is load
// bearing, and the comments say which part is forced by the design and which is
// merely how it is spelled.

import {
  type EffectsOf,
  path,
  reconcile,
  reader,
  defineStep,
  wakeCause,
  quiesce,
  anyOf,
  yieldStep,
  ready,
  fieldNe,
  objectGone,
} from '@apsis-io/perseid/perseid.js'
import { asDeployment, wantedReplicas } from '@apsis-io/perseid/k8s.js'

// The capabilities. Each is a WIT interface the component imports, and the
// program cannot call one it has not named here. `derive-wit.ts` reads them back
// out of this step's yield type, so the world and the code are ONE fact.
const observe = reconcile.observe<string>()
const ensure = reconcile.ensure()
const report = reconcile.status()

// The shape and its defaults come from the SDK rather than being re-declared
// here. This read `type Deployment = { spec?: { replicas?: number } }` with a
// bare `JSON.parse(raw) as Deployment` - which is not wrong, and is one of four
// hand-rolled projections in this directory that disagreed about what an ABSENT
// field means. `asDeployment` also refuses a body that parses to a non-object,
// where the cast would have handed every accessor `undefined`.
const read = reader(observe, asDeployment)

export const TARGET = path.ns('default').deployments('simple-demo')
export const WANT = 2

export const step = defineStep(function* () {
  // ***`yield*` IS NOT DECORATION.*** An effect is DATA the step yields; the
  // host interprets it. That is what makes this a pure function of its
  // observations - `runStep(step, fakeHandler)` runs it with no cluster - and
  // it is also how the world above is derived.
  //
  // `need` does the read, the three-valued unwrap and the decode in one yield.
  // Absent means the thing this program maintains is gone, so there is nothing
  // to reconcile toward: it TERMINATES. A failed read is different and only
  // makes us late, so it YIELDS. Those are the defaults; both are arguments,
  // because the right answer is a property of your program and not of the SDK.
  const dep = yield* read.need(TARGET)

  // ⛔ ***LEVEL-TRIGGERED, AND THIS BLOCK IS WHY THE PROGRAM IS CORRECT.*** The
  // repair is re-derived from the world on EVERY pass, whatever woke us. ADR-0107
  // permits "do the work for the condition that holds" - a missed wake only makes
  // you LATE - and forbids the opposite, "skip work because nothing was listed",
  // which turns a level-triggered program into an edge-triggered one in disguise.
  // So the decision below reads `dep`, never the wake cause.
  // `wantedReplicas` rather than `dep.spec?.replicas`, and the difference is
  // meaning rather than behaviour: an ABSENT `spec.replicas` is a Deployment that
  // wants ONE, not one that wants nothing. Both spellings repair here; only this
  // one says why.
  if (wantedReplicas(dep) !== WANT) {
    // ABSOLUTE, never a delta: a step re-derives from a fresh read every pass,
    // so two passes before one obligation lands would apply a delta twice.
    yield* ensure({ path: TARGET, field: 'spec.replicas', value: WANT })

    // Do not park on a condition the write above is about to satisfy.
    return yieldStep
  }

  // ---------------------------------------------------------------------------
  // Converged. Park - and learn WHY we woke.
  //
  // ⛔ ***A WAKE SAYS WHY WE RAN, NOT WHAT IS TRUE NOW - AND THIS FILE SHIPPED
  // IT BACKWARDS.*** It used to dispatch `report(unready('Drifted', …))` from an
  // arm. But dispatch happens at the END of the pass, after the block above has
  // already established the target IS at `WANT`, so the arm announced "Drifted"
  // over a measurement the same pass had just taken. The wake describes the
  // world that CHANGED; the reads describe the world as it is. Only the second
  // is a status - so the cause below is CONTEXT in the message, never a verdict.
  //
  // ***THIS PROGRAM DOES NOT USE `held()`, AND THAT IS THE POINT.*** `held()`
  // answers WHICH of your conditions held, so a program with per-subject work can
  // read only what moved - see `sentinel.ts`, and `follower.ts` for the case
  // where the subjects are not known until the pass runs.
  //
  // This program has one subject and no per-subject work. It wants one fact -
  // was I woken by something I named, or by time - and `wakeCause()` is that
  // question and nothing more. Reaching for the finer tool here would add a
  // branch with nothing on either side of it.
  const why = yield* wakeCause()

  // ⚠ ***"THE TWO ARE DELIBERATELY INDISTINGUISHABLE" USED TO BE HERE AND IS NO
  // LONGER TRUE (2026-09-08).*** This said a backstop tick and a host that could
  // not compute the answer were the same fact, because `wakeCause()` derived
  // itself from `held` being empty and could not tell them apart. It asks the
  // host now: `backstop`, `unknown` and `first-pass` are three answers.
  //
  // What survives is that this program does not BRANCH on any of them - the
  // repair above is level-triggered and re-derives from the world whatever woke
  // it (ADR-0107). The cause is context in the message, never a verdict.
  //
  // Saying so is the point. Without this line a backstop tick reports NOTHING,
  // and an operator cannot tell a program that is watching from one that is
  // merely polling.
  yield* report(ready('Converged', `${TARGET} at ${WANT}; woke on ${why}`))

  // The park: both subjects, disjoined. A park must say what would change its
  // mind, and there is no `deadline(Date.now() + …)` arm because the host
  // renders `|| Backstop()` onto every park already.
  return quiesce(anyOf(fieldNe(TARGET, 'spec.replicas', WANT), objectGone(TARGET)))
})

/** The capabilities, read back out of the step's yield type - see `derive-wit.ts`. */
export type SimpleEffects = EffectsOf<typeof step>
