// A Perseid step written on the whole SDK — the worked example.
//
// `src/main.ts` is the SHIPPED one: it drives the same shape against the real
// WIT host imports and is what `derive-wit` reads for the component. This file
// is the readable one — a fake handler, five canned observations, and every
// piece of the SDK used once, so the shape of a step is visible without the host
// half around it.
//
//	bun src/sugar.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS DEMONSTRATES, AND WHERE EACH PIECE IS DEFINED
//
//	path.ns(…).deployments(…)   sdk/…/perseid.ts   an apiserver path is BUILT,
//	                                               never typed - `ApiPath` is
//	                                               branded, so a hand-written
//	                                               string is not assignable
//	reconcile.observe/.ensure   sdk/…/perseid.ts   the WIT contract pre-applied:
//	                                               no interface id, op name or
//	                                               argument shape to get wrong
//	defineStep                  sdk/…/perseid.ts   infers the effect union, pins
//	                                               the return to Outcome
//	match / when                sdk/…/match.ts     exhaustive, and the arms may
//	                                               YIELD
//	matchValue                  sdk/…/match.ts     the same, outside a generator
//	or / ne / length / listPods sdk/…/expr.ts      the aperture expression
//	  / replicas                                   language, TYPED
//	runStep                     sdk/…/perseid.ts   drives it against a world
//
// ***THE STEP ITSELF IS TWENTY LINES.*** Everything else here is the world it
// runs against, which in production is radiant.
// ═══════════════════════════════════════════════════════════════════════════

import { match, matchValue, when } from '@apsis-io/perseid/match'

import {
  type Obs,
  type Outcome,
  defineStep,
  path,
  reconcile,
  runStep,
  known,
  absent,
  unknown,
  yieldStep,
  terminate,
  quiesce,
  anyOf,
  countNeField,
  untilDrift,
} from '@apsis-io/perseid/perseid'

// ---------------------------------------------------------------------------
// What this operator is about.
//
// BUILT, not typed. The segments cannot be mis-ordered and the `namespaces`
// segment cannot be forgotten, and both arguments complete from the live cluster
// once `bun tools/gen-cluster-vocab.ts` has been run.
//
// `observe('replicas')` — a bare field name where a path goes, which answered
// `unknown` on every pass for four days while looking healthy — is now
// unspellable rather than merely discouraged.
const deployment = path.ns('default').deployments('api')
const selector = 'app=api'
const want = 2

// ***THERE IS NO `const workload = 'api'` HERE ANY MORE, AND ITS ABSENCE IS THE
// POINT.*** It was a SECOND spelling of the object the line above already names,
// kept in step by hand: edit the path to `deployments('api-v2')` and the program
// observes the new deployment and parks on the old one - awake for changes it no
// longer reads, asleep through every change it does. `workloadOf(deployment)`
// derives it, so the two cannot disagree.

/** The `known` arm's value — what `when`'s clauses receive. */
type KnownReplicas = Extract<Obs<number>, { t: 'known' }>

// The capabilities. `reconcile` is `wit/reconcile/reconcile.wit` pre-applied;
// the type argument is this program's genuine choice, because `obs` carries a
// string on the wire and this step compares a number, so the handler converts.
const observe = reconcile.observe<number>()
const ensure = reconcile.ensure()

// ---------------------------------------------------------------------------
// The wake condition, as an EXPRESSION rather than a string.
//
// A resume is DATA: the host evaluates it without running the step, which is
// what lets radiant index parked programs by what they wait on and show an
// operator why one is asleep.
//
// ***BOTH ARMS COMPARE TWO OBSERVATIONS, WHICH THE LANGUAGE COULD NOT EXPRESS
// UNTIL aperture GREW TYPES AND ARITHMETIC.*** Parking on `!= want` alone would
// be stale the moment anyone edits `spec.replicas`; this re-reads the desired
// count at wake time, so a spec change to a different number wakes the program
// instead of leaving it asleep on a target nobody wants.
//
// The type is the safety property: `Resume` is `Expr<'bool'>`, so an EFFECT —
// `setReplicas(…)`, which is an ordinary expression in the same language — is a
// compile error here. That is the host's `CheckPure` rule, moved to the build.
const wakeOnDrift = (seen: number) =>
  anyOf(
    // AUTODERIVED from the observation - see `untilDrift`. The path that was
    // read is the input, so there is no name to keep in step, and it parks on
    // the value it SAW rather than on the constant it wanted.
    untilDrift(deployment, seen),
    // The second arm is a DELIBERATE ADDITION and stays explicit. Autoderivation
    // answers "wake when what I read changes"; this says something the
    // observation cannot imply - that the pod census should track the desired
    // count - and inventing it from a path would be the SDK guessing at intent.
    countNeField(selector, deployment),
  )

