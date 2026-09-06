// Perseid — the ADR-0075 reconciliation step contract.
//
// A Perseid is one operator program: a step that observes, emits obligations,
// and yields. Radiant dispatches them; the name follows from that (a radiant is
// the point a meteor appears to come from, and a Perseid is one such meteor).
//
// UNLIKE EVERY OTHER MODULE HERE, this imports no `periapsis:*` interface. A
// step's effects are DATA it yields; the host supplies the world through the
// handler passed to `runStep`. So importing this does not oblige your world.wit
// to import anything (see index.ts's note on Vite/Rollup external handling) —
// the capabilities you actually need come from the effects you define, and are
// derivable from their types (examples/wasm/perseid-ts/tools/derive-wit.ts).
//
// The contract, in one paragraph: a step is a generator. It YIELDS effects and
// returns an Outcome. It performs no I/O, so it is a pure function of the
// observations it is given — replayable, unit-testable against a fake handler,
// and safe to re-run. It never remembers that it asked for something; it
// re-derives the same conclusion from the same observation next tick, which is
// why in-flight bookkeeping cannot leak.

// ---------------------------------------------------------------------------
// Observation — THREE-VALUED, never `T | undefined`.
//
// `absent` means "it is not there". `unknown` means "I could not tell". An
// instrument that cannot distinguish those is the single most repeated defect
// in this codebase's history: it appears in the product (foldAbsentGone, the
// absence-convergence work) and appeared three separate times in ONE DAY inside
// the kubelet-benchmark harness (periapsis's internal notes
// — `pgrep -c` printing 0 while exiting non-zero, `shim_pss` returning 0 for an
// unreadable smaps, a settle check that could not tell drained from
// never-started). Collapsing the two into `undefined` reintroduces that whole
// family, so the type will not let you.
import * as E from './expr'

export type Obs<T> =
  | { readonly t: 'known'; readonly v: T }
  | { readonly t: 'absent' }
  | { readonly t: 'unknown' }

export const known = <T>(v: T): Obs<T> => ({ t: 'known', v })
export const absent: Obs<never> = { t: 'absent' }
export const unknown: Obs<never> = { t: 'unknown' }

// ---------------------------------------------------------------------------
// Resume — why a quiesced step should be woken. DATA, deliberately not a
// predicate: it is stored beside the parked program and evaluated WITHOUT
// running it, which is what lets the runtime index parked programs by wake
// condition and lets an operator see why one is asleep.
// *** IT IS AN aperture EXPRESSION, NOT A TAGGED UNION. engi decided it
// 2026-08-21: "should be expression". ***
//
// A tagged union needs a DISCRIMINANT, and a discriminant must be spelled
// identically in every language on the wire. There were four spellings — this
// file, a Go enum, a Rust decoder, a TS host switch — and they did not agree.
// Measured before the change:
//
//     {"r":"countNe","query":"app=demo","n":3}
//       -> Go: err=nil, Kind=0, Query="app=demo", N=3
//
// The PAYLOAD decoded. `"r"` matched no Go field, so the discriminant silently
// stayed at its zero value and the host refused the park as "an EMPTY resume
// expression" with the fields populated beside it. *** Every well-formed park
// this SDK produced was rejected by the Go host, for the whole life of the
// feature. *** An expression is one string: there is no discriminant to lose.
//
// It is STILL DATA - a string rather than a closure - which is what the four
// lines at the top of this section are about, and the reason is unchanged.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***A RESUME MUST BE PURE, AND THAT BECAME A CHECKED PROPERTY ON 2026-08-29
// RATHER THAN AN OBVIOUS ONE.*** aperture gained types, arity checking and
// EFFECTS-AS-EXPRESSIONS in the same language: `SetReplicas(path, n)` and
// `SetCondition(type, status, reason, message)` are now ordinary expressions,
// not opcodes beside them.
//
// One vocabulary for reads and writes is what makes the wake index possible - a
// park's subject and a write's target are finally comparable - and it means the
// two are separated by a CHECK rather than by their syntax:
//
//	emit position     an effect expression      SetReplicas("/apis/…", 3)
//	resume position   must be PURE              refused by CheckPure
//
// The host evaluates a resume WITHOUT running the step, repeatedly, to decide
// whether to wake it. An effect there would perform a write on every wake check
// - a write nobody asked for, on the wake path, for as long as the program
// stays parked.
//
// Every builder below is pure by construction; `periapsis's aperture`'s
// TestSDKResumeExpressions_ParseAndTypecheck runs each one's output through the
// host's own `Parse`/`CheckArity`/`CheckPure`, because the guest builds these
// strings and cannot evaluate them. That test also carries the negative control:
// an effect expression IS refused in a resume position, so the checks are not
// inert.
// ═══════════════════════════════════════════════════════════════════════════
export type Resume = E.Expr<'bool'>

// ---------------------------------------------------------------------------
// THE THREE VOCABULARIES, AND WHY THEY ARE THREE TYPES RATHER THAN THREE
// COMMENTS ABOUT `string`.
//
// engi, 2026-08-29: *"why 'replicasNe takes a name, not a path' - can it detect
// that it's already normalized? or require and enforce canonical form
// everywhere?"*
//
// A step addresses objects in three different languages, and which one is
// correct depends on the QUESTION being asked, not on taste:
//
//	PATH      /apis/apps/v1/namespaces/default/deployments/api   observe.get, scale
//	NAME      api                                                Replicas, GetPod
//	SELECTOR  app=api                                            ListPods / count
//
// ***THE ASYMMETRY IS A SECURITY PROPERTY AND NOT AN INCONSISTENCY.*** A NAME
// cannot name a namespace, so it resolves in the GRANT's namespace and there is
// nothing to bind wrongly. A PATH can name one, so it must be checked against
// the grant — a second enforcement point that can disagree with the first.
// `perseidrun/assemble.go` records making that trade the other way and
// regretting it: *"strictly weaker — the replacement rests on a DERIVATION
// staying correct rather than on a capability being absent."*
//
// ***SO: DO NOT "DETECT AND NORMALISE".*** Accepting a path in `replicasNe` and
// converting it would put a forgeable namespace back on the READ side, where
// today there is nothing to forge. Worse, the detection is a GUESS whose wrong
// branch fails SILENTLY — and this contract has paid for that guess twice:
//
//	observe('replicas')          a NAME where a path goes    unresolvable for 4 days
//	count('/api/v1/...')         a PATH where a selector goes 239 asks, 119 resolved
//
// Both compiled. Both ran. Neither errored: `get` and `count` never throw by
// contract, `unknown` is a legitimate answer and `yield` a legitimate outcome.
//
// ***AND "ONE CANONICAL FORM EVERYWHERE" DOES NOT SURVIVE EITHER, WHICHEVER ONE
// YOU PICK.*** Paths everywhere costs reads their unforgeability — the property
// above. Names everywhere makes a cross-namespace write inexpressible, and
// `spec.writes` exists precisely to authorise those. The vocabularies differ
// because the questions differ.
//
// ***THE ANSWER IS TO MAKE THEM UNCONFUSABLE RATHER THAN IDENTICAL.*** Each is a
// distinct type below, so passing one where another goes is a COMPILE error —
// which mechanically prevents both incidents above, neither of which any amount
// of documentation prevented.

/**
 * The shape of a namespaced apiserver path: it must contain a `/namespaces/`
 * segment.
 *
 * ***DELIBERATELY WEAKER THAN THE HOST'S GRAMMAR, BECAUSE THE STRICTER FORM
 * SILENTLY LOSES COMPLETION.*** The obvious spelling is the full grammar
 * `namespacedName` parses — `/api/V/namespaces/NS/KIND/NAME` and
 * `/apis/G/V/namespaces/NS/KIND/NAME`. Measured at the argument position, with
 * the cluster vocabulary augmented in:
 *
 *	`/api/${s}/namespaces/${s}/${s}/${s}` | `/apis/…`   completions 0   rejects 'replicas'
 *	`/${string}`                                        completions 2   rejects 'replicas'
 *	`${string}/namespaces/${string}`                    completions 2   rejects 'replicas'  ← this
 *
 * A template literal type in a union can suppress the string literals beside it
 * for completion purposes. WHY these three differ is NOT established — the
 * pattern beginning with a placeholder completes and the one beginning with
 * `/api` does not, but `/${string}` also begins with a literal and completes, so
 * "starts with a placeholder" is refuted as the rule. Recorded as four
 * measurements rather than a mechanism.
 *
 * ***WHAT IS LOST BY WEAKENING IT IS NOTHING THE HOST DOES NOT ALREADY CATCH.***
 * `namespacedName` anchors on POSITION and refuses anything else, including
 * cluster-scoped paths and a group literally named `namespaces`. This type's job
 * is to separate the three VOCABULARIES — a bare name, a selector and a path —
 * which is the confusion that has actually cost this contract twice. Requiring
 * `/namespaces/` rejects `replicas` and `app=api` and accepts every real
 * namespaced path.
 */
export type ApiPathShape = `${string}/namespaces/${string}`

/** The shape of a label selector: at minimum `key=value`. */
export type LabelSelectorShape = `${string}=${string}`

// ---------------------------------------------------------------------------
// CLUSTER VOCABULARY — completion from objects that actually exist.
//
// engi, 2026-08-29: "can you make autocompletion from real cluster?"
//
// These are EMPTY interfaces on purpose. `tools/gen-cluster-vocab.ts` queries a
// live cluster and emits a declaration-merging augmentation that adds one member
// per object; `keyof` then yields the union, and it is `never` when nothing has
// been generated — so the SDK ships with no cluster knowledge baked in and an
// un-augmented consumer loses completion rather than correctness.
//
// ***THIS IS THE ONLY CLUSTER FACT THAT IS SAFE TO COMPLETE FROM, AND THE OTHER
// TWO WERE MEASURED AND REJECTED.*** A Perseid CR's `spec.capabilities` is
// AUTHORED, so a typo shipped in a CR would become a suggestion — the
// self-certifying loop `reconcile.wit` warns about one level up. Its
// `spec.imports` is the artifact's derived demand: 44 ids for `scaler-v4`, 39 of
// them `wasi:*` noise. An object that EXISTS is neither — it is a fact about the
// world rather than a claim about a program.
export interface KnownWorkloadPaths {}
export interface KnownWorkloadNames {}
export interface KnownSelectors {}
export interface KnownNamespaces {}
export interface KnownPodNames {}

declare const canonicalOf: unique symbol

/**
 * A namespaced apiserver path in CANONICAL form — one that was BUILT rather
 * than typed (engi, 2026-08-29: "make fluent api api path", "and require
 * canonical form").
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***THE BRAND IS WHAT MAKES IT A REQUIREMENT RATHER THAN A CONVENTION.*** A
 * bare string literal, however well-formed, is NOT assignable here — it carries
 * no `[CanonicalPath]` — so `path()` (or the documented escape hatch) is the
 * only way to obtain one. A comment saying "please use the builder" is advice; a
 * brand is a compile error.
 *
 * ***AND REQUIRING IT DISSOLVES A TENSION THAT COST FOUR MEASUREMENTS.*** While
 * a path was a validated STRING, completion and validation fought each other:
 * the full grammar as a template literal type offered ZERO completions, and the
 * shapes that completed were weaker than the host's parser. With the path
 * CONSTRUCTED, neither question is asked of the string at all — completion moves
 * to the builder's ARGUMENTS, where a namespace and an object name are exactly
 * the things the cluster can enumerate, and correctness comes from the builder
 * having only one way to assemble the segments.
 *
 * The literal is preserved through the brand rather than erased, so the type
 * still displays as the path it is - useful when a mismatch is being read in an
 * error message.
 *
 * ***`Kind` IS NOT DECORATION — WITHOUT IT THERE IS EXACTLY ONE CANONICAL FORM
 * IN THE UNIVERSE*** (engi, 2026-08-29: "standalone Canonical is bad, what if we
 * introduce another canonical form of something").
 *
 * A single unbranded `Canonical<S>` marks a string as "built by a builder" and
 * says nothing about WHICH. The moment a second one exists — a canonical label
 * selector, a canonical resume expression, a canonical workload reference —
 * every one of them carries the identical brand, so they are mutually
 * assignable wherever their string shapes overlap, and a selector could be
 * passed where a path goes.
 *
 * ***AND THE OVERLAP IS NOT HYPOTHETICAL FOR THIS SDK.*** `ApiPathShape` is
 * `${string}/namespaces/${string}` and `LabelSelectorShape` is
 * `${string}=${string}` — both are satisfied by
 * `app=x/namespaces/y`. Two brands that differ only in `Kind` are disjoint;
 * one brand shared between them would make that string legal in both positions,
 * which is precisely the vocabulary confusion this whole section exists to
 * prevent, reintroduced by the mechanism meant to prevent it.
 *
 * `Kind` is phantom: it exists only in the type, costs nothing at runtime, and
 * appears in the error message when the wrong canonical form is passed.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export type Canonical<Kind extends string, S extends string> = S & {
  readonly [canonicalOf]: Kind
}

/** A namespaced apiserver path, canonical by construction. */
export type ApiPath = Canonical<'apiserver-path', ApiPathShape>

/**
 * The shape of a namespaced COLLECTION path: an object path without the name.
 *
 * Same shape family as `ApiPathShape` and a THIRD canonical kind on purpose
 * (ADR-0101): `list(...)`/`fields(...)` take a collection and `get(...)` takes an
 * object, and a string that is both is a read the host refuses one way or the
 * other. The kinded brand makes passing one where the other goes a compile error.
 */
export type CollectionPathShape = `${string}/namespaces/${string}`

/** A namespaced collection path, canonical by construction. */
export type CollectionPath = Canonical<'collection-path', CollectionPathShape>

/**
 * The shape of a CLUSTER-SCOPED apiserver path.
 *
 * The complement of `ApiPathShape`, deliberately: an object is namespaced or it
 * is not, and a path satisfying both would be one the two read surfaces
 * disagree about.
 */
export type ClusterPathShape = `/api${string}`

/**
 * A cluster-scoped apiserver path, canonical by construction.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***THE SECOND CANONICAL FORM, AND WHY `Canonical` IS KINDED*** (engi,
 * 2026-08-29: "standalone Canonical is bad, what if we introduce another
 * canonical form of something").
 *
 * With an unkinded brand this would be the SAME TYPE as `ApiPath`, and the two
 * would be interchangeable wherever their shapes overlapped. They address
 * different read surfaces with different authority:
 *
 *	ApiPath       observe.get          confined by the grant's NAMESPACE
 *	ClusterPath   observe-cluster.get  confined by spec.reads, per OBJECT
 *
 * Passing one where the other goes routes a read around the confinement chosen
 * for it. `Kind` makes that a compile error instead of a convention.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export type ClusterPath = Canonical<'cluster-path', ClusterPathShape>

/** A namespace name. Real namespaces complete. */
export type Namespace = (keyof KnownNamespaces & string) | (string & {})

/** A pod NAME, resolved in the grant's namespace. Never a path. */
export type PodName = (keyof KnownPodNames & string) | (string & {})

/** A workload NAME, resolved in the grant's namespace. Never a path. */
export type WorkloadName = (keyof KnownWorkloadNames & string) | (string & {})

/** A label selector. Real selectors complete; any `key=value` is accepted. */
export type LabelSelector = (keyof KnownSelectors & string) | (LabelSelectorShape & {})

/**
 * Build a canonical apiserver path.
 *
 *     path.ns('default').deployments('api')
 *     path.ns('default').pods('api-7d9f')
 *     path.ns('kube-system').resource('apps', 'v1', 'daemonsets', 'kube-proxy')
 *
 * ***THE ONLY WAY TO GET AN `ApiPath`, AND THAT IS THE POINT*** (engi,
 * 2026-08-29: "make fluent api api path", "and require canonical form"). A
 * hand-typed string is not assignable no matter how correct it looks, so the
 * segments cannot be mis-ordered, a separator cannot be doubled, and the
 * `namespaces` segment cannot be forgotten.
 *
 * ***THE NAMESPACE IS AN ARGUMENT HERE AND THAT IS NOT A CONTRADICTION.*** The
 * grant still decides what a program may reach: `spec.writes` gates every
 * obligation and a read outside the grant returns ABSENT. What this removes is
 * the class of error where a program meant a legal object and produced a
 * malformed or differently-shaped string for it — which is the failure that
 * costs a silent `unknown` forever rather than a refusal.
 *
 * Completion comes from the ARGUMENTS rather than the assembled string, which
 * is why requiring the builder made the vocabulary problem easier instead of
 * harder: a namespace and an object name are exactly what a cluster can
 * enumerate, and `tools/gen-cluster-vocab.ts` fills both in.
 */
