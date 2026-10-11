/// <reference path="../../../../sdk/ts/periapsis/types/wit.d.ts" />
/// <reference path="../../../../sdk/ts/periapsis/types/periapsis.d.ts" />

// ⛔ ***THOSE TWO REFERENCES ARE LOAD-BEARING AND THE GATE DID NOT CATCH THEIR
// ABSENCE UNTIL SOMETHING IMPORTED `exec.ts`.*** The SDK declares the `wit`
// global and `periapsis:host/exec@0.1.0` in its own `types/`, but this project's
// tsconfig `include` covers only `src/**` and `tools/**`, so nothing pulled them
// in. `execcheck-main.ts` is the first file here to import
// `@apsis-io/periapsis-sdk/exec`, and the moment it did, `tsgo` reported three
// errors INSIDE THE SDK - "Cannot find name 'wit'" - for a file that had been
// correct and shipping the whole time.
//
// Referenced rather than re-declared: this file's own header warns it is already
// a second copy of a WIT contract that nothing keeps in sync, and a third copy of
// the exec binding would be the same debt at a seam that spawns processes.
//
// ⚠ js-dwarf-shell hit this first and solved it the other way - a local
// `declare const wit` in its own `src/wit.d.ts` - which is why the gap survived:
// the one existing consumer had patched around it privately, so the SDK looked
// fine from the outside.

// Ambient types for the three WIT interfaces `wit/world.wit` imports.
//
// ***WHY THIS FILE EXISTS AT ALL: THIS IS THE ONLY PERSEID EXAMPLE THAT
// TYPE-CHECKS.*** `perseid-component` has no tsconfig and no `tsc` step - dwarf
// binds its imports at componentize time and nothing checks the shapes before
// then. `build.sh` here runs `tsgo --noEmit` as step 1, so the host boundary can
// be checked instead of assumed, and that is worth keeping.
//
// Hand-written rather than generated, and the risk is stated rather than hidden:
// ***these declarations are a second copy of `wit/deps/reconcile/reconcile.wit`
// and nothing enforces that they agree.*** They are transcribed from it
// directly - `get: func(path: string) -> obs`, `scale: func(path: string,
// replicas: s32)`, `set: func(c: condition)` - and if that file moves, this one
// goes stale silently. The mitigation is that a drifted shape fails at
// `dwarf componentize` rather than in a pod, because dwarf reads the real WIT.

// ⛔ ***THE READS ARE `async func` AND THEREFORE RETURN PROMISES. THE EFFECTS ARE
// NOT.*** This file is hand-maintained, so it drifted the moment the contract
// moved: `observe.get/count/now` and `observe-cluster.get` became `async func` in
// 174167826 and these declarations still said `Obs`. A program written against
// the old shape reads `.tag` off a PROMISE, gets `undefined`, and every
// observation silently becomes `unknown` - a step that yields forever while
// looking healthy, which is this codebase's most-repeated failure.
//
// The split is not arbitrary: a read is a ROUND TRIP and an effect is DECLARED
// (it returns nothing and rides back with the outcome), so only the reads need
// to suspend. When adding a function here, check `wit/reconcile/reconcile.wit`
// for `async func` rather than copying the neighbour.
declare module 'perseid:reconcile/observe@0.1.0' {
  // WIT `variant obs { known(string), absent, unknown }`. dwarf binds a variant
  // to `{ tag, val }` - NOT the SDK's `{ t, v }`, which is a different type in a
  // different vocabulary. main.ts converts between them explicitly.
  export type Obs =
    | { readonly tag: 'known'; readonly val: string }
    | { readonly tag: 'absent' }
    | { readonly tag: 'unknown' }

  /** Read one object by path. Never throws: failure is `unknown`. */
  export function get(path: string): Promise<Obs>
  /** Count members of a collection by LABEL SELECTOR. Never throws. */
  export function count(query: string): Promise<Obs>
  /** u64 - a bigint across the boundary, not a number. */
  export function now(): Promise<bigint>
}

declare module 'perseid:reconcile/workloads@0.1.0' {
  /** `scale: func(path: string, replicas: s32)` - absolute, not a delta. */
  export function scale(path: string, replicas: number): void
}

declare module 'perseid:reconcile/ensure@0.1.0' {
  // ***THE VARIANT LOWERS TO `{ tag, val }`, AND `s64` LOWERS TO `bigint`.***
  // Both are jco conventions and both are places a wrong shape is silent: the
  // SDK's own `EnsureValue` is `{ text } | { num }`, so the handler in
  // janitor-main.ts CONVERTS rather than forwards. Same class of trap as
  // `status`'s lowercase enum below - a payload that crosses the boundary
  // structurally intact and semantically wrong.
  export type Value =
    | { tag: 'text'; val: string }
    | { tag: 'num'; val: bigint }
    | { tag: 'flag'; val: boolean }
  /** `ensure: func(path: string, field: string, value: value)` */
  export function ensure(path: string, field: string, value: Value): void
}

