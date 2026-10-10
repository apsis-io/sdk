// ADR-0075's step contract, written against the SDK
// (@apsis-io/perseid/perseid.ts) rather than reimplementing it.
//
// Same five arms as ../perseid-ocaml and ../perseid-effect, so the three
// artifacts stay comparable in SHAPE.
//
// ***THIS SAID "All three produce identical output" AND THAT IS NO LONGER TRUE***
// (trail-main, 2026-08-25, correcting the claim rather than leaving it asserting
// something the port made false). This file moved to the typed action interfaces;
// the other two still perform a stringly-typed `emit`, so the printed `acts`
// differ:
//
//     here      scale(/apis/apps/v1/.../api, 3)   ·  set(Ready=True AtDesiredScale)
//     the two   scale +2 · scale -2               ·  status readyReplicas=3
//
// ***THE SIBLINGS ARE NOT RED AND THAT IS WHY THIS NOTE EXISTS.***
// `ci/verify-wit-imports.sh` keys on a declared WIT interface id, and only this
// file declared one — perseid-effect reaches `emit` through an Effect-TS service
// and perseid-ocaml through an OCaml effect, so neither NAMES the deleted
// interface anywhere the guard can see it. They are equally stale and
// structurally invisible to the check that found this one.
//
// Left unported deliberately: the assigned population was this file, its derived
// world and ADR-0075. Porting them is real work nobody has a row for.

import { match, matchValue, when } from '@apsis-io/perseid/match.js'
import {
  type Obs,
  type Outcome,
  type Handler,
  type EffectsOf,
  type EnsureValue,
  path,
  reconcile,
  defineStep,
  runStep,
  runStepAsync,
  known,
  absent,
  unknown,
  yieldStep,
  quiesce,
  terminate,
  anyOf,
  countNeField,
  untilDrift,
} from '@apsis-io/perseid/perseid.js'

// The HOST half of the three capabilities declared in wit/world.wit. Aliased
// because the effect wrappers below already own the unprefixed names - and the
// two are deliberately different things: `ensure` yields a request the runner
// interprets, `hostEnsure` performs it.
//
// Importing is safe at module scope; CALLING is not. dwarf's Wizer pre-init
// evaluates top-level code at build time, so a host call up here would run
// against no host (see ../perseid-ocaml/src/main.ts, and `run` below).
import { wakeable } from '@apsis-io/perseid/wake.js'
import { get as hostGet } from 'perseid:reconcile/observe@0.1.0'
// ***`ensure`, NOT `workloads.scale`, SINCE 2026-09-01.*** e75c8c392 removed the
// specialized writes: `IfaceWorkloads` conferred `Ensure` narrowed to
// `spec.replicas`, and it now confers NOTHING. The import still LINKS - the
// interface exists - so a component built against it instantiates fine and every
// obligation it declares is refused at the aperture. That is the shape this file
// already paid for once with a dead `emit` import: it built, it passed, and it
// was wrong for four days.
import { ensure as hostEnsure, type Value as HostValue } from 'perseid:reconcile/ensure@0.1.0'
import { status as hostSet, type ConditionStatus as HostCondStatus } from 'perseid:reconcile/status@0.1.0'

// The capabilities this operator needs. `defineEffect` produces wrappers with
// NARROW yield types — hand-writing them as `Generator<AllEffects, …>` compiles
// and silently destroys the capability tracking, which is why the SDK owns this.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***THIS FILE IMPORTED `periapsis:reconcile/emit@0.1.0` UNTIL 2026-08-25 AND
// THAT INTERFACE WAS DELETED ON 2026-08-21*** (trail-main). It built, passed
// its own tests and produced a derived world naming a dead import for four
// days — which is precisely the failure `ci/verify-wit-imports.sh` was written
// to make visible, and it is what that guard was red on.
//
// Two typed effects replace one stringly-typed `emit`, so the artifact's TYPES
// now name the actions it performs. Under `emit(op: string)` a component's
// world said it could emit SOMETHING and nothing said what.
// ═══════════════════════════════════════════════════════════════════════════
// ***THESE WERE THREE HAND-WRITTEN `defineEffect` CALLS UNTIL 2026-08-29.***
// Each one repeated an interface id, an op name and an argument shape - three
// strings and a record per effect, all fixed by the contract, none of them
// checked against it. `reconcile` is `wit/reconcile/reconcile.wit` pre-applied,
// so there is nothing left to spell wrong.
//
// The `{ path, n }` vs `{ path, replicas }` note that lived here belonged to
// `ScaleArgs` and went with it. `ensure` names the field it writes, so there is
// no per-effect argument convention left to get wrong: the path says WHICH
// object, `field` says WHICH field, and the value carries its own type.
const observe = reconcile.observe<number>()
// ***THE FIELD IS NOW THE PROGRAM'S TO NAME, AND THAT IS A WIDENING.***
// `workloads.scale` could only ever write `spec.replicas` - one capability, one
// effect, one field. `ensure` writes ANY field `spec.writes` admits, so what
// bounds this program is no longer the interface it holds but the paths its
// manifest declares. Strictly less well bounded, and deliberate: engi retired the
// specialized write rather than keep one capability per field.
const ensure = reconcile.ensure()
const report = reconcile.status()

