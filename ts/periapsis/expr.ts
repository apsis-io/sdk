// The aperture expression language, typed.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***aperture DOES NOT TYPE-CHECK EXPRESSIONS, AND THAT IS MEASURED RATHER THAN
// ASSUMED*** (engi, 2026-08-29: "and types and effects?").
//
// aperture gained a `signatures` table with `Type`s, `CheckArity` and
// `CheckPure` the same day. It is easy to read that as "expressions are
// type-checked now". They are not: the table types PARAMETERS and results for
// arity and addressing, and nothing walks an expression comparing operand types.
// Probed against the host's own `Parse` + `CheckArity` + `CheckPure` + `Eval`:
//
//	ListPods("app=x").exists          static ok    eval REJECTS (no such property)
//	Now().length                      static ok    eval REJECTS
//	ListPods(3).length != 1           static ok    eval REJECTS (param type)
//	GetPod("web").length              static ok    eval ACCEPTS      ← nonsense
//	GetPod("web") != 3                static ok    eval ACCEPTS      ← nonsense
//	Replicas("api") != "three"        static ok    eval ACCEPTS      ← nonsense
//	Replicas("api") != 3 && Replicas("api")   static ok  eval ACCEPTS ← nonsense
//
// ***THE LAST FOUR ARE THE REASON THIS FILE EXISTS.*** They evaluate without
// error and mean nothing: an int compared to a string is never equal, so a park
// on it either wakes immediately forever or never wakes at all - and `quiesce`
// returns nothing by contract, so the step cannot see which. That is the exact
// state ADR-0075 calls out, a program correctly asleep on a condition nobody
// will satisfy, reached by a typo rather than by a design error.
//
// So this builder is deliberately STRICTER THAN THE HOST. Every rule below is
// one the host either enforces at eval or cannot express at all; none of them
// contradicts it. `internal/aperture/sdkresume_test.go` runs what this produces
// through the host's real checks, so "stricter" stays "stricter and compatible"
// rather than "stricter and diverged".
//
// # THE TYPES ARE THE MEASURED DOMAIN, NOT THE SIGNATURE TABLE'S
//
// `signatures` gives `Replicas` and `Now` the same result type, `TInt`. At
// runtime they differ in a way that matters:
//
//	GetPod("web").exists       ✓    a three-valued observation
//	Replicas("api").exists     ✓    also three-valued, despite being "TInt"
//	Now().exists               ✗    a bare float64 - the clock cannot be absent
//
// `.exists` asks "did this observation resolve", so it belongs to things that
// are OBSERVED. `Now()` is not observed, it is read. Hence `observed-int` here:
// it is not a type aperture names, it is the distinction aperture's runtime
// makes, given a name so the SDK can enforce it.
// ═══════════════════════════════════════════════════════════════════════════

import type { ApiPath, LabelSelector, PodName, WorkloadName } from './perseid'

declare const exprOf: unique symbol

/**
 * The types an aperture expression can have.
 *
 * `effect` is the one that carries a safety property rather than a shape: an
 * expression of that type PERFORMS something, so it belongs in an emit position
 * and never in a resume. That is `CheckPure`'s rule, mirrored as a type.
 */
export type ApType = 'bool' | 'int' | 'observed-int' | 'string' | 'pod' | 'pods' | 'effect'

/**
 * An aperture expression of type `T`.
 *
 * A branded string: it IS the expression text, so it crosses the wire as itself,
 * and it cannot be produced by writing one - the same canonical-form discipline
 * `ApiPath` uses, for the same reason. A hand-written expression is exactly what
 * the four nonsense shapes above look like.
 *
 * `Kind` is part of the brand rather than a separate marker so two expression
 * types are DISJOINT: without it, `Expr<'effect'>` and `Expr<'bool'>` are the
 * same type and the purity mirror silently disappears.
 */
export type Expr<T extends ApType> = string & { readonly [exprOf]: T }

/** Anything usable where an integer goes: a literal, a clock read, an observation. */
export type IntLike = Expr<'int'> | Expr<'observed-int'> | number

/** Anything `.exists` can be asked of - i.e. anything actually OBSERVED. */
export type Observed = Expr<'pod'> | Expr<'observed-int'>

const mk = <T extends ApType>(text: string): Expr<T> => text as Expr<T>

/**
 * Quote a string literal for the grammar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***THIS REFUSED A DOUBLE QUOTE UNTIL 2026-08-29, AND THE REFUSAL WAS RIGHT
 * ABOUT A LANGUAGE THAT HAS SINCE CHANGED.*** The grammar's string token was
 * `"[^"]*"` - no escapes - so a value containing a quote could not be
 * represented, and emitting one would have produced an expression that does not
 * parse. Refusing was the correct response to that.
 *
 * The token now accepts JSON escapes, so the value IS representable and this
 * escapes rather than refuses. `JSON.stringify` is exactly the right tool: the
 * grammar decodes with `encoding/json` on the host side, so producer and
 * consumer are the same dialect by construction rather than by agreement.
 *
 * ***WHY THE LIMIT MATTERED ENOUGH TO CHANGE THE LANGUAGE.*** `cmd/trail`
 * rendered a condition's message with JSON escaping and aperture could not parse
 * it, so the write boundary refused the obligation - silently, because an action
 * returns nothing to the guest by contract. Every condition apogeos' governance
 * monitor declared quoted a policy name, so every one was dropped for hours with
 * no error on either side.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function lit(s: string): string {
  return JSON.stringify(s)
}

const intText = (v: IntLike): string => (typeof v === 'number' ? String(Math.trunc(v)) : v)

// ---------------------------------------------------------------------------
// Symbols. One per entry in aperture's `signatures` table.

/** `GetPod(name) -> pod`. A NAME, resolved in the grant's namespace. */
export const getPod = (name: PodName): Expr<'pod'> => mk(`GetPod(${lit(name)})`)

