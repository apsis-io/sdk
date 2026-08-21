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
export type Resume =
  | { readonly r: 'changed'; readonly ref: string }
  | { readonly r: 'exists'; readonly query: string }
  | { readonly r: 'missing'; readonly query: string }
  | { readonly r: 'countNe'; readonly query: string; readonly n: number }
  | { readonly r: 'after'; readonly ms: number }
  | { readonly r: 'any'; readonly of: readonly Resume[] }
  | { readonly r: 'all'; readonly of: readonly Resume[] }

export const changed = (ref: string): Resume => ({ r: 'changed', ref })
export const exists = (query: string): Resume => ({ r: 'exists', query })
export const missing = (query: string): Resume => ({ r: 'missing', query })
export const countNe = (query: string, n: number): Resume => ({ r: 'countNe', query, n })
export const after = (ms: number): Resume => ({ r: 'after', ms })
export const anyOf = (...of: Resume[]): Resume => ({ r: 'any', of })
export const allOf = (...of: Resume[]): Resume => ({ r: 'all', of })

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