// A REAL APISERVER PATH, because `scale`'s path is the same vocabulary
// `spec.writes` uses and a toy string here would model the exact defect this
// contract already paid for once — `count` was given a path where a selector
// goes, the host answered `unknown` forever, and nothing reported it.
// BUILT, not typed. `ApiPath` is branded, so the string below is not merely
// discouraged - a hand-written one is not assignable at all, and the segments
// cannot be mis-ordered nor the `namespaces` segment forgotten.
const deployment = path.ns('default').deployments('api')
const selector = 'app=api'

// ***THIS WAS FOUR LINES OF `ReturnType<…> extends Step<infer A, any>`.*** The
// union is the step's capability set, so it is read off the step itself rather
// than assembled from the effects by hand - a list that could fall behind the
// yields it is supposed to describe.
type Effs = EffectsOf<typeof step>

const want = 3

/** The `known` arm's value — what `when`'s clauses receive. */
type KnownReplicas = Extract<Obs<number>, { t: 'known' }>

// ═══════════════════════════════════════════════════════════════════════════
// ***THE WAKE CONDITION IS BUILT, NOT WRITTEN, AND IT WAITS ON MORE THAN IT
// USED TO.*** This was `countNe('app=api', want)` — a pod census against a
// number the guest had already decided.
//
// `Replicas` reads `spec.replicas`, the field this program MAINTAINS, so the
// first arm wakes when somebody edits the desired count; the old form stayed
// asleep on a target nobody wanted any more. The second is the pod census,
// which only became expressible when aperture grew types and arithmetic:
// comparing two OBSERVATIONS needed a right-hand side that is not a literal.
//
// `Resume` is `Expr<'bool'>`, so an effect here — `setReplicas(…)`, an ordinary
// expression in the same language — is a compile error. That is the host's
// `CheckPure` rule, moved to the build.
//
// The host still adds its own bounded backstop, which is why waiting on more
// conditions degrades to a slower wake rather than a lost one.
// ═══════════════════════════════════════════════════════════════════════════
//
// ***AND IT NAMES THE DEPLOYMENT ONCE.*** This read `replicas('api')` twice,
// against a `deployment` path built three lines up from the same name - three
// spellings of one object, related by nothing. Edit the path and the program
// observes the new deployment and parks on the old one: awake for changes it no
// longer reads, asleep through every change it does, with `quiesce` returning
// nothing to say so. `untilDrift` derives the resume FROM the observed path, so
// there is no second spelling left to drift.
const wakeOnDrift = (seen: number) =>
  anyOf(
    untilDrift(deployment, seen),
    // Explicit, because the observation does not imply it: that the pod census
    // should track the desired count is a second claim, and deriving it from a
    // path would be the SDK guessing at intent.
    countNeField(selector, deployment),
  )