export const path = {
  /** Scope to a namespace. Real namespaces complete. */
  ns: <NS extends Namespace>(namespace: NS) => ({
    /** `/apis/apps/v1/namespaces/NS/deployments/NAME` — what `scale` writes. */
    deployments: <N extends WorkloadName>(name: N) =>
      `/apis/apps/v1/namespaces/${namespace}/deployments/${name}` as Canonical<
        'apiserver-path',
        `/apis/apps/v1/namespaces/${NS}/deployments/${N}`
      >,

    /** `/api/v1/namespaces/NS/pods/NAME` — the CORE group, so `/api` not `/apis`. */
    pods: <N extends PodName>(name: N) =>
      `/api/v1/namespaces/${namespace}/pods/${name}` as Canonical<
        'apiserver-path',
        `/api/v1/namespaces/${NS}/pods/${N}`
      >,

    /**
     * `/apis/radiant.apsis/v1/namespaces/NS/perseids/NAME` — ANOTHER PROGRAM.
     *
     * ***THE ADDRESS OF A CONCLUSION RATHER THAN OF A WORKLOAD***, which is why
     * it gets a name of its own instead of being left to `resource(...)`. What a
     * reader wants off this object is `status.carry` — what that program
     * decided — and `carriedBy` is the parser for it.
     *
     * Reading it needs `radiant:reconcile/observe-perseids@0.1.0`. That is a
     * SEPARATE grant from `observe` on purpose: "may see another program's
     * conclusions" and "may see a Deployment's replica count" are different
     * sentences, and a manifest should be able to say one without the other.
     *
     * A four-argument `resource('radiant.apsis', 'v1', 'perseids', name)` is the
     * same string and is exactly the call this builder exists to remove — the
     * group and the plural are both easy to get subtly wrong, and a wrong path
     * reads as a permanent `absent`, not as an error.
     */
    perseids: <N extends string>(name: N) =>
      `/apis/radiant.apsis/v1/namespaces/${namespace}/perseids/${name}` as Canonical<
        'apiserver-path',
        `/apis/radiant.apsis/v1/namespaces/${NS}/perseids/${N}`
      >,

    /** Any grouped resource: `/apis/GROUP/VERSION/namespaces/NS/KIND/NAME`. */
    resource: <G extends string, V extends string, K extends string, N extends string>(
      group: G,
      version: V,
      kind: K,
      name: N,
    ) =>
      `/apis/${group}/${version}/namespaces/${namespace}/${kind}/${name}` as Canonical<
        'apiserver-path',
        `/apis/${G}/${V}/namespaces/${NS}/${K}/${N}`
      >,

    /** Any core resource: `/api/VERSION/namespaces/NS/KIND/NAME`. */
    core: <V extends string, K extends string, N extends string>(version: V, kind: K, name: N) =>
      `/api/${version}/namespaces/${namespace}/${kind}/${name}` as Canonical<
        'apiserver-path',
        `/api/${V}/namespaces/${NS}/${K}/${N}`
      >,

    /**
     * `/api/v1/namespaces/NS/KIND` — a core-group COLLECTION, what `list(...)` and
     * `fields(...)` take (ADR-0101). `collection('configmaps')`, `collection('pods')`.
     */
    collection: <K extends string>(kind: K) =>
      `/api/v1/namespaces/${namespace}/${kind}` as Canonical<
        'collection-path',
        `/api/v1/namespaces/${NS}/${K}`
      >,

    /** `/apis/GROUP/VERSION/namespaces/NS/KIND` — a grouped COLLECTION. */
    collectionOf: <G extends string, V extends string, K extends string>(
      group: G,
      version: V,
      kind: K,
    ) =>
      `/apis/${group}/${version}/namespaces/${namespace}/${kind}` as Canonical<
        'collection-path',
        `/apis/${G}/${V}/namespaces/${NS}/${K}`
      >,
  }),
  /**
   * A CLUSTER-SCOPED object: `/apis/GROUP/VERSION/RESOURCE/NAME`.
   *
   * No namespace, because there is none - which is exactly why reading one needs
   * `spec.reads` to name it and `observe-cluster` to be imported. `path.ns(...)`
   * builds the other kind and the two are not interchangeable.
   */
  cluster: <G extends string, V extends string, R extends string, N extends string>(
    group: G,
    version: V,
    resource: R,
    name: N,
  ) =>
    `/apis/${group}/${version}/${resource}/${name}` as Canonical<
      'cluster-path',
      `/apis/${G}/${V}/${R}/${N}`
    >,

  /**
   * A NODE: `/api/v1/nodes/NAME`.
   *
   * ***THE ONE CLUSTER KIND A CONTROLLER ROUTINELY WRITES***, and the reason it
   * gets a name rather than being left to `clusterCore('v1', 'nodes', n)`:
   * cordoning is `spec.unschedulable`, and the four-argument form is exactly the
   * call this builder exists to remove - `nodes` is easy to write `node`, and a
   * wrong resource reads as a permanent `absent` on the read side and a refused
   * write on this one.
   */
  nodes: <N extends string>(name: N) =>
    `/api/v1/nodes/${name}` as Canonical<'cluster-path', `/api/v1/nodes/${N}`>,

  /** A cluster-scoped object in the CORE group: `/api/VERSION/RESOURCE/NAME`. */
  clusterCore: <V extends string, R extends string, N extends string>(
    version: V,
    resource: R,
    name: N,
  ) =>
    `/api/${version}/${resource}/${name}` as Canonical<
      'cluster-path',
      `/api/${V}/${R}/${N}`
    >,
} as const

/**
 * Adopt a path that only exists at RUNTIME — from config, an env var, an
 * annotation — after checking it the way the host will.
 *
 * ***IT THROWS RATHER THAN RETURNING A RESULT, AND THAT IS DELIBERATE.*** A step
 * that could handle a malformed path would have to decide what to do about it,
 * and every available answer is worse than stopping: emitting the obligation
 * anyway is a write at an unknown target, and skipping it is a program that
 * looks healthy and reconciles nothing. The builder above covers every path
 * known at authoring time, so reaching this function at all means the value came
 * from outside the program.
 *
 * The check mirrors `namespacedName` — ANCHORED ON POSITION, not searched for.
 * That is not a detail: the host's first version scanned for a segment equal to
 * `namespaces`, which a group literally named `namespaces` can shift. A parse an
 * attacker can shift is a boundary an attacker can cross, so a laxer check here
 * would admit strings the host then reads differently.
 */
export function unsafeApiPath(candidate: string): ApiPath {
  const parts = candidate.replace(/^\/+|\/+$/g, '').split('/')
  const at = parts[0] === 'api' ? 2 : parts[0] === 'apis' ? 3 : -1
  const ok =
    at > 0 &&
    parts[at] === 'namespaces' &&
    at + 3 < parts.length &&
    parts[at + 1] !== '' &&
    parts[at + 2] !== '' &&
    parts[at + 3] !== ''

  if (!ok) {
    throw new Error(
      `unsafeApiPath: ${JSON.stringify(candidate)} is not a namespaced apiserver path. ` +
        'Expected /api/VERSION/namespaces/NS/KIND/NAME or ' +
        '/apis/GROUP/VERSION/namespaces/NS/KIND/NAME. The host refuses anything else ' +
        'rather than treating it as belonging to the grant, so this would observe ' +
        '`unknown` forever while looking healthy.',
    )
  }

  return candidate as ApiPath
}

/**
 * Refuses a PATH in a NAME position, as a guard parameter.
 *
 * ***A GUARD TUPLE RATHER THAN A CONDITIONAL PARAMETER TYPE, AND THE CHOICE IS
 * MEASURED — IT IS THE OPPOSITE OF THE ONE `quiesce` MAKES.*** A name position
 * must do two things at once: OFFER the real workload names, and REFUSE a path.
 * Three forms, completions and rejection counted separately:
 *
 *	name: WorkloadName                    completions 3   path rejected NO
 *	name: NotAPath<N>  (conditional)      completions 0   path rejected yes
 *	name: N + this guard                  completions 3   path rejected yes   ← this
 *
 * A conditional parameter type is unresolved at the caret, so the language
 * service offers nothing — the same class of silent completion loss measured on
 * `Wit`. `quiesce` can afford the conditional because there is no vocabulary to
 * complete there, only an empty string to refuse; here there is, so the worse
 * error message is the right trade.
 *
 * ⛔ ***NOTHING REFERENCES THIS ANY MORE, AND THAT IS NOT A REASON TO DELETE
 * IT.*** The paragraph below records why the guard stopped being needed — the
 * `Get(path, field)` inversion made a bare name the unresolvable thing — so this
 * is a documented vestige rather than an oversight. An audit that greps for
 * unreferenced exports finds it, correctly, and the next step is the wrong one:
 *
 * ***IT IS AN EXPORTED TYPE IN A PUBLISHED PACKAGE.*** `@apsis-io/periapsis-sdk`
 * has shipped to npm through `periapsis-sdk-v0.1.0 … v0.2.0`, so removing it is a
 * BREAKING CHANGE for anyone importing it, not a tidy-up. Whether that is worth a
 * major is a release decision and belongs to whoever cuts one — not to a sweep
 * that measured only this repo, which cannot see a downstream consumer at all.
 *
 * Kept deliberately. Delete it in a release that says so.
 */
export type RefusesAPath<N extends string> = N extends `/${string}`
  ? [ERROR_a_PATH_was_passed_where_a_NAME_goes_the_grant_supplies_the_namespace: never]
  : []

// ═══════════════════════════════════════════════════════════════════════════
// ***EVERY BUILDER BELOW TAKES A PATH, AND THAT IS AN INVERSION RATHER THAN A
// WIDENING (2026-08-30).***
//
// They took bare NAMES, guarded by `RefusesAPath` so a path in a name position
// was a compile error. `Get(path, field)` replaced the eight name-taking read
// symbols, so the polarity flipped: a NAME is now the thing that cannot be
// resolved, because there is no symbol left that borrows a namespace from the
// grant.
//
// ***THE GUARD DID NOT SURVIVE AND DID NOT NEED TO.*** `ApiPath` is a branded
// type with no string constructor - `path.ns(x).deployments(y)` is the only way
// to make one - so a bare name in a path position is already a type error, and
// with a BETTER message than the guard tuple produced. What the guard bought
// (completions at the caret, measured: 3 vs 0) the builder buys too, and from
// the same cluster vocabulary.
//
// ⚠ ***THIS IS A BREAKING CHANGE TO EVERY COMPONENT SOURCE.*** `replicasNe('api',
// 3)` does not become `replicasNe(path, 3)` by accident: it fails to compile,
// which is the outcome to want. A silently-accepted rename would have parked the
// fleet on conditions that never fire.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wake when an object EXISTS — or, if it does, when it stops existing.
 *
 * ANY KIND: the path says which. The field is `metadata.name`, which every
 * object has and which is therefore ABSENT exactly when the object is.
 *
 * Renamed from `exists`, which took a pod NAME and could only ever watch a pod.
 */
// ═══════════════════════════════════════════════════════════════════════════
// ***THESE TAKE `PathLike`, NOT `ApiPath`, SO A PARK CAN TRAVERSE AN EDGE.***
//
//	quiesce(fieldNe(ownedBy(pod), 'spec.replicas', 3))
//
// `expr.ts` has accepted `ApiPath | Expr<'path'>` since edges landed; these three
// narrowed it back to `ApiPath`, which made the object graph unreachable from a
// STEP - the only place a park is ever written. The mechanism was landed, tested,
// deployed and unusable by any program, which is the shape ADR-0106 already names
// about the wake.
//
// ⚠ ***A PARK ON AN EDGE WATCHES THE SOURCE, NOT THE TARGET*** (declared in
// reconcilehost's `unwatchableSymbols`). Subjects come from an expression's
// LITERALS, and the only literal in `fieldNe(ownedBy(pod), …)` is the POD. So
// this is correct when the thing that changes your answer lives on the SOURCE -
// a pod being rescheduled changes `spec.nodeName` ON THE POD - and degrades to
// the backstop poll when it lives on the target.
//
// ⛔ ***AND `nodeOf` HAS A SECOND CONSTRAINT THAT `ownedBy` DOES NOT: ITS TARGET
// MUST ALREADY BE IN `spec.reads`.*** A Node is cluster-scoped, and cluster reads
// are granted per OBJECT by name - so a program can only traverse to a node it
// declared in advance, which the common case ("whichever machine my pod landed
// on") cannot do. `ownedBy` is free of this: an owner is namespaced, so it is
// bounded by the grant's namespace and the kind's capability, both of which a
// program already holds for its own workloads.
// ═══════════════════════════════════════════════════════════════════════════
export const objectExists = (path: E.ReadPathLike): Resume =>
  E.exists(E.get(path, 'metadata.name'))

/**
 * Wake when an object is GONE.
 *
 * *** A NEGATION, NOT A COMPARISON — AND FOR TWO REASONS. *** The grammar has no
 * boolean literals, so `== false` does not parse. And it is the correct form:
 * `exists` maps Known->true, Absent->false, Unknown->Unknown, and `!` propagates
 * a non-Known observation rather than flipping it. *** An object that cannot be
 * read is not "missing" *** — treating it as missing would wake a program to
 * tear something down because the apiserver blipped.
 *
 * Renamed from `missing`, and it replaces `workloadMissing` too: those differed
 * only in which kind their symbol named, and the path says that now.
 */
export const objectGone = (path: E.ReadPathLike): Resume =>
  E.not(E.exists(E.get(path, 'metadata.name')))

/** Wake when the pods matching a LABEL SELECTOR stop numbering n. */
/**
 * Wake when ANY object matching `selector` has `field` other than `want`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⭐ ***ONE PARK OVER A WHOLE KIND - THE THING THAT WAS INEXPRESSIBLE UNTIL
 * 2026-09-06.*** Before `min`/`max`, the only question a park could ask of a set
 * was its SIZE, so a program watching N objects had to NAME all N. `sentinel.ts`
 * hard-codes four subjects and `drainer.ts` one node for exactly this reason,
 * and a fleet-wide watchdog meant one Perseid per node.
 *
 *     anyFieldNe(path.ns('default').deployments(), 'tier=web', 'status.readyReplicas', 3)
 *
 * ⚠ ***THE SET IS ONE SUBJECT TO THE WAKE INDEX***, keyed by (collection,
 * selector) - so this costs one watch however many objects match, and objects
 * ENTERING or LEAVING the selector are covered without the program knowing their
 * names. That is the half a per-object park cannot do at all.
 *
 * ⛔ NUMERIC FIELDS ONLY, and an EMPTY match is an ERROR rather than "nothing is
 * wrong". A selector matching nothing usually means the selector is wrong, and
 * answering `false` there would report a healthy fleet for a typo.
 */
export const anyFieldNe = (
  collection: CollectionPath,
  selector: LabelSelector | '',
  field: string,
  want: number,
): Resume =>
  E.or(E.ne(E.minOf(E.fields(collection, selector, field)), want),
       E.ne(E.maxOf(E.fields(collection, selector, field)), want))

/**
 * Wake when EVERY object matching `selector` has `field` equal to `want` - the
 * convergence half of `anyFieldNe`, for a program that parks until a fleet is
 * uniform rather than until it breaks.
 */
export const allFieldsAre = (
  collection: CollectionPath,
  selector: LabelSelector | '',
  field: string,
  want: number,
): Resume =>
  E.and(E.eq(E.minOf(E.fields(collection, selector, field)), want),
        E.eq(E.maxOf(E.fields(collection, selector, field)), want))

export const countNe = (selector: LabelSelector, n: number): Resume =>
  E.ne(E.length(E.listPods(selector)), n)

/**
 * Wake when the pods matching a SELECTOR stop numbering what the WORKLOAD asks
 * for.
 *
 * ***NEWLY EXPRESSIBLE, AND ONLY BECAUSE aperture GREW A TYPE SYSTEM AND
 * ARITHMETIC ON 2026-08-29.*** Every other builder here compares an observation
 * to a LITERAL the guest already knows. This compares two OBSERVATIONS, which
 * the language could not express while a comparison's right-hand side had to be
 * a constant.
 *
 * It is the wake condition a level-triggered scaler actually wants. `countNe`
 * needs the guest to supply the desired count, so a park is stale the moment
 * anyone edits `spec.replicas`; this one re-reads BOTH sides at wake time, so a
 * spec change to a different number wakes the program rather than leaving it
 * parked on a target nobody wants any more.
 *
 * Verified against the host's own parser and checks by
 * `TestSDKResumeExpressions_ParseAndTypecheck` in periapsis's aperture - the guest
 * builds these and cannot evaluate them, so "aperture accepts this" is a claim
 * that needs a test rather than a comment.
 *
 * Renamed from `countNeReplicas`: the right-hand side is a FIELD now, and
 * naming it in the function meant a second name per field.
 */
export const countNeField = (
  selector: LabelSelector,
  workload: ApiPath,
  field = 'spec.replicas',
): Resume => E.ne(E.length(E.listPods(selector)), E.get(workload, field))

/**
 * Wake when a FIELD of an object stops being n.
 *
 * *** PREFER THIS TO countNe FOR A SCALER, AND THE DIFFERENCE IS NOT
 * COSMETIC. *** countNe observes PODS, which is a lagging, flapping proxy for
 * the field a scaler actually reconciles toward:
 *
 *     during a rollout the pod count passes through values nobody set
 *     a crashlooping pod changes the count without the spec changing
 *     a spec change to the SAME count is invisible to a pod census
 *
 * `spec.replicas` is the desired count, the thing the program writes with
 * `Ensure`. Parking on the field you maintain is what makes a level-triggered
 * program level-triggered.
 *
 * The kind's read capability still applies, and every resume expression is
 * evaluated with a FIXED capability set that excludes `secrets:read`
 * (periapsis's reconcile host states the extent). The grant's namespace
 * and labels still apply too: an object outside them reads ABSENT, so this wakes
 * on "not there" rather than on a permission error.
 *
 * Renamed from `replicasNe`, and generalised with it - the field is a parameter
 * because `Get` made every field reachable, so a builder per field would be the
 * shape the collapse removed.
 */
