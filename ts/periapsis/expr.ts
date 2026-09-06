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
// contradicts it. `periapsis's aperture/sdkresume_test.go` runs what this produces
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

import type {
  ApiPath,
  ClusterPath,
  CollectionPath,
  LabelSelector,
  PodName,
  WorkloadName,
} from './perseid'

declare const exprOf: unique symbol

/**
 * The types an aperture expression can have.
 *
 * `effect` is the one that carries a safety property rather than a shape: an
 * expression of that type PERFORMS something, so it belongs in an emit position
 * and never in a resume. That is `CheckPure`'s rule, mirrored as a type.
 */
export type ApType =
  | 'bool'
  | 'int'
  | 'observed-int'
  | 'string'
  | 'pods'
  | 'list'
  | 'path'
  | 'value'
  | 'effect'

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

/**
 * Anything usable where an integer goes: a literal, a clock read, an observation.
 *
 * `value` is here because `Get` is the only way to read a number off an object
 * now, so excluding it would leave arithmetic and comparison with nothing to
 * consume. It is a WIDENING of what the type system checks - a `value` may hold
 * a string - and the host is three-valued rather than typed at that point, so a
 * comparison against a non-number yields UNKNOWN rather than an error. That is
 * the same latitude `observed-int` always had; what is lost is the SDK's
 * ability to reject `get(cfg, 'data.mode') > 3` statically, which is the price
 * of one symbol reading every kind.
 */
export type IntLike = Expr<'int'> | Expr<'observed-int'> | Expr<'value'> | number

/** Anything `.exists` can be asked of - i.e. anything actually OBSERVED. */
export type Observed = Expr<'observed-int'> | Expr<'value'>

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
 * ***WHY THE LIMIT MATTERED ENOUGH TO CHANGE THE LANGUAGE.*** trail
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
// The language version.

/**
 * The expression language this SDK emits, as an integer radiant compares against
 * the one it speaks. ***PUT IT IN THE PERSEID: `spec.language: 1`.*** Admission
 * refuses a program whose declared language is newer than the evaluating radiant -
 * BEFORE a pod, before a pass - instead of the program failing at its first park
 * with `unknown symbol`. Undeclared is not refused; it is unchecked, and the
 * failure moves to runtime.
 *
 * WHY THE SDK CARRIES IT AND THE ARTIFACT CANNOT: a resume is assembled at
 * runtime from the constructors in this file, so what a component CAN emit is a
 * property of the SDK it was built with, not of its bytes. Held equal to
 * `aperture.LanguageVersion` by a guard in the host's tests; bump it there first.
 *
 *     1  2026-09-02  ADR-0101: list, fields
 *     2  2026-09-05  the object graph: ownedBy, nodeOf
 *     3  2026-09-06  the field-path SELECTOR `a[?k=v]` - the first bump for
 *                    something that moves NO SYMBOL. A field path reaches the
 *                    language as a string ARGUMENT, so the symbol digest could
 *                    not see it: a program using the new form was ADMITTED by a
 *                    radiant that cannot parse it, and the resume then went
 *                    unevaluable and dropped silently to its backstop -
 *                    "degrades safely" and "degrades visibly" are not the same
 *                    property. The host's `pathGrammarDigest` closes it by
 *                    folding parser behaviour into the fingerprint.
 *     4  2026-09-06  `.min`/`.max` on a `fields` result - THE LANGUAGE'S
 *                    QUANTIFIERS. `.length` was the whole surface of a set, so
 *                    a park could ask HOW MANY objects match and never whether
 *                    ANY of them differs; every program watching N objects had
 *                    to NAME all N, and a fleet-wide watchdog meant one Perseid
 *                    per node. A MEMBER PROPERTY is a third thing the symbol
 *                    table cannot see, alongside the field-path grammar - so
 *                    the host now folds `listProperties` into the fingerprint
 *                    for the same reason version 3 folded in the parser.
 */
export const LANGUAGE_VERSION = 4

// ---------------------------------------------------------------------------
// Symbols. One per entry in aperture's `signatures` table.

/** `ListPods(selector) -> pods`. A LABEL SELECTOR, never a path. */
export const listPods = (selector: LabelSelector): Expr<'pods'> =>
  mk(`ListPods(${lit(selector)})`)

