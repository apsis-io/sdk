# periapsis

Ergonomic TypeScript wrappers around Periapsis's `periapsis:*` WIT interfaces,
for components built with [dwarf](https://github.com/apsis-io/dwarf)
(QuickJS, genuine WASI 0.3/Preview 3 async). Consolidates what used to be a
hand-copied `src/periapsis.ts` per `examples/wasm/*` example into one shared
module, plus two new pieces (`exec`, `magic`) that had no wrapper before.

Not an npm package - just TypeScript source, imported by relative path (dwarf
componentizes each consumer's own Vite bundle, so there's nothing to publish
or install). From an example three levels down (`examples/wasm/<name>/src/`):

```ts
import { identity } from "../../../../sdk/ts/periapsis/identity.js";
import { config } from "../../../../sdk/ts/periapsis/config.js";
import { info } from "../../../../sdk/ts/periapsis/log.js";
import { reportStatus } from "../../../../sdk/ts/periapsis/status.js";
import { exec } from "../../../../sdk/ts/periapsis/exec.js";
import { definePlugProvider } from "../../../../sdk/ts/periapsis/magic.js";
```

**Import each module directly, not the `index.js` barrel** (unless you
already use every `periapsis:component/*` interface): Vite/Rollup treats an
`external` import (`periapsis:*`/`wasi:*` are marked external in every
example's `vite.config.ts`, since dwarf/the host satisfies them, not the
bundle) as having unknowable side effects and keeps it in the output even
when the imported binding ends up unused. A single shared module importing
all six `periapsis:component/*` interfaces would force every consumer's
`world.wit` to declare all six regardless of which ones it actually calls -
breaking this codebase's minimal-capability-surface principle
(`--host-caps`: an unlisted interface fails closed at instantiation). That's
why this package is six small per-interface modules instead of one
`component.ts` (confirmed live: the monolithic version broke
`js-dwarf-plug`'s build with an unresolved `periapsis:component/identity`
import it never called).

## Modules

- **`identity.ts`** - `identity()`.
- **`config.ts`** - `config(key)`.
- **`log.ts`** - `log`/`trace`/`debug`/`info`/`warn`/`error`.
- **`metrics.ts`** - `counter`/`gauge`/`histogram`.
- **`status.ts`** - `reportStatus` (depends on `identity.ts` - a real
  dependency, `status.notify` needs identity's component/instance fields).
- **`checkpoint.ts`** - `checkpointRequested`/`checkpointSave`/`checkpointLoad`.

  All six wrap `periapsis:component/*` - plain sync functions, usable from
  any world (p2 or p3).
- **`exec.ts`** - `exec(name, args?, input?)` and the lower-level `spawn`/`drainStdout`.
  Wraps `periapsis:host/exec@0.1.0` (ADR: the exec seam, `tools/trail/src/exec.rs`) -
  allowlisted child-component spawning. **p3-only** (`stream<u8>` + an `async
  func` need trail's `--p3` launch path); a guest may only spawn a name
  declared at pod launch via `--exec-with <name>=<path>`.
- **`magic.ts`** - `definePlugProvider(handle)` for authoring a magic-seam
  provider, `callSeam(handle, request)` for consuming one, and the typed
  `SeamError`/`seamUnavailable`/`seamRejected`/`seamTooLarge` instead of raw
  `throw { tag: "..." }` object literals. Wraps `periapsis:magic/handler`
  (ADR-0028) - `handle` is a plain sync WIT func, not `async func`, so a
  provider can't do async I/O through this seam (see `exec.ts` for the
  subprocess-shaped alternative).
- **`fetch.ts`** - `fetch(input, init) -> Response`, a standard outbound
  `fetch()`. Unlike every other module here, this one needs a build-time
  compose step, not just an import - see "Outbound HTTP (`fetch.ts`)" below.
- **`console.ts`** - `consoleP2`/`consoleP3`, typed narrower views onto
  dwarf's built-in `console` global, split by which world shape can safely
  use which methods - see the `console` section below for why.

## Type declarations

Three ambient `.d.ts` files under `types/`, split by what actually owns each
declaration - not one grab-bag:

- **`types/periapsis.d.ts`** - the `periapsis:*` WIT interfaces this package
  wraps (`periapsis:component/*`, `periapsis:host/exec@0.1.0`,
  `periapsis:magic/handler@0.1.0`).
- **`types/wit.d.ts`** - the generic component-model-async stream plumbing
  (the `wit` global's `Stream` helper, `StreamReadableU8`/`StreamWritableU8`)
  - not periapsis-specific, applies to any WASI 0.3/p3 world.
- **`types/dwarf.d.ts`** - dwarf's own runtime globals that aren't derived
  from any WIT interface at all: `console` (see dwarf's own README "Console"
  section), `TextEncoder`/`TextDecoder` (always on, no `--polyfill`, real
  UTF-8 - `codec.ts` uses these instead of a hand-rolled ASCII-only codec, a
  correctness fix as well as a simplification), and `process` (also always
  on - `env`/`argv`/`cwd()`/`exit()`, no stdout/stderr surface; doesn't
  overlap with `config.ts` - `process.env` is raw OS env vars, `config.ts`
  is periapsis's own structured per-pod config).

dwarf does no type-checking of its own (and `jco types`/`--emit-types`
doesn't actually match dwarf's runtime conventions - see `exec.ts`'s header
comment) - these three files are purely for the author's `tsc`/editor
experience and never affect the build. A consuming example that needs MORE
than this package covers (its own `wasi:filesystem`/`wasi:sockets` usage, say)
still declares those itself, same as before.

**`console` (`types/dwarf.d.ts`) vs `log.ts`**: two different logging paths,
not redundant. `console.{log,info,debug,warn,error}` are sync (need
`wasi:cli/stdout`/`stderr@0.2.12` imported) and
`console.{print,println,eprint,eprintln}` are async, `Promise`-returning
(prefer `wasi:cli/stdout`/`stderr@0.3.x` if imported, else fall back to the
0.2.x sync path) - see `types/dwarf.d.ts`'s `Console` interface doc comment
for the full behavior, including a real safety constraint: the four async variants
crash if called from a plain SYNC export (no active component-model-async
task state outside an async export call). Reach for `console` during
local/interactive debugging (e.g. `trail --component` against a real
terminal). `log.ts`'s `info`/`warn`/etc go through `periapsis:component/log`
to the HOST, which routes to journald/`kubectl logs` - use that for anything
meant to actually be visible once deployed as a pod.

**`console.ts`** splits the single `console` global into two narrower,
world-shape-specific views - `consoleP2` (`log`/`info`/`debug`/`warn`/`error`)
and `consoleP3` (`print`/`println`/`eprint`/`eprintln`) - for a real, confirmed
reason, not just organization: **mixing `wasi:cli/stdout@0.2.x` (which
`log`/`info`/`debug` need) with `wasi:cli/command@0.3.0` (any p3 world) in the
same world fails at WIT-resolution time.** Confirmed empirically (not
inferred): a world with both `include wasi:cli/command@0.3.0;` and
`import wasi:cli/stdout@0.2.12;` errors `package 'wasi:cli@0.2.12' not found`
during auto-vendoring, even via a clean full auto-vendor - dwarf's WIT
tooling can't resolve two different versions of the same package name in one
world. A p3 component can safely use `consoleP3` (works against the 0.3.x
stdout/stderr its `wasi:cli/command@0.3.0` include already provides) but
**cannot** also use `consoleP2` - importing `wasi:cli/stdout@0.2.x` to get it
won't build alongside that world's own `wasi:cli@0.3.0`. Both are just typed
views onto the same runtime `console` global (zero extra cost) - import only
the one matching your world's shape, so calling the wrong family is a type
error at author time, not a build failure discovered later.

(Flagged to dwarf-main as a real gap/feature request: `log`/`info`/`debug`
could in principle also prefer `wasi:cli/stdout@0.3.x` first the same way
`print`/`println` already do, which would sidestep this limitation entirely
for p3 consumers - not yet implemented as of this writing.)

## Outbound HTTP (`fetch.ts`)

`fetch.ts` wraps `dwarf:fetch/client` (a SEPARATE component,
`fetch-provider/fetch-provider.wasm`, built from dwarf's own
`examples/fetch-provider` - not part of dwarf itself, adapted from that
example's own `fetch.js` DX wrapper). Unlike every other module in this
package, importing it isn't enough on its own - `dwarf:fetch/client`'s
implementation needs `wit.Future`/`wit.Stream` type indices that only make
sense inside `fetch-provider`'s own fixed, minimal world, so it has to be
composed in as a separate component at build time:

1. Vendor `fetch-provider/package.wit`'s `interface client {...}` block into
   your own `wit/deps/dwarf-fetch/package.wit`, and
   `import dwarf:fetch/client;` in your world (auto-vendoring also works -
   the global wkg config's `dwarf` namespace mapping, alongside `periapsis`,
   points at the same local registry `wit/.registry/`, which includes a copy
   of this interface).
2. Build with `--polyfill fetch-classes` (for `Request`/`Response`/`Headers`),
   then compose `fetch-provider.wasm` in via `wac plug`:
   ```bash
   dwarf --wit wit --js dist/main.js -o my-app.wasm --polyfill fetch-classes
   wac plug --plug .../sdk/ts/periapsis/fetch-provider/fetch-provider.wasm my-app.wasm -o my-app.composed.wasm
   ```
   Run the COMPOSED output, not the plain one - the plain one has an
   unsatisfied `dwarf:fetch/client` import and fails to instantiate.

`fetch` is `async` end to end - only callable from an async export.
`fetch-provider/build.sh` rebuilds `fetch-provider.wasm` from dwarf's own
example (`$DWARF_REPO`, defaults to `~/git/dwarf`) - re-run it when picking
up a newer dwarf.

Live-validated end to end: a real POST with a body, through `fetch.ts`,
composed via `wac plug`, run on `trail --p3` against a real local HTTP
server - correct status/body round-trip. (One real dead end along the way,
worth recording: an empty response body first looked like a `fetch-provider`
or trail bug, reproduced identically under raw `wasmtime` too - turned out to
be the test's OWN throwaway HTTP server not decoding `Transfer-Encoding:
chunked` request bodies, nothing to do with `fetch-provider`/trail at all.)

Known limits (inherited from `fetch-provider`, not fixed here): response
bodies are read with a single `read(65536)` call, not a drain loop - bodies
larger than 64KB are truncated. `request.url` is parsed with a small regex
(`http(s)://host[:port]/path?query`), not full WHATWG URL parsing.

## What this doesn't replace

Filesystem (`writeFile`/`readFile`) and socket (`tcpSendReceive`) helpers
already exist in some examples' own `periapsis.ts` (e.g. `js-dwarf-p3`) but
weren't part of this package's requested scope - still per-example for now.