export const fieldNe = (path: E.ReadPathLike, field: string, n: number): Resume =>
  E.ne(E.get(path, field), n)

/**
 * Wake when a STRING or BOOLEAN field becomes `value`.
 *
 * The scalar sibling of `fieldNe`, for the fields a number cannot express - an
 * annotation, a phase, `spec.unschedulable`. The host has always compared these;
 * until 2026-09-05 this SDK had no way to say so (see `E.ScalarLike`).
 *
 * ***FALSE RATHER THAN TRUE WHILE THE FIELD IS ABSENT***, because an absent
 * operand propagates as unknown and a park holds unless its condition is TRUE.
 * That is the direction you want here: a program parking "until the drain flag
 * appears" must not resume instantly on a node that has no such annotation.
 */
export const fieldIs = (path: E.ReadPathLike, field: string, value: string | boolean): Resume =>
  E.eqScalar(E.get(path, field), value)

/**
 * Wake when a field STOPS being `value` - including by being DELETED.
 *
 * ⛔ ***THE `|| !exists` HALF IS THE WHOLE POINT AND A BARE `!=` IS A BUG
 * HERE.*** Removing an annotation makes the field ABSENT, and `absent != "true"`
 * evaluates to UNKNOWN, not true - so a park written as a plain inequality never
 * fires on the withdrawal it was written to catch, and the program waits out its
 * backstop instead. The failure is invisible: the program does eventually wake,
 * just slowly, and the park LOOKS like it is watching the right thing.
 *
 * `.exists` is a real question on a field precisely because the host narrows to
 * the field before evaluating - a missing one is absent, not unknown - which is
 * what makes this expressible at all.
 *
 * ⭐ ***IT TAKES A NUMBER TOO, SINCE 2026-09-06, AND THE REASON IS MEASURED.***
 * It was string|boolean only, so a NUMERIC field that Kubernetes omits had no
 * builder that could fire on its absence - and `status.readyReplicas` is the
 * canonical one: ***KUBERNETES OMITS IT AT ZERO***, which is precisely the state
 * a watchdog exists to catch. Measured live: a Deployment scaled to 0 carried a
 * `status` of only `conditions`, `observedGeneration` and `terminatingReplicas`,
 * so a `fieldNe(..., 1)` park read ABSENT, propagated UNKNOWN, and never fired.
 * The program noticed on its 60s timer instead - correct, late, and looking
 * subscribed the whole time.
 *
 * So the string case and the numeric case have the SAME trap and now have the
 * same remedy. `fieldNe` remains right where the field is always present.
 *
 * ⚠ ***THE `typeof value === 'number'` BRANCH IS RENDERING-EQUIVALENT TODAY AND
 * IS STILL NOT REDUNDANT.*** `scalarText` does `String(v)` for anything
 * non-string, so `neScalar(get, 1)` emits `!= 1` exactly as `ne` does - a
 * mutation replacing the numeric arm with the scalar one is EQUIVALENT and no
 * test can catch it, which is why one is not written. What the branch buys is at
 * the TYPE level: `neScalar` takes `ScalarLike` (string|boolean), so without it a
 * caller must cast a number, and a cast is where the next wrong type gets in.
 * Dispatching to the numeric comparator is also what stays correct if either
 * renderer ever stops coinciding.
 */
export const fieldNoLonger = (
  path: E.ReadPathLike,
  field: string,
  value: string | boolean | number,
): Resume =>
  E.or(
    E.not(E.exists(E.get(path, field))),
    typeof value === 'number'
      ? E.ne(E.get(path, field), value)
      : E.neScalar(E.get(path, field), value),
  )

// ---------------------------------------------------------------------------
// DERIVING A RESUME FROM WHAT THE STEP ACTUALLY OBSERVED.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***A HAND-WRITTEN RESUME NAMES THE OBJECT A SECOND TIME, AND THE TWO SPELLINGS
// ARE NOT CHECKED AGAINST EACH OTHER.*** This is the shape every example had:
//
//	const deployment = path.ns('default').deployments('api')   // what it OBSERVES
//	const workload   = 'api'                                   // what it PARKS on
//	quiesce(replicasNe(workload, want))
//
// Those are two spellings of one object, written apart, kept in step by hand.
// Nothing in the type system, the host, or the grant relates them - `ApiPath` is
// branded precisely so a path cannot be typed by hand, and then the resume takes
// a bare NAME, which can. Edit the path to `deployments('api-v2')` and the
// program observes the new object and parks on the old one: it wakes when a
// deployment it no longer reads changes, and sleeps through every change to the
// one it does.
//
// ***THAT FAILURE IS INVISIBLE FROM BOTH SIDES.*** The step is correctly asleep
// on a well-formed condition, `quiesce` returns nothing to the guest, and the
// host cannot know the two were meant to agree. It is ADR-0075's "asleep on a
// condition nobody will satisfy", reached by an edit rather than a design error.
//
// So derive it. The path the step read IS the input, so there is no second
// spelling to drift - the same reason `path` is a builder rather than a string.
// ═══════════════════════════════════════════════════════════════════════════

/** `/apis/apps/v1/namespaces/<ns>/deployments/<name>`, the shape `path.ns().deployments()` builds. */
const DEPLOYMENT_PATH = /^\/apis\/apps\/v1\/namespaces\/[^/]+\/deployments\/([^/]+)$/

/**
 * The workload NAME an apiserver path addresses.
 *
 * Exported because a resume often needs the name in more than one clause, and
 * deriving it twice from the one path is still one source of truth - whereas a
 * `const workload = 'api'` beside the path is a second one.
 *
 * ***THROWS RATHER THAN RETURNING A GUESS.*** A path this cannot read is a
 * program asking for a resume the SDK has no derivation for, and the useful
 * answer is which explicit helper to reach for. Returning something plausible
 * would produce an expression that parses, evaluates, and watches the wrong
 * object - the failure mode this whole section exists to remove.
 */
export const workloadOf = (observed: ApiPath): WorkloadName => {
  const m = DEPLOYMENT_PATH.exec(observed)
  if (!m) {
    throw new Error(
      `workloadOf: ${observed} is not a deployment path, so there is no replica count to ` +
        'watch. Autoderivation covers deployments (the object `scale` writes); for anything ' +
        'else name the condition explicitly - podExists, countNe, deadlineIn - so the resume ' +
        'says what it means rather than being inferred wrongly.',
    )
  }

  return m[1] as WorkloadName
}

/**
 * Wake when the object this step OBSERVED stops holding the value it SAW.
 *
 * The two arguments are the observation itself: the path that was read, and the
 * value that came back. Both are already in hand at the moment a step decides to
 * park, so there is nothing to restate and nothing to keep in step.
 *
 *     known: when(
 *       [(o: KnownReplicas) => o.v === want, ({ v }) => quiesce(untilDrift(deployment, v))],
 *       …
 *     )
 *
 * ***IT PARKS ON WHAT IT SAW, NOT ON WHAT IT WANTED, AND THOSE DIFFER MORE THAN
 * THEY LOOK.*** At the moment of quiescing they are equal - that is why the step
 * quiesced - so the emitted expression is identical either way. What differs is
 * what happens when the target changes: `want` is the program's own constant and
 * cannot drift, while `v` is a fact about the cluster. Deriving from the
 * observation means the resume is a statement about the world rather than a copy
 * of a literal that also appears three lines up.
 *
 * Uses `Replicas`, which reads `spec.replicas` - the DESIRED count, the field a
 * scaler writes - for the reasons `replicasNe` sets out at length: a pod census
 * lags, flaps during a rollout, and cannot see a spec change to the same count.
 */
export const untilDrift = (observed: ApiPath, seen: number): Resume => {
  // ***THE NAME IS DISCARDED AND THAT IS THE POINT.*** `workloadOf` exists to
  // pull a NAME out of a path, because the read symbol took a bare name and a
  // park therefore had to be re-addressed in a second vocabulary. `Get` takes
  // the path, so the round trip is gone - what is left of that call here is its
  // VALIDATION, which still matters: it refuses a path that does not address a
  // deployment, and refuses a subresource (`.../scale`), which is a different
  // object than the one this parks on.
  workloadOf(observed)

  return fieldNe(observed, 'spec.replicas', seen)
}

/**
 * Wake at an ABSOLUTE deadline, in epoch millis.
 *
 * *** TAKES THE INSTANT, NOT A DELAY, AND THAT IS THE POINT. *** A delay is
 * relative to a park that happens elsewhere, so evaluating it needs a `parkedAt`
 * travelling alongside — two facts that must stay correct, only one of which is
 * the "data" this design promises. An absolute deadline means the same thing in
 * the driver, in a status renderer and in an operator's terminal a week later.
 *
 * Use `deadlineIn` when you have the guest's own clock.
 */
// ***TAKES bigint TOO, BECAUSE THE WIT CLOCK RETURNS ONE.***
// `reconcile.wit:96` is `now: func() -> u64`, and a u64 arrives in JS as a
// BigInt — so `deadlineIn(5_000, now())`, the obvious call, would throw
// TypeError on `bigint + number` INSIDE THE PRODUCER, before any string is
// emitted and where no host-side test of the output form could ever see it.
//
// Two places in this repo already wrote `Number(now())` by hand, which is the
// binding telling us what it returns. Coercing here means the obvious call
// works instead of the correct call needing a wrapper nobody can be relied on
// to remember (radiant-main found this; comet is unaffected because its `now`
// is a `defineEffect<void, number>` rather than the WIT import).
export const deadline = (atEpochMillis: number | bigint): Resume =>
  E.ge(E.now(), Math.trunc(Number(atEpochMillis)))

/**
 * `deadline`, computed from the guest's clock: wake `ms` from `nowEpochMillis`.
 *
 * *** BOTH ARGUMENTS ARE REQUIRED so there is no hidden second time source. ***
 * `now` is a capability (reconcile.wit's `observe.now`), not a syscall — a
 * replay supplies a recorded one and a step stays a pure function of its
 * observations. Reading a clock inside this helper would defeat that.
 */
export const deadlineIn = (ms: number, nowEpochMillis: number | bigint): Resume =>
  deadline(Number(nowEpochMillis) + ms)

// ═══════════════════════════════════════════════════════════════════════════
// ***A CONVENTION FOR THE TWO RETIRED SYMBOLS BELOW, SO THE NEXT CENSUS IS NOT
// LIED TO.*** A retirement notice written with call parens makes every future
// `grep 'changed('` hit the one place the symbol is most thoroughly dead — the
// better the documentation, the more false positives in exactly the search
// somebody runs to check whether it is gone. It already cost this: a census
// reported comet as a live caller when its code calls were zero, and the number
// travelled into two peers' conclusions.
//
//     text ABOUT the symbol   -> write it BARE      `changed`
//     text QUOTING the caller -> KEEP the parens    `changed(${ref})`
//
// The throw strings below are the second kind ON PURPOSE. They echo what the
// user typed, and that is the one thing an error message exists to be
// recognisable as. Do not "fix" them (seam-vision drew this boundary).
//
// ***AND THIS NOTE SELF-MATCHES, UNAVOIDABLY — DO NOT "FIX" THAT EITHER.***
// A rule about parens must display parens, and a warning that a search gives
// false positives has to contain the search. So this text is a THIRD kind,
// neither about-the-symbol nor quoting-the-caller: it is about the SEARCH, and
// it is the one case where self-matching cannot be written around.
//
// ***WHICH IS FINE, BECAUSE THE SECOND AXIS IS WHERE, NOT ONLY WHAT***
// (radiant-main):
//
//     a polluting mention in a CALLER file    indistinguishable from a call
//     the same mention in the DEFINING file   trivially excluded — a census of
//                                             callers excludes the definition
//                                             by definition
//
// Both mentions that actually cost something tonight were in CALLER files
// (comet, perseid-ts) and both are now bare. The residue is confined to this
// file, which anybody counting callers already skips.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * *** REPLACED BY `deadlineIn(ms, now)`, AND THIS THROWS RATHER THAN INVENTING A
 * CLOCK. ***
 *
 * `after` was a delay with no instant attached, which only worked because
 * something downstream supplied the park time — the `parkedAt` side-car this
 * change exists to delete. Restoring it here would mean either reading a clock
 * inside the SDK (destroying replayability: `now` is a CAPABILITY, so a replay
 * supplies a recorded one and a step stays a pure function of its observations)
 * or re-introducing the second value that has to stay correct.
 *
 * Kept as a throwing export rather than deleted so the four call sites still
 * RESOLVE their import and fail with this sentence instead of a module-level
 * "no such export", which says nothing about what to do.
 *
 * ⚠ ***aperture GREW ARITHMETIC ON 2026-08-29, SO THE OBVIOUS FIX IS NOW
 * SPELLABLE AND IS SILENTLY WRONG.*** `Now() + ms` looks like it restores this
 * builder, and it does not:
 *
 *	Now() >= Now() + 60000     parses ✓   arity ✓   pure ✓   ALWAYS FALSE
 *
 * Measured against the host's own checks. A resume is re-evaluated on every wake
 * check, so BOTH sides move together and the right-hand side stays 60 seconds
 * ahead forever. Nothing errors, nothing logs, and the program is parked on a
 * condition that cannot become true - which `reconcile.wit` calls *"a program
 * correctly asleep on a condition nobody will satisfy, indistinguishable from a
 * program correctly asleep."*
 *
 * A delay needs an anchor the expression cannot see. `deadlineIn(ms, now)` takes
 * the instant from an observation, which is the whole point: the anchor is DATA
 * the step observed, not a clock the resume reads.
 */
export const after = (ms: number): Resume => {
  throw new Error(
    `perseid: after(${ms}) is gone — a resume carries an ABSOLUTE deadline now. ` +
      'Use deadlineIn(ms, Number(now())), or deadline(atEpochMillis). ' +
      // ***NAMES WHERE `now` COMES FROM, BECAUSE IT IS NOT AN SDK EXPORT.*** A
      // reader following this advice greps this file for `now`, finds nothing,
      // and concludes the remedy is broken — the inert-advertised-remedy defect,
      // in the one message that only ever fires at somebody already stuck. It is
      // a WIT import, deliberately: the clock is a capability, not a syscall.
      "`now` is imported from the world, not from this SDK: " +
      "import { now } from 'radiant:reconcile/observe@0.1.0'. " +
      'A bare delay needed a parkedAt travelling beside the expression, and that side-car is ' +
      'exactly what the expression form removes.'
  )
}

/**
 * *** NOT EXPRESSIBLE, AND THIS THROWS RATHER THAN GUESSING. ***
 *
 * `changed` has no aperture equivalent and never had one:
 *
 *   - aperture has no notion of CHANGE. There is no resourceVersion,
 *     generation, or previous-value in the language — every symbol answers
 *     "what is true now", so "it moved" cannot be written.
 *   - ~~it has no DEPLOYMENT symbol either.~~ *** THAT HALF WAS CLOSED
 *     2026-08-22 — SEE `replicasNe` ABOVE. *** `workloads:read` now confers
 *     `Replicas`, so a resume expression CAN name a workload. Only the CHANGE
 *     half remains, and it is the half that was never going to be a wiring job.
 *
 * *** SO THE DECISION IS: `changed` STAYS RETIRED, AND IT IS NOT WAITING ON
 * ANYTHING. *** Every call site that reached for it wanted "wake when the thing
 * I maintain moves", and that is `replicasNe(name, n)` — parked on the DESIRED
 * count, which is the field the program actually writes. `changed` was the
 * question you ask when you cannot read the field; you can now read the field.
 *
 * What "changed" would additionally buy is waking on a spec edit to the SAME
 * value, and paying for it means the host remembering each parked program's
 * previous observation — per-program state behind an interface whose whole
 * invariant is that a resume is DATA the host evaluates without running the
 * step. That is an ADR, not a symbol, and nothing is currently asking for it.
 *
 * *** IT ALSO NEVER WORKED. *** The Go host's typed Resume had no `changed` arm,
 * so a park using it decoded to the zero discriminant and was refused. The four
 * call sites are dev-host scripts and one example; nothing in production
 * depended on it, because nothing could.
 *
 * Throwing keeps every caller COMPILING while making it impossible to emit an
 * expression the host cannot evaluate — a silent substitution here would park a
 * program on a condition that looks right and never fires. Closing it properly
 * is a capability decision (a `workloads:read` conferring `GetDeployment`, plus
 * whatever "changed" should mean in a language with no history) and belongs to
 * engi.
 */
export const changed = (ref: string): Resume => {
  throw new Error(
    `perseid: changed(${JSON.stringify(ref)}) is not expressible as an aperture resume. ` +
      'aperture has no notion of change (no resourceVersion/generation), and the Go host ' +
      'never had a `changed` arm - a park using it was always refused. USE replicasNe(name, n) ' +
      'if you meant "wake when the workload I maintain moves": that reads spec.replicas ' +
      'directly and is what every call site here wanted. Otherwise countNe/exists/missing on ' +
      'what you can observe, or deadlineIn for a poll.'
  )
}

