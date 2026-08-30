// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Guards for the typed aperture expression algebra.
//
// The expression TEXT these produce is checked against the host's own parser and
// checks by internal/aperture/sdkresume_test.go. What is checked HERE is the
// half the host cannot do: refusing expressions aperture would accept and
// evaluate into nonsense.

import {
  type Expr,
  get,
  listPods,
  now,
  exists,
  length,
  ne,
  ge,
  plus,
  not,
  or,
  and,
  ensure,
  computed,
  create,
  setCondition,
} from './expr'
import { type Resume, quiesce, path, kinds } from './perseid'

const DEP = path.ns('default').deployments('api')
const POD = path.ns('default').pods('web')
const DEP_TEXT = '/apis/apps/v1/namespaces/default/deployments/api'
const POD_TEXT = '/api/v1/namespaces/default/pods/web'

// The two reads every guard below is built from. Named so the SHAPE under test
// is what the line says, rather than a path literal repeated a dozen times.
const podName = () => get(POD, 'metadata.name')
const depReplicas = () => get(DEP, 'spec.replicas')

type Assert<T extends true> = T
type Same<A, B, MSG extends string> = [A] extends [B] ? ([B] extends [A] ? true : MSG) : MSG

// ⭐ ***THE PURITY MIRROR: AN EFFECT CANNOT BE A RESUME.***
//
// This is `CheckPure`'s rule as a type. The host refuses an effect in a resume
// position at park time, which the step cannot see - `quiesce` returns nothing
// by contract - so without this the failure is a refused park the guest never
// learns about.
export const _anEffectIsNotAResume = () => {
  const scaleIt = ensure(DEP, 'spec.replicas', 3)

  // @ts-expect-error an effect PERFORMS; a resume is evaluated on every wake check
  quiesce(scaleIt)

  // @ts-expect-error and it is not a boolean expression either
  const _: Resume = scaleIt

  return scaleIt
}

export type _EffectAndBoolAreDisjoint = Assert<
  Expr<'effect'> extends Expr<'bool'>
    ? 'Expr is not discriminated by its type: an effect is usable as a resume'
    : true
>

// A resume built from the algebra IS a Resume - or the assertion above would
// also pass for a brand nothing satisfies.
export const _aBooleanExpressionIsAResume = (): Resume => ne(depReplicas(), 3)

export type _ResumeIsABooleanExpression = Assert<
  Same<Resume, Expr<'bool'>, 'Resume drifted from Expr<bool>'>
>

// ⭐ ***THE FOUR SHAPES THE HOST EVALUATES INTO NONSENSE.***
//
// Each one parses, passes CheckArity and CheckPure, and EVALUATES WITHOUT ERROR
// against a real aperture - measured. They mean nothing: an int compared to a
// string is never equal, so a park on one either wakes forever or never wakes,
// and the step cannot tell which.
export const _theHostsSilentShapesAreRejectedHere = () => {
  // @ts-expect-error `.length` is for a SET; Get returns one field
  length(podName())
  // @ts-expect-error `.exists` asks whether an observation resolved; Now() is a bare clock read
  exists(now())
  // @ts-expect-error an integer is not a boolean operand
  and(depReplicas(), exists(podName()))
}

// ⚠ ***ONE ARM OF THAT BLOCK WAS RETIRED RATHER THAN CONVERTED, AND SAYING SO
// IS THE POINT.*** `ne(getPod('web'), 3)` - a POD compared to an integer - was a
// type error because `GetPod` returned `Expr<'pod'>`, a type nothing numeric
// accepted. `Get` returns `Expr<'value'>`, which IS an `IntLike`, because a
// field may hold a number and the SDK cannot know which field.
//
// So that comparison typechecks now. It is not silently wrong at RUNTIME: the
// host is three-valued there and answers UNKNOWN for a comparison against a
// non-number, so the failure is a program that never wakes rather than one that
// wakes on a lie. But the SDK no longer catches it, and leaving a
// `@ts-expect-error` that no longer errors would fail the build in a way that
// reads as unrelated to the cause.
//
// ***THIS IS THE PRICE OF ONE SYMBOL READING EVERY KIND***, and it is written
// where the guard used to be so nobody has to re-derive it from an absence.

// …and each vocabulary accepts its own, so the block above cannot pass by
// rejecting everything.
export const _theCorrectShapesAreAccepted = () => {
  const a = exists(podName())
  const b = ne(length(listPods('app=api')), 3)
  const c = ge(now(), 1788011630089)
  const d = ne(length(listPods('app=api')), depReplicas())
  const e = ne(plus(length(listPods('app=api')), 2), depReplicas())

  return or(a, and(b, c), not(d), e)
}

// `.exists` IS valid on Replicas even though it is an integer - measured against
// the host, which resolves the property on a three-valued observation and
// refuses it on the clock. This is the one place the SDK's types are finer than
// aperture's `signatures` table, which gives both the same `TInt`.
export const _existsIsValidOnAnObservedInt = (): Resume => not(exists(depReplicas()))

