// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Guards for the Perseid SDK's TYPE surface.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***THESE ARE COMPILE-TIME ASSERTIONS AND THEY HAVE TO BE, BECAUSE THE DEFECT
// THEY GUARD COMPILES CLEAN.***
//
// `Handler<NoInfer<E>>` typed every handler argument as `never` for as long as
// it existed. Nothing errored: `never` is assignable to everything, so a handler
// body kept working, `runStep` kept running, and the only symptom was that
// completion and argument checking were silently gone. No runtime test can see
// that — the values are identical either way. The only instrument that
// distinguishes `(a: string) => …` from `(a: never) => …` is the type checker,
// so the assertion has to be a type.
//
// A NEGATIVE assertion is what makes them work: `Not<IsNever<…>>`. Asserting
// "the arg is assignable to string" PASSES for `never`, which is exactly the
// broken state — the direction that looks like a stronger check is the one that
// cannot fail. That is this repo's "check the false-positive direction first",
// arriving in a type test.
//
// # HOW TO RUN THEM
//
// They run wherever this file is type-checked. `examples/wasm/perseid-ts` lists
// it in `tsconfig.json`'s `include`, so `build.sh` step 1 (`tsgo --noEmit`)
// enforces them on every component build. There is no separate test command to
// forget.
//
// The handful of RUNTIME facts below (an empty resume throws) are ordinary
// assertions in `runtimeGuards()`:
//
//	bun -e 'import {runtimeGuards} from "./ts/periapsis/perseid.test.ts"; runtimeGuards()'
//
// ***BUN, NOT NODE, AND THE REASON IS THE IMPORT ABOVE.*** It is extensionless,
// which `moduleResolution: bundler` resolves and node's ESM resolver does NOT —
// node fails with ERR_MODULE_NOT_FOUND before running a line. Written down
// because the obvious command is the one that does not work, and a run
// instruction nobody has executed is the same untested claim as any other.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type Handler,
  type Obs,
  type Outcome,
  type FinalizeOutcome,
  type Step,
  type EffectsOf,
  type YieldOf,
  type ApiPath,
  type ClusterPath,
  type Resume,
  type ApiPathShape,
  type LabelSelectorShape,
  type Canonical,
  type Wit,
  type ScaleArgs,
  cleanupDone,
  retry,
  defineEffect,
  defineStep,
  path,
  reconcile,
  runStep,
  quiesce,
  known,
  absent,
  unknown,
  yieldStep,
  terminate,
  fieldNe,
  unsafeApiPath,
  WIT_OBSERVE,
  WIT_WORKLOADS,
} from './perseid'

const WEB = path.ns('default').deployments('web')

// ---------------------------------------------------------------------------
// The assertion vocabulary.

// ***THE FAILURE CARRIES THE DIAGNOSIS, BECAUSE A TYPE ERROR HAS NOWHERE ELSE TO
// PUT ONE.*** A plain `Assert<T extends true>` fails with "Type 'false' does not
// satisfy the constraint 'true'" - which says a check failed and nothing about
// what broke. Measured against the real mutation (`NoInfer<Handler<E>>`
// restored) that is the entire message.
//
// Threading a MSG string through means the compiler prints it: the red names
// the mechanism, which is this tree's standing requirement for a guard and is
// otherwise unreachable in a type-level test.

/** Fails to compile unless T is exactly `true`; MSG is rendered into the error. */
type Assert<T extends true> = T

/** `true`, or MSG if T collapsed to `never`. */
type NotNever<T, MSG extends string> = [T] extends [never] ? MSG : true

/**
 * `true`, or MSG unless A and B are mutually assignable.
 *
 * Mutual, not `extends`: `never extends string` is TRUE, so a one-directional
 * check passes in exactly the broken state these guards exist to catch.
 */
type Same<A, B, MSG extends string> = [A] extends [B] ? ([B] extends [A] ? true : MSG) : MSG

// ---------------------------------------------------------------------------
// A representative step, in the shape that showed the defect: an INLINE handler
// literal rather than an annotated `Handler<…>` constant.

const webDeployment = path.ns('default').deployments('web')
const observe = reconcile.observe<number>()
const scale = reconcile.scale()

