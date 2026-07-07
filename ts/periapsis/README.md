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
  from any WIT interface at all (`console` - see dwarf's own README "Console"
  section).

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

## What this doesn't replace

Filesystem (`writeFile`/`readFile`) and socket (`tcpSendReceive`) helpers
already exist in some examples' own `periapsis.ts` (e.g. `js-dwarf-p3`) but
weren't part of this package's requested scope - still per-example for now.
