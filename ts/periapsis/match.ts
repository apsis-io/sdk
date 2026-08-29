// Exhaustive matching over a tagged union, for code that YIELDS.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***WHY THIS EXISTS WHEN ts-pattern IS EXCELLENT*** (engi, 2026-08-29: adopt
// ts-pattern, then "can you write better ts-pattern? for ts 7.0").
//
// ts-pattern is a better GENERAL matcher than this will ever be: deep patterns,
// `P.select`, guards, unions, array and map patterns. This is not an attempt to
// beat it at that. It solves one thing ts-pattern structurally cannot, and the
// one thing happens to be what a Perseid step is made of.
//
// # THE PROBLEM: A `.with()` HANDLER CANNOT `yield*`
//
// `.with(pattern, handler)` takes an ORDINARY function. A `yield*` inside one is
// a syntax error, so a step - whose whole purpose is to yield effects - cannot
// put its effects in the arms. Measured in the port of `src/sugar.ts`, the two
// available workarounds both cost something:
//
//	compute a plain "plan" value, act on it after     an `if` chain immediately
//	                                                  after an exhaustive match
//	every arm returns a GENERATOR, then `yield*`      three one-line generator
//	                                                  declarations + a `done()`
//	                                                  lift, purely as ceremony
//
// ***HERE THE MATCHER IS ITSELF A GENERATOR AND DELEGATES INTO THE ARM.*** An
// arm may be an ordinary function or a generator function; a generator arm is
// `yield*`-ed, so its effects belong to the caller's step and the yield union
// composes exactly as a hand-written `switch` would. No lift, no factories.
//
// # EXHAUSTIVENESS WITHOUT A TERMINAL CALL
//
// `arms` is a MAPPED TYPE over the tag's variants, so a missing case is a
// missing property - reported at the object literal, naming the key. There is no
// `.exhaustive()` to forget, which matters because forgetting it is silent:
// `.otherwise()` and a bare unterminated chain both type-check.
//
// This is the same mechanism as `Handler<E>` in perseid.ts, which is already the
// thing that makes "the runner handles every capability" structural rather than
// a review item. One idea, used twice.
//
// # WHAT IT DELIBERATELY DOES NOT DO
//
// No value patterns, no nesting, no selection. `{ t: 'known', v: want }` is a
// ts-pattern arm and here it is an `if` inside the `known` arm. That is a real
// loss and it is the price of the tag being the only thing dispatched on -
// which is also what keeps the type surface O(variants) instead of the deep
// recursive exclusion ts-pattern computes.
//
// ***USE ts-pattern FOR MATCHING SHAPES. USE THIS WHEN THE ARMS MUST YIELD.***
// ═══════════════════════════════════════════════════════════════════════════

/** A tagged union member: an object carrying a string discriminant at `K`. */
export type Tagged<K extends string> = { readonly [P in K]: string }

/** The member of `T` whose tag `K` is `V`. */
export type Variant<T extends Tagged<K>, K extends string, V extends string> = Extract<
  T,
  { readonly [P in K]: V }
>

/**
 * Every variant of `T`, exhaustively.
 *
 * A missing key fails at the object literal and NAMES it - `TS2741: Property
 * 'unknown' is missing … but required in type 'Arms<Obs<number>, "t">'`. No
 * terminal call is involved, so there is nothing to forget.
 *
 * ⚠ ***AN EXTRA ARM IS NOT CAUGHT HERE, AND THE FIRST VERSION OF THIS COMMENT
 * CLAIMED IT WAS.*** "An unknown key is an excess property" is false: `A` is
 * INFERRED from the arms literal, and excess-property checking applies when a
 * literal is assigned to a KNOWN type, not when it is the thing being inferred
 * from. An arm named `pending` on a three-variant union type-checked and was
 * dead code; the `@ts-expect-error` written to assert otherwise sat unused,
 * which is what surfaced it.
 *
 * Exactness comes from `match`'s self-referential constraint
 * (`A extends Arms<T,K> & Record<Exclude<keyof A, T[K]>, never>`), not from
 * this type. A typo'd arm was already caught by the OTHER direction - misspell
 * `unknown` and the required key goes missing - so the gap only ever admitted a
 * genuinely surplus arm.
 *
 * ***THE ARM RETURN IS `unknown`, AND THAT IS AN INFERENCE DECISION RATHER THAN
 * LAXITY.*** The first version wrote it as `R | Generator<E, R, any>` so the
 * effect and result types were parameters of the constraint. It compiled and E
 * INFERRED AS `unknown`: a type variable buried inside one member of a union in
 * a return position is a weak inference site, so nothing pinned it and every
 * yielded effect was lost - the step then failed to satisfy `Step<AnyEffect, …>`
 * with an error about `IteratorYieldResult<unknown>`, several frames from the
 * cause.
 *
 * So the constraint enforces TOTALITY only, and `match` reads the effects and
 * the result back OUT of the arms object with `YieldsOf`/`ResultOf`. Same shape
 * as `EffectsOf` in perseid.ts: constrain loosely, infer precisely.
 */