const step = defineStep(function* () {
  const have = yield* observe(webDeployment)
  switch (have.t) {
    case 'absent':
      return terminate
    case 'unknown':
      return yieldStep
    case 'known': {
      if (have.v !== 2) {
        yield* scale({ path: webDeployment, n: 2 })

        return yieldStep
      }

      return quiesce(fieldNe(WEB, 'spec.replicas', 2))
    }
  }
})

type Effs = EffectsOf<typeof step>
type GetArg = Handler<Effs> extends { get: (a: infer A) => any } ? A : never
type ScaleArg = Handler<Effs> extends { scale: (a: infer A) => any } ? A : never

// ---------------------------------------------------------------------------
// ⭐ THE REGRESSION: handler arguments must not be `never`.
//
// Stated as `Not<IsNever<…>>` first and `Exactly<…>` second on purpose. The
// second alone would be enough today, but it is the assertion someone weakens to
// `extends` when a type moves - and `never extends string` is true, so the
// weakened form silently stops testing anything. The first cannot be weakened
// into vacuity.
export type _HandlerGetArgIsNotNever = Assert<
  NotNever<GetArg, 'Handler<E> get-arg is never: Extract<E,{op:K}> matched no member'>
>
export type _HandlerScaleArgIsNotNever = Assert<
  NotNever<ScaleArg, 'Handler<E> scale-arg is never: Extract<E,{op:K}> matched no member'>
>
export type _HandlerGetArgIsTheEffectsArg = Assert<
  Same<GetArg, ApiPath, 'Handler<E> get-arg is not the effect arg type (ApiPath)'>
>
export type _HandlerScaleArgIsTheEffectsArg = Assert<
  Same<ScaleArg, ScaleArgs, 'Handler<E> scale-arg is not ScaleArgs'>
>

// ⭐ The same through `runStep`'s PARAMETER, which is where `NoInfer` sits — and
// this is the pair that actually caught the defect. `Handler<E>` was never
// broken; the runner's APPLICATION of it was, so the four assertions above stay
// green under the real mutation and only these two go red. A guard on the type
// alone would have shipped the bug.
type RunStepHandler = Parameters<typeof runStep<Effs, Outcome>>[1]
type RunStepGetArg = RunStepHandler extends { get: (a: infer A) => any } ? A : never

export type _RunStepGetArgIsNotNever = Assert<
  NotNever<
    RunStepGetArg,
    'runStep handler arg is never: NoInfer is INSIDE Handler<>, use NoInfer<Handler<E>>'
  >
>
export type _RunStepGetArgIsTheEffectsArg = Assert<
  Same<
    RunStepGetArg,
    ApiPath,
    'runStep handler arg is not the effect arg type: check NoInfer placement'
  >
>

// ---------------------------------------------------------------------------
// `NoInfer`'s actual job must survive the fix.
//
// It is not decoration: without it, TypeScript infers E from the HANDLER as well
// as the step, so a handler with an extra key widens the capability set instead
// of being rejected. The fix moved NoInfer outward; if it had merely been
// deleted, these two assertions are what would notice.

export const _anExtraHandlerKeyIsRejected = () => {
  runStep(step, {
    get: () => known(1),
    scale: () => {},
    // @ts-expect-error a key no effect yields is not part of the capability set
    bogus: () => {},
  })
}

export const _aMissingHandlerKeyIsRejected = () => {
  // @ts-expect-error `Handler` is TOTAL - scale is yielded and must be handled
  runStep(step, { get: () => known(1) })
}

// ---------------------------------------------------------------------------
// engi's ask 3, both halves. Each is a compile error, and `@ts-expect-error` is
// what asserts that: it FAILS THE BUILD if the error stops occurring, so these
// cannot rot into passing by accident.

// ***STILL REJECTED, AND NO LONGER FOR THE REASON THIS GUARD WAS WRITTEN.***
// It was the `R extends '' ? never : R` conditional on `quiesce`. Since `Resume`
// became `Expr<'bool'>`, the empty string is refused one step earlier - it is
// not a branded expression, so it is not a Resume at all, and the conditional
// is now unreachable rather than load-bearing.
//
// Kept because the PROPERTY is what matters (a park must state a wake
// condition) and it is now defended twice. Recorded rather than silently left
// passing: a guard that still goes green for a different reason is the shape
// that gets quoted as evidence for a mechanism it no longer tests.
export const _anEmptyResumeIsRejected = () => {
  // @ts-expect-error a park with no wake condition - the host refuses it too
  quiesce('')
}

