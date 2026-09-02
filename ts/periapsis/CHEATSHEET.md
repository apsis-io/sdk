# periapsis SDK Cheat Sheet

Quick reference for `ts/periapsis/*.ts`. See [README.md](README.md) for
full explanations, world-shape constraints, and the stories behind the
non-obvious bits; this is the fast-lookup version. See
periapsis's own `wit/CHEATSHEET.md` for the raw WIT contracts
these wrap.

**Import per-module, never the barrel** (`index.ts`) — an unused `external`
import still forces your `world.wit` to declare it, and `--host-caps` fails
closed on any declared-but-unlisted interface.

```ts
import { identity } from "@apsis-io/periapsis-sdk/identity.js";
```

## Module → WIT → world shape

| Module | Wraps | World shape |
|---|---|---|
| `identity.ts` | `periapsis:component/identity@0.1.0` | any (p2 or p3) |
| `config.ts` | `periapsis:component/config@0.1.0` | any |
| `log.ts` | `periapsis:component/log@0.1.0` | any |
| `metrics.ts` | `periapsis:component/metrics@0.1.0` | any |
| `status.ts` | `periapsis:component/status@0.1.0` (+ `identity.ts`) | any |
| `checkpoint.ts` | `periapsis:component/checkpoint@0.1.0` | any |
| `exec.ts` | `periapsis:host/exec@0.1.0` | **p3-only** (`stream<u8>`, async `wait`) |
| `magic.ts` | `periapsis:magic/handler@0.1.0` | any (`handle` is sync) |
| `fetch.ts` | `dwarf:fetch/client` (separate composed component) | any, `async`-only call site |
| `console.ts` | dwarf's built-in `consoleP3` global (pinned, not the plain `console`) | **p3-only** |
| `sockets.ts` | `wasi:sockets/types@0.3.0` (not periapsis-specific) | **p3-only** |
| `websocket.ts` | built on `sockets.ts` + `sha1.ts` | **p3-only**, command-style component only (no `wasi:http/service`) |
| `sha1.ts` | none (pure JS) | any |
| `codec.ts` | none (pure JS, real UTF-8 via dwarf's `TextEncoder`/`TextDecoder`) | any |

## Signatures

```ts
// identity.ts
identity(): {
  component: string; instance: string; sdkVersion: string;
  workload: string | null; namespace: string | null;
  podName: string | null; podUid: string | null;
  pawnName: string | null; nodeName: string | null;
  attributes: { key: string; value: string }[];
}

// config.ts
config(key: string): string | undefined

// log.ts
type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
log(level: LogLevel, message: string, attrs?: Record<string, string>): void
trace/debug/info/warn/error(message: string, attrs?: Record<string, string>): void

// metrics.ts
counter(name: string, by?: number /* =1 */, labels?: Record<string, string>): void
gauge(name: string, value: number, labels?: Record<string, string>): void
histogram(name: string, value: number, labels?: Record<string, string>): void

// status.ts
type HealthState = "starting" | "ready" | "degraded" | "failed" | "stopping";
reportStatus(state: HealthState, message?: string): void

// checkpoint.ts
checkpointRequested(): boolean
checkpointSave(state: unknown): void
checkpointLoad<T = unknown>(): T | undefined

// exec.ts (p3-only)
interface ExecResult { exitCode: number; stdout: string; }
exec(name: string, args?: string[], input?: string): Promise<ExecResult>
spawn(name: string, args?: string[], input?: string): ChildProcess   // for interleaved read/write
drainStdout(child: ChildProcess): Promise<string>

// magic.ts
type SeamErrorTag = "unavailable" | "rejected" | "too-large";
class SeamError extends Error { readonly tag: SeamErrorTag }
seamUnavailable() / seamRejected() / seamTooLarge(): SeamError
definePlugProvider(handle: (req: Uint8Array) => Uint8Array): { handle: (req: Uint8Array) => Uint8Array }
callSeam(hostHandle: (req: Uint8Array) => Uint8Array, req: Uint8Array): Uint8Array

// fetch.ts (async-export-only; needs wac plug compose, see README)
fetch(input: string | Request, init?: RequestInit): Promise<Response>

// console.ts — a pinned binding to dwarf's own consoleP3 global (real,
// separately-built by dwarf, not a cast of the plain `console`)
consoleP3: { log/info/debug/warn/error/print/println/eprint/eprintln(...args): Promise<void> }  // MUST await every call

// sockets.ts (p3-only) — ONE send() stream per connection, not per message
class TcpSender {
  constructor(sock: TcpSocket)
  send(bytes: Uint8Array): Promise<void>
  close(): Promise<void>   // call once, when connection is done
}
readExact(readable: { read(n): Promise<Uint8Array> }, n: number): Promise<Uint8Array>

// websocket.ts (p3-only, command-style component only)
computeAcceptKey(clientKey: string): string
readHttpHeaders(readable): Promise<string>
parseUpgradeRequest(headerText: string): { key: string } | null
buildUpgradeResponse(clientKey: string): Uint8Array
readFrame(readable): Promise<{ opcode: number; payload: Uint8Array } | null>
buildTextFrame(text: string) / buildBinaryFrame(bytes) / buildCloseFrame(): Uint8Array
WS_OPCODE: { CONTINUATION:0x0, TEXT:0x1, BINARY:0x2, CLOSE:0x8, PING:0x9, PONG:0xa }

// sha1.ts
sha1(message: Uint8Array): Uint8Array   // RFC 3174, not for adversarial input

// codec.ts
stringToBytes(s: string): Uint8Array
bytesToString(bytes: Uint8Array): string
concatBytes(chunks: Uint8Array[]): Uint8Array
```

## Gotchas

- **`console` vs `log.ts`**: different destinations. `console` → real
  terminal (local/`trail --component` debugging only). `log.ts` → host →
  journald/`kubectl logs` (what's actually visible once deployed). Not
  redundant — use `log.ts` for anything meant to survive deployment.
- **`consoleP3` is the only console export** — trail dropped WASI P2 support
  entirely (ADR-0045), so a `consoleP2` sync view no longer has any world
  that could use it; it's been removed. Every world in this repo is p3-only,
  so `consoleP3`'s async-only shape is simply how logging works now.
  **Await every `consoleP3` call** — an unawaited call as the literal last
  statement before an async export returns produces no output at all,
  silently (confirmed empirically; two unawaited calls followed by an
  awaited third one *do* all flush correctly — it's about nothing
  subsequent forcing the write through, not "unawaited is always lost").
- **`consoleP3`/`console.print*` family**: crashes outright ("no active task
  state") if called from a plain sync export — only safe from an `async`
  export (e.g. `wasi:cli/run@0.3.0`).
- **`sockets.ts`'s `TcpSender`**: exists specifically because dropping the
  writable after every individual message looks fine but is wrong — it
  triggers a real TCP half-close of your write side, and a well-behaved peer
  reacts by closing its own write side, so your next `receive()` read then
  legitimately (not buggily) sees EOF. Open **one** `TcpSender` per
  connection, `send()` every message through it, `close()` once at the end.
- **`sock.send(readable)` itself is NOT a Promise** — its WIT signature is a
  plain (non-`async`) `func` returning `future<result<_,error-code>>`, which
  dwarf's runtime represents as a `FutureReadable` wrapper (`{read(), drop()}`),
  not a real `Promise`. `await sock.send(...)` or handing it to `Promise.all`
  silently never waits on it — `TcpSender` (and `readExact`) already handle
  this correctly; don't reach for `sock.send`/`receive` raw unless you have to.
- **`exec.ts`/`sockets.ts`/`websocket.ts` are p3-only.** Need `trail --p3`
  and (for `exec`) `--exec-with <name>=<path>` at pod launch — an
  undeclared name throws `{ tag: "not-allowed" }`.
- **`websocket.ts` needs a command-style component**, not `wasi:http/service`
  (`trail --serve`) — `wasi:http` has no socket-hijack/upgrade primitive, so
  a WS server's own `run()` must bind/listen/accept directly.
- **`fetch.ts` needs a build-time compose step**, not just an import — see
  README's "Outbound HTTP" section for the full `wac plug` recipe. Run the
  *composed* output; the plain one has an unsatisfied `dwarf:fetch/client`
  import and won't instantiate.
- **`magic.ts`'s `handle` is sync** — a provider can't do async I/O through
  this seam at all (use `exec.ts` for that shape instead).

## Common recipes

```ts
// Minimal component: identity + structured logging + health
import { identity } from "@apsis-io/periapsis-sdk/identity.js";
import { info, warn } from "@apsis-io/periapsis-sdk/log.js";
import { reportStatus } from "@apsis-io/periapsis-sdk/status.js";

reportStatus("starting");
const id = identity();
info("component starting", { component: id.component, instance: id.instance });
reportStatus("ready", "listening");

// p3 command component doing structured logging (must await)
import { consoleP3 } from "@apsis-io/periapsis-sdk/console.js";
export const run = {
  async run() {
    await consoleP3.log("hello from run()");
  },
};

// Allowlisted child process (p3, needs --exec-with foo=/path/to/foo.wasm)
import { exec } from "@apsis-io/periapsis-sdk/exec.js";
const { exitCode, stdout } = await exec("foo", ["--flag"], "stdin input\n");

// Server-side socket, sending multiple messages on one connection (p3)
import { TcpSender, readExact } from "@apsis-io/periapsis-sdk/sockets.js";
const sender = new TcpSender(conn);
try {
  await sender.send(new TextEncoder().encode("first\n"));
  await sender.send(new TextEncoder().encode("second\n"));
} finally {
  await sender.close();
}
```