// ***THIS WAS A `switch` WHOSE EXHAUSTIVENESS WAS A COINCIDENCE.*** The comment
// here used to explain it: a declared return type plus every arm returning, so
// a missing case fails with TS2366 "Function lacks ending return statement".
// That works, and it is two unrelated facts holding hands — delete the return
// annotation and the exhaustiveness goes with it, silently.
//
// `match` is exhaustive because `arms` is a mapped type over the tag: a missing
// case is a missing property, reported by name, with no terminal call to forget.
const step = defineStep(function* () {
  // ***`observe('replicas')` UNTIL 2026-08-26, AND IT WAS UNRESOLVABLE.***
  // `observe.get` takes an apiserver PATH - the same vocabulary `scale` and
  // `spec.writes` use - and aperture cannot resolve a bare field name, so
  // against a real host this returned `unknown` on every pass, forever, and
  // the step yielded without ever scaling anything. Nothing would have
  // reported it: `get` never throws by contract, `unknown` is a legitimate
  // answer, and `yield` is a legitimate outcome.
  //
  // That is the identical defect this contract already paid for once, recorded
  // twenty lines up: `count` was given a path where a SELECTOR goes. Same
  // vocabulary confusion, opposite direction, and it survived here because
  // nothing in this file ever called the real host - `drive()` below hands the
  // generator a fake.
  const have = yield* observe(deployment)

  return yield* match(have, 't', {
    absent: () => terminate,
    unknown: () => yieldStep,

    // One annotated clause parameter supplies the variant type for the whole
    // call; `when` cannot infer it from the arms object it is written into.
    known: when(
      // AT THE DESIRED SCALE. Report, then park.
      [
        (o: KnownReplicas) => o.v === want,
        // ***THE ARM TAKES THE OBSERVED VALUE NOW.*** It used to take nothing
        // and the resume was a module-level constant; parking on what was
        // actually SEEN is what lets the wake condition be derived rather than
        // restated.
        function* ({ v }) {
          // `type` is the condition's IDENTITY: a later `set` with 'Ready'
          // REPLACES this one rather than adding a second. `status` is the
          // Kubernetes spelling and the SDK's union makes 'true' a compile
          // error — a lower-cased value is well-formed JSON that fails
          // apiserver validation, and `set` returns nothing, so the step could
          // never see the rejection.
          yield* report({
            type: 'Ready',
            status: 'True',
            reason: 'AtDesiredScale',
            message: `${want} of ${want} replicas`,
          })

          // quiesce REQUIRES a resume: there is no way to say "nothing to do"
          // without saying what would change your mind.
          //
          // ***`changed` ON A DEPLOYMENT IS STILL NOT EXPRESSIBLE, AND NEVER
          // WAS*** (engi, 2026-08-21). aperture has no notion of change — no
          // resourceVersion, no generation, no previous value — so a park using
          // it was always refused. What replaced it is `wakeOnDrift` above:
          // not a change notification, but a condition that stops holding.
          return quiesce(wakeOnDrift(v))
        },
      ],

      // ═══════════════════════════════════════════════════════════════════
      // NOT AT THE DESIRED SCALE. ***TWO ARMS COLLAPSED INTO ONE BECAUSE
      // THE WRITE IS ABSOLUTE.*** The old code computed `+${want - have.v}` and
      // `-${have.v - want}` — a DELTA — and needed a branch per direction to
      // keep the sign right. `ensure(path, 'spec.replicas', n)` states the count
      // you want, so the arithmetic and the second branch both go.
      //
      // That is not tidying. A delta is only correct if the observation it was
      // derived from is still true when the host applies it, and a step
      // re-derives from a FRESH observation every tick — so two ticks before
      // one obligation lands apply the correction twice. An absolute target is
      // idempotent under exactly the re-derivation this contract mandates.
      // ═══════════════════════════════════════════════════════════════════
      function* () {
        yield* ensure({ path: deployment, field: 'spec.replicas', value: want })

        return yieldStep
      },
    ),
  })
})

// ---------------------------------------------------------------------------
// The runtime half. `Handler<Effs>` is a mapped type over the ops in Effs, so it
// must be TOTAL — omit one and this does not compile. Adding a capability you do
// not handle is a build failure, not a review item.
function drive(o: Obs<number>): { outcome: Outcome; acts: string[] } {
  const acts: string[] = []
  const handler: Handler<Effs> = {
    get: () => o,
    // ***THE KEYS ARE WIT FUNCTION NAMES, AND `Handler<Effs>` IS TOTAL.***
    // Dropping `emit` and adding these two is not optional bookkeeping: a
    // missing key is a compile error, so the runner cannot fall behind the
    // capability set. That is what caught the shape of this port immediately
    // rather than at the first pod.
    ensure: (args) => {
      if (!('value' in args)) return
      acts.push(`ensure(${args.path}, ${args.field}, ${JSON.stringify(args.value)})`)
    },
    status: (c) => {
      acts.push(`set(${c.type}=${c.status} ${c.reason})`)
    },
  }
  return { outcome: runStep(step, handler), acts }
}