// `return quiesce` - the function, unapplied. Stated as a TYPE assertion rather
// than a `@ts-expect-error` on the return statement, because the error does not
// occur there: the body type-checks on its own and the mismatch is reported at
// the `defineStep(…)` CALL, on the argument. A directive at the return is
// reported UNUSED, which fails the build for the wrong reason and reads as
// though the rule does not hold.
export type _QuiesceUnappliedIsNotAnOutcome = Assert<
  typeof quiesce extends Outcome ? 'the quiesce FUNCTION is assignable to Outcome' : true
>

// …and the pin is what converts that into an error at the step. Without
// `defineStep` the return type simply widens and nothing complains.
export const _aStepBodyMustReturnAnOutcome = () => {
  const body = function* () {
    yield* observe(webDeployment)

    return quiesce
  }
  // @ts-expect-error the body returns the FUNCTION `quiesce`, not an Outcome
  defineStep(body)
}

// A non-empty resume is of course fine - without this, the assertion above
// would also pass if `quiesce` had been broken outright.
export const _aRealResumeIsAccepted = (): Outcome => quiesce(fieldNe(WEB, 'spec.replicas', 2))

// ---------------------------------------------------------------------------
// engi's ask 1: the wit set is OPEN. Both directions, because a closed union
// would still satisfy a test that only checks the known members.

export type _AKnownWitIsAWit = Assert<
  typeof WIT_OBSERVE extends Wit ? true : 'a KNOWN wit id is not assignable to Wit'
>
export type _AnUnknownWitIsStillAWit = Assert<
  'acme:custom/thing@1.0.0' extends Wit
    ? true
    : 'Wit has CLOSED: an interface this SDK has not heard of is refused'
>

// ⭐ ***THE COMPLETION GUARD, AS CLOSE AS A TYPE CAN GET TO ONE.***
//
// Completion is not assertable: `tsgo --noEmit` is green whether the argument
// offers three suggestions or none, which is how `KnownWit | WitId` (measured:
// ZERO completions) passed every other assertion in this file.
//
// Absorption into `string` is the mechanism that kills it, and THAT is
// checkable. This also fails for the old `KnownWit | (string & {})` form -
// `string` is assignable to `string & {}` - so it is simultaneously the guard
// that the id is TYPED at all.
export type _WitHasNotCollapsedToString = Assert<
  string extends Wit
    ? 'Wit accepts any string: the id is unvalidated AND literal completions are gone'
    : true
>

// engi, 2026-08-29: "can you type wit string". The shapes people actually
// mistype, each rejected. `@ts-expect-error` fails the build if any of them
// starts being accepted.
export const _malformedWitIdsAreRejected = () => {
  const d = defineEffect<string, string>()
  // @ts-expect-error no @version - derives a world naming an import no host supplies
  d('radiant:reconcile/observe', 'get')
  // @ts-expect-error no /interface segment
  d('radiant:reconcile@0.1.0', 'get')
  // @ts-expect-error separators swapped
  d('periapsis/reconcile:observe@0.1.0', 'get')
  // @ts-expect-error a bare word
  d('observe', 'get')
  // @ts-expect-error `latest` is not a semver triple
  d('acme:custom/thing@latest', 'get')
}

// …and the other direction, or the five above would also pass for a `Wit` that
// rejects everything.
export const _wellFormedWitIdsAreAccepted = () => {
  const d = defineEffect<string, string>()
  d(WIT_OBSERVE, 'get')
  d('acme:custom/thing@1.0.0', 'get')
}

// ---------------------------------------------------------------------------
// engi's ask 4: the sugar must produce exactly what the longhand produces.
// Otherwise it is a second vocabulary for the same seam - the shape this
// codebase has deleted repeatedly.

const longhandScale = defineEffect<ScaleArgs, void>()(WIT_WORKLOADS, 'scale')
const longhandObserve = defineEffect<string, Obs<number>>()(WIT_OBSERVE, 'get')

export type _SugarScaleMatchesLonghand = Assert<
  Same<
    EffectsOf<typeof scale>,
    EffectsOf<typeof longhandScale>,
    'reconcile.scale() and the longhand defineEffect yield DIFFERENT effects - the sugar is a second vocabulary'
  >