/** `ListPods(selector) -> pods`. A LABEL SELECTOR, never a path. */
export const listPods = (selector: LabelSelector): Expr<'pods'> =>
  mk(`ListPods(${lit(selector)})`)

/** `Replicas(name) -> int`, and OBSERVED, so `exists()` may be asked of it. */
export const replicas = (name: WorkloadName): Expr<'observed-int'> =>
  mk(`Replicas(${lit(name)})`)

/**
 * `Now() -> int`. EPOCH MILLISECONDS, UTC.
 *
 * NOT observed: the clock cannot be absent, and `Now().exists` is refused by the
 * host at evaluation. It is typed `int` rather than `observed-int` for exactly
 * that reason.
 */
export const now = (): Expr<'int'> => mk('Now()')

// ---------------------------------------------------------------------------
// Properties.

/** `.exists` - did this observation RESOLVE. Only for things that are observed. */
export const exists = (o: Observed): Expr<'bool'> => mk(`${o}.exists`)

/** `.length` - how many. Only for a set. */
export const length = (p: Expr<'pods'>): Expr<'int'> => mk(`${p}.length`)

// ---------------------------------------------------------------------------
// Comparison. Both operands must be integers - which is the rule the host does
// NOT enforce, and the one that produces a silently meaningless park.

const cmp =
  (op: string) =>
  (a: IntLike, b: IntLike): Expr<'bool'> =>
    mk(`${intText(a)} ${op} ${intText(b)}`)

export const ne = cmp('!=')
export const eq = cmp('==')
export const lt = cmp('<')
export const le = cmp('<=')
export const gt = cmp('>')
export const ge = cmp('>=')

// ---------------------------------------------------------------------------
// Arithmetic.
//
// ***THERE IS NO DIVISION, AND ITS ABSENCE IS A DECISION.*** Divide-by-zero has
// no answer in a three-valued language that is not either a lie or a new failure
// mode, so the grammar has `+ - *` and stops. Nothing here can produce `/`.

const arith =
  (op: string) =>
  (a: IntLike, b: IntLike): Expr<'int'> =>
    mk(`${intText(a)} ${op} ${intText(b)}`)

export const plus = arith('+')
export const minus = arith('-')
export const times = arith('*')

// ---------------------------------------------------------------------------
// Boolean operators. Operands must be BOOLEAN - the host will happily evaluate
// `Replicas("api") != 3 && Replicas("api")`, which is measured above and means
// nothing.

export const not = (b: Expr<'bool'>): Expr<'bool'> => mk(`!${b}`)

const paren = (b: Expr<'bool'>): string => `(${b})`

/** Wake if ANY holds. */
export const or = (...bs: Expr<'bool'>[]): Expr<'bool'> => mk(bs.map(paren).join(' || '))

/**
 * Wake only if ALL hold.
 *
 * ⚠ A conjunction of pure time bounds has nothing to watch, so it degrades to
 * polling. If you want a guaranteed wake, put the deadline in an `or`.
 */
export const and = (...bs: Expr<'bool'>[]): Expr<'bool'> => mk(bs.map(paren).join(' && '))

// ---------------------------------------------------------------------------
// EFFECTS.
//
// Effects are ORDINARY EXPRESSIONS as of 2026-08-29 - not opcodes beside the
// language. One vocabulary for reads and writes is what made the wake index
// possible: a park's subject and a write's target are finally comparable.
//
// ***THE TYPE IS WHAT KEEPS THEM OUT OF A RESUME.*** `Expr<'effect'>` is not
// `Expr<'bool'>`, and a resume position takes a bool - so `CheckPure`'s rule is
// a compile error here rather than a host-side refusal the guest cannot see.

/**
 * `SetReplicas(path, n) -> effect`. The path is CANONICAL - built, not typed.
 *
 * The replica count may be an EXPRESSION, which is what arithmetic bought:
 * `setReplicas(p, plus(length(listPods('app=x')), 2))` is legal, and the host
 * evaluates the argument at emit time so the stored obligation carries the
 * resulting literal. A step's conclusion is fixed when it declares it.
 */
export const setReplicas = (path: ApiPath, n: IntLike): Expr<'effect'> =>
  mk(`SetReplicas(${lit(path)}, ${intText(n)})`)

/**
 * `SetCondition(type, status, reason, message) -> effect`. SELF-TARGETED.
 *
 * ***IT TAKES NO PATH, AND THAT IS THE POINT.*** The subject is the grant's own
 * Perseid, supplied by the host. A path argument would exist only to be
 * validated back to the single value it is allowed to hold - the trade
 * `assemble.go` records as made once and regretted. A step cannot report on
 * another Perseid because there is nothing to bind wrongly.
 *
 * `status` is Kubernetes' spelling (`'True'`), not WIT's (`true`): the CRD
 * enumerates exactly those three strings and a lower-cased value is well-formed
 * JSON that FAILS APISERVER VALIDATION - rejected at write time, invisible to
 * the step because `set` returns nothing.
 */
export const setCondition = (
  type: string,
  status: 'True' | 'False' | 'Unknown',
  reason: string,
  message: string,
): Expr<'effect'> =>
  mk(`SetCondition(${lit(type)}, ${lit(status)}, ${lit(reason)}, ${lit(message)})`)