// `paren`, not `group`: this file already EXPORTS a `group` Step combinator
// (see below), and a second declaration merges with it rather than shadowing.
/**
 * Wake at the host's BACKSTOP, and nothing else of your own.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***THE HOST ALREADY DOES THIS TO EVERY PARK*** - `internal/aperture/eval.go`
 * renders `(<the whole user resume>) || Backstop()` in `WithBackstop`. So this
 * does not ADD liveness; it lets a program SAY that a bounded recheck is the
 * intent, instead of the idiom it replaces:
 *
 *     anyOf(resume, deadline(Date.now() + RECHECK_MS))   // three things wrong
 *     anyOf(resume, backstop())                          // says it, costs nothing
 *
 * The old idiom is REDUNDANT (the host adds its own), STALE BY CONSTRUCTION
 * (`Date.now()` runs when the step builds the expression, and the host evaluates
 * it at wake time), and it SPENDS A DISJUNCT - an operand `on()` then has to
 * skip when mapping a held index back to an arm.
 *
 * ⚠ ***ALONE IT IS ONLY AS BOUNDED AS THE BACKSTOP IS.*** Under
 * `-perseid-backstop=off` a program parked on this waits forever, and the only
 * symptom is that its passes counter stops climbing. Reach for a real condition
 * unless the wake is genuinely time-only.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const backstop = (): Resume => untilBackstop

/**
 * Wake when ANY sub-condition holds.
 *
 * ***`backstop()` OPERANDS ARE FOLDED AWAY, BECAUSE `X || false` IS `X`.*** The
 * point is not brevity - it is that an operand costs an INDEX. The host flattens
 * `||` and reports which operand held; a `false` that can never hold would still
 * shift every arm after it, so writing the intent would silently change the
 * dispatch. Folding is what makes `backstop()` free to say.
 *
 * ⚠ Only here. In `allOf`, `X && false` is `false` - folding there would turn a
 * park into one that can never fire.
 */
export const anyOf = (...of: Resume[]): Resume => {
  const live = of.filter((r) => (r as unknown as string) !== (untilBackstop as unknown as string))

  // Every operand was a backstop, so that IS the park - `false` alone, which is
  // exactly what `untilBackstop` means.
  return live.length === 0 ? untilBackstop : E.or(...live)
}

/**
 * Wake when EVERY sub-condition holds.
 *
 * *** A TIME BOUND INSIDE THIS IS NOT A BACKSTOP. *** It is gated by its
 * siblings and cannot fire alone, so the host will add its own — see
 * `reconcilehost.hasTimeBound`. If you want a guaranteed wake, put the deadline
 * in an `anyOf`.
 */
export const allOf = (...of: Resume[]): Resume => E.and(...of)

/**
 * Park until the BACKSTOP. Nothing but time will wake this.
 *
 * ***THE PRINCIPLED SPELLING OF WHAT `quiesce('')` REFUSES.*** An empty resume
 * is a compile error because "a park must say what would change its mind" - and
 * a backstop-only park is a legitimate thing to want, so until boolean literals
 * entered the grammar there was no way to SAY it. An empty resume meant both "I
 * forgot" and "nothing will"; now empty means you forgot and this means you
 * meant it.
 *
 * ⚠ ***IT IS ONLY BOUNDED IF A BACKSTOP IS SET.*** With
 * `-perseid-backstop=off` a program parked on this waits forever and the only
 * symptom is that its passes counter stops climbing - which is precisely what
 * ADR-0075 invariant 5 exists to prevent. Reach for a real condition unless the
 * wake is genuinely time-only.
 */
export const untilBackstop: Resume = 'false' as Resume

/**
 * Re-run at the next poll: a yield that is PACED rather than immediate.
 *
 * Differs from `yieldStep` in who decides the interval. A yield says "run me
 * again now" and the driver's own spin guard is what stops it burning; this
 * parks properly and comes back at the poll interval, so the pacing is the
 * host's configuration rather than a floor the driver has to enforce.
 */
export const nextPoll: Resume = 'true' as Resume

// ---------------------------------------------------------------------------
// Outcome. `quiesce` REQUIRES a resume expression — there is no way to say "I am
// done for now" without saying what would change your mind. The host is expected
// to add its own bounded `after` backstop on top, so a declared condition that
// is too narrow degrades to a slow poll rather than a lost wakeup.
//
// `carry` is OPTIONAL ON EVERY VARIANT and its ABSENCE IS MEANINGFUL — see
// `remember`/`forget` below, and `internal/reconcilehost/carry.go` for the
// three-valued wire contract this mirrors.
export type Outcome =
  | { readonly o: 'yield'; readonly carry?: string }
  | { readonly o: 'quiesce'; readonly resume: Resume; readonly carry?: string }
  | { readonly o: 'terminate'; readonly carry?: string }

export const yieldStep: Outcome = { o: 'yield' }
export const terminate: Outcome = { o: 'terminate' }

// ---------------------------------------------------------------------------
// Carry: what a probe remembers between passes.
//
// ***THE THREE-VALUED CONTRACT SURVIVES INTO TYPESCRIPT BY ACCIDENT OF
// `JSON.stringify`, WHICH IS NOT A GOOD ENOUGH REASON TO LEAVE IT BARE.*** The
// host reads `carry` as a POINTER (carry.go): absent KEEPS the previous value,
// `""` CLEARS it, anything else SETS it. An omitted TS property and an
// `undefined` one both serialize to an absent key, so the mapping happens to be
// right — and an author who writes `{ o: 'yield', carry: computed }` where
// `computed` came back `''` has silently erased the program's memory, with the
// object simply no longer carrying what it used to and nothing logged.
//
// So the two answers get two SPELLINGS, and the dangerous one cannot be reached
// by an expression that merely evaluated to empty.

/** The host's bound on one program's memory (`MaxCarryBytes`, carry.go). */
export const MAX_CARRY_BYTES = 4096

const carryBytes = (value: string): number => new TextEncoder().encode(value).length

/**
 * Remember `value` across passes, on top of any outcome.
 *
 *     return remember(quiesce(afterMs(60_000)), JSON.stringify(summary))
 *
 * ***AN EMPTY VALUE IS A COMPILE ERROR, NOT A SILENT WIPE*** — the same
 * parameter-position trick as `quiesce('')`, and for a sharper reason. There,
 * the empty resume is refused by the host anyway and the type only moves WHEN
 * you find out. Here the host ACCEPTS `""` as a real answer meaning *forget
 * everything*, so an accidental empty is not an error at any layer: it is a
 * successful pass that destroyed the program's state. `forget()` is the way to
 * say it deliberately.
 *
 * A value that is only empty at RUNTIME throws, for the reason `quiesce` throws:
 * the alternative is data loss that looks like an ordinary pass.
 */
export function remember<O extends Outcome, V extends string>(
  outcome: O,
  value: V extends '' ? never : V,
): O {
  if (value === '') {
    throw new Error(
      'remember: empty value. The host reads "" as CLEAR (carry.go), so this would erase ' +
        "the program's memory rather than leave it alone - which is a successful pass that " +
        'destroyed state. Use forget(outcome) to mean it, or omit the call to keep the ' +
        'previous value.',
    )
  }
  // ***REFUSED HERE, WHERE THE AUTHOR CAN SEE WHAT THEY BUILT.*** The host
  // refuses an over-large carry at the pass that produced it, deliberately
  // (ErrCarryTooLarge) - but that refusal arrives one process away, naming a
  // byte count and not the line that grew. A probe that accumulates a window
  // crosses this bound gradually and in production.
  const n = carryBytes(value)
  if (n > MAX_CARRY_BYTES) {
    throw new Error(
      `remember: ${n} bytes exceeds the host bound of ${MAX_CARRY_BYTES} (MaxCarryBytes). ` +
        'The carry is written to the Perseid OBJECT, so this is an apiserver write, not ' +
        'process memory. A probe that needs more should bound its window, not its history.',
    )
  }

  return { ...outcome, carry: value }
}

/** Deliberately clear what was remembered — the only way to reset a streak. */
export function forget<O extends Outcome>(outcome: O): O {
  return { ...outcome, carry: '' }
}

/**
 * Read what a program published, out of an observed Perseid object.
 *
 * ***THIS IS THE OTHER HALF OF `observe-perseids`*** (engi, 2026-09-05: "one
 * perseid do metrics and writes them as data on itself, another reads them").
 * A step's only self-targeted write is its own status, so a probe publishes on
 * `status.carry` and a reader gets there through an ordinary `observe` of the
 * Perseid path plus this parser.
 *
 * Returns `null` for every shape that is not a published value — absent status,
 * absent carry, a non-string carry, unparseable JSON. ***A PROBE THAT HAS NOT
 * SPOKEN YET AND ONE THAT PUBLISHED GARBAGE ARE BOTH `null` ON PURPOSE***: the
 * reader's correct response to either is to not act on a measurement it does not
 * have, and a gate that distinguished them would be tempted to proceed on one.
 */
export function carriedBy(rawPerseid: string): string | null {
  try {
    const o = JSON.parse(rawPerseid) as { status?: { carry?: unknown } }
    const carry = o.status?.carry

    return typeof carry === 'string' && carry !== '' ? carry : null
  } catch {
    return null
  }
}

/**
 * ***AN EMPTY RESUME IS A COMPILE ERROR, NOT A RUNTIME ONE*** (engi,
 * 2026-08-29: "forbid returning quiesce as func and empty resume").
 *
 * `quiesce('')` is a park with no wake condition. The host ALREADY refuses it —
 * `podstep.go` returns *"step parked with an EMPTY resume"* — so this changes
 * nothing about whether it works; it changes WHEN you find out, from the first
 * live pass against radiant to the build. `examples/wasm/perseid-ts/src/hand.ts`
 * had shipped exactly this call.
 *
 * The mechanism is the parameter type, not the doc comment: when `R` infers as
 * the literal `''` the parameter resolves to `never`, which is uninhabited, so
 * there is no way to satisfy it deliberately. Any other literal — and any value
 * merely typed `string` — passes through as itself.
 *
 * ***THE CONDITIONAL IS IN THE PARAMETER RATHER THAN A GUARD TUPLE ON PURPOSE:
 * IT IS THE SAME REFUSAL WITH A USABLE ERROR.*** A rest-parameter guard reports
 * *"Expected 2 arguments, but got 1"* at the call — a wrong-arity complaint
 * about a one-argument function, which sends the reader looking for a parameter
 * that does not exist. This reports *"Argument of type '""' is not assignable to
 * parameter of type 'never'"* AT THE ARGUMENT. Both refuse; only one points at
 * the empty string.
 *
 * A resume that is only empty at RUNTIME — `quiesce(buildResume())` where the
 * builder returned '' — cannot be seen by any type, so it throws. That is the
 * one place in this file where a throw is right: the alternative is a program
 * that parks forever on a condition nothing can satisfy, which
 * `reconcile.wit` calls *"a program correctly asleep on a condition nobody will
 * satisfy, indistinguishable from a program correctly asleep."*
 */
export function quiesce<R extends Resume>(resume: R extends '' ? never : R): Outcome {
  if (resume === '') {
    throw new Error(
      'quiesce: empty resume. A park must say what would change its mind - the host ' +
        'refuses this ("step parked with an EMPTY resume") and a step that ignored ' +
        'the refusal would wait for a condition nothing can satisfy.',
    )
  }

  return { o: 'quiesce', resume }
}

// ---------------------------------------------------------------------------
// FINALIZE — the deletion path (engi, 2026-08-30: "finalizers can be a
// different entrypoint").
//
// ***A DIFFERENT OUTCOME TYPE, AND THE ABSENCES ARE THE CONTRACT.*** There is no
// `quiesce` here and no failure case, and neither is an oversight:
//
//	NO PARK      a finalizer runs while an object is UNDELETABLE. A park that
//	             held one would be indistinguishable from a correct wait, and
//	             both render as a `waitingFor`. `quiesce` is not in this union,
//	             so it is UNSPELLABLE rather than refused.
//	NO FAILURE   a terminal failure leaves an object undeletable with no path
//	             forward - the exact outcome the split entrypoint exists to
//	             prevent. `retry(reason)` is the honest encoding: either it
//	             eventually completes, or an operator reads why it has not.
//
// The host bounds the retrying (a deadline from `metadata.deletionTimestamp`),
// so a finalizer that never succeeds costs a delayed delete and a Warning Event,
// never a wedged object.
//
// ***A VARIANT RATHER THAN JSON, WHICH IS WHERE THIS DIFFERS FROM `step`.***
// `step.run` returns a string because its outcome carries a resume EXPRESSION -
// open-ended text the type system cannot check. A finalize outcome is closed and
// tiny, so `wit/reconcile/reconcile.wit` declares it as a variant and the
// component model carries the shape. `tag`/`val` is the jco lowering.
export type FinalizeOutcome =
  | { readonly tag: 'done' }
  | { readonly tag: 'retry'; readonly val: string }

/** Cleanup is complete; the host may remove the finalizer and the object goes. */
export const cleanupDone: FinalizeOutcome = { tag: 'done' }

/**
 * Not yet - the host will call again, bounded by its deadline.
 *
 * ***AN EMPTY REASON IS A COMPILE ERROR, THE SAME MECHANISM `quiesce` USES AND
 * FOR A SHARPER REASON.*** A retry HOLDS AN OBJECT UNDELETABLE, so the reason is
 * the only thing an operator can act on - and `reconcilehost.finalizeFromReply`
 * already refuses a blank one at runtime ("finalize asked to RETRY with no
 * reason"). This changes nothing about whether it works; it changes when you
 * find out, from a live delete that will not complete to the build.
 *
 * The mechanism is the parameter type, not the doc: when `W` infers as the
 * literal `''` the parameter resolves to `never`, which is uninhabited.
 *
 * ***THE REASON MUST ALSO BE STABLE ACROSS ATTEMPTS, AND NOTHING CAN ENFORCE
 * THAT.*** The host emits it as a Kubernetes Event on every held tick, and the
 * apiserver aggregates repeated Events only when the text matches EXACTLY - so a
 * reason carrying a timestamp, an elapsed duration or an attempt counter
 * produces one Event row per tick and the apiserver then drops the message
 * entirely in favour of "(combined from similar events)". Measured on
 * 2026-08-31: 58 rows for one object, message discarded. Say WHAT you are
 * waiting for, not HOW LONG you have waited - the Event's own count and
 * timestamps carry the duration.
 */
export function retry<W extends string>(why: W extends '' ? never : W): FinalizeOutcome {
  if ((why as string) === '') {
    throw new Error(
      'retry: empty reason. A retry holds the object undeletable, so the reason is the ' +
        'only thing an operator can act on - the host refuses this ("finalize asked to ' +
        'RETRY with no reason") and the object would be held with a blank explanation.',
    )
  }

  return { tag: 'retry', val: why }
}

/**
 * Drive a finalizer generator, exactly as `runStep` drives a step.
 *
 * ***THE SAME DRIVER ON PURPOSE.*** A finalizer observes and declares like any
 * other pass - it is usually mostly writes - so it is the same effect vocabulary
 * and the same interpreter. What differs is the OUTCOME and the host-side
 * contract around it, which is why this is a distinct export rather than a flag:
 * the two must not be reachable from one another by accident.
 */
export function runFinalize<E extends AnyEffect>(
  finalize: () => Step<E, FinalizeOutcome>,
  handler: HandlerArg<E>,
): FinalizeOutcome {
  // ***THE OUTCOME TYPE IS PINNED HERE TOO, NOT LEFT GENERIC.*** It was `<E, A>`
  // for one commit, which typechecked a finalizer returning ANYTHING - including
  // a step's `Outcome`, which is the one wrong value most likely to be passed by
  // someone adapting an existing program. The entrypoint would then hand the
  // component model a `{o: 'yield'}` where a variant was declared.
  return (runStep as unknown as (f: () => Step<E, FinalizeOutcome>, h: HandlerArg<E>) => FinalizeOutcome)(
    finalize,
    handler,
  )
}

/**
 * The same, awaiting each handler result.
 *
 * ***`finalize.run` IS `async func` SINCE 2026-09-04, AND THIS IS WHY IT HAD TO
 * BE.*** A finalizer decides whether cleanup is complete, which is a question
 * about the world - so it reads, usually through the very same handler as its
 * step. Every read in the contract is `async func`, and a SYNC export cannot
 * await one: the guest trapped with *"no active task state"*. The alternative
 * was a finalizer forbidden to read, which is a worse contract.
 *
 * The outcome type is pinned here for the same reason it is pinned in
 * {@link runFinalize} - a generic `A` typechecks a finalizer returning a step's
 * `Outcome`, which is the one wrong value an author adapting a step will reach
 * for.
 */
export async function runFinalizeAsync<E extends AnyEffect>(
  finalize: () => Step<E, FinalizeOutcome>,
  handler: HandlerArg<E>,
): Promise<FinalizeOutcome> {
  return (
    runStepAsync as unknown as (
      f: () => Step<E, FinalizeOutcome>,
      h: HandlerArg<E>,
    ) => Promise<FinalizeOutcome>
  )(finalize, handler)
}

// ---------------------------------------------------------------------------
// Conditions — the payload of `radiant:reconcile/status@0.1.0`.
//
// engi decided the vocabulary 2026-08-25: copy Kubernetes. This mirrors
// `metav1.Condition` minus the two fields a guest cannot supply — the host owns
// `lastTransitionTime` (it needs the PREVIOUS condition, and a step that held
// one would be doing in-flight bookkeeping) and `observedGeneration` (a fact
// about the object being written).

