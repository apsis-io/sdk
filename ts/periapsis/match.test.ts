// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Guards for the yielding matcher. Same discipline as perseid.test.ts: the
// interesting properties are type-level, so the assertions have to be types.

import { match, matchValue, when } from './match'
import {
  type Obs,
  type Outcome,
  type EffectsOf,
  defineStep,
  reconcile,
  runStep,
  known,
  unknown,
  yieldStep,
  terminate,
  quiesce,
  replicasNe,
  path,
} from './perseid'

type Assert<T extends true> = T
type Same<A, B, MSG extends string> = [A] extends [B] ? ([B] extends [A] ? true : MSG) : MSG
type NotNever<T, MSG extends string> = [T] extends [never] ? MSG : true

const target = path.ns('default').deployments('api')
const observe = reconcile.observe<number>()
const scale = reconcile.scale()

const step = defineStep(function* () {
  const have = yield* observe(target)

  return yield* match(have, 't', {
    absent: () => terminate,
    unknown: () => yieldStep,
    known: function* ({ v }) {
      if (v === 2) return quiesce(replicasNe('api', 2))
      yield* scale({ path: target, n: 2 })

      return yieldStep
    },
  })
})

// ⭐ ***THE POINT OF THE LIBRARY: A GENERATOR ARM'S EFFECTS REACH THE STEP.***
//
// This is what ts-pattern structurally cannot do - its `.with()` handler is an
// ordinary function, so the effects had to be lifted into generator factories
// outside the match. If the delegation ever stopped composing, the step's
// capability set would silently lose `scale` and `derive-wit` would emit a world
// missing an import the program actually needs.
type Effs = EffectsOf<typeof step>

export type _TheMatchPreservesTheEffectUnion = Assert<
  Same<
    Effs['op'],
    'get' | 'scale',
    'a generator arm lost its effects: the step no longer demands what it performs'
  >
>
export type _TheEffectUnionIsNotNever = Assert<
  NotNever<Effs, 'the effect union collapsed to never'>
>

// The result type is read THROUGH the generator arm, not left as the generator.
export type _TheResultLooksThroughAGeneratorArm = Assert<
  Same<
    ReturnType<typeof step> extends Generator<any, infer R, any> ? R : never,
    Outcome,
    'ResultOf did not look through a generator arm'
  >
>

// A missing arm is a compile error AT THE LITERAL, naming the key (TS2741).
export const _aMissingArmIsRejected = () => {
  const have: Obs<number> = unknown

  return match(
    have,
    't',
    // @ts-expect-error 'unknown' is missing - exhaustiveness needs no terminal call
    { absent: () => terminate, known: () => yieldStep },
  )
}

// An arm for a variant that does not exist is an excess property.
export const _anUnknownArmIsRejected = () => {
  const have: Obs<number> = unknown

  return match(have, 't', {
    absent: () => terminate,
    unknown: () => yieldStep,
    known: () => yieldStep,
    // @ts-expect-error `Obs` has no `pending` variant
    pending: () => yieldStep,
  })
}

/** Runtime: the step still behaves, and a foreign tag throws rather than returning undefined. */
export function runtimeGuards(): void {
  const drive = (o: Obs<number>) => {
    const acts: string[] = []
    const outcome = runStep(step, {
      get: () => o,
      scale: ({ n }) => {
        acts.push(`scale=${n}`)
      },
    })

    return { outcome, acts }
  }

  const eq = (got: unknown, want: unknown, what: string) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    }
  }

  eq(drive(known(2)).outcome, { o: 'quiesce', resume: replicasNe('api', 2) }, 'at desired scale')
  eq(drive(known(1)).acts, ['scale=2'], 'below desired scale emits one obligation')
  eq(drive(unknown).outcome, yieldStep, 'unknown yields')
  eq(drive({ t: 'absent' } as Obs<number>).outcome, terminate, 'absent terminates')

  // ***A TAG NO ARM COVERS MUST THROW.*** It is unreachable through the types,
  // and a value crossing a WIT boundary is not bound by the guest's types: a
  // host that grew a fourth `obs` variant sends one. Falling through would
  // return `undefined` as the Outcome, which the host reads as an unknown verb
  // one process away from the cause.
  let threw = ''
  try {
    const foreign = { t: 'pending' } as unknown as Obs<number>
    runStep(defineStep(function* () {
      return yield* match(foreign, 't', {
        absent: () => terminate,
        unknown: () => yieldStep,
        known: () => yieldStep,
      })
    }), { get: () => unknown })
  } catch (e) {
    threw = String(e)
  }
  if (!threw.includes('no arm for')) {
    throw new Error(`a foreign tag did not throw; got: ${threw || '(no throw)'}`)
  }

  console.log('match.test.ts: runtime guards pass')
}

// ---------------------------------------------------------------------------
// EXTENSIONS: guarded arms, and matching outside a generator.