>
export type _SugarObserveMatchesLonghand = Assert<
  Same<
    EffectsOf<typeof observe>,
    EffectsOf<typeof longhandObserve>,
    'reconcile.observe() and the longhand defineEffect yield DIFFERENT effects'
  >
>

// ---------------------------------------------------------------------------
// engi's ask 2: `defineStep` pins the return to Outcome and still infers the
// yields. The second half matters as much as the first - a `defineStep` that
// pinned the return by widening E to `AnyEffect` would destroy the capability
// tracking that is the whole reason a step is typed at all.

export type _StepReturnsOutcome = Assert<
  ReturnType<typeof step> extends Step<any, infer R>
    ? Same<R, Outcome, 'defineStep did not pin the return type to Outcome'>
    : 'defineStep did not return a Step'
>
export type _StepKeepsItsEffectUnionNarrow = Assert<
  NotNever<Effs, 'defineStep lost the effect union - capability tracking is gone'>
>
export type _StepDoesNotYieldEverything = Assert<
  Same<
    Effs['op'],
    'get' | 'scale',
    'defineStep WIDENED the effect union - a step now looks like it needs everything'
  >
>

// ---------------------------------------------------------------------------
// THE HANDLER-AS-A-CONSTANT CASE, which is where `YieldOf` earns its export.
//
// An INLINE handler literal is contextually typed by `runStep`. One lifted into
// its own `const` is not - nothing types a free-standing object literal - so
// under `strict` every parameter is an implicit-any error. That is not a defect
// in the SDK and it is not the `never` bug returning: it is TS7006, and the
// annotation below is the whole fix.

const handlersAnnotated: Handler<YieldOf<ReturnType<typeof step>>> = {
  get: (what) => {
    // Checked, not `any` and not `never`: assigning to string compiles, and the
    // line below proves it is not `any` by rejecting a number.
    const p: ApiPath = what

    return known(p.length)
  },
  scale: ({ path, n }) => {
    void `${path}${n}`
  },
}

export const _anAnnotatedStandaloneHandlerWorks = () => runStep(step, handlersAnnotated)

// If `what` were `any`, this would compile. It must not.
export const _theAnnotatedHandlerArgIsNotAny = () => {
  const h: Handler<YieldOf<ReturnType<typeof step>>> = {
    // @ts-expect-error `what` is string; a number parameter is not compatible
    get: (what: number) => known(what),
    scale: () => {},
  }

  return h
}

// `YieldOf<ReturnType<…>>` and `EffectsOf<…>` must name the SAME set, or the SDK
// ships two spellings of one idea and they are free to drift.
export type _YieldOfAndEffectsOfAgree = Assert<
  Same<
    YieldOf<ReturnType<typeof step>>,
    EffectsOf<typeof step>,
    'YieldOf<ReturnType<S>> and EffectsOf<S> name different sets'
  >
>

// ---------------------------------------------------------------------------
// ⭐ THE THREE VOCABULARIES CANNOT BE SWAPPED.
//
// engi, 2026-08-29, asked whether `replicasNe` should detect an already-
// normalised path, or whether one canonical form should be enforced everywhere.
// Neither: a NAME cannot forge a namespace and a PATH can, so they are different
// languages on purpose - and the answer to the confusion is to make them
// UNCONFUSABLE.
//
// ***THE FIRST TWO CASES ARE THE TWO DEFECTS THIS CONTRACT HAS ACTUALLY PAID
// FOR, AND BOTH COMPILED AT THE TIME.*** Neither errored at runtime either:
// `get` and `count` never throw by contract, so the host answered `unknown`
// forever while the program looked healthy.

// ⭐ ***A PATH MUST BE BUILT, NOT TYPED*** (engi: "require canonical form").
//
// The brand is the mechanism. A hand-written literal is not assignable however
// correct it looks, so `path.…` (or `unsafeApiPath`, for a value that only
// exists at runtime) is the only way to obtain one.
export const _aHandTypedPathIsRejectedEvenWhenCorrect = () => {
  const obs = reconcile.observe<number>()

  // @ts-expect-error correct in every character, and still not canonical
  obs('/apis/apps/v1/namespaces/default/deployments/web')
  // @ts-expect-error a template-built string is not canonical either
  obs(`/apis/apps/v1/namespaces/${'default'}/deployments/web`)
}