/**
 * ***`'True'`, NOT `true` AND NOT `'true'`. THE WIT ENUM AND THE KUBERNETES
 * WIRE VALUE DIFFER BY CASE ALONE.***
 *
 * WIT identifiers are lower-case by grammar, so `reconcile.wit` reads
 * `true`/`false`/`unknown`; `metav1.ConditionStatus` is `"True"`/`"False"`/
 * `"Unknown"` and the CRD enumerates exactly those three strings.
 *
 * A lower-cased value is well-formed JSON that FAILS APISERVER VALIDATION, so
 * the report is rejected at write time. `set` returns nothing by contract, so
 * the step cannot see it and the condition simply never appears — which is
 * indistinguishable from a step that chose not to report.
 *
 * ***THIS UNION IS THE REMEDY AND IT IS A MECHANISM, NOT A WARNING.*** The
 * comment above cannot stop anyone; the type makes `status: 'true'` a COMPILE
 * ERROR at the call site, which is the only form of this rule that survives a
 * hurried author. It is also why the type lives in the SDK rather than in the
 * example that needed it first.
 */
export type ConditionStatus = 'True' | 'False' | 'Unknown'

/**
 * One Kubernetes condition, as a step reports it.
 *
 * ***`type` IS AN IDENTITY, NOT A LABEL: A SECOND `set` WITH THE SAME `type`
 * REPLACES RATHER THAN APPENDS***, exactly as `meta.SetStatusCondition` does.
 * Two different facts reported under one `type` are not two conditions — the
 * second silently destroys the first, and the loss is invisible because `set`
 * returns nothing. Give each distinct fact its own `type`.
 *
 * `reason` is CamelCase and machine-readable; `message` is for a human. Both
 * are required non-empty by Kubernetes.
 */
export type Condition = {
  readonly type: string
  readonly status: ConditionStatus
  readonly reason: string
  readonly message: string
}

// ---------------------------------------------------------------------------
// The WIT interface vocabulary.
//
// engi, 2026-08-29: "wit string => auto completion and maybe typed string" -
// BOTH, and the two turned out to fight each other (see `Wit`). These are the
// interfaces `wit/reconcile/reconcile.wit` actually declares, so typing the
// opening quote offers them instead of requiring the id to be recalled and
// retyped per effect.
//
// ***A TYPO HERE IS NOT A COMPILE ERROR ANYWHERE ELSE.*** The id is data: it
// feeds `tools/derive-wit.ts`, which reads it off the yield type to emit the
// component's world. A misspelled interface derives a world naming an import no
// host supplies, and the component then fails to INSTANTIATE — the failure is at
// link time, far from the string that caused it. This file already records the
// same class of defect: main.ts named `radiant:reconcile/emit@0.1.0` for four
// days after that interface was deleted, and it built and passed its own tests
// throughout.
/**
 * The shared vocabulary. TYPES-ONLY: it declares `obs` and no functions, so
 * importing it confers nothing.
 *
 * It exists so `observe` and `observe-cluster` can return the same three-valued
 * observation WITHOUT one implying the other - `use observe.{obs}` made every
 * world importing the cluster read also import the namespaced one, so a program
 * had to be granted a read it never calls.
 */
export const WIT_TYPES = 'radiant:reconcile/types@0.1.0'
export const WIT_OBSERVE = 'radiant:reconcile/observe@0.1.0'
export const WIT_OBSERVE_CLUSTER = 'radiant:reconcile/observe-cluster@0.1.0'
// ***`WIT_WORKLOADS` WAS REMOVED 2026-09-05 WITH THE INTERFACE.*** engi:
// "remove workloads". `scale(path, n)` rendered the same `Ensure(path,
// "spec.replicas", n)` that `ensure` renders, and the interface had already
// stopped conferring anything on 2026-09-01 - so the id named a grant no host
// would honour. Use WIT_ENSURE.
export const WIT_STATUS = 'radiant:reconcile/status@0.1.0'
// ***THE INTERFACE IS THE GRANT, WHICH IS WHY THESE ARE SEPARATE IDS.***
// WIT_ENSURE writes any field `spec.writes` declares and WIT_DELETE removes the
// object outright, so a program permitted to adjust a Deployment must not
// thereby be able to delete it. They cannot share an id.
//
// ⚠ This paragraph cited WIT_WORKLOADS as the narrow case - "scoped to the
// single field spec.replicas" - and that narrowing was removed on 2026-09-01,
// four days before the interface itself. Nothing narrows an Ensure by field
// today; `scopedEffectFields` is an empty mechanism awaiting a user.
export const WIT_ENSURE = 'radiant:reconcile/ensure@0.1.0'
export const WIT_DELETE = 'radiant:reconcile/delete@0.1.0'
export const WIT_CREATE = 'radiant:reconcile/create@0.1.0'
// A program's OWN memory, read back. The write half is not an interface at all -
// it rides on the outcome (see `remember`/`forget`) - and that asymmetry is the
// design: a call could change what a program remembers and then fail, leaving it
// holding a value no pass ever concluded.
export const WIT_CARRY = 'radiant:reconcile/carry@0.1.0'

// Which arms of this program's OWN resume held at the wake that started this
// pass - the host half of keyed dispatch, so `on()` can run the handler for the
// condition that actually holds instead of re-deriving which of N states it is
// in.
//
// ⚠ ***AN INDEX NAMES AN OPERAND OF THE HOST'S FLATTENED DISJUNCTION, NOT A KEY'S
// POSITION.*** This said "a key's POSITION in the map" until 2026-09-06, which is
// true only while every arm is ONE operand wide - and the builders worth using
// are not: `fieldNoLonger` emits `(!exists) || (!= v)`. `on()` maps the reported
// index back through each arm's width; see `topLevelOrCount`.
export const WIT_WOKE = 'radiant:reconcile/woke@0.1.0'

/** The interfaces this SDK knows. Autocompletion comes from this union. */
export type KnownWit =
  | typeof WIT_TYPES
  | typeof WIT_OBSERVE
  | typeof WIT_OBSERVE_CLUSTER
  | typeof WIT_STATUS
  | typeof WIT_ENSURE
  | typeof WIT_DELETE
  | typeof WIT_CREATE
  | typeof WIT_CARRY
  | typeof WIT_WOKE

/**
 * The SHAPE of a WIT interface id: `namespace:package/interface@major.minor.patch`.
 *
 * ***THE ID IS TYPED, NOT MERELY OPEN*** (engi, 2026-08-29: "can you type wit
 * string, or make a builder"). This is the whole reason it is a template literal
 * type and not `(string & {})`: that idiom keeps the set open and validates
 * NOTHING, so `'observe'`, `'radiant:reconcile/observe'` (no version) and
 * `'periapsis/reconcile:observe@0.1.0'` (separators swapped) are all accepted.
 *
 * ***AND A MALFORMED ID IS INVISIBLE UNTIL LINK TIME.*** It is data: it feeds
 * `tools/derive-wit.ts`, which reads it off the yield type to emit the world.
 * A misspelled interface derives a world naming an import no host supplies, and
 * the component then fails to INSTANTIATE — far from the string that caused it,
 * with a message about an unsatisfied import rather than a typo. This tree has
 * already paid for that once: main.ts named `radiant:reconcile/emit@0.1.0` for
 * four days after that interface was deleted, and it built and passed its own
 * tests throughout.
 *
 * `${bigint}` rather than `${number}` for the version segments: `${number}`
 * admits `1e3`, `1.5` and `-1`, which are all valid TypeScript numbers and none
 * of them a semver component.
 *
 * It does not parse WIT — `':/@1.2.3'` satisfies it. It rejects the shapes people
 * actually mistype, which is a different and achievable goal.
 */
export type WitId = `${string}:${string}/${string}@${bigint}.${bigint}.${bigint}`

/**
 * A WIT interface id: the known ones offered by name, any other one accepted if
 * it is WELL-FORMED.
 *
 * ***THIS IS ONE TYPE SATISFYING TWO ASKS THAT PULL APART***: completion of the
 * known ids, and a typed string rather than a bare `string`. Getting either
 * alone is easy and neither is worth much without the other — completion with
 * no validation accepts `'observe'`; validation with no completion means nobody
 * discovers the ids in the first place.
 *
 * The union also keeps the set OPEN — a Perseid may import a host interface this
 * SDK has never heard of, and the SDK is not the right place to decide it
 * cannot. What it may not do is import a malformed one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***THE `& {}` IS LOAD-BEARING AND THE BARE UNION LOSES COMPLETION ENTIRELY.***
 * Measured with the TypeScript language service at the argument position, four
 * forms, completions counted and malformed ids counted separately:
 *
 *	KnownWit | (string & {})    completions 3   malformed rejected 0/2
 *	KnownWit | WitId            completions 0   malformed rejected 2/2
 *	KnownWit | (WitId & {})     completions 3   malformed rejected 2/2   ← this
 *
 * A template literal type in a union SUBSUMES the string literals for
 * completion purposes, so the obvious `KnownWit | WitId` type-checks perfectly
 * and silently offers nothing — the ask-1 behaviour disappears while every
 * assertion about assignability still passes. `& {}` defeats the subsumption
 * without weakening the constraint.
 *
 * ***THIS WAS NOT PREDICTED. It was found by measuring the baseline BEFORE the
 * change and again after***, which is the only reason the regression was
 * visible at all: completion is not a property any type test can assert, so
 * `tsgo --noEmit` is green for all four rows above.
 *
 * What IS guarded, as the nearest structural proxy: `Wit` must not collapse to
 * `string`. Absorption into `string` is exactly what kills completion, and
 * `_WitHasNotCollapsedToString` in perseid.test.ts fires on it — it is also
 * what fails for the old `(string & {})` form, since `string` IS assignable to
 * that.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export type Wit = KnownWit | (WitId & {})

// ---------------------------------------------------------------------------
// Effects.
//
// `wit` is TYPE-ONLY — optional, never assigned, zero runtime cost. It names the
// interface this effect corresponds to, which is what makes a component's world
// derivable from its code instead of maintained beside it.
export type Effect<W extends string, Op extends string, A> = {
  readonly op: Op
  readonly args: A
  readonly wit?: W
}

export type AnyEffect = { readonly op: string; readonly args: unknown }

/**
 * A step: yields effects `E`, returns `A`.
 *
 * E accumulates as a UNION across `yield*`, so it *is* the capability set —
 * tracked by the compiler, with no library needed. A runner that supplies only
 * some of E structurally rejects a step that needs more.
 */
export type Step<E extends AnyEffect, A = Outcome> = Generator<E, A, any>

/**
 * Define an effect wrapper. Curried so the RESULT type is explicit and the
 * argument type is inferred:
 *
 *     const observe = defineEffect<string, Obs<number>>()('radiant:reconcile/observe@0.1.0', 'get')
 *     const scale   = defineEffect<{path: string, n: number}, void>()('radiant:reconcile/workloads@0.1.0', 'scale')
 *
 * `scale` rather than a generic `emit`: actions are TYPED WIT imports as of
 * 2026-08-21, so the effect names the function it calls. The old form passed an
 * op STRING to one `act(op, args)`, which meant importing the interface told you
 * a program could emit SOMETHING and nothing in its types said what.
 *
 * Both type arguments are explicit (<Args, Result>) on purpose: there is no
 * call-site value for TypeScript to infer Args from, and leaving it to be
 * inferred silently resolves it to `unknown` — which then makes every handler
 * argument `unknown` and defeats the point.
 *
 *     const have = yield* observe('replicas')   // Obs<number>, checked
 *
 * USE THIS RATHER THAN HAND-WRITING WRAPPERS. A hand-written wrapper typed as
 * `Generator<AllMyEffects, R, any>` compiles fine and silently destroys the
 * capability tracking — every step then looks like it needs everything. This
 * helper cannot produce that shape.
 */
export function defineEffect<A, R>() {
  return <W extends Wit, Op extends string>(_wit: W, op: Op) =>
    function* (args: A): Step<Effect<W, Op, A>, R> {
      return (yield { op, args }) as R
    }
}

// ---------------------------------------------------------------------------
// SUGAR FOR EFFECTS (engi, 2026-08-29: "add sugar for effects").
//
// `defineEffect` is the general form and stays the general form. What it makes
// you repeat is the part that is FIXED BY THE CONTRACT: every program that
// scales writes the same interface id, the same op name and the same argument
// shape, and each of those is a string or a record it could get wrong on its
// own. `reconcile` below is that contract, pre-applied.
//
// ***THE ARGUMENT SHAPE IS THE PART WORTH CENTRALISING, AND main.ts CARRIES A
// SIX-LINE COMMENT EXPLAINING IT.*** `scale` takes `{ path, n }` and NOT
// `{ path, replicas }`: the WIT parameter is `replicas`, but the wire shape is
// aperture's `SetReplicasArgs`, whose JSON tags are `path` and `n`. Both
// vocabularies are correct and only one is what the host parses. That is a fact
// about the seam, so it belongs at the seam rather than in a comment every
// author has to find — a step written against `{ path, replicas }` type-checks
// against its own handler and marshals to something radiant cannot read.

/**
 * The `radiant:reconcile` contract as ready-made effects.
 *
 *     const observe = reconcile.observe<number>()
 *     const have    = yield* observe(deployment)   // Obs<number>, checked
 *
 * Each is a THUNK because the observation's value type is the caller's: `obs`
 * carries `known(string)` on the wire, and whether a step sees `Obs<string>` or
 * `Obs<number>` depends on what its handler converts to. Fixing it here would
 * force a cast at exactly the boundary that exists to prevent one.
 */
/**
 * What `reconcile.ensure` takes.
 *
 * ***THE VALUE MIRRORS THE WIT VARIANT RATHER THAN BEING A BARE UNION OF
 * PRIMITIVES.*** `{ text: '3' }` and `{ num: 3 }` are different writes, and a
 * plain `string | number | boolean` would make them indistinguishable the moment
 * a caller passed a value whose type came from somewhere else - which is exactly
 * how a numeric field ends up holding a string.
 */
export type EnsureValue = string | number | boolean

// ═══════════════════════════════════════════════════════════════════════════
// ***BARE, NOT TAGGED*** (engi, 2026-09-05: "ensure(path.nodes('worker-1'),
// 'spec.unschedulable', true)?"). It was
// `{text: string} | {num: number} | {flag: boolean}` and the tag bought nothing
// here.
//
// ⚠ ***THE TWO SDK HALVES DISAGREED, WHICH IS THE ACTUAL DEFECT THE QUESTION
// FOUND.*** `expr.ts`'s `EnsureValue` has ALWAYS been
// `string | number | boolean | Computed`, dispatching on `typeof`. So the same
// value was written two ways depending on which half you were in - `true` in a
// resume expression, `{ flag: true }` in a step - for one interface, one wire
// variant and one meaning.
//
// ***THE TAG WAS COPIED FROM THE WIT VARIANT, WHERE IT IS LOAD-BEARING, TO A
// PLACE WHERE IT IS NOT.*** `variant value { text, num, flag }` needs a
// discriminant because the component model does; TypeScript already has one -
// `typeof` - and the lowering in each `*-main.ts` is exactly where the two
// representations are supposed to meet.
//
// ⛔ ***WHY `Computed` IS NOT HERE, WHICH IS THE ONE REAL ASYMMETRY.*** In
// `expr.ts` a string is genuinely ambiguous: an `Expr` is a plain string at
// runtime, so nothing can tell `'fast'` (a ConfigMap value to store) from
// `Get(...) + 1` (expression text to emit bare) by inspection - hence
// `computed()`. A STEP's `ensure` has no such ambiguity: it declares an
// obligation carrying a literal, and there is no expression text it could be
// confused with. So `typeof v === 'string'` means text, always.
// ═══════════════════════════════════════════════════════════════════════════
// ***THE BOOLEAN ARM MIRRORS THE WIT, WHICH MIRRORS THE GRAMMAR — AND ALL THREE
// MOVED IN ONE DAY.*** It was removed on 2026-08-31 because `Ensure(p,"d",true)`
// did not parse, and restored hours later when boolean literals were added to
// the grammar. The intervening commit is the lesson: it survived HERE for one
// commit after leaving the WIT, and the compiler found it the first time a
// handler tried to lower a value — the only place the two shapes meet.


/** One field of a create body: a DOTTED path and a typed value. */
export type CreateField = { readonly path: string; readonly value: EnsureValue }

export type CreateArgs = {
  readonly path: ApiPath
  readonly body: readonly CreateField[]
}

export type EnsureArgs = {
  /**
   * ***EITHER KIND OF PATH, AND THE HOST TELLS THEM APART FROM THE PATH
   * ITSELF*** (engi, 2026-09-05: "unify and extend ensure args"). One symbol
   * writes both scopes; what differs is the BOUND, not the verb:
   *
   *	ApiPath      confined by the grant's NAMESPACE and by spec.writes
   *	ClusterPath  confined by spec.writes ALONE - there is no namespace to
   *	             compare, so the declaration is the whole boundary
   *
   * ⚠ ***THE TWO REMAIN DIFFERENT KINDS EVERYWHERE ELSE, AND THAT IS STILL
   * LOAD-BEARING.*** `observe.get` takes `ApiPath` and `observeCluster.get`
   * takes `ClusterPath`, because those two READS have different confinements
   * and passing one where the other goes routes around the one chosen for it.
   * The union is widened HERE and not there because `ensure`'s confinement is
   * `spec.writes` in both cases - the same mechanism, naming the same objects.
   */
  readonly path: ApiPath | ClusterPath
  readonly field: string
  readonly value: EnsureValue
}