// ***A RECORD LOOKUP WITH NO EXHAUSTIVENESS, UNTIL 2026-08-29.*** Indexing an
// object literal by `o.o` type-checks whether or not every outcome has an entry;
// a missing one is `undefined` at `.padEnd`. `matchValue` is the same dispatch
// with the arms required — and it refuses an arm that yields, since calling one
// would return an iterator nobody advances.
const name = (o: Outcome): string =>
  matchValue(o, 'o', {
    yield: () => 'Yield',
    quiesce: () => 'Quiesce',
    terminate: () => 'Terminate',
  })

function runCase(label: string, o: Obs<number>) {
  const { outcome, acts } = drive(o)
  console.log(`${label.padEnd(10)} -> ${name(outcome).padEnd(9)} acts=[${acts.join('; ')}]`)
}

// ---------------------------------------------------------------------------
// Capability typing is asserted MECHANICALLY, not in prose. `step` yields both
// effects; a runner accepting only the observe effect must reject it. If
// TypeScript ever stopped inferring the yield union through yield*, the
// directive below becomes an unused-directive error (TS2578) and the build
// fails. build.sh runs `tsc --noEmit`, so it is enforced.
type ObserveEff = Extract<Effs, { op: 'get' }>
declare function runObserveOnly<A>(g: Generator<ObserveEff, A, any>): A
export const _capabilityTypingHolds = () => {
  // @ts-expect-error a step that also emits must NOT satisfy an observe-only runner
  runObserveOnly(step())
}

// replicasOf reads `spec.replicas` out of the JSON `observe.get` returns.
//
// ***TOTAL AND THREE-VALUED-SAFE: AN UNREADABLE SHAPE YIELDS NaN RATHER THAN
// THROWING.*** A throw here escapes into the step and fails the pass; NaN makes
// every comparison false, which leaves the program declaring its obligation and
// yielding - the same conservative outcome as an unknown observation. Neither is
// good, and only one of them is recoverable without an operator.
const replicasOf = (raw: string): number => {
  try {
    const o = JSON.parse(raw) as { spec?: { replicas?: unknown } }
    return Number(o?.spec?.replicas)
  } catch {
    return NaN
  }
}


// ---------------------------------------------------------------------------
// ***THE REAL HALF. `drive()` ABOVE IS A FAKE AND THAT IS WHY THIS FILE COULD
// SHIP A COMPONENT THAT COULD NOT RUN.***
//
// Everything above this line is exercised by `run` against a handler that
// records strings. It type-checks, it proves the capability typing, and it
// touches no host - so `observe('replicas')` passed every check this file had
// while being unresolvable against a real apiserver, and the world could omit
// the `step` export without one test noticing.
//
// This is the join: the same generator, driven by a handler whose three keys
// call the WIT imports the world declares.

// ***THE SAME THREE-ARM LOWERING AS `janitor-main.ts` AND `podmaker-main.ts`,
// AND IT IS DUPLICATED ON PURPOSE UNTIL THE THIRD CALLER EARNS A HOME.*** It
// cannot live in the SDK as written: `HostValue` comes from a generated WIT
// binding that only exists inside a component build, and the SDK is compiled
// against no world at all. Promoting it would drag that binding into every
// consumer, including the ones that never write.
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