export const _aBuiltPathIsAccepted = () => {
  const obs = reconcile.observe<number>()

  obs(path.ns('default').deployments('web'))
  obs(path.ns('default').pods('web-0'))
  obs(path.ns('kube-system').resource('apps', 'v1', 'daemonsets', 'kube-proxy'))
  obs(path.ns('default').core('v1', 'configmaps', 'settings'))

  // The runtime escape hatch produces one too - that is what makes it an escape
  // hatch rather than a second vocabulary.
  return obs(unsafeApiPath(process.env.TARGET ?? ''))
}

// The builder must produce the LITERAL, not a widened string: the type is what
// an error message shows, and a widened one would also mean two different built
// paths were mutually assignable.
const builtApiDeployment = path.ns('default').deployments('api')
const builtPod = path.ns('kube-system').pods('coredns-0')

export type _TheBuilderKeepsTheLiteral = Assert<
  Same<
    typeof builtApiDeployment,
    Canonical<'apiserver-path', '/apis/apps/v1/namespaces/default/deployments/api'>,
    'path.ns(...).deployments(...) widened the literal'
  >
>
// Pods are the CORE group: `/api/v1/...`, not `/apis/...`. Getting that wrong
// produces a path the host refuses, so it is worth pinning separately.
export type _PodsUseTheCoreGroup = Assert<
  Same<
    typeof builtPod,
    Canonical<'apiserver-path', '/api/v1/namespaces/kube-system/pods/coredns-0'>,
    'path.ns(...).pods(...) does not build a core-group path'
  >
>

// ⭐ ***TWO CANONICAL FORMS MUST BE DISJOINT EVEN WHEN THEIR SHAPES ARE
// IDENTICAL*** (engi: "standalone Canonical is bad, what if we introduce another
// canonical form of something").
//
// An unkinded `Canonical<S>` marks a string as "built" and not as built FOR
// WHAT, so every canonical form in the SDK would share one brand and be mutually
// assignable wherever the shapes overlap. These two differ ONLY in `Kind`, so
// the assertion fails for exactly that regression and cannot pass by accident on
// a shape difference.
type PathKind = Canonical<'apiserver-path', ApiPathShape>
type OtherKind = Canonical<'something-else', ApiPathShape>

export type _DifferentKindsOverOneShapeAreDisjoint = Assert<
  OtherKind extends PathKind
    ? 'the brand is not kinded: two canonical forms with identical shapes are interchangeable'
    : true
>
// …and the same kind over the same shape IS the same type, or the assertion
// above would also pass for a brand nothing can ever satisfy.
export type _TheSameKindIsAssignable = Assert<
  Same<PathKind, ApiPath, 'ApiPath is not Canonical<apiserver-path, ApiPathShape>'>
>

// ***THE SHAPES GENUINELY OVERLAP, WHICH IS WHY THE KIND CARRIES THE WEIGHT.***
// `app=x/namespaces/y` satisfies BOTH `ApiPathShape` (contains `/namespaces/`)
// and `LabelSelectorShape` (contains `=`). With one shared brand, a canonical
// selector would be assignable where a path goes - the vocabulary confusion this
// section exists to prevent, reintroduced by the mechanism preventing it.
export type _TheShapesOverlap = Assert<
  'app=x/namespaces/y' extends ApiPathShape
    ? 'app=x/namespaces/y' extends LabelSelectorShape
      ? true
      : 'the overlap example no longer satisfies LabelSelectorShape - the doc is stale'
    : 'the overlap example no longer satisfies ApiPathShape - the doc is stale'
>

// ⭐ ***THE SECOND CANONICAL FORM ARRIVED, AND THIS IS THE CASE THE KINDED BRAND
// WAS BUILT FOR.*** `ClusterPath` and `ApiPath` are both branded strings; only
// `Kind` distinguishes them. They address different read surfaces with different
// confinement - a namespace grant versus a per-object `spec.reads` - so passing
// one where the other goes routes a read around the bound chosen for it.
export const _theTwoPathKindsCannotBeSwapped = () => {
  const namespaced = reconcile.observe<number>()
  const cluster = reconcile.observeCluster()

  // @ts-expect-error a CLUSTER path where a namespaced one goes
  namespaced(path.cluster('admissionregistration.k8s.io', 'v1', 'validatingadmissionpolicies', 'p'))
  // @ts-expect-error a NAMESPACED path where a cluster one goes
  cluster(path.ns('default').deployments('api'))
  // @ts-expect-error still not a hand-written string
  cluster('/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/p')
}