/**
 * Arguments to `ensureAll`: several fields of ONE object, applied as ONE write.
 * Same field shape as `create`, because it is the same thing - a dotted path and
 * a value - and the host lowers both through the same code.
 */
export type EnsureAllArgs = {
  readonly path: ApiPath
  readonly fields: readonly CreateField[]
}

export const reconcile = {
  /** `observe.get(path) -> obs`. The path is an apiserver path, not a field name. */
  observe: <T = string>() => defineEffect<ApiPath, Obs<T>>()(WIT_OBSERVE, 'get'),

  /**
   * `observe-cluster.get(path) -> obs`. A CLUSTER-SCOPED read.
   *
   * Importing this interface is the authority to read cluster-scoped objects at
   * all; `spec.reads` names WHICH ones, by exact path. A path outside that list
   * reports `absent` - "not in your world" is correctly indistinguishable from
   * "not there", and `unknown` would invite a retry that can never succeed.
   *
   * The value is the object as JSON rather than a scalar: a cluster-scoped
   * object has no single number a reconciler maintains, and three scalar reads
   * would be three round trips whose results could disagree with each other.
   */
  observeCluster: <T = string>() =>
    defineEffect<ClusterPath, Obs<T>>()(WIT_OBSERVE_CLUSTER, 'get'),

  /**
   * `observe.count(query) -> obs`.
   *
   * ***THE QUERY IS A LABEL SELECTOR (`app=api`), NOT A PATH.*** A path fails
   * `labels.Parse`, so the host answers `unknown` forever and nothing reports
   * it — `count` never throws by contract. Measured on a live node once
   * already: 239 asks, 119 resolved.
   */
  count: <T = number>() => defineEffect<LabelSelector, Obs<T>>()(WIT_OBSERVE, 'count'),

  /**
   * `observe.get(collection) -> obs`, the objects as a JSON ARRAY.
   *
   * ***THE SAME WIT SYMBOL AS `observe`, AND THAT IS WHY THIS COST NOTHING TO
   * SHIP.*** `get` takes a path; a collection path IS a path. The host tells
   * the two apart from the path itself (`IsCollectionPath`) exactly as `ensure`
   * tells the two write scopes apart. No new import, so `ci/wit-skew.sh` does
   * not fire and no deployed component needs rebuilding to keep running.
   *
   * ***WHAT THIS ADDS OVER `count`, WHICH IS THE WHOLE POINT: NAMES AND
   * FIELDS.*** `count` takes a LABEL SELECTOR and answers `.length`, so a
   * program could learn that eleven pods matched and never which, and could
   * only ever ask questions a label can express. A pod's node is not a label.
   * So `pods on machine X` was not a narrower version of a query this surface
   * had - it was not expressible at all, and enumerating plus filtering
   * `spec.nodeName` in the guest is what makes it so.
   *
   * ⚠ ***READING A SET IS NOT AUTHORITY TO WRITE ONE, AND THE GAP IS
   * DELIBERATE.*** `spec.writes` matches a canonical object path EXACTLY, so a
   * program cannot act on what it discovers here: a name learned at runtime was
   * not in the manifest. That is `WriteConflicts`' doing rather than an
   * oversight - admission proves no two programs claim one object, and a
   * selector-shaped declaration would make that proof impossible. ***So this
   * surface is for DECIDING and REPORTING, never for reaching further.***
   *
   * Bounded by the grant's namespace and by the kind's read capability - the
   * same bound `count` already applies to the same objects.
   */
  enumerate: <T = string>() => defineEffect<CollectionPath, Obs<T>>()(WIT_OBSERVE, 'get'),

  /** `observe.now() -> u64`. EPOCH MILLISECONDS, UTC. */
  now: () => defineEffect<void, number>()(WIT_OBSERVE, 'now'),

  /**
   * Write ANY field of any object the aperture allows.
   *
   * ***THE VALUE IS TYPED BECAUSE THE EXPRESSION LANGUAGE IS.*** `Ensure(p,
   * "spec.replicas", 3)` sets a NUMBER; `Ensure(p, "data.x", "3")` sets the
   * one-character STRING. Both parse and both apply, so a mistyped value is a
   * field set to the wrong thing rather than an error - which is why this
   * mirrors the WIT variant instead of taking a `string`.
   *
   * ***A `text` VALUE IS NEVER EVALUATED.*** `text: 'Now()'` writes those five
   * characters. That is the same decision `expr.ts` records for `ensure`'s bare
   * literal: deciding by the string's SHAPE was tried and thrown away, because a
   * ConfigMap value that happens to read like an expression would be evaluated
   * instead of stored.
   */
  ensure: () => defineEffect<EnsureArgs, void>()(WIT_ENSURE, 'ensure'),

  /**
   * `ensureAll`: SEVERAL fields of one object in ONE apiserver write, so a reader
   * can never observe the new value of one field beside the old value of another.
   *
   * ***`ensure` IS ONE FIELD PER OBLIGATION, AND OBLIGATIONS APPLY ONE AT A
   * TIME.*** A relay writing `data.v` and a `data.t` stamp as two `ensure`s had
   * 3 of 6 convergences observed TORN - new `v` beside old `t`, durably, until the
   * next pass (overhead-bench, 2026-09-01). Same grant as `ensure`
   * (`radiant:reconcile/ensure@0.1.0`), same WIT interface, a second function on it.
   *
   * ⚠ ***`spec.replicas` ON AN apps KIND IS REFUSED BY THE HOST, WITH THE
   * REASON.*** That field is written through the `/scale` subresource for least
   * privilege, and no apiserver write is atomic across a subresource boundary.
   * `ensure` for the count, `ensureAll` for the rest.
   */
  ensureAll: () => defineEffect<EnsureAllArgs, void>()(WIT_ENSURE, 'ensure-all'),

  /**
   * Remove an object.
   *
   * SEPARATE FROM `ensure` BECAUSE THE INTERFACE IS THE GRANT - editing a
   * ConfigMap's data and deleting it are different authorities, and
   * `periapsis's aperture` keeps `IfaceEnsure` and `IfaceDelete` apart for that
   * reason.
   *
   * IDEMPOTENT BY CONTRACT: the applier treats NotFound as success. That matters
   * most in a FINALIZER, which runs on a fresh instance every attempt and so
   * must re-declare its cleanup each time with no memory of the last.
   */
  del: () => defineEffect<ApiPath, void>()(WIT_DELETE, 'delete'),

  /**
   * Create an object.
   *
   * ***THE BODY IS A FLAT LIST OF DOTTED PATHS, AND THAT IS A SECURITY
   * DECISION.*** A JSON object is already valid struct-literal syntax in the
   * host's grammar, so the tempting shape is a JSON string passed through — an
   * injection surface: a body of `{"a":1}, Delete("/…/victim")` yields an
   * expression that PARSES, as a three-argument Create. It is refused today only
   * because effect symbols do not resolve in argument position, which is defence
   * by accident. Every token is rendered by the host from typed data instead.
   *
   * ⚠ ***KEYS RENDER SORTED AT EVERY LEVEL.*** The ledger keys on the
   * obligation's bytes, so a body whose order varied between passes would make
   * an unchanged Create look new every time — applied forever, retired never.
   *
   * ⛔ ***NO ARRAYS: A ConfigMap OR A Secret YES, A Deployment NO.*** The
   * grammar's `[` is postfix indexing, not an array literal. Measured; the
   * remedy is the grammar, as it was for booleans.
   */
  create: () => defineEffect<CreateArgs, void>()(WIT_CREATE, 'create'),


  /** `workloads.scale(path, replicas)`. Returns nothing on purpose — see the WIT. */

  /** `status.set(condition)`. `type` is an IDENTITY: a second set REPLACES. */
  report: () => defineEffect<Condition, void>()(WIT_STATUS, 'set'),

  /**
   * `carry.get()`: what this program remembered on its LAST pass.
   *
   * ***THE INPUT HALF OF A PROBE, AND THE ONLY THING THAT MAKES ONE POSSIBLE.***
   * A total step re-derives everything from the present world, so a streak, a
   * rate or a rolling average is unspellable in one: the current observation is
   * one sample and the others are gone. The carry is where the others live, and
   * `internal/reconcilehost/carry.go` argues at length why it is an explicit
   * input and output rather than a module global — restart-safe, replayable, and
   * visible in `kubectl get perseid -o yaml`.
   *
   * Pair it with `remember`/`forget`, which are the WRITE half and are NOT
   * effects: they ride on the outcome. See `remember`'s doc for why the two
   * directions are spelled so differently.
   *
   *     const window = windowOf(yield* carry())
   *     return remember(quiesce(...), JSON.stringify(publish(window, now)))
   *
   * ⚠ ***EMPTY IS A REAL ANSWER AND IT MEANS "NOTHING".*** A first pass, a
   * program that never carries, and one that deliberately cleared its memory all
   * read `''`. Treat that as "start measuring", never as an error: the carry
   * outlives the version of the program that wrote it, so a step that threw on
   * an unrecognised value could never publish the one that would replace it.
   *
   * ⚠ ***TAKES NO ARGUMENT BECAUSE THERE IS NOTHING TO NAME.*** A program can
   * only read ITS OWN memory. Reading what a DIFFERENT program concluded is a
   * cluster read of that Perseid's object — `observe` plus `carriedBy`, gated by
   * `radiant:reconcile/observe-perseids@0.1.0` — and keeping the two apart is
   * what lets a grant say "may see peers" without saying "may see this one".
   *
   * ⛔ ***THE OP IS `'carry'` AND THE WIT FUNCTION IS `get`. THAT DIVERGENCE IS
   * DELIBERATE AND IS THE ONE IN THIS TABLE.*** `Handler<E>` is keyed on the OP
   * ALONE — `readonly [K in Exclude<E['op'], StructuralOp>]` — so the interface
   * id is not part of the key, and `observe.get` and `observeCluster.get`
   * already SHARE one `get` handler. That sharing is fine for those two: both
   * take a path and return an `Obs`, so one function answers both.
   *
   * A third `get` here would join them and it is not compatible — this one takes
   * `void` and returns a bare `string`. The collision does not fail to compile;
   * it produces a handler typed as the UNION, so a wiring that answered `get` by
   * calling `hostGet(path)` would be handed `undefined` and a probe would read
   * its memory as whatever an observation of nothing returns.
   *
   * The op is an SDK-internal routing key and never reaches the wire — the
   * `*-main.ts` wiring maps it to the real import, and `tools/derive-wit.ts`
   * emits the world from `WIT_CARRY`, not from this string — so renaming it
   * costs nothing and removes a whole class of silent misrouting.
   */
  carry: () => defineEffect<void, string>()(WIT_CARRY, 'carry'),

  /**
   * `woke.held() -> list<u32>`. Which arms of this program's own resume were
   * TRUE at the wake that started this pass.
   *
   * ⚠ ***A HINT, NEVER A CORRECTNESS INPUT.*** A step must stay a total function
   * of the world. "Do the work for the condition that holds" is fine, because a
   * missed wake makes it LATE; "skip work because nothing is listed" turns a
   * level-triggered program edge-triggered and a missed wake into a MISSING
   * action. `on()` is built so the safe use is the easy one.
   *
   * EMPTY is the common answer and means "nothing you named is true" - what a
   * backstop tick says. It is also what an older host returns, so a program
   * using this degrades to re-deriving, which is what every step does today.
   */
  woke: () => defineEffect<void, number[]>()(WIT_WOKE, 'held'),
} as const

// ---------------------------------------------------------------------------
// STEP SUGAR (engi, 2026-08-29: "step syntax sugar, with types").
//
// A bare `function* step() { … }` infers its effects correctly and its RETURN
// TYPE not at all — TypeScript widens it to whatever the arms happen to produce.
// Writing the annotation by hand costs four lines of type plumbing, which
// main.ts pays in full:
//
//	type ObserveEff = ReturnType<typeof observe> extends Step<infer A, any> ? A : never
//	type ScaleEff   = ReturnType<typeof scale>   extends Step<infer A, any> ? A : never
//	type ReportEff  = ReturnType<typeof report>  extends Step<infer A, any> ? A : never
//	function* step(): Step<ObserveEff | ScaleEff | ReportEff, Outcome> { … }
//
// `defineStep` infers the effect union from the yields, exactly as the bare form
// does, and PINS the return type to `Outcome` — which the bare form cannot,
// because there is nothing to contextually type it against.
//
// ***THAT PIN IS ALSO THE ANSWER TO "FORBID RETURNING QUIESCE AS FUNC".***
// `return quiesce` — the function, unapplied — is a plausible typo for
// `return quiesce(…)`, and under a bare generator it is ACCEPTED: the step's
// return type simply widens to include `(resume: Resume) => Outcome`, nothing
// errors, and `runStep` hands the host a function. `JSON.stringify` renders a
// function as `undefined`, so the reply is `{}` — which `podstep.go` reads as an
// unknown verb and refuses at runtime, one process away from the typo.
//
// Under `defineStep` the body is contextually typed as returning `Outcome`, so
// the unapplied function is a compile error at the `return`. Ask 2 and ask 3 are
// one mechanism, which is why they are documented together rather than as two
// features that happen to help each other.

/**
 * Declare a step: yields are inferred, the return is pinned to `Outcome`.
 *
 *     const step = defineStep(function* () {
 *       const have = yield* observe(path)
 *       if (have.t !== 'known') return yieldStep
 *       return quiesce(countNe('app=api', 3))
 *     })
 *
 * It is the identity function at runtime. All of its work is done by the time
 * the program runs, which is the point.
 */
export function defineStep<E extends AnyEffect>(body: () => Step<E, Outcome>): () => Step<E, Outcome> {
  return body
}

/**
 * `defineStep` for the deletion path: the same inference, a different outcome.
 *
 * ***A SEPARATE FUNCTION RATHER THAN MAKING `defineStep` GENERIC IN ITS
 * OUTCOME.*** The whole value of `defineStep` is that it PINS the return type -
 * a generator whose outcome is inferred would accept a step that falls off the
 * end returning `undefined`, or one that returns a bare string, and the error
 * would surface at the entrypoint as a shape mismatch rather than at the
 * `return` that caused it. Widening it to `A` to serve two callers would give
 * that up for both.
 *
 * ***AND KEEPING THEM APART IS WHAT MAKES THE TWO CONTRACTS UNCONFUSABLE.*** A
 * step may park, a finalizer may not; a finalizer may `retry`, a step may not.
 * Because the two definers pin different outcome types, `quiesce(...)` inside a
 * finalizer is a compile error at the return statement, and `retry(...)` inside
 * a step is too. One generic function would accept both in either place and the
 * host would refuse it at runtime - on the deletion path, against an object that
 * cannot be deleted while you find out.
 *
 * This existed as a gap for exactly one commit: `runFinalize` shipped in
 * eb751d377 with no way to DEFINE the generator it drives, so the first program
 * to try one did not compile. Found by writing that program.
 */
export function defineFinalize<E extends AnyEffect>(
  body: () => Step<E, FinalizeOutcome>,
): () => Step<E, FinalizeOutcome> {
  return body
}

/**
 * The effect union of a step — its capability set, as the compiler tracks it.
 *
 * This is what `Handler<…>` is written over when a runner wants to name the
 * handler type rather than pass a literal:
 *
 *     const handler: Handler<EffectsOf<typeof step>> = { … }
 */
export type EffectsOf<S> = S extends () => Step<infer E, any> ? E : never

// ---------------------------------------------------------------------------
// The runner.
//
// `Handler<E>` is a mapped type over E's `op`s, so it must be TOTAL: omit one
// and the call does not compile. That makes "the runner handles every
// capability" structural rather than a review item.
export type Handler<E extends AnyEffect> = {
  readonly [K in Exclude<E['op'], StructuralOp>]: (args: Extract<E, { op: K }>['args']) => unknown
}

// ⛔ ***`Handler<NoInfer<E>>` TYPES EVERY HANDLER ARGUMENT AS `never`, AND IT
// COMPILES CLEAN — 2026-08-29, reported by engi as "it types handlers as
// never".***
//
// `NoInfer<E>` is an intrinsic, not an alias: it does NOT reduce to the union it
// wraps, so `Extract<NoInfer<E>, {op: K}>` matches no member and collapses to
// `never`. `never['args']` is `never`, so every handler parameter becomes
// `never` — and `never` is assignable to everything, so nothing errors. The
// handler still type-checks, `runStep` still runs, and the ONLY symptom is that
// completion and argument checking are silently gone inside every handler body.
//
// Measured, same file, same compiler:
//
//	Handler<E>            get: (a: string) => …     ✓
//	Handler<NoInfer<E>>   get: (a: never)  => …     ✗   no error anywhere
//
// ***THE FIX IS TO WRAP THE RESULT, NOT THE INPUT: `NoInfer<Handler<E>>`.***
// The mapped type is computed over the real union first and NoInfer then blocks
// inference from the handler position, which is the only thing it was ever there
// to do — an extra key is still rejected as an excess property rather than
// widening E. Both arms are pinned by TestHandlerArgsAreNotNever in
// handler_types_test.ts; a bare `never` cannot be caught by "does it compile",
// because that is exactly what it does.

/** The handler position for a runner: computed over E, then closed to inference. */
type HandlerArg<E extends AnyEffect> = NoInfer<Handler<E>>