export function runtimeGuards(): void {
  const eq = (got: string, want: string, what: string) => {
    if (got !== want) throw new Error(`${what}: got ${got}, want ${want}`)
  }

  eq(String(exists(podName())), `Get("${POD_TEXT}", "metadata.name").exists`, 'objectExists')
  eq(String(ne(length(listPods('app=api')), 3)), 'ListPods("app=api").length != 3', 'countNe')
  eq(String(ne(depReplicas(), 3)), `Get("${DEP_TEXT}", "spec.replicas") != 3`, 'fieldNe')
  eq(String(ge(now(), 1788011630089)), 'Now() >= 1788011630089', 'deadline')
  eq(
    String(ne(length(listPods('app=api')), depReplicas())),
    `ListPods("app=api").length != Get("${DEP_TEXT}", "spec.replicas")`,
    'countNeField',
  )
  eq(
    String(ensure(DEP, 'spec.replicas', 3)),
    `Ensure("${DEP_TEXT}", "spec.replicas", 3)`,
    'ensure with a numeric literal',
  )

  // ⭐ ***THE LITERAL/EXPRESSION SPLIT, BOTH WAYS.*** An `Expr` is a plain
  // string at runtime, so nothing can tell `'fast'` from `Get(...) + 1` by
  // inspecting it - which is why a computed value is WRAPPED and a bare one is
  // not. Deciding by the string's SHAPE was tried and thrown away: a ConfigMap
  // value that happens to read `Now()` would be emitted bare and EVALUATED,
  // writing the clock into the field instead of the five characters asked for.
  //
  // The middle case is the one that would have failed under that design, so it
  // is here rather than left implied.
  const cfg = path.ns('default').core('v1', 'configmaps', 'cfg')
  eq(
    String(ensure(cfg, 'data.mode', 'fast')),
    'Ensure("/api/v1/namespaces/default/configmaps/cfg", "data.mode", "fast")',
    'a bare string is QUOTED',
  )
  eq(
    String(ensure(cfg, 'data.mode', 'Now()')),
    'Ensure("/api/v1/namespaces/default/configmaps/cfg", "data.mode", "Now()")',
    'a string that LOOKS like an expression is still quoted',
  )
  eq(
    String(ensure(cfg, 'data.mode', computed(now()))),
    'Ensure("/api/v1/namespaces/default/configmaps/cfg", "data.mode", Now())',
    'a computed value is emitted BARE',
  )
  eq(
    String(setCondition('Ready', 'True', 'AtDesiredScale', '3 of 3')),
    'SetCondition("Ready", "True", "AtDesiredScale", "3 of 3")',
    'setCondition',
  )

  // ⭐ ***A QUOTE ROUND-TRIPS NOW; IT USED TO REFUSE.*** The grammar's token was
  // `"[^"]*"`, so a value containing a quote was unrepresentable and `lit`
  // refused rather than emit something that would not parse. The token accepts
  // JSON escapes now, so the value is representable and is escaped instead.
  //
  // ***THE ASSERTION IS THE ESCAPED TEXT, NOT "IT DID NOT THROW".*** A `lit`
  // that silently dropped the quote would also not throw, and would produce an
  // expression that parses and means something else - which is worse than the
  // refusal it replaced.
  const quoted = String(setCondition('Ready', 'False', 'NotBound', 'policy "x" is absent'))
  const want =
    'SetCondition("Ready", "False", "NotBound", "policy \\"x\\" is absent")'
  if (quoted !== want) {
    throw new Error(`a quoted message was not escaped as the grammar expects:\n  got  ${quoted}\n  want ${want}`)
  }

  // And the host must be able to read it back. internal/aperture decodes with
  // encoding/json, which is the same dialect JSON.stringify emits - that pairing
  // is what makes this safe, and TestSDKResumeExpressions pins it from the Go
  // side against this exact shape.
  if (!quoted.includes('\\"x\\"')) {
    throw new Error(`the escape is not JSON-shaped, so the Go decoder will not match it: ${quoted}`)
  }

  console.log('expr.test.ts: runtime guards pass')
}

// ═══════════════════════════════════════════════════════════════════════════
// ***A HAND-WRITTEN BODY IS NOT ASSIGNABLE*** (engi, 2026-08-30: "deprecate
// structured value").
//
// `StructValue` is branded, so only a kinded builder can produce one - the same
// discipline `ApiPath` uses. The raw two-argument `create(path, {...})` let a
// caller pair a Deployment path with a ConfigMap body, misspell a field, or put
// `data` on a workload; the host refuses some of that and the apiserver the
// rest, at APPLY time, inside an obligation the ledger has already recorded,
// with `create` returning nothing to the guest.
//
// These are `@ts-expect-error`, so the BUILD is the assertion: if the brand ever
// stops refusing, tsgo fails on the unused directive rather than passing
// quietly. That is the only instrument in the tree that can see a type that
// should not exist.
// ═══════════════════════════════════════════════════════════════════════════
export const _aHandWrittenBodyIsRefused = () => {
  const p = path.ns('default').deployments('api')

  // @ts-expect-error a bare object literal is not a StructValue - only a builder makes one
  create({ path: p, body: { spec: { replicas: 3 } } })

  // @ts-expect-error and neither is an empty one
  create({ path: p, body: {} })
}

// ...and the builder's output IS accepted, or the block above would pass for a
// `create` that refuses everything.
export const _aBuiltObjectIsAccepted = (): Expr<'effect'> =>
  create(
    kinds.ns('default').deployment('api', {
      replicas: 3,
      selector: { app: 'api' },
      containers: [{ name: 'api', image: 'nginx:alpine' }],
    }),
  )

// The untyped escape hatch still goes through the facade, so it is paired and
// namespaced even though its body is not typed.
export const _theEscapeHatchIsStillPaired = (): Expr<'effect'> =>
  create(
    kinds
      .ns('default')
      .resource('acme.example', 'v1', 'widgets', 'w1', { spec: { size: 3 } }),
  )