// ---------------------------------------------------------------------------
// The step.

const step = defineStep(function* () {
  const have = yield* observe(deployment)

  // Exhaustiveness is the object literal: drop an arm and the missing property
  // is reported here, by name. There is no terminal call to forget.
  return yield* match(have, 't', {
    // The object is gone. Nothing to reconcile toward, ever.
    absent: () => terminate,

    // We could not TELL. Not the same as gone — concluding "absent" from a blip
    // is the single most repeated defect in this codebase, and `Obs` is
    // three-valued to stop it.
    unknown: () => yieldStep,

    // Clauses are tried in order, and the LAST argument is the required default
    // — so a guarded arm cannot fall through to `undefined`.
    known: when(
      // ***THE FIRST CLAUSE'S PARAMETER IS ANNOTATED, AND IT HAS TO BE.***
      // `when` cannot infer the variant from the arms object it is being written
      // into - a generic call in argument position gets no contextual type
      // through a variadic tuple - so without this every clause parameter
      // resolves to `unknown` and the arm does not compile. One annotation
      // supplies it for all three.
      [(o: KnownReplicas) => o.v === want, ({ v }) => quiesce(wakeOnDrift(v))],

      // An observation that cannot be true of a live workload. Reconciling
      // toward it would fight the apiserver forever.
      [(o: KnownReplicas) => o.v < 0, () => terminate],

      // ***THE ARM YIELDS DIRECTLY*** — the reason this matcher exists. Its
      // effects join the step's union, so `derive-wit` still reads `workloads`
      // out of this program's type and the component's world names it.
      function* ({ v }) {
        console.log(`  observed ${v}, want ${want} — emitting`)
        // ABSOLUTE, not a delta. A step re-derives from a fresh observation
        // every tick, so two ticks before one obligation lands would apply a
        // delta twice; an absolute target is idempotent under exactly that.
        yield* ensure({ path: deployment, field: 'spec.replicas', value: want })

        return yieldStep
      },
    ),
  })
})

// ---------------------------------------------------------------------------
// Reading an outcome, OUTSIDE a generator.
//
// `match` is a generator and must be `yield*`-ed, which is right where effects
// are possible and unusable everywhere else. `matchValue` is the same
// exhaustive dispatch for ordinary code — and refuses an arm that yields, since
// calling one would return an iterator nobody advances.
const describe = (o: Outcome): string =>
  matchValue(o, 'o', {
    yield: () => 'Yield      (run me again next tick)',
    quiesce: ({ resume }) => `Quiesce    until ${resume}`,
    terminate: () => 'Terminate  (nothing to reconcile toward)',
  })

// ---------------------------------------------------------------------------
// The world. In production this is radiant; here it is a fake, which is the
// whole point of a step being a pure function of its observations.
//
// The handler's keys are WIT function names and the type is TOTAL: omit one and
// this does not compile. `what` is an `ApiPath` and the ensure argument is
// `{path, n}` — both checked, both completed from the cluster.
function drive(label: string, o: Obs<number>): void {
  const acts: string[] = []
  const outcome = runStep(step, {
    get: () => o,
    ensure: (args) => {
      if (!('value' in args)) return
      acts.push(`ensure(${args.path}, ${String(args.value)})`)
    },
  })

  console.log(`${label.padEnd(9)} -> ${describe(outcome)}`)
  acts.forEach((a) => console.log(`             ${a}`))
}

console.log(`reconciling ${deployment} toward ${want} replica(s)\n`)
drive('below', known(1))
drive('equal', known(want))
drive('above', known(5))
drive('negative', known(-1))
drive('absent', absent)
drive('unknown', unknown)
console.log(`\nparked programs wait on: ${wakeOnDrift(want)}`)