export const _eachPathKindIsAcceptedByItsOwnSurface = () => {
  reconcile.observe<number>()(path.ns('default').deployments('api'))
  reconcile.observeCluster()(
    path.cluster('admissionregistration.k8s.io', 'v1', 'validatingadmissionpolicies', 'p'),
  )

  return reconcile.observeCluster()(path.clusterCore('v1', 'nodes', 'node-1'))
}

const builtCluster = path.cluster('admissionregistration.k8s.io', 'v1', 'validatingadmissionpolicies', 'p')

export type _TheClusterBuilderKeepsTheLiteral = Assert<
  Same<
    typeof builtCluster,
    Canonical<'cluster-path', '/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/p'>,
    'path.cluster(...) widened the literal'
  >
>

// ***THEY MUST BE DISJOINT AS TYPES, NOT MERELY DIFFERENT AS SHAPES.*** A
// cluster path happens not to contain `/namespaces/`, so a shape-only check
// would pass for an unkinded brand too - and this is the assertion that would
// not.
export type _ClusterPathIsNotAnApiPath = Assert<
  ClusterPath extends ApiPath
    ? 'ClusterPath is assignable to ApiPath: the brand kinds are not discriminating'
    : true
>
export type _ApiPathIsNotAClusterPath = Assert<
  ApiPath extends ClusterPath
    ? 'ApiPath is assignable to ClusterPath: a namespaced read could be routed at the cluster surface'
    : true
>

export const _theThreeVocabulariesCannotBeSwapped = () => {
  const obs = reconcile.observe<number>()
  const cnt = reconcile.count<number>()

  // @ts-expect-error a NAME where a PATH goes - observe('replicas'), unresolvable for 4 days
  obs('replicas')
  // @ts-expect-error a SELECTOR where a PATH goes
  obs('app=api')
  // @ts-expect-error a PATH where a SELECTOR goes - count(path), 239 asks / 119 resolved
  cnt('/apis/apps/v1/namespaces/default/deployments/api')
  // ⭐ ***THIS GUARD INVERTED ON 2026-08-30 AND IS KEPT RATHER THAN DELETED.***
  // It read "a PATH where a NAME goes - the grant supplies the namespace",
  // because the read symbol took a bare name. `Get(path, field)` replaced it, so
  // a NAME is now the unresolvable thing and a path is required.
  //
  // The refusal still holds and by a BETTER mechanism: `ApiPath` is branded with
  // no string constructor, so this is a type error with a message naming the
  // brand rather than a guard-tuple error naming a phantom parameter.
  // @ts-expect-error a NAME where a PATH goes - only path.ns(..) builds one
  fieldNe('api', 'spec.replicas', 3)
}

// …and each accepts its own, or the block above would also pass for types that
// reject everything.
export const _eachVocabularyAcceptsItsOwn = () => {
  reconcile.observe<number>()(path.ns('default').deployments('api'))
  reconcile.count<number>()('app=api')

  return fieldNe(path.ns('default').deployments('api'), 'spec.replicas', 3)
}

// ---------------------------------------------------------------------------
// Runtime facts. Small, because almost everything here is a type.