/**
 * `Get(path, field) -> value`. THE READ, for every kind.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * engi, 2026-08-30: *"write generalized read - deprecate specialized reads
 * (GetConfigMap, ...)"*.
 *
 *     get(deployment('default', 'api'), 'status.readyReplicas')
 *     get(configMap('default', 'cfg'), 'data.mode')
 *
 * It replaced `getPod`, `replicas`, `getDeployment`, `getStatefulSet`,
 * `getDaemonSet`, `getReplicaSet`, `getConfigMap` and `getSecret` - eight
 * constructors that differed only in the kind they named and the two fields they
 * exposed. A ninth kind was a ninth round of capability + signature + dispatch +
 * read surface + an entry in BOTH SDKs. The path already says the kind.
 *
 * ***THE AUTHORITY DID NOT COLLAPSE WITH THE SYMBOL.*** `Get` is conferred by
 * every read capability, and the host checks the PATH'S KIND against the granted
 * set at evaluation - so holding `pods:read` makes this resolvable and lets it
 * read pods, and does not let it read a Secret. In particular `secrets:read` is
 * still absent from the host's fixed resume capability set, so a Get naming a
 * Secret does not resolve in a WAKE CONDITION and cannot publish a claim about a
 * secret's value into `status.waitingFor`. Read secrets in a STEP.
 *
 * ***A FIELD, NEVER THE OBJECT.*** The host narrows to the single field named
 * here before the language sees anything, so there is no pod template or
 * annotation map to reach. A missing field is ABSENT rather than unknown - the
 * object was read, the field genuinely is not there - so `.exists` on an
 * optional field is a real question rather than a frozen program.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const get = (path: ReadPathLike, field: string): Expr<'value'> =>
  mk(`Get(${pathText(path)}, ${lit(field)})`)

/**
 * `Now() -> int`. EPOCH MILLISECONDS, UTC.
 *
 * NOT observed: the clock cannot be absent, and `Now().exists` is refused by the
 * host at evaluation. It is typed `int` rather than `observed-int` for exactly
 * that reason.
 */
export const now = (): Expr<'int'> => mk('Now()')

/**
 * `List(collection, selector) -> list`. ***ONE CALL OVER N OBJECTS, FOR EVERY
 * KIND WITH A READ CAPABILITY*** (ADR-0101) - what `listPods` has always been for
 * pods. `length(list(...))` is a count.
 *
 *     list(path.ns('overhead').collection('configmaps'), 'role=src')
 *
 * WHY IT MATTERS: with only `get` per object, calls and objects watched are the
 * same number, and the host's 16-call budget per wake check (15 for you - the
 * host's own backstop `Now()` is the 16th) was a ceiling of 7 compared pairs per
 * park. overhead-bench measured it on a fused relay, 2026-09-02.
 *
 * ***THE AUTHORITY IS THE KIND'S, DECIDED FROM THE ARGUMENT.*** Every read
 * capability makes this resolvable; whether THIS collection may be listed needs
 * that kind's capability - `observe-configmaps` for configmaps - and never a
 * `spec.reads` entry, because a list is a wider read than any declared object.
 * The grant's label selector still applies to every object listed.
 */
export const list = (collection: CollectionPath, selector: LabelSelector | ''): Expr<'list'> =>
  mk(`List(${lit(collection)}, ${lit(selector)})`)

/**
 * `Fields(collection, selector, field) -> list`. One field of every matching
 * object, ***ORDERED BY OBJECT NAME***, in one call.
 *
 *     ne(fields(cms, 'role=src', 'data.v'), fields(cms, 'role=dst', 'data.v'))
 *
 * is "some source differs from its destination" for any number of pairs, in TWO
 * calls - the park the fused relay needed. The name order is what makes
 * `src-000..src-007` line up against `dst-000..dst-007`; name your pairs so they
 * sort alike. A missing field is ABSENT, never "", and an absent element makes
 * the comparison unknown - which does not hold, and the backstop asks again.
 */
export const fields = (
  collection: CollectionPath,
  selector: LabelSelector | '',
  field: string,
): Expr<'list'> => mk(`Fields(${lit(collection)}, ${lit(selector)}, ${lit(field)})`)

// ---------------------------------------------------------------------------
// Properties.

/** `.exists` - did this observation RESOLVE. Only for things that are observed. */
export const exists = (o: Observed): Expr<'bool'> => mk(`${o}.exists`)

/** `.length` - how many. Only for a set: pods, or a `list`/`fields` result. */
export const length = (p: Expr<'pods'> | Expr<'list'>): Expr<'int'> => mk(`${p}.length`)

/**
 * `.min` / `.max` - the extremes of a NUMERIC `fields` result.
 *
 * ⭐ ***THESE ARE THE LANGUAGE'S QUANTIFIERS, AND THEY ARE THE ONLY WAY TO ASK
 * ANYTHING OF A SET BEYOND ITS SIZE.*** Until 2026-09-06 `.length` was the whole
 * surface, so a park could say "how many objects match" and never "does ANY of
 * them differ from what I want" - which is why every program watching N objects
 * had to NAME them, and a fleet-wide watchdog meant one Perseid per node.
 *
 * Combined with the comparison operators the language already has, they recover
 * both quantifiers without a new symbol:
 *
 *	any element != n   min != n || max != n
 *	all elements == n  min == n && max == n
 *
 * ⛔ NUMERIC FIELDS ONLY. A ConfigMap's `data` values are strings by API type, so
 * these refuse them - use `fields(...) != fields(...)` for that. `min` of an
 * EMPTY set is an error rather than 0: the extreme of nothing is not a number,
 * and a park would compare against whatever came back.
 */
export const minOf = (p: Expr<'list'>): Expr<'int'> => mk(`${p}.min`)
export const maxOf = (p: Expr<'list'>): Expr<'int'> => mk(`${p}.max`)