declare module 'perseid:reconcile/delete@0.1.0' {
  /** `delete: func(path: string)` - idempotent; the applier treats NotFound as success. */
  function del(path: string): void
  export { del as delete }
}

declare module 'perseid:reconcile/create@0.1.0' {
  import type { Value } from 'perseid:reconcile/ensure@0.1.0'
  /** `record field { path: string, value: value }` - a DOTTED path. */
  export type Field = { path: string; value: Value }
  /** `create: func(path: string, body: list<field>)` */
  export function create(path: string, body: Field[]): void
}

declare module 'perseid:reconcile/status@0.1.0' {
  // ***LOWERCASE, AND THE SDK'S IS NOT.*** WIT `enum condition-status { true,
  // false, unknown }` binds to these strings; the SDK's `ConditionStatus` is
  // `'True' | 'False' | 'Unknown'` because it copies Kubernetes' spelling. The
  // two are one `toLowerCase()` apart and a cast between them would compile.
  //
  // Declaring the host's spelling honestly is what makes that conversion a
  // COMPILE ERROR if it is skipped, which is the entire value of this file.
  // The resume expression cost this repo exactly one such mismatch already: a
  // payload that decoded with `err == nil` and a zero discriminant.
  export type ConditionStatus = 'true' | 'false' | 'unknown'

  /** WIT `record condition { %type, status, reason, message }`. */
  export type Condition = {
    readonly type: string
    readonly status: ConditionStatus
    readonly reason: string
    readonly message: string
  }

  /** `set: func(c: condition)` - `type` is an IDENTITY; a second set replaces. */
  export function status(c: Condition): void
}

// The CLUSTER-SCOPED read, added 2026-08-29. Same `obs` shape as `observe` -
// the WIT does `use observe.{obs}` rather than declaring a second variant, which
// is also why a world importing this one imports `observe` too.
// Which arms of THIS program's own resume held at the wake that started this
// pass, as indices into the disjunction it parked on.
//
// ***SYNC, FOR THE SAME REASON `carry` IS.*** It is answered from a value already
// sitting on the step's store - handed over with the request that started the
// pass - so there is nothing to await and the WIT says `func`, not `async func`.
//
// ⚠ ***AN EMPTY LIST IS THE COMMON ANSWER AND IS NOT AN ERROR.*** A backstop tick
// held nothing, and a host that predates the interface exports nothing at all. A
// program that treats empty as a failure has misread a hint as a fact.
declare module 'perseid:reconcile/woke@0.1.0' {
  /**
   * Which arms of the program's own resume held, each as its own SOURCE TEXT.
   * Never throws; empty is ordinary.
   *
   * ⚠ ***THIS DECLARED `number[]` UNTIL 2026-09-08 AND HAD BEEN WRONG SINCE THE
   * TEXT CUTOVER.*** Exactly the silent drift this file's header warns about: a
   * hand-written second copy of a contract that nothing enforces. It went
   * unnoticed because no program here binds `held` through these declarations -
   * `sentinel-main.ts` is the only caller and it passes the value straight
   * through, so nothing ever indexed the array and got a number.
   */
  export function held(): string[]

  /** Why this pass is running, coarsely - see `Cause` in the SDK. */
  export function cause(): 'condition' | 'backstop' | 'unknown' | 'first-pass'
}

declare module 'perseid:reconcile/observe-cluster@0.1.0' {
  export type Obs =
    | { readonly tag: 'known'; readonly val: string }
    | { readonly tag: 'absent' }
    | { readonly tag: 'unknown' }

  /** Read one cluster-scoped object by full apiserver path. Never throws. */
  export function get(path: string): Promise<Obs>
}

// A program's OWN memory, read back (the carry's input half, added 2026-09-05).
//
// ***SYNC, UNLIKE EVERY OTHER READ HERE, AND THAT IS THE CONTRACT RATHER THAN AN
// OVERSIGHT.*** `observe.get` is `async func` because radiant answers it over
// the converse stream - the host genuinely has to go and ask. This one is
// answered from a string already sitting on the step's store, handed over with
// the request that started the pass, so there is nothing to await and the WIT
// says `func` not `async func`.
//
// There is no `set`: a step publishes its NEXT carry on its outcome, so that a
// pass which changes its memory and then fails cannot leave the program
// remembering something no pass concluded.
declare module 'perseid:reconcile/carry@0.1.0' {
  /** What this program remembered last pass. `''` means nothing remembered. */
  export function carry(): string
}