// ⭐ `when()` closes the one thing ts-pattern did better: a VALUE case as a
// clause rather than an `if` buried in the arm. The clause arm still yields.
type KnownObs = Extract<Obs<number>, { t: 'known' }>

const guardedStep = defineStep(function* () {
  const have = yield* observe(target)

  return yield* match(have, 't', {
    absent: () => terminate,
    unknown: () => yieldStep,
    // ***ONE ANNOTATED CLAUSE PARAMETER SUPPLIES `In` FOR THE WHOLE CALL.***
    // It was an explicit `when<In, R>` here until the overloads landed - and
    // that form is what proved the old single-`R` design broken: it needed
    // `Outcome | Generator<…>` written out by hand, because inference could not
    // produce it.
    known: when(
      [(o: KnownObs) => o.v === 2, () => quiesce(replicasNe('api', 2))],
      [(o: KnownObs) => o.v < 0, () => terminate],
      function* () {
        yield* scale({ path: target, n: 2 })

        return yieldStep
      },
    ),
  })
})

// The effects of a CLAUSE arm must still reach the step. This is the property
// the distributive YieldsOf fix exists for: a `when()` arm returns a UNION, and
// the pre-fix inline conditional dropped the generator member of it entirely.
// ⚠ ***`NotNever` ALONE WAS TOO WEAK HERE, AND IT PASSED THROUGHOUT.*** The
// step yields `get` from the observation OUTSIDE the match, so the effect union
// is non-empty even when the clause arm's `scale` is dropped entirely - which is
// precisely the regression this guard names. It stayed green through three
// redesigns of `when()`, two of which really did lose the effects.
//
// The set has to be asserted EXACTLY. `NotNever` is kept beside it because it
// cannot be weakened into vacuity if the op union is ever refactored.
export type _AClauseArmsEffectsReachTheStep = Assert<
  Same<
    EffectsOf<typeof guardedStep>['op'],
    'get' | 'scale',
    'a when() clause lost its effects: the yielding arm is missing from the union'
  >
>
export type _TheClauseStepHasEffectsAtAll = Assert<
  NotNever<
    EffectsOf<typeof guardedStep>,
    'a when() clause lost its effects: YieldsOf stopped distributing over the union'
  >
>

// ⭐ `matchValue` - outside a generator, exhaustive, no yield* .
export const outcomeLabel = (o: Outcome): string =>
  matchValue(o, 'o', {
    yield: () => 'Yield',
    quiesce: ({ resume }) => `Quiesce until ${resume}`,
    terminate: () => 'Terminate',
  })

export type _MatchValueReturnsTheArmsResult = Assert<
  Same<ReturnType<typeof outcomeLabel>, string, 'matchValue did not return the arms result'>
>

// ***AN ARM THAT YIELDS MUST BE REFUSED.*** Called, a generator arm returns an
// iterator nobody advances: the body never runs, nothing errors, and a generator
// object lands where a value belongs.
export const _matchValueRefusesAYieldingArm = () => {
  const o: Outcome = yieldStep

  // @ts-expect-error the `quiesce` arm yields - use match(...) with yield*
  const bad: string = matchValue(o, 'o', {
    yield: () => 'Yield',
    quiesce: function* () {
      yield undefined

      return 'never runs'
    },
    terminate: () => 'Terminate',
  })

  return bad
}

// A missing arm is still caught here, or matchValue would be the hole that
// `match`'s totality closes.
export const _matchValueIsStillExhaustive = () => {
  const o: Outcome = yieldStep

  return matchValue(
    o,
    'o',
    // @ts-expect-error 'terminate' is missing
    { yield: () => 'Yield', quiesce: () => 'Quiesce' },
  )
}

export function extensionRuntimeGuards(): void {
  const eq = (got: unknown, want: unknown, what: string) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    }
  }

  const drive = (o: Obs<number>) => {
    const acts: string[] = []
    const outcome = runStep(guardedStep, {
      get: () => o,
      scale: ({ n }) => {
        acts.push(`scale=${n}`)
      },
    })

    return { outcome, acts }
  }

  // Clause ORDER is meaningful: first match wins.
  eq(drive(known(2)).outcome, { o: 'quiesce', resume: replicasNe('api', 2) }, 'first clause wins')
  eq(drive(known(-1)).outcome, terminate, 'second clause')
  eq(drive(known(1)).acts, ['scale=2'], 'fallback clause yields')

  eq(outcomeLabel(yieldStep), 'Yield', 'matchValue yield')
  eq(outcomeLabel(terminate), 'Terminate', 'matchValue terminate')
  eq(outcomeLabel(quiesce(replicasNe('api', 2))), `Quiesce until ${replicasNe('api', 2)}`, 'matchValue quiesce')

  console.log('match.test.ts: extension runtime guards pass')
}
