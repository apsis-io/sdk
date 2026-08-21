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
// the kubelet-benchmark harness (done/2026-08-11_perigeos-vs-kubelet-same-board.md
// — `pgrep -c` printing 0 while exiting non-zero, `shim_pss` returning 0 for an
// unreadable smaps, a settle check that could not tell drained from
// never-started). Collapsing the two into `undefined` reintroduces that whole
// family, so the type will not let you.
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
export type Resume = string

/**
 * Quote a literal for the aperture grammar.
 *
 * *** THE GRAMMAR'S STRING TOKEN IS `"[^"]*"` — THERE ARE NO ESCAPES. *** A
 * value containing a double quote cannot be represented at all, so this REFUSES
 * rather than emitting something that will not parse. A silently-mangled
 * selector would park a program on a condition nobody can satisfy, which is the
 * exact state the whole design exists to make inspectable.
 */
const lit = (s: string): string => {
  if (s.includes('"')) {
    throw new Error(
      `perseid: a resume literal cannot contain a double quote (got ${JSON.stringify(s)}). ` +
        'The aperture grammar has no string escapes, so this would produce an expression ' +
        'that does not parse and a program parked on a condition nobody can satisfy.'
    )
  }
  return `"${s}"`
}

/** Wake when a named pod is readable. */
export const exists = (name: string): Resume => `GetPod(${lit(name)}).exists`

/**
 * Wake when a named pod is ABSENT.
 *
 * *** A NEGATION, NOT A COMPARISON — AND FOR TWO REASONS. *** The grammar has no
 * boolean literals, so `== false` does not parse. And it is the correct form:
 * `exists` maps Known->true, Absent->false, Unknown->Unknown, and `!` propagates
 * a non-Known observation rather than flipping it. *** A pod that cannot be read
 * is not "missing" *** — treating it as missing would wake a program to tear
 * something down because the apiserver blipped.
 */
export const missing = (name: string): Resume => `!GetPod(${lit(name)}).exists`

/** Wake when the pods matching a LABEL SELECTOR stop numbering n. */
export const countNe = (selector: string, n: number): Resume =>
  `ListPods(${lit(selector)}).length != ${n}`

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
export const deadline = (atEpochMillis: number): Resume =>
  `Now() >= ${Math.trunc(atEpochMillis)}`

/**
 * `deadline`, computed from the guest's clock: wake `ms` from `nowEpochMillis`.
 *
 * *** BOTH ARGUMENTS ARE REQUIRED so there is no hidden second time source. ***
 * `now` is a capability (reconcile.wit's `observe.now`), not a syscall — a
 * replay supplies a recorded one and a step stays a pure function of its
 * observations. Reading a clock inside this helper would defeat that.
 */
export const deadlineIn = (ms: number, nowEpochMillis: number): Resume =>
  deadline(nowEpochMillis + ms)

/**
 * *** REPLACED BY `deadlineIn(ms, now)`, AND THIS THROWS RATHER THAN INVENTING A
 * CLOCK. ***
 *
 * `after(ms)` was a delay with no instant attached, which only worked because
 * something downstream supplied the park time — the `parkedAt` side-car this
 * change exists to delete. Restoring it here would mean either reading a clock
 * inside the SDK (destroying replayability: `now` is a CAPABILITY, so a replay
 * supplies a recorded one and a step stays a pure function of its observations)
 * or re-introducing the second value that has to stay correct.
 *
 * Kept as a throwing export rather than deleted so the four call sites still
 * RESOLVE their import and fail with this sentence instead of a module-level
 * "no such export", which says nothing about what to do.
 */
export const after = (ms: number): Resume => {
  throw new Error(
    `perseid: after(${ms}) is gone — a resume carries an ABSOLUTE deadline now. ` +
      'Use deadlineIn(ms, Number(now())) with the guest\'s own clock, or deadline(atEpochMillis). ' +
      'A bare delay needed a parkedAt travelling beside the expression, and that side-car is ' +
      'exactly what the expression form removes.'
  )
}