// ---------------------------------------------------------------------------
// ⛔ EIGHT PER-KIND CONSTRUCTORS WERE HERE AND ARE DELETED, 2026-08-30.
//
// `getPod`, `replicas`, `getDeployment`, `getStatefulSet`, `getDaemonSet`,
// `getReplicaSet`, `getConfigMap`, `getSecret` - and the `desired`, `ready` and
// `data` properties that only they produced. `get(path, field)` is all of them.
//
// ***THE COMMENT THAT USED TO SIT HERE ARGUED THEY WERE NECESSARY, AND IT WAS
// WRONG ON THE MECHANISM.*** It said a generic `get('statefulsets', name)`
// "would emit an expression the host cannot index, so a parked program would
// silently fall back to polling" - because `Addresses.Kind` is static per
// symbol. That is true of a KIND-plus-NAME spelling and false of the one that
// shipped: a full path carries namespace, kind and name, so `Addressing.ByPath`
// indexes it exactly, and MORE precisely than the old form did - a bare name had
// to borrow its namespace from the grant.
//
// Recorded rather than deleted because the argument was load-bearing for months
// and reads as sound; what it got wrong was assuming the generic form had to be
// (kind, name).

// ---------------------------------------------------------------------------
// Comparison. Both operands must be integers - which is the rule the host does
// NOT enforce, and the one that produces a silently meaningless park.
//
// ***NOT PARENTHESISED, AND THAT IS CORRECT RATHER THAN AN OVERSIGHT.*** `cmp`
// sits at the LOOSEST level of the arithmetic/comparison chain (grammar.go:
// `cmp -> add -> mul -> unary -> postfix -> primary`), so any add- or
// mul-level text embedded as its operand already binds correctly without
// help - "a + b != c * d" parses as "(a + b) != (c * d)" regardless. The
// hazard `arith` below fixes (a looser "add" result embedded inside a
// tighter "mul" context) has no analogue here: nothing in this language sits
// ABOVE `cmp` for one of its own results to be embedded inside.
const cmp =
  (op: string) =>
  (a: IntLike, b: IntLike): Expr<'bool'> =>
    mk(`${intText(a)} ${op} ${intText(b)}`)

export const ne = cmp('!=')
export const eq = cmp('==')

/**
 * A NON-INTEGER scalar the grammar compares directly: a string or a boolean.
 *
 * ***THE HOST HAS ALWAYS SUPPORTED THESE AND THIS SDK COULD NOT SPELL THEM.***
 * `evalState.compare` has a `case string` and a `case bool` arm, each defining
 * `==` and `!=` (and refusing `<`/`>`, which is why this is a separate type
 * rather than a widening of `IntLike` - ordering is genuinely undefined here).
 * `cmp` above takes `IntLike`, so every park condition an author could write was
 * about a number.
 *
 * Found 2026-09-05 trying to park on a node's drain annotation - a STRING - and
 * it is the reason a cluster park had nothing to say even after the wake index
 * learned to carry one.
 */
export type ScalarLike = string | boolean

// A boolean renders bare and a string is JSON-quoted, which is the same dialect
// `lit` uses and the host decodes with.
const scalarText = (v: ScalarLike): string => (typeof v === 'string' ? lit(v) : String(v))

const cmpScalar =
  (op: string) =>
  (a: Expr<'value'>, b: ScalarLike): Expr<'bool'> =>
    mk(`${a} ${op} ${scalarText(b)}`)

/** `Get(p, f) == "text"` or `== true`. */
export const eqScalar = cmpScalar('==')

/**
 * `Get(p, f) != "text"`.
 *
 * ⚠ ***THIS IS UNKNOWN WHEN THE FIELD IS ABSENT, WHICH IS USUALLY NOT WHAT A
 * WAKE CONDITION WANTS.*** An absent operand propagates rather than comparing,
 * so `absent != "true"` is unknown and a park on it does NOT fire when the field
 * is DELETED. `perseid.fieldNoLonger` is the wake-shaped version.
 */
export const neScalar = cmpScalar('!=')

/**
 * `==` / `!=` between two LISTS (ADR-0101): element-wise and strict, the host's
 * rule for scalars applied per element. Different lengths are unequal; an absent
 * element makes the whole comparison unknown. `<`/`>` are not defined on lists,
 * and there is deliberately no constructor for them.
 */
const listCmp =
  (op: string) =>
  (a: Expr<'list'>, b: Expr<'list'>): Expr<'bool'> =>
    mk(`${a} ${op} ${b}`)

export const listEq = listCmp('==')
export const listNe = listCmp('!=')
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

// ***BOTH OPERANDS ARE PARENTHESISED, UNCONDITIONALLY - THE SAME DISCIPLINE
// and/or USE FOR BOOLEAN OPERANDS BELOW (`paren`).*** `IntLike` is an opaque
// branded string at runtime: this function cannot tell "a NUMBER literal"
// from "the text of a nested `plus(a, b)`", so there is no way to add parens
// only where precedence actually requires them without tracking precedence as
// SDK-side metadata, which does not exist. Grouping unconditionally is always
// semantically inert for a well-formed operand and always correct, at the
// cost of a redundant `(3)` on a bare literal - exactly the trade `and`/`or`
// already made for booleans.
//
// ***THE DEFECT THIS FIXES: `times(plus(a, b), c)` USED TO RENDER
// `"a + b * c"`.*** The grammar's `mul` (`*`) binds tighter than `add`
// (`+`/`-`) - grammar.go's own comment: "BETWEEN cmp AND unary, so `a + 1 > b`
// parses as `(a + 1) > b` - the reading every other language gives it" - so
// unparenthesised text for a `plus`/`minus` result embedded as an operand of
// `times` parsed as `a + (b * c)` instead of the intended `(a + b) * c`,
// silently computing the wrong value with no error on either side. `cmp`
// above does not need this: see its own comment for why.
const parenInt = (v: IntLike): string => `(${intText(v)})`

