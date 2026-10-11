// ADR-0075's step contract in Effect-TS. Same logic and same five arms as
// ../perseid-ocaml and ../perseid-ts, so artifact sizes are directly comparable.
//
// WHY THIS ONE IS INTERESTING: Effect<A, E, R> tracks REQUIRED CAPABILITIES in
// the type. `step` below is Effect<Outcome, never, Observe | Emit> — it cannot
// be run until both are provided. That is "effects declared, not performed"
// enforced by the compiler, which is the one thing neither plain generators nor
// OCaml 5 give you (OCaml's effects are untyped; only the GADT's result type is
// checked).

import { Context, Effect, Layer } from 'effect'

type Obs<T> = { t: 'known'; v: T } | { t: 'absent' } | { t: 'unknown' }
type Outcome = { o: 'yield' } | { o: 'quiesce' } | { o: 'terminate' }

// The two capabilities, as services. These are the WIT imports of the step.
class Observe extends Context.Tag('Observe')<
  Observe,
  { readonly get: (key: string) => Effect.Effect<Obs<number>> }
>() {}

class Emit extends Context.Tag('Emit')<
  Emit,
  { readonly act: (s: string) => Effect.Effect<void> }
>() {}

// Note the inferred type: Effect<Outcome, never, Observe | Emit>.
const step = Effect.gen(function* () {
  const observe = yield* Observe
  const emit = yield* Emit

  const have = yield* observe.get('replicas')
  switch (have.t) {
    case 'absent':
      return { o: 'terminate' } as Outcome
    case 'unknown':
      return { o: 'yield' } as Outcome
    case 'known': {
      const want = 3
      if (have.v < want) {
        yield* emit.act(`scale +${want - have.v}`)
        return { o: 'yield' } as Outcome
      }
      if (have.v > want) {
        yield* emit.act(`scale -${have.v - want}`)
        return { o: 'yield' } as Outcome
      }
      yield* emit.act('status readyReplicas=3')
      return { o: 'quiesce' } as Outcome
    }
    default: {
      const _exhaustive: never = have
      throw new Error(`unreachable: ${JSON.stringify(_exhaustive)}`)
    }
  }
})

const name = (o: Outcome) => ({ yield: 'Yield', quiesce: 'Quiesce', terminate: 'Terminate' })[o.o]

// The runtime half is a Layer. Swapping the real world for a fake snapshot is
// one `provide` — which is where Effect's testability claim comes from.
function runCase(label: string, obs: Obs<number>) {
  const acts: string[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(Observe, { get: () => Effect.succeed(obs) }),
    Layer.succeed(Emit, { act: (s: string) => Effect.sync(() => { acts.push(s) }) }),
  )
  const outcome = Effect.runSync(step.pipe(Effect.provide(layer)))
  console.log(`${label.padEnd(10)} -> ${name(outcome).padEnd(9)} acts=[${acts.join('; ')}]`)
}

export const run = {
  async run() {
    runCase('below', { t: 'known', v: 1 })
    runCase('equal', { t: 'known', v: 3 })
    runCase('above', { t: 'known', v: 5 })
    runCase('absent', { t: 'absent' })
    runCase('unknown', { t: 'unknown' })
  },
}