/**
 * Drive one step to completion against `handler`, which supplies the world.
 *
 * Total by construction in the only sense that matters here: it performs no I/O
 * itself and returns whatever the step returns. A step that loops forever still
 * loops forever — bounding that is the host's job (fuel or a deadline), not the
 * type system's.
 */
/**
 * A step short-circuiting to an outcome, thrown rather than yielded.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***A THROW AND NOT AN EFFECT, BECAUSE OF `@group`.*** The obvious design is a
 * structural `@bail` op beside `@group`/`@select`. It is wrong: `driveSync`
 * RECURSES for each group arm, so a bail raised inside one would be returned as
 * THAT ARM'S VALUE and the step would carry on with an `Outcome` where an
 * observation should be. The failure is silent and typed.
 *
 * An exception unwinds every frame including the recursion, which is exactly
 * short-circuit semantics, and `Promise.all` in the async driver rejects on the
 * first throw and propagates it for free. Nothing in `group`/`select` had to
 * learn about this.
 *
 * ⚠ It is caught at the two runner boundaries and nowhere else, so a `try`
 * around a `yield*` in program code will swallow it. Do not catch broadly
 * between a `need()` and the runner.
 * ═══════════════════════════════════════════════════════════════════════════
 */
class Bail {
  constructor(readonly outcome: Outcome) {}
}

/** Short-circuit the step with `outcome`. See `Bail`. */
export const bail = (outcome: Outcome): never => {
  throw new Bail(outcome)
}

export function runStep<E extends AnyEffect, A>(
  step: () => Step<E, A>,
  handler: HandlerArg<E>,
): A {
  try {
    return driveSync(step(), handler as Record<string, (a: unknown) => unknown>)
  } catch (e) {
    // The cast is sound for every step `defineStep` accepts: it pins the return
    // to `Outcome`, and a bail carries one.
    if (e instanceof Bail) return e.outcome as A
    throw e
  }
}

function driveSync(it: Step<any, any>, handler: Record<string, (a: unknown) => unknown>): any {
  let sent: unknown = undefined
  for (;;) {
    const r = it.next(sent)
    if (r.done) return r.value
    const eff = r.value
    if (eff.op === '@group') {
      // Sequential, and the RESULTS are identical to the concurrent runner's —
      // only the wall-clock differs. That is the colorless property.
      sent = (eff.args as Step<any, any>[]).map((sub) => driveSync(sub, handler))
      continue
    }
    if (eff.op === '@select') {
      // FAIL CLOSED rather than pick one. Under sequential execution "whichever
      // finishes first" has no meaning, so any answer here would be a silent
      // semantic difference between this runner and runStepAsync — which is the
      // exact class of bug the rest of this contract exists to prevent.
      throw new Error('select requires an async runner: use runStepAsync')
    }
    sent = handler[eff.op](eff.args)
  }
}

/**
 * The same, awaiting each handler result before resuming the step.
 *
 * Any handler that talks to an apiserver is async, so this is the one a real
 * host uses; `runStep` is for pure/fake handlers in tests. The STEP stays an
 * ordinary synchronous generator either way — it suspends at each yield, and
 * only the driver knows about promises. That is deliberate: a step that could
 * await would be a step that could block, and the contract says it cannot.
 */
export async function runStepAsync<E extends AnyEffect, A>(
  step: () => Step<E, A>,
  handler: HandlerArg<E>,
): Promise<A> {
  try {
    return await driveAsync(step(), handler as Record<string, (a: unknown) => unknown>)
  } catch (e) {
    // ⚠ `await` inside the `try` is load-bearing: `return driveAsync(...)`
    // resolves the promise OUTSIDE this frame, so a rejection would skip the
    // catch entirely and a bail would surface to the host as a crash.
    if (e instanceof Bail) return e.outcome as A
    throw e
  }
}

async function driveAsync(
  it: Step<any, any>,
  handler: Record<string, (a: unknown) => unknown>,
): Promise<any> {
  let sent: unknown = undefined
  for (;;) {
    const r = it.next(sent)
    if (r.done) return r.value
    const eff = r.value
    if (eff.op === '@group') {
      sent = await Promise.all((eff.args as Step<any, any>[]).map((sub) => driveAsync(sub, handler)))
      continue
    }
    if (eff.op === '@select') {
      sent = await Promise.race(
        (eff.args as Step<any, any>[]).map((sub, index) =>
          driveAsync(sub, handler).then((value) => ({ index, value })),
        ),
      )
      continue
    }
    sent = await handler[eff.op](eff.args)
  }
}

// ---------------------------------------------------------------------------
// READING, SUGARED.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***MEASURED, NOT GUESSED: THIS IS THE SHAPE THE CORPUS IS MADE OF.*** Across
// the example programs, 36 hand-written three-valued unwraps and 16 `JSON.parse`
// calls follow a read - and only 6 uses of the exhaustive `match`. The safe form
// was losing to the `if`-chain because it cost more to type, so the sugar's job
// is to make the safe form the CHEAP one.
//
//	const seen = yield* observe(TARGET)          ->   const dep = yield* read.need(TARGET)
//	if (seen.t === 'absent') return terminate
//	if (seen.t === 'unknown') return yieldStep
//	const dep = JSON.parse(seen.v) as …
//
// ⚠ ***`need` DECIDES A POLICY, SO THE POLICY IS AN ARGUMENT.*** `absent ->
// terminate` is right when the object is the thing you maintain and wrong when
// its absence is what you are waiting for. The defaults are the common case and
// are overridable per call; they are not a claim about your program.
// ═══════════════════════════════════════════════════════════════════════════

/** Decode a read body, `null` if it is not a JSON object. */
const asRecord = (raw: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(raw)

    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Wrap a read effect so its result arrives decoded, and optionally unwrapped.
 *
 *     const read = reader(observe)              // once, beside the capability
 *     const dep  = yield* read.need(TARGET)     // decoded; bails on absent/unknown
 *     const obs  = yield* read.get(TARGET)      // Obs<T>, decide for yourself
 *
 * Generic in the PATH type, so one factory serves `observe` (ApiPath),
 * `observeCluster` (ClusterPath) and `enumerate` (CollectionPath) without three
 * spellings. The effect union `E` passes straight through, so `derive-wit` still
 * reads the same capabilities out of the step's yield type.
 */
export function reader<P, E extends AnyEffect, T = Record<string, unknown>>(
  read: (p: P) => Step<E, Obs<string>>,
  decode: (raw: string) => T | null = asRecord as unknown as (raw: string) => T | null,
) {
  return {
    /**
     * The read, decoded, still three-valued.
     *
     * ⚠ A body that does not decode is reported `unknown`, NOT `absent`: we got
     * an answer and could not interpret it, which is a failure to read and not
     * a statement that the object is gone. Collapsing those is the defect `Obs`
     * is three-valued to prevent.
     */
    *get(path: P): Step<E, Obs<T>> {
      const seen = yield* read(path)
      if (seen.t !== 'known') return seen
      const v = decode(seen.v)

      return v === null ? unknown : known(v)
    },

    /** The read, decoded and unwrapped; short-circuits the step otherwise. */
    *need(path: P, on: { absent?: Outcome; unknown?: Outcome } = {}): Step<E, T> {
      const seen = yield* read(path)
      if (seen.t === 'absent') return bail(on.absent ?? terminate)
      if (seen.t === 'unknown') return bail(on.unknown ?? yieldStep)
      const v = decode(seen.v)

      return v === null ? bail(on.unknown ?? yieldStep) : v
    },
  }
}

// ---------------------------------------------------------------------------
// Structured concurrency — `group` and `select`, after Zig 0.16's std.Io.
//
// A step yields one effect at a time and waits, so three independent
// observations cost three round trips. These let a step ask for several at once
// while staying a plain synchronous generator: the RUNNER decides whether that
// means concurrently (runStepAsync) or one after another (runStep). Same step
// body either way — the colorless property, which is the point of Zig's design
// and the reason it is worth copying.
//
// They are STRUCTURAL effects: the runner resolves them itself and the handler
// never sees them, so `Handler<E>` excludes their ops. But the inner effects
// stay in the step's yield union, so capability tracking, handler totality and
// WIT derivation all keep working through a group.

/** Reserved `wit` value: this effect is control flow, not a capability. */
export const STRUCTURAL = '@structural'
export type StructuralOp = '@group' | '@select'

export type GroupEff = {
  readonly op: '@group'
  readonly args: readonly Step<any, any>[]
  readonly wit?: typeof STRUCTURAL
}
export type SelectEff = {
  readonly op: '@select'
  readonly args: readonly Step<any, any>[]
  readonly wit?: typeof STRUCTURAL
}

/**
 * The effects a `Step` yields — its capability set, as the compiler tracks it.
 *
 * ***EXPORTED FOR THE HANDLER-AS-A-CONSTANT CASE*** (engi, 2026-08-29). An
 * inline handler literal is contextually typed by `runStep`, so its arguments
 * are checked and completed. A handler lifted into its own `const` is NOT —
 * nothing types a free-standing object literal, so every parameter falls back
 * to implicit `any` and TypeScript reports TS7006/TS7031 under `strict`:
 *
 *	const handlers = { get: (what) => … }        // `what` is implicitly any
 *	runStep(step, handlers)                       // too late - already widened
 *
 * The annotation is what recovers it, and this is the type that spells it:
 *
 *	const handlers: Handler<YieldOf<ReturnType<typeof step>>> = { get: (what) => … }
 *	const handlers: Handler<EffectsOf<typeof step>> = { get: (what) => … }   // same, shorter
 *
 * ***`EffectsOf` AND `YieldOf` ARE NOT DUPLICATES AND THE DIFFERENCE IS ONE
 * `ReturnType`.*** `YieldOf` takes a STEP — the generator object; `EffectsOf`
 * takes the FUNCTION that returns one, which is what you have a `typeof` for.
 * Both are here because `group`/`select` compose over steps while call sites
 * name functions, and collapsing them would force a `ReturnType` at whichever
 * end lost.
 */
export type YieldOf<S> = S extends Step<infer E, any> ? E : never

/** What a `Step` returns — `Outcome` for a step, the sub-result inside a `group`. */
export type ReturnOf<S> = S extends Step<any, infer R> ? R : never

/**
 * Run several sub-steps and collect ALL results, positionally typed.
 *
 *     const [dep, pods] = yield* group(getReplicas(d), countPods(p))
 */
export function* group<T extends readonly Step<any, any>[]>(
  ...steps: T
): Step<YieldOf<T[number]> | GroupEff, { -readonly [K in keyof T]: ReturnOf<T[K]> }> {
  return (yield { op: '@group', args: steps } as GroupEff) as any
}

/**
 * Race sub-steps; the FIRST to finish wins. Returns which one and its value.
 *
 * Note what this cannot do: cancel the losers. A step's effects are obligations
 * the host may already have acted on, so "unracing" one is not generally
 * meaningful. Zig's Io can cancel because its operations are I/O; ours are
 * declarations. Losers run to completion and their results are discarded.
 */
export function* select<T extends readonly Step<any, any>[]>(
  ...steps: T
): Step<YieldOf<T[number]> | SelectEff, { index: number; value: ReturnOf<T[number]> }> {
  return (yield { op: '@select', args: steps } as SelectEff) as any
}

/**
 * Run sub-steps concurrently and bind their results to NAMES.
 *
 *     const { dep, pods } = yield* where({
 *       dep:  observe(deployment),
 *       pods: count('app=api'),
 *     })
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***THE NAMED SIBLING OF `group`, AND THE DIFFERENCE IS THE WHOLE POINT.***
 * `group(a, b)` returns `[ra, rb]` and a reader has to count to know which is
 * which. This package already states the objection in another context -
 * `SubjectsOfEffect`: *"position is a convention nothing enforces, and it breaks
 * silently the first time a symbol takes two paths"* - and a positional
 * destructure breaks the same way the first time somebody inserts an arm in the
 * middle. Renaming a binding here is a compile error; reordering one is a no-op.
 *
 * ***IT IS `group` UNDERNEATH, NOT A SECOND MECHANISM.*** Same `@group` effect,
 * same concurrency, same runner - so there is one thing to reason about and one
 * thing that can be wrong. What this adds is the zip back to names, which is
 * exactly the part a caller would otherwise write by hand at every call site.
 *
 * ⚠ ***THE ARMS RUN CONCURRENTLY, SO A BINDING CANNOT SEE ANOTHER BINDING.***
 * Haskell's `where` is mutually recursive; this is not, and cannot be - the arms
 * are dispatched together and their results arrive together. A value derived
 * from another belongs in ordinary code after the yield, where the dependency is
 * visible. Naming it `where` is about the SHAPE (bind several names beside the
 * expression that uses them), not about the semantics of the Haskell one.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function* where<T extends Record<string, Step<any, any>>>(
  bindings: T,
): Step<YieldOf<T[keyof T]> | GroupEff, { [K in keyof T]: ReturnOf<T[K]> }> {
  // ***INSERTION ORDER, WHICH JavaScript GUARANTEES FOR STRING KEYS.*** The
  // names are zipped back by position against this same list, so the only
  // requirement is that the two walks agree - and reading them from one array
  // is what makes that true by construction rather than by care.
  const names = Object.keys(bindings)
  const results = (yield {
    op: '@group',
    args: names.map((n) => bindings[n]!),
  } as GroupEff) as unknown as unknown[]

  const out = {} as { [K in keyof T]: ReturnOf<T[K]> }
  names.forEach((n, i) => {
    out[n as keyof T] = results[i] as ReturnOf<T[keyof T]>
  })

  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// THE GENERALIZED OBJECT BUILDER: ONE MECHANISM, KIND-BRANDED.
//
// engi, 2026-08-30: *"generalized object builder, pods, cms, etc"*, and *"by
// kinded I mean Canonical and object kind"*.
//
// A path and a body each carry their KIND in the brand, so the two cannot be
// mismatched:
//
//	const o = objects.ns('default')
//	get(o.pod('web').path, 'status.phase')             // a pod path, read-only
//	create(o.deployment('api').with({ ... }))          // path AND body, paired
//	ensure(o.configMap('cfg').path, 'data.mode', 'x')
//
// ***`Canonical<K, S>` IS THE SDK'S EXISTING BRAND AND THIS REUSES IT.*** An
// `ApiPath` is `Canonical<'apiserver-path', ApiPathShape>` - a string that
// cannot be written by hand. Adding the KIND to the brand makes a Deployment
// path a different TYPE from a ConfigMap path, so pairing one with the other's
// body is a compile error rather than an apiserver rejection nobody sees.
//
// # ONE MECHANISM, NOT A METHOD PER KIND
//
// `kinded()` below builds every entry. The well-known kinds are one line each
// and exist for their TYPED bodies; `resource()` reaches anything else,
// including a CRD the SDK has never heard of - which is the whole point of the
// host taking paths rather than a capability per kind.
//
// # WHY SOME KINDS HAVE NO `with(...)`
//
// ⛔ A pod cannot be CREATED. It is in the host's `unwritableKinds`, and Create
// is the worse half of that exclusion: an obligation is applied with RADIANT'S
// credential, which the seam-binding policy exempts ON PODS, so a program that
// could create one could bring it into existence with `radiant.apsis/link`
// already set. `pod()` therefore yields a path and no body builder - the TYPE
// says what the host would refuse, at the point of writing rather than the
// point of applying.
//
// `podTemplate` is a different thing and is legitimate: a pod TEMPLATE is a
// FIELD of a Deployment or a Job, and those kinds are writable.
// ═══════════════════════════════════════════════════════════════════════════

// The kind brand lives in expr.ts, because `create` has to see it - a path and
// a body typed as bare `ApiPath`/`StructValue` never unify their kinds, and a
// Deployment path pairs happily with a ConfigMap body. Re-exported here so a
// caller has one import.
export type KindedPath<K extends string> = E.KindedPath<K>
export type KindedBody<K extends string> = E.KindedBody<K>
export type KindedObject<K extends string> = E.KindedObject<K>

/** Labels/annotations: a flat string map, which is what the apiserver accepts. */
export type Meta = { labels?: Record<string, string>; annotations?: Record<string, string> }

const metaOf = (m?: Meta): E.StructShape | undefined => {
  if (!m) return undefined
  const out: E.StructShape = {}
  if (m.labels) out.labels = { ...m.labels }
  if (m.annotations) out.annotations = { ...m.annotations }

  return Object.keys(out).length > 0 ? out : undefined
}

// ***NO metadata.name AND NO metadata.namespace, EVER.*** The host REFUSES a
// create body that names its own identity: the path is the string spec.writes
// was checked against, and a body that could name a different object would land
// it outside the approved address. `Meta` offers labels and annotations and
// nothing else, so the type is the reason a caller cannot try.
const bodyWith = <K extends string>(shape: E.StructShape, m?: Meta): KindedBody<K> => {
  const meta = metaOf(m)

  return E.asBody(meta ? { ...shape, metadata: meta } : shape) as KindedBody<K>
}

/** A container, as a workload's pod template holds one. */
export type Container = {
  name: string
  image: string
  command?: string[]
  args?: string[]
  env?: Record<string, string>
}

/**
 * `spec.template` for a workload - a pod TEMPLATE, not a pod.
 *
 * The legitimate half of what a "pod builder" would be: the template is a field
 * of a Deployment or a Job, both writable, where a pod OBJECT is refused.
 */
// ***THE FOUR `as unknown as E.StructShape` CASTS HERE ARE GONE, AND THEIR
// ABSENCE IS THE POINT.*** They existed because `StructShape` had no array
// case, so an array value was not expressible in the type and every array had
// to be lied about at the boundary. That is the same cast that let an array
// reach `structText` and render as a key-sorted JSON OBJECT - the 10+ element
// `command` defect - because `as unknown as` does not merely widen, it tells
// the compiler the value is the one thing it is not.
//
// `StructShape` now admits `StructArray` directly, so these assign plainly:
// `string[]` is a `readonly EnsureValue[]`, `Record<string, string>` is a
// `StructShape`, and `map` produces a `readonly StructShape[]`. A guardrail
// that leaves the casts that defeat it in place has added a type and changed
// nothing.
//
// The spreads stay - they defensively copy the caller's arrays, which is a
// separate concern from the casts and was never what they were for.
export const podTemplate = (containers: Container[], m?: Meta): E.StructShape => {
  const spec: E.StructShape = {
    containers: containers.map((c) => {
      const out: E.StructShape = { name: c.name, image: c.image }
      if (c.command) out.command = [...c.command]
      if (c.args) out.args = [...c.args]
      if (c.env) out.env = c.env

      return out
    }),
  }
  const meta = metaOf(m)

  return meta ? { spec, metadata: meta } : { spec }
}

/**
 * ONE MECHANISM. Everything below is built from this.
 *
 * `with` is optional per kind: a kind the host cannot CREATE simply does not
 * get one, so the absence is the type saying what the host would refuse.
 */
const kinded = <K extends string>(path: ApiPath) => ({
  /** The path, branded with its kind. Usable for get / ensure / delete. */
  path: path as KindedPath<K>,
  /** Pair it with a body for `create`. */
  with: (shape: E.StructShape, m?: Meta): KindedObject<K> => ({
    path: path as KindedPath<K>,
    body: bodyWith<K>(shape, m),
  }),
})

export type DeploymentSpec = {
  replicas: number | E.Expr<'int'> | E.Expr<'observed-int'> | E.Expr<'value'>
  selector: Record<string, string>
  containers: Container[]
}

/**
 * The scoping facade: one namespace, stated once.
 *
 * ⚠ The namespace is still written by the GUEST here, and the host still checks
 * it against the grant. The strong form - the host resolving kind+name against
 * the grant so a namespace is unforgeable - needs an expression that carries
 * kind and name rather than a path, which changes what spec.writes, the wake
 * index and TargetOf compare. `aperture.Facade.PathFor` is the host half of
 * that, already in place; this is deliberately not pretending to be it.
 */
export const objects = {
  ns: <NS extends Namespace>(namespace: NS) => {
    const p = path.ns(namespace)

    return {
      /** `v1 Pod`. READ ONLY - see the header for why there is no `with`. */
      pod: <N extends PodName>(name: N) => ({ path: p.pods(name) as KindedPath<'pods'> }),

      /** `v1 ConfigMap`. */
      configMap: (name: string) => ({
        ...kinded<'configmaps'>(p.core('v1', 'configmaps', name)),
        data: (data: Record<string, string>, m?: Meta): KindedObject<'configmaps'> =>
          kinded<'configmaps'>(p.core('v1', 'configmaps', name)).with({ data: { ...data } }, m),
      }),

      /**
       * `v1 Secret`.
       *
       * `stringData`, never `data`: `data` is base64, and a builder taking it
       * would invite a caller to hand plaintext to a field the apiserver
       * decodes. The apiserver encodes `stringData` itself.
       */
      secret: (name: string) => ({
        ...kinded<'secrets'>(p.core('v1', 'secrets', name)),
        stringData: (d: Record<string, string>, m?: Meta): KindedObject<'secrets'> =>
          kinded<'secrets'>(p.core('v1', 'secrets', name)).with({ stringData: { ...d } }, m),
      }),

      /** `apps/v1 Deployment`. */
      deployment: <N extends WorkloadName>(name: N) => ({
        ...kinded<'deployments'>(p.deployments(name)),
        spec: (s: DeploymentSpec, m?: Meta): KindedObject<'deployments'> =>
          kinded<'deployments'>(p.deployments(name)).with(
            {
              spec: {
                // ***A BARE Expr MUST BE WRAPPED, NOT HANDED TO THE GENERIC
                // FIELD RENDERER.*** `Expr<T>` is a plain string at runtime -
                // the brand is erased - and expr.ts's struct-field renderer
                // cannot tell `replicas: '3'` (a literal to quote) from
                // `replicas: 'Get(...) + 2'` (expression text to emit bare)
                // by inspecting the value; that ambiguity is exactly why
                // `computed()` exists. DeploymentSpec.replicas's own type
                // advertises `Expr<'int'> | Expr<'observed-int'> |
                // Expr<'value'>` as valid input, so a caller passing one
                // reasonably expects it evaluated - but without this, it
                // reached the field renderer un-wrapped and came out
                // JSON-quoted as a literal string, silently writing the
                // wrong type into spec.replicas.
                replicas: typeof s.replicas === 'number' ? s.replicas : E.computed(s.replicas),
                selector: { matchLabels: { ...s.selector } },
                template: podTemplate(s.containers, { labels: s.selector }),
              },
            },
            m,
          ),
      }),

      /**
       * ***THE ESCAPE HATCH, AND IT IS THE SAME MECHANISM.*** A CRD has no
       * static shape here - the point of the host taking paths is that a kind
       * needs no entry anywhere - so this brands the path with the plural and
       * leaves the body untyped. It still gives the FACADE (one namespace) and
       * the PAIRING (path and body from one call).
       */
      resource: <K extends string>(group: string, version: string, plural: K, name: string) =>
        kinded<K>(p.resource(group, version, plural, name)),
    }
  },
}

/**
 * Park on several conditions and run the handler for whichever HOLDS.
 *
 *     return quiesce(yield* on({
 *       [fieldIs(NODE, DRAIN_KEY, 'true')]: function* () { yield* startDrain() },
 *       [taintAppeared(NODE)]:              function* () { yield* autoDrain() },
 *     }))
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***THE EXPRESSION IS THE KEY*** (engi, 2026-09-06). `Resume` is a branded
 * string and object keys are strings, so this is literal TypeScript with no
 * naming layer to keep in sync between the park and the dispatch.
 *
 * It does two things in one call, and they are for DIFFERENT passes:
 *
 *	  reads `woke.held()`   which arms held at the wake that started THIS pass,
 *	                        and runs their handlers
 *	  returns a Resume      the disjunction of every key, for the NEXT park
 *
 * ⛔ ***THE MAP MUST BE THE SAME ON EVERY PASS, AND THIS IS THE ONE WAY TO
 * MISUSE IT.*** The host reports an index into its FLATTENED disjunction, and
 * `on()` maps it back to an arm using each key's own width - so a later pass that
 * builds a different map, or reorders one, has the host naming operands this map
 * assigns to somebody else. Build it from constants, never inside a branch. The
 * failure is silent - a handler for the wrong condition - which is why it is
 * stated here rather than guarded: nothing on either side can see the map the
 * previous pass used.
 *
 * ⚠ ***AN INDEX IS NOT A KEY'S POSITION, AND THIS DOC SAID IT WAS UNTIL
 * 2026-09-06.*** The two coincide only while every arm is ONE operand wide.
 * `fieldNoLonger` emits `(!exists) || (!= v)`, because an absent operand
 * propagates as unknown - so the builder that is CORRECT for a field Kubernetes
 * may omit is exactly the one that makes them diverge. Measured live: four such
 * arms, a wake on the fourth, and the third arm's handler ran - publishing a
 * healthy verdict about a Deployment with no pods.
 *
 * ⚠ ***A HINT, NEVER CORRECTNESS.*** An empty result means "nothing you named is
 * true" - what a backstop tick says, and what an older host returns. So a step
 * must remain correct when NO handler runs: `on()` makes the late case safe, not
 * the missing case. Do the work for a condition that holds; never skip work
 * because nothing was listed.
 *
 * ***EVERY ARM THAT HOLDS RUNS, NOT THE FIRST.*** Two conditions can be true at
 * once and the program declared a handler for each; a `switch` would silently
 * drop one and pick a different one on a different day.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * The union of every effect the arms of `A` can yield.
 *
 * ⛔ ***A NAKED `Record<string, () => Generator<E, …>>` INFERS `E` FROM ONE ARM
 * AND REJECTS THE REST, WHICH BREAKS `on()` IN EXACTLY ITS INTENDED CASE.*** The
 * whole reason to dispatch on several arms is that they watch DIFFERENT
 * subjects, and different subjects are read with different effects - a namespaced
 * `observe` and a cluster-scoped `observe-cluster`, say. Against the old
 * signature TypeScript fixed `E` to the first arm's effect and then reported the
 * second as `not assignable`, so the first program to use `on()` for its purpose
 * did not compile.
 *
 * Inferring over the RECORD TYPE and distributing lets `E` be the union. The
 * conditional is distributive because `A[keyof A]` is a union of the arm
 * functions and the checked type is a naked parameter.
 */
/** The effects one arm's `then` yields, whether it is a Step or a thunk. */
type ThenEffects<H> = H extends () => Generator<infer E, unknown, unknown>
  ? E
  : H extends Generator<infer E, unknown, unknown>
    ? E
    : never

/**
 * The UNION over every arm.
 *
 * ⚠ ***`T[number][1]` IS WHAT MAKES ARMS WITH DIFFERENT EFFECTS UNIFY.*** A
 * plain `...arms: readonly Arm<E>[]` fixes `E` on the FIRST arm and then rejects
 * every other one - which is not a type-noise problem, it is a program that
 * cannot observe two kinds of thing in one park. Indexing the tuple distributes,
 * exactly as the arms-object form's `A[keyof A]` did.
 */
type ArmsEffects<T extends readonly Arm<AnyEffect>[]> = ThenEffects<T[number][1]>

/**
 * How many operands an expression contributes to the host's FLATTENED
 * disjunction: its top-level `||` count plus one.
 *
 * ***PAREN- AND QUOTE-AWARE, BECAUSE BOTH APPEAR IN REAL ARMS.*** A path is a
 * quoted string that can contain anything, and every builder parenthesises its
 * operands - so a naive `split('||')` miscounts an arm containing a literal
 * `||` in a field path and one whose nesting is deeper than one level.
 *
 * ⚠ It counts what `HeldDisjuncts` flattens, so the two definitions must agree.
 * They are tested against each other rather than assumed: the host's own test
 * asserts the operand count for the same shapes this counts.
 */
export const topLevelOrCount = (expr: string): number => {
  let depth = 0
  let inString = false
  let operands = 1
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '|' && expr[i + 1] === '|' && depth === 0) {
      operands++
      i++
    }
  }

  return operands
}

