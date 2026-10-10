# ADR-0075 step contract in Effect-TS — capabilities in the type, at 6x the size

Same step, same five arms, same WIT world as `../perseid-ts` and `../perseid-ocaml`.
All three produce **identical output**.

Built with `dwarf --minify --opt-size`; best-of-5, warm cache.

| | artifact | wake |
|---|---|---|
| `../perseid-ts` | 1.43 MB | 39 ms |
| `../perseid-ocaml` | 2.66 MB | 58 ms |
| **this** | **8.57 MB** | **190 ms** |

## What it buys, and it is real

`Effect<A, E, R>` tracks **required capabilities in the type**. `step` here is
inferred as `Effect<Outcome, never, Observe | Emit>` — it *cannot be run* until
both are provided. That is ADR-0075's "effects declared, not performed" enforced
by the compiler rather than by discipline, and it is strictly more than either
alternative offers: plain generators do not track capabilities at all, and OCaml
5's effects are **untyped** (its GADT checks an effect's result type, not which
effects a function performs).

Three more things come free that the ADR would otherwise have to design:

- **`Layer` is the handler.** Swapping the real world for a fake snapshot is one
  `provide`, so replay and unit tests are built in — see `runCase`.
- **`TestClock`** gives deterministic time, which is exactly why ADR-0075 makes
  `Now` an effect.
- **`Schedule`** expresses retry and back-off as data, which is what obligations
  need.

## What it costs

**5x the artifact and ~4x the wake latency of plain TS**, for a program whose
logic is forty lines. Under ADR-0075's model — parked programs woken per event —
wake latency is the metric that matters, not artifact size, and 198 ms per wake
is a real budget.

*Not a final verdict:* this uses neither wasmtime's pooling allocator nor
pre-instantiation, both of which exist on trail's serve path. Treat it as an
un-optimised ceiling.

## It needs `--polyfill url`

Without it, componentization fails during Wizer:

    Failed to evaluate user JavaScript module: Error: URL is not defined
        at hash (/dist/main.js:811:30)
        at MetricKeyImpl ...
        at counter ...

Effect's metrics module builds a metric key at import time, which hashes via
`URL`. This is the same JS-engine-layer gap class ADR-0059's w8s work hit
(`URL`, `structuredClone`, `setTimeout`) — worth expecting for any large library
under QuickJS, and worth testing before designing around one.

The concern that did *not* materialise: Effect's **fiber runtime works** under
QuickJS. `Effect.runSync` drives its own scheduler inside the component with no
host timer support and completes correctly.

## Build

    ./build.sh
    trail --component perseid-effect.wasm --p3 --host-caps none