export type Arms<T extends Tagged<K>, K extends string> = {
  readonly [V in T[K]]: (value: Variant<T, K, V>) => unknown
}

type Returned<F> = F extends (value: any) => infer R ? R : never

// ***THESE TWO DISTRIBUTE, AND THE FIRST VERSION DID NOT.*** They were written
// as `Returned<A[V]> extends Generator<…>` inline, which is a type EXPRESSION in
// the check position - conditional types only distribute over a NAKED type
// parameter. That is exactly right while every arm returns one thing, and wrong
// the moment an arm returns a union: `Outcome | Generator<ScaleEff, Outcome>` is
// not assignable to `Generator<…>` as a whole, so the effects were dropped and
// the result came back as the raw union including the un-run generator.
//
// An arm returns a union as soon as it has an `if` in it - which is precisely
// what `when()` below builds - so this had to be fixed before guarded arms could
// work at all.
type YieldOfResult<R> = R extends Generator<infer E, any, any> ? E : never
type ValueOfResult<R> = R extends Generator<any, infer X, any> ? X : R

/** The union of effects yielded by any generator arm. Pure arms contribute nothing. */
export type YieldsOf<A> = { [V in keyof A]: YieldOfResult<Returned<A[V]>> }[keyof A]

/** The union of results, looking THROUGH a generator arm to what it returns. */
export type ResultOf<A> = { [V in keyof A]: ValueOfResult<Returned<A[V]>> }[keyof A]

function isGenerator(x: unknown): x is Generator<unknown, unknown, unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { next?: unknown }).next === 'function' &&
    typeof (x as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  )
}

/**
 * Match `value` on its `tag`, running the corresponding arm.
 *
 *     return yield* match(have, 't', {
 *       absent:  () => terminate,
 *       unknown: () => yieldStep,
 *       known:   function* ({ v }) {
 *         if (v === want) return quiesce(replicasNe('api', want))
 *         yield* scale({ path: deployment, n: want })
 *         return yieldStep
 *       },
 *     })
 *
 * ***IT IS A GENERATOR, SO CALL IT WITH `yield*` EVEN WHEN NO ARM YIELDS.***
 * That is the one ergonomic cost, and it is deliberate: a matcher that returned
 * a value when no arm yielded and a generator otherwise would have a type that
 * depends on which arms you wrote, and the failure - forgetting `yield*` on the
 * day an arm starts yielding - would be silent.
 *
 * The tag is explicit rather than guessed. `Obs` tags on `t` and `Outcome` on
 * `o`; a default would be right for one of them and quietly wrong for the other.
 */
export function* match<
  T extends Tagged<K>,
  K extends string,
  A extends Arms<T, K> & Record<Exclude<keyof A, T[K]>, never>,
>(
  value: T,
  tag: K,
  arms: A,
): Generator<YieldsOf<A>, ResultOf<A>, any> {
  // ***THE ONE UNSOUND-LOOKING CAST, AND WHY IT IS SOUND.*** The arm was selected
  // BY `value[tag]`, so the value IS the variant that arm accepts - but the
  // checker cannot follow that through an index signature, and sees only a
  // contravariant parameter mismatch (`T` vs `Extract<T, …>`). The narrowing is
  // real and untrackable, which is exactly what a cast is for. It goes through
  // `unknown` because the direct form is refused, and it is confined to this
  // line: every caller-facing type above is inferred, not asserted.
  const arm = arms[value[tag] as T[K]] as unknown as ((value: T) => unknown) | undefined

  if (arm === undefined) {
    // ***UNREACHABLE THROUGH THE TYPES, AND CHECKED ANYWAY.*** `Arms` is total,
    // so a missing arm cannot compile - but the VALUE arrives from a host across
    // a WIT boundary, and a variant the guest does not know about decodes to a
    // tag no arm covers. Throwing names it; falling through would return
    // `undefined` as the step's Outcome, which the host reads as an unknown verb
    // one process away from the cause.
    throw new Error(
      `match: no arm for ${tag}=${JSON.stringify(value[tag])}. ` +
        `Known arms: ${Object.keys(arms).join(', ')}. A value carrying a tag the ` +
        `program was not compiled against usually means the host and the guest ` +
        `disagree about the variant.`,
    )
  }

  const out: unknown = arm(value)

  // `isGenerator` can only report THAT it is a generator, never of what - the
  // yield type is erased at runtime. The assertion restores what the signature
  // already computed from the arms.
  return isGenerator(out)
    ? yield* (out as Generator<YieldsOf<A>, ResultOf<A>, any>)
    : (out as ResultOf<A>)
}

