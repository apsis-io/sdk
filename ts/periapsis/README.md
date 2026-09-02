# periapsis

See also: [CHEATSHEET.md](CHEATSHEET.md) for a dense, single-page quick
reference (signatures, gotchas, recipes) without the surrounding prose.

Ergonomic TypeScript wrappers around Periapsis's `periapsis:*` WIT interfaces,
for components built with [dwarf](https://github.com/apsis-io/dwarf)
(QuickJS, genuine WASI 0.3/Preview 3 async). Consolidates what used to be a
hand-copied `src/periapsis.ts` per `examples/wasm/*` example into one shared
module, plus two new pieces (`exec`, `magic`) that had no wrapper before.

Published as `@apsis-io/periapsis-sdk`. It ships no `.wasm`: `fetch()` needs a
separate component that the package deliberately does not carry, only the recipe
to build it (`fetch-provider/build.sh`, which needs a dwarf checkout). Every
other module works from the package alone. It ships TypeScript SOURCE rather than
built output - dwarf componentizes each consumer's own Vite bundle, so there is
nothing to compile here - and its `exports` map resolves `./x.js` to `./x.ts`,
which is why the imports below carry a `.js` suffix that no `.js` file has:

```ts
import { identity } from "@apsis-io/periapsis-sdk/identity.js";
import { config } from "@apsis-io/periapsis-sdk/config.js";
import { info } from "@apsis-io/periapsis-sdk/log.js";
import { reportStatus } from "@apsis-io/periapsis-sdk/status.js";
import { exec } from "@apsis-io/periapsis-sdk/exec.js";
import { definePlugProvider } from "@apsis-io/periapsis-sdk/magic.js";
```

**Cannot install it from a registry?** Vendor a snapshot instead - which is what
periapsis itself does, because npm and bun cannot resolve a git dependency that
lives in a subdirectory of a private repo:

```sh
<path-to-this-repo>/sync-consumer.sh ts/periapsis vendor/periapsis-sdk
```

Then depend on the copy by NAME, so imports do not change:

```json
"@apsis-io/periapsis-sdk": "file:vendor/periapsis-sdk"
```

Copies the whole SDK (every module, `types/`, `fetch-provider/`) into
`vendor/periapsis-sdk/` in your own tree; re-run it to pick up upstream
changes (it's a snapshot copy, not a symlink - `--delete`d and replaced each
run, same model as the WIT sync script). Update your imports to point at
that directory instead.

**Or install it from npm.** This directory now has a `package.json`
(`@apsis-io/periapsis-sdk`, Apache-2.0 - deliberately NOT this repo's own
Business Source License 1.1, the same reasoning `shardkit` was carved out
under GPL-3.0-or-later: a thin client SDK should be unencumbered even though
`periapsis` core (the "Licensed Work") isn't - see CLAUDE.md). Ships raw
`.ts` source, no build step (matches how every in-repo example already
consumes it - Vite/esbuild transpile on the fly); `exports` maps both
`./foo.js` and `./foo` specifiers to `./foo.ts`, so `import { identity }
from "@apsis-io/periapsis-sdk/identity.js"` resolves the same way the
in-repo relative imports already do. A consumer using plain `tsc` (no
bundler) needs `allowArbitraryExtensions`/`noEmit` to resolve `.ts` from
`node_modules` - not the common case for a dwarf-targeting project, but
worth knowing.

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
  Wraps `periapsis:host/exec@0.1.0` (ADR: the exec seam, `trail's exec implementation`) -
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
- **`console.ts`** - `consoleP3`, a typed, documented binding to dwarf's own
  pinned `consoleP3` global - see the `console` section below for why it's
  pinned rather than just re-exporting the plain `console`.
- **`sockets.ts`** - `TcpSender`, a server-side (accepted) `tcp-socket`'s
  send stream done right: ONE `send()` call and one long-lived writable per
  *connection*, not per message. Wraps `wasi:sockets@0.3` (not
  periapsis-specific) - extracted from `examples/wasm/js-dwarf-websocket`
  after a real usage-pattern bug there (dropping the writable after every
  message correctly end-of-streams `send()`'s own stream, triggering a
  genuine TCP half-close of the write side - a well-behaved peer then
  closes its own write side too, so the next `receive()` read legitimately
  sees EOF) looked exactly like a platform bug for two separate
  investigation passes before the actual mechanism was found. Also
  `readExact(readable, n)`, a small loop-until-full helper. **p3-only**
  (`wasi:sockets@0.3`'s `bind`/`listen`/accept has no p2 equivalent here).
- **`websocket.ts`** - a real WebSocket **server**, hand-rolled on
  `sockets.ts` + `sha1.ts`: `computeAcceptKey`/`parseUpgradeRequest`/
  `buildUpgradeResponse` (the RFC 6455 handshake), `readHttpHeaders`,
  `readFrame`/`buildTextFrame`/`buildBinaryFrame`/`buildCloseFrame`/
  `WS_OPCODE` (RFC 6455 framing). `wasi:http/service` has no socket-hijack/
  upgrade primitive, so this only works from a command-style component
  (`wasi:cli/command`, not `http-service`/`trail --serve`) whose own `run()`
  binds+listens directly - see `examples/wasm/js-dwarf-websocket`'s README
  for the full story (live-validated: a real `WebSocket` client, multiple
  messages round-tripped, clean close). **p3-only**, same reason as
  `sockets.ts`.
- **`sha1.ts`** - a minimal pure-JS SHA-1 (RFC 3174), no WIT dependency.
  dwarf has no `crypto`/`crypto.subtle` at all; `websocket.ts`'s handshake
  needs one for `Sec-WebSocket-Accept` (a checksum over fixed,
  non-adversarial input - not a place SHA-1's broken collision resistance
  would matter even if a real `crypto.subtle` were available).

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
not redundant. `console.{log,info,debug,warn,error}` now try WASI 0.2 first
(`wasi:cli/stdout`/`stderr@0.2.12` - sync, returns `void`) and fall back to
WASI 0.3's async write-via-stream (`Promise<void>`) when only that's
imported, and `console.{print,println,eprint,eprintln}` are unconditionally
async, `Promise`-returning, with the same 0.3-preferred/0.2-fallback
priority - see `types/dwarf.d.ts`'s `Console` interface doc comment for the
full behavior, including two real safety constraints: (1) the async family
crashes if called from a plain SYNC export (no active component-model-async
task state outside an async export call), and (2) in the 0.3-fallback case,
an *unawaited* call is only safe if something else in the same async export
subsequently awaits/yields afterward - as the literal last statement before
the export returns, it silently produces no output at all (confirmed
empirically). Reach for `console` during local/interactive debugging (e.g.
`trail --component` against a real terminal). `log.ts`'s `info`/`warn`/etc go
through `periapsis:component/log` to the HOST, which routes to
journald/`kubectl logs` - use that for anything meant to actually be visible
once deployed as a pod.

**`console.ts`** exports `consoleP3`, a typed binding to dwarf's own pinned
`consoleP3` global (`types/dwarf.d.ts`) - all nine methods, all
`Promise`-returning. This used to be a `consoleP2`/`consoleP3` split (a
guaranteed-sync view for p2 worlds alongside the async p3 one), for a real,
confirmed reason: **mixing `wasi:cli/stdout@0.2.x` with
`wasi:cli/command@0.3.0` (any p3 world) in the same world fails at
WIT-resolution time.** Confirmed empirically (not inferred): a world with
both `include wasi:cli/command@0.3.0;` and `import wasi:cli/stdout@0.2.12;`
errors `package 'wasi:cli@0.2.12' not found` during auto-vendoring, even via
a clean full auto-vendor - dwarf's WIT tooling can't resolve two different
versions of the same package name in one world. Since trail dropped WASI P2
support entirely (ADR-0045), no world in this repo can be p2-only anymore, so
`consoleP2` had no shape left that could use it and was removed - every
world here is p3-only, so `consoleP3`'s async-only shape (**every call must
be awaited** per the safety constraint above) is just how logging works now.

dwarf itself now builds `consoleP3` as a real, separately-implemented global
(not just a type-level view) and aliases the plain `console` FROM it - so
`console.ts`'s `consoleP3` binds directly to that pinned global via
`globalThis.consoleP3`, rather than casting the plain `console` (which
remains free to repoint at a future WASI version without affecting this
binding).

(The WIT-mixing limitation itself was reported to dwarf-main as a real
gap/feature request; dwarf-main confirmed it as an upstream wkg/wit-parser
dependency-resolution constraint, not a dwarf bug it can paper over, and
shipped the `log`/`info`/`debug`/`warn`/`error` p3-fallback described above in
response - both independently verified live against a fresh dwarf build.)

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
   wac plug --plug .@apsis-io/periapsis-sdk/fetch-provider/fetch-provider.wasm my-app.wasm -o my-app.composed.wasm
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

Filesystem (`writeFile`/`readFile`) helpers already exist in some examples'
own `periapsis.ts` (e.g. `js-dwarf-p3`) but weren't part of this package's
scope - still per-example for now. (Socket helpers moved in as `sockets.ts`
- see "Modules" above.)