const arith =
  (op: string) =>
  (a: IntLike, b: IntLike): Expr<'int'> =>
    mk(`${parenInt(a)} ${op} ${parenInt(b)}`)

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
 * `Ensure(path, field, value) -> effect`. THE WRITE, for every kind.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * The mirror of `get`, and it replaced `setReplicas` (engi, 2026-08-30:
 * *"deprecate specialized writes"*).
 *
 *     ensure(deployment('default', 'api'), 'spec.replicas', 3)
 *     ensure(configMap('default', 'cfg'), 'data.mode', 'fast')
 *
 * The value may be an EXPRESSION, which is what arithmetic bought:
 * `ensure(p, 'spec.replicas', plus(length(listPods('app=x')), 2))` is legal, and
 * the host evaluates the argument at emit time so the stored obligation carries
 * the resulting literal. A step's conclusion is fixed when it declares it.
 *
 * ***THE DECLARATION IS THE OBJECT.*** `spec.writes` names the object and that
 * is complete access to it - which field you write is not a second grant:
 *
 *     writes:
 *       - /apis/apps/v1/namespaces/default/deployments/api
 *
 * A field-scoped boundary was tried and removed the same day. Enumerating fields
 * does not scale - you cannot list every env var or label - and `spec.writes`
 * exists for admission-time CONFLICT DETECTION, which reasons about OBJECTS, so
 * field-scoping would have made two programs writing one object stop looking
 * like a conflict.
 *
 * What bounds this instead is its OWN capability (`radiant:reconcile/ensure`,
 * so no existing scaler silently gains it), the grant's namespace, and the KIND:
 * configmaps, secrets, deployments, statefulsets, daemonsets, replicasets.
 *
 * ⛔ ***NOT pods, AND THAT ONE EXCLUSION IS A SECURITY ARGUMENT RATHER THAN A
 * SCOPE DECISION.*** An obligation is applied with RADIANT'S credential, and the
 * seam-binding admission policy exempts exactly that identity - on pods. A
 * program that could write a pod could stamp the binding annotations through the
 * one identity the policy lets past.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * `OwnedBy(path)` — the CONTROLLER owner of an object, as a path.
 *
 * ***AN EDGE IN THE OBJECT GRAPH, AND IT RETURNS A PATH SO IT COMPOSES WITH
 * EVERYTHING*** (engi, 2026-09-05: "what if pods, owners, nodes, and events were
 * one queryable graph instead of separate API objects?"):
 *
 *     get(ownedBy(pod), 'spec.replicas')            // the owner's scale
 *     get(ownedBy(ownedBy(pod)), 'metadata.name')   // pod -> rs -> deployment
 *
 * ***IT CONFERS NO AUTHORITY.*** Resolving the edge READS the source object, so
 * it is gated by exactly the capability that source's kind already needs; and the
 * path it returns is bounded by whatever consumes it. A program that may not read
 * the pod cannot learn its owner, and one that may not read Deployments gets
 * `absent` from a `get` on the result.
 *
 * Three-valued like every read: `unknown` when the source could not be read,
 * `absent` when there is no controller owner or its kind is one this aperture
 * cannot address — never a guess.
 *
 * ⚠ ***A PARK ON AN EDGE SUBSCRIBES TO THE SOURCE, NOT THE TARGET.*** Subjects
 * are extracted from an expression's literals, and the only literal here is the
 * pod. So the owner changing does not wake the program; the backstop does.
 */
export const ownedBy = (path: PathLike): Expr<'path'> => mk(`OwnedBy(${pathText(path)})`)

/**
 * `NodeOf(path)` — the machine running a pod, as a CLUSTER-scoped path.
 *
 * ***THE EDGE THAT CROSSES SCOPES***, which is the interesting one: the result
 * lives outside any namespace, so consuming it needs `observe-cluster` AND the
 * node named in `spec.reads`. This symbol grants none of that — `nodeOf(pod)` is
 * a string, and it is the `get` around it that must be permitted.
 *
 *     get(nodeOf(pod), 'spec.unschedulable')   // is my pod's machine cordoned
 *
 * `absent` while the pod is unscheduled: `spec.nodeName` is empty until the
 * scheduler places it, and "no node yet" must not read as "some node".
 */
export const nodeOf = (path: PathLike): Expr<'path'> => mk(`NodeOf(${pathText(path)})`)

export const ensure = (path: PathLike, field: string, value: EnsureValue): Expr<'effect'> =>
  mk(`Ensure(${pathText(path)}, ${lit(field)}, ${valueText(value)})`)

// ═══════════════════════════════════════════════════════════════════════════
// ⛔ ***THERE IS NO `ensureCluster`, AND THAT IS A DECISION RATHER THAN A GAP***
// (engi, 2026-09-05). `ensure` above writes a CLUSTER-SCOPED object too - a Node,
// a PersistentVolume - and the PATH is what says which:
//
//	ensure(path.ns('default').deployments('api'), 'spec.replicas', { num: 3 })
//	ensure(path.nodes('worker-1'), 'spec.unschedulable', { flag: true })
//
// It existed for an hour as a second SPELLING emitting the same `Ensure` symbol,
// so an author could say at the call site that they were cordoning a machine.
// It was removed once the path was shown to encode its scope UNAMBIGUOUSLY - by
// segment arity, see `aperture.ScopeOf` - because a second name for one function
// is then a thing to keep in step for no confinement it adds.
//
// ⚠ ***WHAT IS LOST IS THE CALL-SITE SIGNAL, AND IT IS WORTH KNOWING.*** A reader
// scanning a program no longer sees "this one is cluster-scoped" in the verb;
// they have to read the path. The AUTHORITY is unchanged and is where it always
// was - `spec.writes` names the object, and for a cluster object that declaration
// is the ONLY bound, since there is no namespace to compare.
// ═══════════════════════════════════════════════════════════════════════════


/**
 * What `ensure` may write: a scalar LITERAL, or a computed expression.
 *
 * ***A NUMBER OR BOOLEAN IS UNAMBIGUOUS; A STRING IS NOT, AND THAT IS WHY
 * `computed()` EXISTS.*** An `Expr` IS a plain string at runtime - the brand is
 * erased - so nothing can tell `'fast'` (a ConfigMap value to quote) from
 * `Get(...) + 1` (expression text to emit bare) by inspecting it.
 *
 * The first attempt here was a regex on the string's SHAPE, and it is worth
 * recording why it was thrown away rather than tightened: it decides a
 * correctness question with a guess, and it is wrong in the DANGEROUS direction.
 * A ConfigMap value that happens to read `Now()` - a perfectly ordinary thing to
 * store - would be emitted bare and EVALUATED, writing the clock into the field
 * instead of the four characters the caller asked for. No amount of narrowing
 * fixes that; the shape of a value and the shape of an expression genuinely
 * overlap.
 *
 * So the caller says which they meant. A bare string is ALWAYS a literal - the
 * common case stays `ensure(cfg, 'data.mode', 'fast')` - and an expression is
 * wrapped once, which is exactly where the author already knows the answer.
 */
export type EnsureValue = string | number | boolean | Computed

/** An expression to be evaluated at emit time, rather than a literal to store. */
export type Computed = { readonly [computedOf]: true; readonly text: string }

// ***A REAL RUNTIME VALUE, UNLIKE exprOf/bodyOf/kindOf ABOVE - AND THAT
// DIFFERENCE IS THE WHOLE POINT.*** Those three are pure TYPE brands: nothing
// ever tests for them at runtime, so `declare const … : unique symbol`
// (erased entirely by the compiler - it exists only to give TypeScript
// something to key a nominal type on) is correct for them. isStruct below
// tests THIS one with `in`, which needs an actual value to look up - a
// `declare const` there is not merely unused, it is a ReferenceError the
// moment isStruct runs, thrown from inside `create`/`ensure`, on every call.
//
// ***Symbol.for, NOT Symbol, AND THAT IS A CORRECTNESS FIX RATHER THAN A
// STYLE.*** `Symbol('computed')` is unique PER MODULE INSTANCE. Load this file
// twice in one process and there are two different symbols, so a Computed built
// by instance A fails `computedOf in v` in instance B - and isStruct's checks
// are all satisfied by that object, so it comes back TRUE. The expression is
// then rendered by structText as the literal body `{"text": "Now()"}` instead
// of the bare expression: not a crash, not a type error, a WRONG VALUE WRITTEN
// TO THE CLUSTER, and one that looks like the caller passed a struct.
//
// Two instances is the normal case, not a pathological one. periapsis depends
// on this package as `file:` paths from several different depths and also has
// the published @apsis-io/periapsis-sdk available; npm and bun dedupe by
// RESOLVED PATH, so two spellings of the same copy are two instances.
//
// The global registry is keyed by this string, so every instance - including
// different VERSIONS of this package - agrees. The key is namespaced because
// the registry is process-global and shared with every other library in it.
const computedOf: unique symbol = Symbol.for('@apsis-io/periapsis-sdk:computed')

/**
 * Mark an expression as the COMPUTED value of an `ensure`.
 *
 *     ensure(dep, 'spec.replicas', computed(plus(length(listPods('app=x')), 2)))
 *
 * Only needed for a value the host must evaluate. A literal - including a
 * numeric one - goes in directly.
 */
export const computed = (e: Expr<'int'> | Expr<'observed-int'> | Expr<'value'>): Computed =>
  ({ [computedOf]: true, text: e }) as unknown as Computed

/** Render an Ensure value: a quoted literal, or bare expression text. */
function valueText(v: EnsureValue): string {
  if (typeof v === 'number') return String(Math.trunc(v))
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return lit(v)

  return v.text
}

/**
 * `At(apiVersion, kind, name) -> path`. Name an object WITHOUT a namespace.
 *
 *     get(at('apps/v1', 'deployments', 'web'), 'status.readyReplicas')
 *     ensure(at('v1', 'configmaps', 'cfg'), 'data.mode', 'fast')
 *
 * ***THE NAMESPACE COMES FROM THE GRANT, AND A PROGRAM CANNOT SUPPLY ONE.*** Not
 * "is refused when it tries" - cannot say it. `reconcile.wit` makes the same
 * argument about `count`: a path "lets a program NAME one - which then has to be
 * checked against the grant, so the boundary gains a SECOND ENFORCEMENT POINT
 * THAT CAN DISAGREE WITH THE FIRST".
 *
 * The apiVersion is spelled the way an object's own `apiVersion` field spells it
 * - `apps/v1`, or `v1` for the core group - rather than as a group and a version
 * nobody orders correctly.
 *
 * An OBLIGATION built from one still stores a plain path: an effect evaluates
 * its arguments and renders the result, so nothing downstream sees an `At`.
 */
export const at = (apiVersion: string, kind: string, name: string): Expr<'path'> =>
  mk(`At(${lit(apiVersion)}, ${lit(kind)}, ${lit(name)})`)

/**
 * Anywhere a path goes: a BUILT path, or an `at(...)` that resolves to one.
 *
 * ***THE TWO ARE NOT INTERCHANGEABLE IN STRENGTH AND BOTH ARE LEGITIMATE.*** An
 * `ApiPath` states a namespace, which the host then checks against the grant - a
 * second enforcement point that CAN disagree. An `at(...)` cannot state one, so
 * there is nothing to check. The second is stronger; the first is what you need
 * when the object is genuinely in another shape of address.
 */
export type PathLike = ApiPath | Expr<'path'>

/**
 * Anywhere a path goes to be READ: namespaced, cluster-scoped, or a resolved
 * edge.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***A SEPARATE TYPE RATHER THAN A WIDENING OF `PathLike`, BECAUSE `PathLike`
 * ALSO FEEDS `del`.*** Widening it in one place would silently make `del(node)`
 * typecheck, and there is no cluster delete anywhere in the host - a program
 * would compile, ship, and have its obligation refused at the write boundary.
 * The read arm is the only one the host actually grew.
 *
 * ***WHY THE BRAND STILL EARNS ITS KEEP HERE.*** `ApiPath` and `ClusterPath` are
 * kinded so a cluster path cannot reach a NAMESPACED read surface -
 * `observe.get` takes one and `observeCluster.get` the other, because those two
 * reads have different confinements. `Get` in the EXPRESSION language is not one
 * of those surfaces: it is scope-generic, exactly as `ensure` became when engi
 * unified it ("why path can't encode scopes?"), and the host tells the two apart
 * from the path itself. So this union widens the symbol that genuinely accepts
 * both and leaves every other one alone.
 *
 * ⚠ The confinements are NOT the same on the two sides and that is the point:
 * a namespaced read is bounded by the grant's namespace and the kind's
 * capability, a cluster read by `spec.reads` matched EXACTLY. Both are enforced
 * by the host; neither is enforced by this type.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export type ReadPathLike = PathLike | ClusterPath

/** Render a path argument: both forms are already the text to emit. */
const pathText = (p: ReadPathLike): string => (isPathExpr(p) ? p : lit(p))

// A path EXPRESSION is emitted bare (the host evaluates it); a built path is a
// LITERAL and must be quoted. Both are strings at runtime, so the discriminator
// has to be the shape.
//
// ⛔ ***THIS WAS `p.startsWith('At(')` AND IT WENT STALE THE MOMENT A SECOND
// PATH-PRODUCING SYMBOL EXISTED.*** `ownedBy` and `nodeOf` emit `OwnedBy(` and
// `NodeOf(`, so an edge was QUOTED as a literal:
//
//	want  Get(OwnedBy("/api/v1/..."), "spec.replicas")
//	got   Get("OwnedBy(\"/api/v1/...\")", "spec.replicas")
//
// The host then parses a path argument that is a string containing an
// expression, which resolves to nothing - so every traversal silently failed.
// Nothing caught it: the aperture's own tests build expressions directly, and
// this SDK's tests asserted that helpers COMPILED rather than what they RENDER.
//
// ⇒ ***THE TEST IS STRUCTURAL, NOT AN ALLOWLIST OF SYMBOL NAMES.*** A canonical
// apiserver path ALWAYS begins with `/` - that is what `Canonical<'apiserver-path'>`
// and `unsafeApiPath` guarantee - and no expression does. So this cannot go
// stale when the next path-producing symbol is added, which is precisely how the
// old form failed.
const isPathExpr = (p: ReadPathLike): boolean => !p.startsWith('/')

/**
 * A structured value: an object body for {@link create}.
 *
 * Values are scalars, `computed(...)` expressions, or nested `StructValue`s.
 */
export type StructShape = {
  [k: string]: EnsureValue | StructShape | StructArray
}

/**
 * An array field — `command`, `args`, `containers`, `volumes`.
 *
 * ***HOMOGENEOUS BY CONSTRUCTION, AND THAT IS THE GUARDRAIL.*** Written as a
 * union of two arrays (`A[] | B[]`) rather than one array of a union
 * (`(A | B)[]`), so `['sh', {name: 'x'}]` does not typecheck. The grammar
 * permits a mixed array and no guest has ever needed one, and rust/perseid
 * cannot express one at all (`list` takes scalars, `list_of` takes structs) —
 * so the two SDKs now agree on what they ACCEPT and not merely on what they
 * emit.
 *
 * ***AND ARRAYS ARE IN THIS TYPE AT ALL ONLY SINCE 2026-09-03, WHICH IS THE
 * ROOT OF THE DEFECT THAT SHIPPED.*** `StructShape` was
 * `{ [k: string]: EnsureValue | StructShape }`, and an array satisfies a string
 * index signature structurally — so `containers: [...]` typechecked by ACCIDENT,
 * went down the struct path, and rendered as a sorted-key object. The fix to
 * `isStruct` stops that at runtime; naming the type stops it being expressible
 * as a struct in the first place.
 */
export type StructArray = readonly EnsureValue[] | readonly StructShape[]

declare const bodyOf: unique symbol

/**
 * An object body, CANONICAL BY CONSTRUCTION.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***BRANDED, SO ONLY A KINDED BUILDER CAN MAKE ONE*** (engi, 2026-08-30:
 * "deprecate structured value"). This is the same discipline `ApiPath` uses and
 * for the same reason: a hand-written value is exactly the thing that goes
 * wrong.
 *
 * A raw `create(path, {spec: {...}})` let a caller pair a Deployment path with a
 * ConfigMap body, spell `replcas`, or put `data` on a workload. The host refuses
 * some of that and the apiserver the rest - at APPLY time, inside an obligation
 * the ledger has already recorded, with `create` returning nothing to the guest
 * by contract. Late and silent, which is what this SDK exists to move to the
 * compiler.
 *
 * The wire form is unchanged: the host still parses `Create(path, {...})`, and
 * it must, because that IS the obligation. What changed is that no guest writes
 * one by hand.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export type StructValue = StructShape & { readonly [bodyOf]: 'object-body' }

/**
 * Brand a shape as a body. NOT EXPORTED FROM THE PACKAGE INDEX: this is how a
 * kinded builder produces one, and handing it to a caller would retire the
 * brand's whole purpose.
 */
export const asBody = (s: StructShape): StructValue => s as StructValue

declare const kindOf: unique symbol

/**
 * A path that knows what KIND of object it names.
 *
 * ***THE BRAND CARRIES THE KIND SO A MISMATCH IS A TYPE ERROR*** (engi,
 * 2026-08-30: "by kinded I mean Canonical and object kind"). It lives HERE
 * rather than beside the builders because `create` has to see it: if the path
 * and the body are typed as a bare `ApiPath` and `StructValue`, the two kinds
 * never meet and a Deployment path pairs happily with a ConfigMap body.
 */
export type KindedPath<K extends string> = ApiPath & { readonly [kindOf]: K }

/** A body that knows what kind of object it belongs to. */
export type KindedBody<K extends string> = StructValue & { readonly [kindOf]: K }

/**
 * A path and a body for the SAME kind.
 *
 * One type parameter, used twice - which is the whole mechanism. TypeScript
 * unifies `K` across both fields, so pairing kinds that differ has no `K` to
 * infer and the call does not typecheck.
 */
export type KindedObject<K extends string> = {
  readonly path: KindedPath<K>
  readonly body: KindedBody<K>
}

/**
 * Block inference at a position, so `K` is decided by the OTHER one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***WITHOUT THIS THE KIND BRAND DOES NOT BITE, AND IT LOOKS LIKE IT DOES.***
 * Measured: with `K` inferrable from both `path` and `body`, TypeScript
 * unifies a Deployment path and a ConfigMap body by widening to
 * `'deployments' | 'configmaps'` - and each field IS assignable to the union,
 * so the call typechecks. The mismatch the brand exists to catch passes.
 *
 * Caught only because the guard was written as `@ts-expect-error`, so the
 * BUILD failed with "Unused '@ts-expect-error' directive" rather than the test
 * quietly passing. A guard asserting a type error must fail loudly when it
 * stops finding one.
 *
 * Declared here rather than using the built-in so the mechanism is visible: the
 * conditional makes `T` appear in a non-inferrable position, and the indexed
 * access collapses it back to `T`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
type NoInferK<T> = [T][T extends unknown ? 0 : never]

// ARRAYS ARE EXCLUDED, DELIBERATELY: `typeof [] === 'object'` in JS, so without
// this check an array value (podTemplate's `containers`/`command`/`args`) was
// treated as a struct - see arrayText below for what that broke and why it must
// render differently.
//
// This check is still load-bearing even now that `StructShape` names the array
// case and podTemplate's casts are gone. The type says which arrays are
// INTENDED; it cannot say what a JS runtime hands this function, and the
// rendering split is a runtime decision.
const isStruct = (v: EnsureValue | StructShape): v is StructShape =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(computedOf in (v as object))

/**
 * Render a structured value with SORTED keys.
 *
 * ***THE SORT IS THE OBLIGATION'S IDENTITY, NOT TIDINESS.*** `Effect.Expr` IS
 * the identity - the host's ledger dedups on it and retires by
 * non-reassertion - so two passes building the same body must produce
 * byte-identical strings. JS object key order is insertion order, so a body
 * assembled by different code paths would otherwise render differently and the
 * ledger would see a new obligation every pass, re-applying a create it had
 * already performed, forever, with nothing erroring.
 */
const structText = (v: StructShape): string => {
  const parts = Object.keys(v)
    .sort()
    .map((k) => {
      const inner = v[k]

      return `${lit(k)}: ${fieldText(inner)}`
    })

  return `{${parts.join(', ')}}`
}

/**
 * Render an array value with its ELEMENTS IN ORDER, never sorted.
 *
 * ***THE DEFECT THIS FILE SHIPPED: BEFORE isStruct EXCLUDED ARRAYS, AN ARRAY
 * WENT THROUGH structText.*** `Object.keys` on an array returns its indices as
 * STRINGS ('0', '1', ..., '10', ...), `.sort()` on strings is lexicographic
 * ('10' before '2'), and structText wraps in `{...}` - so a 10+ element
 * `command` array rendered as a JSON OBJECT with numerically-scrambled keys
 * instead of a JSON array in the order the caller wrote it, which the parser's
 * array-literal rule (periapsis's internal/aperture/grammar.go, "ORDER IS
 * SIGNIFICANT HERE AND IS NOT FOR OBJECTS") cannot correctly read back as the
 * intended command.
 *
 * Never sorted, unlike structText: array order is DATA (`containers[0]` is not
 * `containers[1]`), not an incidental map-iteration artifact to canonicalise.
 */
const arrayText = (v: StructArray): string =>
  `[${v.map(fieldText).join(', ')}]`

/**
 * `Array.isArray` as a TYPE PREDICATE, because the built-in one does not narrow
 * a `readonly` array out of a union — it is declared `arg is any[]`, and
 * `readonly EnsureValue[]` is not an `any[]`. Without this the two branches
 * below still receive the array type and neither `isStruct` nor `valueText`
 * accepts it.
 */
const isFieldArray = (v: EnsureValue | StructShape | StructArray): v is StructArray =>
  Array.isArray(v)

/** Render one struct field or array element, dispatching on its shape. */
const fieldText = (v: EnsureValue | StructShape | StructArray): string => {
  if (isFieldArray(v)) return arrayText(v)
  if (isStruct(v)) return structText(v)

  return valueText(v)
}

/**
 * `Create(path, body) -> effect`. Bring an object into existence.
 *
 * ***THE PATH IS THE IDENTITY; THE BODY IS EVERYTHING ELSE.*** A canonical path
 * already carries group, version, resource, namespace and name, so the body
 * holds `spec`, labels and the like. A body setting `apiVersion`, `kind`,
 * `metadata.name` or `metadata.namespace` is REFUSED by the host: the path is
 * the string `spec.writes` was checked against, and a body that could name a
 * different object would put it outside the approved address.
 */
export const create = <K extends string>(o: {
  readonly path: KindedPath<K>
  readonly body: KindedBody<NoInferK<K>>
}): Expr<'effect'> => mk(`Create(${lit(o.path)}, ${structText(o.body)})`)

/**
 * `EnsureAll(path, body) -> effect`. SEVERAL fields of one object, ONE apiserver
 * patch - so a reader can never observe the new value of one field beside the
 * old value of another.
 *
 * ***`ensure` IS ONE FIELD PER OBLIGATION, AND OBLIGATIONS APPLY ONE AT A TIME.***
 * A step writing `data.v` and a `data.t` stamp as two ensures produced a durable
 * torn pair: 3 of 6 convergences observed with new `v` beside old `t`
 * (overhead-bench, 2026-09-01). The body here is the same shape `create` takes and
 * renders through the same `structText`, so keys are SORTED - the expression is
 * the ledger identity, and two orderings of one write would be two obligations.
 *
 * ⚠ ***`spec.replicas` ON AN apps KIND IS REFUSED BY THE HOST.*** That field goes
 * through the `/scale` subresource for least privilege, and the apiserver has no
 * write that is atomic across a subresource boundary. Use `ensure` for the count.
 */
export const ensureAll = <K extends string>(o: {
  readonly path: KindedPath<K>
  readonly body: KindedBody<NoInferK<K>>
}): Expr<'effect'> => mk(`EnsureAll(${lit(o.path)}, ${structText(o.body)})`)

/**
 * `Delete(path) -> effect`. Remove the object a path names.
 *
 * ***THE ONLY IRREVERSIBLE VERB IN THIS LANGUAGE.*** Everything else converges
 * toward a declared state and can be re-declared if it lands wrong; a delete
 * cannot be undone by re-running the step.
 *
 * ***ITS OWN INTERFACE (`radiant:reconcile/delete`), NOT `ensure`'s.***
 * Authority is conferred by IMPORTING an interface, so folding it in would grant
 * it to every program already granted Ensure - and `spec.writes` bounds WHICH
 * object either verb may touch while saying nothing about which VERB, so a
 * scaler would silently gain the ability to delete the Deployment it scales.
 *
 * No field: a delete is about the OBJECT, so there is nothing to narrow.
 */
export const del = (path: PathLike): Expr<'effect'> => mk(`Delete(${pathText(path)})`)

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