// ---------------------------------------------------------------------------
// EXTENSIONS (engi, 2026-08-29: "can you extend our matcher").
//
// Two axes, each closing something the first version could not do at all.

/**
 * One guarded clause: a test, and what to do when it passes.
 *
 * The value is already narrowed to its variant by the time a clause sees it,
 * because clauses live INSIDE an arm.
 */
export type Clause<In, R> = readonly [test: (value: In) => boolean, arm: (value: In) => R]

/**
 * Build an arm from ordered clauses and a required default.
 *
 *     known: when(
 *       [({ v }) => v === want, () => quiesce(replicasNe(workload, want))],
 *       [({ v }) => v < 0,      () => terminate],
 *       function* ({ v }) { yield* scale({ path, n: want }); return yieldStep },
 *     )
 *
 * ***THIS CLOSES THE ONE THING ts-pattern DID BETTER***, which this file
 * recorded as a real loss rather than a wash: `{ t: 'known', v: want }` was an
 * ARM there and an `if` here. Now it is a clause.
 *
 * ***THE DEFAULT IS A POSITIONAL ARGUMENT, NOT AN OPTION, SO TOTALITY SURVIVES.***
 * The whole reason this matcher has no `.exhaustive()` is that a terminal call
 * can be forgotten; a guarded arm with optional clauses would reintroduce
 * exactly that hole one level down - every clause could fail and the arm would
 * return `undefined` as an Outcome. The variadic tuple `[...Clause[], default]`
 * makes the compiler require it.
 *
 * Clauses are tried in order and the first match wins, so order is meaningful -
 * the same as a `switch` with fallthrough removed, and the same as ts-pattern.
 *
 * A clause arm may be a generator; its effects join the step exactly as a plain
 * arm's do, because `match` looks THROUGH the union this returns.
 */
// ***OVERLOADS RATHER THAN A VARIADIC TUPLE, AND BOTH EARLIER DESIGNS FAILED
// FOR DIFFERENT REASONS.*** Recorded because each looked correct and the symptom
// was several frames away:
//
//	when<In, R>(...args: [...Clause<In,R>[], (v: In) => R])
//	  ONE `R` for every arm. Inferred as `Outcome` from the first clause, then
//	  REFUSED the generator fallback - so an arm could hold pure clauses or a
//	  yielding one, never both, which is the entire use case.
//
//	when<In, const A extends readonly [...]>(...args: A)
//	  `In` appears ONLY inside `A`'s constraint, which is not an inference site,
//	  so it resolved to `unknown` and every clause parameter with it. The `const`
//	  modifier did not help: the tuple was inferred literally and `In` still had
//	  nothing to infer from.
//
// Overloads give each arm its own return type variable AND put `In` in a real
// parameter position, so one annotated clause supplies it for the whole call.
// The cap is four clauses; nest a `when` inside a fallback for more.

export function when<In, R>(fallback: (v: In) => R): (value: In) => R
export function when<In, R1, R2>(
  c1: readonly [(v: In) => boolean, (v: In) => R1],
  fallback: (v: In) => R2,
): (value: In) => R1 | R2
export function when<In, R1, R2, R3>(
  c1: readonly [(v: In) => boolean, (v: In) => R1],
  c2: readonly [(v: In) => boolean, (v: In) => R2],
  fallback: (v: In) => R3,
): (value: In) => R1 | R2 | R3
export function when<In, R1, R2, R3, R4>(
  c1: readonly [(v: In) => boolean, (v: In) => R1],
  c2: readonly [(v: In) => boolean, (v: In) => R2],
  c3: readonly [(v: In) => boolean, (v: In) => R3],
  fallback: (v: In) => R4,
): (value: In) => R1 | R2 | R3 | R4
export function when<In, R1, R2, R3, R4, R5>(
  c1: readonly [(v: In) => boolean, (v: In) => R1],
  c2: readonly [(v: In) => boolean, (v: In) => R2],
  c3: readonly [(v: In) => boolean, (v: In) => R3],
  c4: readonly [(v: In) => boolean, (v: In) => R4],
  fallback: (v: In) => R5,
): (value: In) => R1 | R2 | R3 | R4 | R5
export function when(...args: unknown[]): (value: unknown) => unknown {
  const clauses = args.slice(0, -1) as Clause<unknown, unknown>[]
  const fallback = args[args.length - 1] as (value: unknown) => unknown

  return (value: unknown) => {
    for (const [test, arm] of clauses) {
      if (test(value)) return arm(value)
    }

    return fallback(value)
  }
}