const hostHandler: Handler<Effs> = {
  // The variant crosses the boundary as `{ tag, val }` (dwarf's binding of
  // WIT's `variant obs`); the SDK's `Obs<T>` is `{ t, v }` with a TYPED value.
  // The conversion is the whole reason this cannot be a cast: `val` is a
  // string on the wire because `obs` carries `known(string)`, and the step
  // compares it as a number.
  // ***AWAITED, BECAUSE THE READ IS `async func`.*** Reading `.tag` off the
  // unawaited promise yields `undefined`, which falls through to `unknown` - the
  // program observes nothing and yields forever, looking healthy.
  get: async (path) => {
    const o = await hostGet(path)
    if (o.tag !== 'known') return o.tag === 'absent' ? absent : unknown

    // ***THE HOST HANDS BACK THE WHOLE OBJECT AS JSON NOW, SO THE FIELD IS
    // PICKED HERE.*** It used to hand back the replica COUNT: `observe.get` on
    // a deployment went through a per-kind read surface that narrowed to
    // `spec.replicas` before the guest saw it. One generic read replaced the
    // eight per-kind ones, and a generic read cannot know which field a step
    // wants - so it returns the object and the step names its own field, which
    // is what `observe-cluster` has always done.
    //
    // ⚠ `Number(o.val)` ALONE WAS THE BUG AND IT IS WORTH THE LINE: on an
    // object it is NaN, every comparison against NaN is false, so the step
    // never concludes it has converged and re-declares its obligation every
    // pass without ever parking. Nothing errors on either side.
    return known(replicasOf(o.val))
  },
  // ***THE LOWERING IS THE ONLY PLACE THE TWO VALUE SHAPES MEET***, which is what
  // makes a missing arm a compile error rather than a wrong write. The SDK's
  // `EnsureValue` is a discriminated record (`{ num }` / `{ text }` / `{ flag }`);
  // WIT's is a tagged variant whose `num` arm is an s64, so the BigInt is not
  // decoration - dwarf binds the WIT integer to a JS bigint and a plain number is
  // rejected at the boundary.
  ensure: (args) => {
    // The scalar form is what this program yields; the body form narrows out.
    if ('value' in args) hostEnsure(args.path, args.field, lower(args.value))
  },
  // ***NOT A PASS-THROUGH, AND A CAST HERE WOULD COMPILE.*** The SDK's
  // `ConditionStatus` is `'True' | 'False' | 'Unknown'` because engi's decision
  // was to copy Kubernetes' spelling; WIT's `enum condition-status` is
  // `true | false | unknown`, so dwarf binds it lowercase. One `toLowerCase()`
  // apart, and the wrong one is not rejected anywhere on the wire - it is a
  // string either way.
  //
  // That is the resume defect's exact shape: a payload that crossed the
  // boundary structurally intact and semantically wrong, with no error on
  // either side. src/wit.d.ts declares the host spelling so skipping this
  // conversion is a compile error rather than a condition nobody can select on.
  status: (c) => hostSet({ ...c, status: c.status.toLowerCase() as HostCondStatus }),
}

// ***EXPORTED UNDER A DIFFERENT LOCAL NAME ON PURPOSE, AND IT IS NOT STYLE.***
// The WIT export must be called `step`, and `step` is already the generator -
// which `tools/derive-wit.ts` finds BY DECLARATION NAME to read the capability
// demand out of its yield type. Renaming the generator would silently detach
// the derived world from the code; exporting the object directly would shadow
// it. An ES module export alias keeps both: the local `step` stays the
// generator, and the module exports `step` as the entrypoint.
const wake = wakeable()

const stepEntry = {
  // `run: func() -> string` - the outcome as JSON. runStep is the SDK's
  // interpreter; the host handler above is what makes it a real pass rather
  // than the five canned ones.
  // ***ASYNC BECAUSE ITS IMPORTS ARE, AND RACED SO IT CAN BE FREED.*** A step
  // blocked in a read cannot be stopped from outside; racing the wake future is
  // the only thing that frees it (ADR-0106). If the signal wins, the pass yields
  // rather than reporting a decision it never finished making.
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(step, hostHandler),
      wake.signalled().then(() => ({ o: 'yield' }) as never),
    ])

    return JSON.stringify(outcome)
  },
}
const signalEntry = wake.handler()
export { stepEntry as step, signalEntry as signal }

export const run = {
  async run() {
    // Inside run(), NOT at module scope: dwarf's Wizer pre-init evaluates
    // top-level code at build time (see ../perseid-ocaml/src/main.ts).
    runCase('below', known(1))
    runCase('equal', known(3))
    runCase('above', known(5))
    runCase('absent', absent)
    runCase('unknown', unknown)
  },
}