/**
 * *** NOT EXPRESSIBLE, AND THIS THROWS RATHER THAN GUESSING. ***
 *
 * `changed(ref)` has no aperture equivalent and never had one:
 *
 *   - aperture has no notion of CHANGE. There is no resourceVersion,
 *     generation, or previous-value in the language — every symbol answers
 *     "what is true now", so "it moved" cannot be written.
 *   - it has no DEPLOYMENT symbol either. `GetDeployment` exists on the facade
 *     (aperture/getdeployment.go) but is absent from `provides`/`dispatch`, so a
 *     resume expression cannot name a workload at all.
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
      'aperture has no notion of change (no resourceVersion/generation) and no deployment ' +
      'symbol, and the Go host never had a `changed` arm — a park using it was always ' +
      'refused. Use countNe/exists/missing on what you can observe, or deadlineIn for a ' +
      'poll. Closing this needs a capability decision, not a workaround.'
  )
}

// `paren`, not `group`: this file already EXPORTS a `group` Step combinator
// (see below), and a second declaration merges with it rather than shadowing.
const paren = (r: Resume): string => `(${r})`

/** Wake when ANY sub-condition holds. */
export const anyOf = (...of: Resume[]): Resume => of.map(paren).join(' || ')

/**
 * Wake when EVERY sub-condition holds.
 *
 * *** A TIME BOUND INSIDE THIS IS NOT A BACKSTOP. *** It is gated by its
 * siblings and cannot fire alone, so the host will add its own — see
 * `reconcilehost.hasTimeBound`. If you want a guaranteed wake, put the deadline
 * in an `anyOf`.
 */
export const allOf = (...of: Resume[]): Resume => of.map(paren).join(' && ')

// ---------------------------------------------------------------------------
// Outcome. `quiesce` REQUIRES a resume expression — there is no way to say "I am
// done for now" without saying what would change your mind. The host is expected
// to add its own bounded `after` backstop on top, so a declared condition that
// is too narrow degrades to a slow poll rather than a lost wakeup.
export type Outcome =
  | { readonly o: 'yield' }
  | { readonly o: 'quiesce'; readonly resume: Resume }
  | { readonly o: 'terminate' }

export const yieldStep: Outcome = { o: 'yield' }
export const quiesce = (resume: Resume): Outcome => ({ o: 'quiesce', resume })
export const terminate: Outcome = { o: 'terminate' }

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
 *     const observe = defineEffect<string, Obs<number>>()('periapsis:reconcile/observe@0.1.0', 'get')
 *     const scale   = defineEffect<{path: string, n: number}, void>()('periapsis:reconcile/workloads@0.1.0', 'scale')
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
  return <W extends string, Op extends string>(_wit: W, op: Op) =>
    function* (args: A): Step<Effect<W, Op, A>, R> {
      return (yield { op, args }) as R
    }
}

// ---------------------------------------------------------------------------
// The runner.
//
// `Handler<E>` is a mapped type over E's `op`s, so it must be TOTAL: omit one
// and the call does not compile. That makes "the runner handles every
// capability" structural rather than a review item.
export type Handler<E extends AnyEffect> = {
  readonly [K in Exclude<E['op'], StructuralOp>]: (args: Extract<E, { op: K }>['args']) => unknown
}

/**
 * Drive one step to completion against `handler`, which supplies the world.
 *
 * Total by construction in the only sense that matters here: it performs no I/O
 * itself and returns whatever the step returns. A step that loops forever still
 * loops forever — bounding that is the host's job (fuel or a deadline), not the
 * type system's.
 */
export function runStep<E extends AnyEffect, A>(
  step: () => Step<E, A>,
  handler: Handler<NoInfer<E>>,
): A {
  return driveSync(step(), handler as Record<string, (a: unknown) => unknown>)
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
  handler: Handler<NoInfer<E>>,
): Promise<A> {
  return driveAsync(step(), handler as Record<string, (a: unknown) => unknown>)
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

type YieldOf<S> = S extends Step<infer E, any> ? E : never
type ReturnOf<S> = S extends Step<any, infer R> ? R : never

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