/**
 * The error surfaced when `matchValue` is handed an arm that yields.
 *
 * ⛔ ***THIS WAS `never` AND THAT MADE THE CHECK VACUOUS.*** `never` is assignable
 * to EVERY type, so the "error" satisfied `const label: string = matchValue(…)`
 * and nothing was reported - the refusal existed in the signature and could not
 * fire. Caught only because the `@ts-expect-error` asserting the refusal was
 * itself reported as UNUSED.
 *
 * That is the same defect as the `Handler<NoInfer<E>>` bug this SDK was fixing
 * an hour earlier - *a `never` that silently satisfies its target* - reproduced
 * in the code written to prevent a different silent failure. A bare `never` is
 * not a compile error; it is the ABSENCE of one.
 *
 * An object type is not assignable to the string/number/Outcome a caller
 * actually wants, so the mismatch is reported, and the property name carries
 * the remedy into the message.
 */
export type ERROR_an_arm_yields_use_match_and_yield_star_instead = {
  readonly __error: 'an arm returned a generator: use match(...) with yield* instead'
}

/**
 * Match on a tag OUTSIDE a generator, when no arm yields.
 *
 *     const label = matchValue(outcome, 'o', {
 *       yield:     () => 'Yield',
 *       quiesce:   ({ resume }) => `Quiesce until ${resume}`,
 *       terminate: () => 'Terminate',
 *     })
 *
 * ***WITHOUT THIS THE LIBRARY ONLY WORKED INSIDE A STEP.*** `match` is a
 * generator, so it must be `yield*`-ed - which is correct where effects are
 * possible and unusable everywhere else. Host-side code maps an `Outcome` to a
 * label, a status string, a log line; none of that is a generator, and the
 * alternative was a record lookup with no exhaustiveness at all (there is one in
 * `examples/wasm/perseid-ts/src/main.ts`: `({yield: …, quiesce: …})[o.o]`).
 *
 * ***AN ARM THAT YIELDS IS REFUSED RATHER THAN SILENTLY RETURNED UNRUN.*** A
 * generator function passed here would be CALLED, produce an iterator nobody
 * advances, and the arm's body would never execute - no error, no effect, and a
 * generator object where an Outcome belongs. The return type collapses to
 * `ERROR_an_arm_yields_use_match_and_yield_star_instead` instead, which names
 * the remedy at the call site.
 */
export function matchValue<
  T extends Tagged<K>,
  K extends string,
  A extends Arms<T, K> & Record<Exclude<keyof A, T[K]>, never>,
>(
  value: T,
  tag: K,
  arms: A,
): [YieldsOf<A>] extends [never] ? ResultOf<A> : ERROR_an_arm_yields_use_match_and_yield_star_instead {
  const arm = arms[value[tag] as T[K]] as unknown as ((value: T) => unknown) | undefined

  if (arm === undefined) {
    throw new Error(
      `matchValue: no arm for ${tag}=${JSON.stringify(value[tag])}. ` +
        `Known arms: ${Object.keys(arms).join(', ')}. A value carrying a tag the ` +
        `program was not compiled against usually means the host and the guest ` +
        `disagree about the variant.`,
    )
  }

  const out: unknown = arm(value)

  if (isGenerator(out)) {
    // Unreachable through the types - the signature refuses a yielding arm - and
    // checked because an untyped caller (JS, or a cast) reaches here, and the
    // silent failure is the expensive one: an un-run generator returned where a
    // value belongs.
    throw new Error(
      `matchValue: the arm for ${tag}=${JSON.stringify(value[tag])} returned a generator. ` +
        `Its body never ran. Use match(...) with yield* for arms that yield.`,
    )
  }

  return out as never
}