export function runtimeGuards(): void {
  const eq = (got: unknown, want: unknown, what: string) => {
    const g = JSON.stringify(got)
    const w = JSON.stringify(want)
    if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`)
  }

  // A resume that is empty only at RUNTIME cannot be caught by a type, so it
  // throws rather than parking forever on a condition nothing satisfies.
  //
  // ***THE CAST IS THE POINT, NOT A WORKAROUND.*** Since `Resume` became
  // `Expr<'bool'>` a plain string cannot reach `quiesce` through the types at
  // all - which is why this has to force it. That is exactly the path a value
  // from outside the program takes: config, an env var, an annotation, or any
  // untyped JS caller. The runtime check is what covers it.
  const buildResume = (): Resume => '' as unknown as Resume
  let threw = ''
  try {
    quiesce(buildResume())
  } catch (e) {
    threw = String(e)
  }
  if (!threw.includes('empty resume')) {
    throw new Error(
      `quiesce('') at runtime did not throw - a step would park on a condition the host ` +
        `refuses, which is indistinguishable from being correctly asleep. Got: ${threw || '(no throw)'}`,
    )
  }

  // The step still RUNS, and the sugar drives the same three outcomes.
  const drive = (o: Obs<number>) => {
    const acts: string[] = []
    const outcome = runStep(step, {
      get: () => o,
      scale: ({ path, n }) => {
        acts.push(`scale(${path},${n})`)
      },
    })

    return { outcome, acts }
  }

  eq(drive(known(2)).outcome, { o: 'quiesce', resume: fieldNe(WEB, 'spec.replicas', 2) }, 'at desired scale')
  eq(drive(known(1)).acts.length, 1, 'below desired scale emits one obligation')
  eq(drive(unknown).outcome, yieldStep, 'unknown yields rather than concluding')
  eq(drive(absent).outcome, terminate, 'absent terminates')

  // ═══════════════════════════════════════════════════════════════════════
  // FINALIZE - the deletion path's outcome vocabulary.
  // ═══════════════════════════════════════════════════════════════════════
  eq(cleanupDone, { tag: 'done' }, 'cleanupDone')
  eq(retry('pvc still bound'), { tag: 'retry', val: 'pvc still bound' }, 'retry carries its reason')

  // ⚠ ***A RETRY WITH NO REASON THROWS, AND THE TYPE ALREADY REFUSED IT.***
  // This is the runtime half of a guard whose primary arm is the parameter
  // type - it catches a reason that is only empty at RUNTIME, which no type can
  // see. The alternative is an object held undeletable with a blank
  // explanation, which reads as a host bug rather than as the program's
  // decision.
  let retryThrew = false
  try {
    // A value merely TYPED string passes the compile-time guard, which is
    // exactly the case this arm exists for.
    const computed: string = ''
    retry(computed)
  } catch {
    retryThrew = true
  }
  if (!retryThrew) {
    throw new Error('retry accepted an empty reason computed at runtime, so an object would ' +
      'be held undeletable with nothing an operator can act on')
  }

  console.log('perseid.test.ts: runtime guards pass')
}

// ═══════════════════════════════════════════════════════════════════════════
// ***THE FINALIZE OUTCOME CANNOT SPELL A PARK, AND THAT IS THE WHOLE TYPE.***
//
// A finalizer runs while an object is UNDELETABLE. A park that held one would be
// indistinguishable from a correct wait - both render as a `waitingFor` - so
// `quiesce` is absent from the union rather than refused at runtime.
//
// These are `@ts-expect-error`, so the BUILD is the assertion: if the union ever
// grows a park, tsgo fails on the unused directive rather than passing quietly.
// ═══════════════════════════════════════════════════════════════════════════
export const _aFinalizerCannotPark = () => {
  // @ts-expect-error a finalizer has no park - `quiesce` is not in FinalizeOutcome
  const _parked: FinalizeOutcome = { o: 'quiesce', resume: 'x' }

  // @ts-expect-error nor a yield: there is no next pass to yield to
  const _yielded: FinalizeOutcome = { o: 'yield' }

  // @ts-expect-error and no terminal failure - that is what leaves an object undeletable
  const _failed: FinalizeOutcome = { tag: 'failed', val: 'nope' }
}

// ...and the two it CAN spell are accepted, or the block above would pass for a
// type nothing satisfies.
export const _theTwoFinalizeOutcomesAreAccepted = (): FinalizeOutcome[] => [
  cleanupDone,
  retry('waiting for the volume to detach'),
]

// ⭐ ***AN EMPTY RETRY REASON IS A COMPILE ERROR.*** Same mechanism `quiesce('')`
// uses: the literal `''` makes the parameter resolve to `never`. The host
// refuses it at runtime too ("finalize asked to RETRY with no reason"); this
// moves the discovery from a live delete that will not complete to the build.
export const _anEmptyRetryReasonIsRefused = () => {
  // @ts-expect-error a retry must say what it is waiting for
  retry('')
}
