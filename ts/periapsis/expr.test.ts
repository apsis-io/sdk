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
  getPod,
  listPods,
  replicas,
  now,
  exists,
  length,
  ne,
  ge,
  plus,
  not,
  or,
  and,
  setReplicas,
  setCondition,
} from './expr'
import { type Resume, quiesce, path } from './perseid'

type Assert<T extends true> = T
type Same<A, B, MSG extends string> = [A] extends [B] ? ([B] extends [A] ? true : MSG) : MSG

// ⭐ ***THE PURITY MIRROR: AN EFFECT CANNOT BE A RESUME.***
//
// This is `CheckPure`'s rule as a type. The host refuses an effect in a resume
// position at park time, which the step cannot see - `quiesce` returns nothing
// by contract - so without this the failure is a refused park the guest never
// learns about.
export const _anEffectIsNotAResume = () => {
  const scaleIt = setReplicas(path.ns('default').deployments('api'), 3)

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
export const _aBooleanExpressionIsAResume = (): Resume => ne(replicas('api'), 3)

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
  // @ts-expect-error `.length` is for a SET; GetPod returns one pod
  length(getPod('web'))
  // @ts-expect-error `.exists` asks whether an observation resolved; Now() is a bare clock read
  exists(now())
  // @ts-expect-error a pod is not an integer
  ne(getPod('web'), 3)
  // @ts-expect-error an integer is not a boolean operand
  and(replicas('api'), exists(getPod('web')))
}

// …and each vocabulary accepts its own, so the block above cannot pass by
// rejecting everything.
export const _theCorrectShapesAreAccepted = () => {
  const a = exists(getPod('web'))
  const b = ne(length(listPods('app=api')), 3)
  const c = ge(now(), 1788011630089)
  const d = ne(length(listPods('app=api')), replicas('api'))
  const e = ne(plus(length(listPods('app=api')), 2), replicas('api'))

  return or(a, and(b, c), not(d), e)
}

// `.exists` IS valid on Replicas even though it is an integer - measured against
// the host, which resolves the property on a three-valued observation and
// refuses it on the clock. This is the one place the SDK's types are finer than
// aperture's `signatures` table, which gives both the same `TInt`.
export const _existsIsValidOnAnObservedInt = (): Resume => not(exists(replicas('api')))

export function runtimeGuards(): void {
  const eq = (got: string, want: string, what: string) => {
    if (got !== want) throw new Error(`${what}: got ${got}, want ${want}`)
  }

  eq(String(exists(getPod('web'))), 'GetPod("web").exists', 'exists')
  eq(String(ne(length(listPods('app=api')), 3)), 'ListPods("app=api").length != 3', 'countNe')
  eq(String(ne(replicas('api'), 3)), 'Replicas("api") != 3', 'replicasNe')
  eq(String(ge(now(), 1788011630089)), 'Now() >= 1788011630089', 'deadline')
  eq(
    String(ne(length(listPods('app=api')), replicas('api'))),
    'ListPods("app=api").length != Replicas("api")',
    'countNeReplicas',
  )
  eq(
    String(setReplicas(path.ns('default').deployments('api'), 3)),
    'SetReplicas("/apis/apps/v1/namespaces/default/deployments/api", 3)',
    'setReplicas',
  )
  eq(
    String(setCondition('Ready', 'True', 'AtDesiredScale', '3 of 3')),
    'SetCondition("Ready", "True", "AtDesiredScale", "3 of 3")',
    'setCondition',
  )

  // The grammar has no string escapes, so a quote must REFUSE rather than emit
  // something that will not parse.
  let threw = ''
  try {
    getPod('we"b')
  } catch (e) {
    threw = String(e)
  }
  if (!threw.includes('double quote')) {
    throw new Error(`a quoted literal did not refuse; got: ${threw || '(no throw)'}`)
  }

  console.log('expr.test.ts: runtime guards pass')
}