/**
 * One arm: what to wake on, and what to do about it.
 *
 * `then` is a Step OR a thunk returning one. An effect call already returns a
 * generator, so the common single-effect arm is just the call:
 *
 *     [objectGone(POD), report({ type: 'Ready', status: 'False', … })]
 *     [drifted(DEP),    function* () { yield* ensure(…); yield* report(…) }]
 *
 * ⚠ A bare Step has its ARGUMENTS evaluated when the arm is built, not when it
 * fires. That is fine for the literal above and wrong for anything derived from
 * work another arm does - use a thunk there, and the laziness is explicit.
 */
export type Arm<E extends AnyEffect> = readonly [
  when: Resume,
  then: Generator<E, unknown, unknown> | (() => Generator<E, unknown, unknown>),
]

/**
 * Park on several conditions and run the handler for whichever HELD.
 *
 *     return quiesce(
 *       yield* on(
 *         [drifted(TARGET),  report({ type: 'Ready', status: 'False', … })],
 *         [objectGone(POD),  function* () { yield* create(…); yield* report(…) }],
 *       ),
 *     )
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***PAIRS, NOT A COMPUTED-KEY OBJECT.*** `{[expr]: handler}` reads as a map
 * when it is really a SEQUENCE, and object keys DEDUPLICATE - two arms watching
 * the same condition collapsed into one silently. A list keeps both, keeps
 * source order, and keeps `when` and `then` adjacent.
 *
 * ***A SINGLE-EFFECT ARM NEEDS NO `function*`.*** An effect call already returns
 * a generator, so `report({…})` is a Step and can be the arm itself. Reach for a
 * thunk when the arm does several things or its arguments depend on other work -
 * see `Arm`.
 *
 * ***IT RETURNS THE RESUME AND THE CALLER PARKS.*** `quiesce` is where a step
 * says what would change its mind; hiding it inside `on` would make the park
 * invisible in the program that owns it.
 *
 * ⚠ You do NOT need a `deadline(Date.now() + …)` arm for liveness: the host
 * renders `(<the whole user resume>) || Backstop()` onto every park
 * (`internal/aperture/eval.go`, `WithBackstop`). If you want to SAY so, use
 * `backstop()`, which `anyOf` folds away rather than spending an operand on.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function* on<T extends readonly Arm<AnyEffect>[]>(
  ...arms: T
): Generator<ArmsEffects<T> | Effect<typeof WIT_WOKE, 'held', void>, Resume, unknown> {
  // ***A LIST, NOT AN OBJECT, AND THE DEDUP IS ONE REASON.*** Keying handlers by
  // the rendered expression made two arms with the same condition collapse into
  // one silently, and object key order is a convention rather than a guarantee
  // for anything but string keys. A list keeps both arms and keeps source order.
  const keys = arms.map(([when]) => String(when))
  // ⛔⛔ ***THE HOST INDEXES FLATTENED OPERANDS; THIS MAP INDEXES ARMS, AND THEY
  // ARE NOT THE SAME NUMBER THE MOMENT AN ARM CONTAINS ITS OWN `||`.***
  //
  // `HeldDisjuncts` flattens `||` RECURSIVELY - it must, because the host wraps
  // the author's whole resume as `(<own>) || Backstop()` and a top-level split
  // would map every key to 0. But it cannot tell that nesting apart from an
  // arm's OWN nesting, and the builders authors should reach for are nested:
  // `fieldNoLonger` emits `(!exists) || (!= v)` precisely because an absent
  // operand propagates as unknown.
  //
  // So four `fieldNoLonger` arms are EIGHT operands to the host. Measured live on
  // `sentinel-demo`: the park fired on its condition, the host reported an index
  // into the eight, `keys[i]` was undefined, and the program dispatched NOTHING -
  // status `via 4 of 4, no dispatch`. The out-of-range guard failed SAFE, which
  // is the only reason this was a lost optimisation and not a wrong handler.
  //
  // ⇒ THE ARM'S WIDTH IS RECOVERABLE FROM ITS OWN TEXT, so the mapping is done
  // here rather than asking the host for something it cannot know. Each key
  // occupies `width` consecutive host indices; a reported index lands in exactly
  // one arm's range.
  const widths = keys.map(topLevelOrCount)
  const armOfIndex = (i: number): number | undefined => {
    let at = 0
    for (let k = 0; k < keys.length; k++) {
      if (i < at + widths[k]!) return k
      at += widths[k]!
    }

    return undefined
  }
  // ***READ BEFORE RUNNING ANYTHING.*** The indices describe the wake that
  // started this pass; a handler that yields could change the world underneath
  // a later read of them.
  const woke = reconcile.woke()
  const heldArms = ((yield* woke()) as number[] | undefined) ?? []

  const alreadyRun = new Set<number>()
  for (const i of heldArms) {
    const key = armOfIndex(i)
    if (key === undefined) {
      // The host named an arm this map does not have - the map changed between
      // passes (see above). Skipping is the only safe answer: running SOME
      // other handler would act on a condition nobody asserted.
      continue
    }
    // The CONSTRAINT says an arm yields `AnyEffect`; the RETURN TYPE promises the
    // narrower `ArmEffects<A>`. Both are true of the same value and TypeScript
    // cannot see it from inside, because it checks the body against the widened
    // constraint rather than against the caller's `A`. The assertion carries the
    // fact the signature already states.
    // ***ONCE PER ARM, NOT ONCE PER OPERAND.*** Both halves of a
    // `(!exists) || (!= v)` arm can hold at the same wake - an absent field
    // satisfies the first and, being absent, is also `!=` nothing - and the
    // program declared ONE handler for that condition.
    if (alreadyRun.has(key)) continue
    alreadyRun.add(key)
    // ***A GENERATOR OBJECT OR A THUNK.*** `report({…})` IS a Step - an effect
    // call returns a generator - so a single-effect arm needs no `function*`
    // wrapper at all. Generators are lazy, so an arm that never fires is never
    // advanced; only its ARGUMENTS are built up front, which is why a handler
    // whose arguments depend on another arm having run must stay a thunk.
    //
    // The CONSTRAINT says an arm yields `AnyEffect`; the RETURN TYPE promises
    // the narrower `ArmsEffects<T>`. Both are true of the same value, and
    // TypeScript cannot see it from in here because it checks the body against
    // the widened constraint rather than against the caller's `T`. The assertion
    // carries the fact the signature already states.
    const then = arms[key]![1] as
      | Generator<ArmsEffects<T>, unknown, unknown>
      | (() => Generator<ArmsEffects<T>, unknown, unknown>)
    yield* typeof then === 'function' ? then() : then
  }

  // ***THE RESUME, AND THE CALLER PARKS.*** `quiesce` stays at the call site: it
  // is the one place a step says what would change its mind, and hiding it here
  // would make the park invisible in the program that owns it.
  return anyOf(...(keys as unknown as Resume[]))
}
