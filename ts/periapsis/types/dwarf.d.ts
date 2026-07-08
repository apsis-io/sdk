// dwarf's own built-in runtime globals - NOT derived from any WIT interface
// (contrast periapsis.d.ts/wit.d.ts, which both mirror real WIT-level
// bindings). console, TextEncoder/TextDecoder, and process.

// dwarf's built-in TextEncoder/TextDecoder (always on, no --polyfill, zero
// extra cost) - confirmed with dwarf-main: hand-written by dwarf itself and
// verified byte-for-byte against real TextEncoder/TextDecoder, including
// WHATWG-spec lone-surrogate replacement. codec.ts uses these instead of a
// hand-rolled charCodeAt/fromCharCode codec (which was ASCII-only and
// silently mangled genuine non-ASCII text before dwarf shipped these).
declare class TextEncoder {
  readonly encoding: "utf-8";
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  readonly encoding: string;
  constructor(label?: string);
  decode(input?: Uint8Array): string;
}

// dwarf's built-in `process` global (always on, no --polyfill - same
// always-exists-throws-a-clear-error-if-the-backing-import-is-missing
// pattern as console). Needs wasi:cli/environment@0.2.x imported for env/
// argv/cwd, wasi:cli/exit@0.2.x for exit() - both interfaces are IDENTICAL
// in shape between WASI 0.2 and 0.3 (unlike stdout/stderr), so no version
// branching needed.
//
// Does NOT overlap with periapsis:component/config (config.ts) - process.env
// is raw OS-level environment variables, config.ts is periapsis's own
// structured per-pod config (periapsis.io/config.<key> annotations). Safe to
// use both. Also does not overlap with console - process has no stdout/
// stderr surface at all, purely env/argv/exit.
interface Process {
  /** Always freshly re-fetched from wasi:cli/environment on access, never cached. */
  readonly env: Record<string, string>;
  /** Exactly get-arguments()'s raw list - no synthetic node/script-path entries prepended. */
  readonly argv: string[];
  /** wasi:cli/environment's initial-cwd() - null (not fabricated) when WASI reports none. */
  cwd(): string | null;
  /** Maps to wasi:cli/exit's exit-with-code(u8) - code is coerced to a byte. */
  exit(code?: number): never;
}
declare const process: Process;

// dwarf's built-in `console` global (see dwarf's own README's "Console"
// section, and confirmed directly with dwarf-main - the README was still
// catching up on print/println/eprint/eprintln when this was written).
// `console` always EXISTS regardless of what's imported; calling a method
// whose backing import is missing throws (log/info/debug/warn/error) or
// rejects (print/println/eprint/eprintln) with a clear error naming what to
// add, rather than being silently absent.
//
// Two families with DIFFERENT sync/async shapes and DIFFERENT safety rules:
//
// - log/info/debug (need wasi:cli/stdout@0.2.12) and warn/error (need
//   wasi:cli/stderr@0.2.12) are SYNC, return void, and format non-string args
//   via JSON.stringify (a compact single-line dump, NOT Node's multi-line
//   util.inspect - plain objects/arrays print fine, but console.log(undefined)
//   prints a BLANK line, not "undefined" - JSON.stringify(undefined) is the
//   JS value undefined, coerced to '' by the internal join - and a circular-
//   reference object THROWS SYNCHRONOUSLY at the call site). Safe to call
//   fire-and-forget from anywhere, including a plain sync export.
// - print/println/eprint/eprintln are ASYNC (always return a Promise, reject
//   on failure, never throw synchronously) and write raw args with no
//   JSON.stringify formatting - println adds a trailing newline, print
//   doesn't; the e-prefixed pair go to stderr instead of stdout. Backing,
//   in priority order: wasi:cli/stdout@0.3.x/stderr@0.3.x if imported
//   (genuinely async, real stream<u8> writes) else wasi:cli/stdout@0.2.x/
//   stderr@0.2.x (a sync write wrapped in an async fn, still Promise-
//   returning for API uniformity) else the promise rejects naming both
//   import options.
//
//   SAFETY CONSTRAINT: the 0.3-backed path uses component-model-async stream/
//   future machinery that has NO task state outside an active async export
//   call - calling print/println/eprint/eprintln (even indirectly) from a
//   PLAIN SYNC export crashes outright ("no active task state" panic, not a
//   graceful error/rejection). Only call these four from within an async
//   export (e.g. wasi:cli/run@0.3.0, or an async periapsis:magic/handler -
//   note the magic seam's own handle is NOT async func, see magic.ts). If
//   you need console output from a sync export, use log/info/debug/warn/error
//   instead - they have no such restriction.
//
// This whole family is a lower-level alternative to log.ts's info/warn/etc
// (which go through periapsis:component/log -> the host -> journald/kubectl
// logs, not stdout/stderr directly) - reach for console during local/
// interactive debugging (e.g. against a real terminal via `trail
// --component`, no host log plumbing needed), and log.ts for anything meant
// to actually reach `kubectl logs` in a deployed pod.
interface Console {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** No trailing newline, stdout. Async-export only - see the safety constraint above. */
  print(...args: unknown[]): Promise<void>;
  /** Trailing newline, stdout. Async-export only - see the safety constraint above. */
  println(...args: unknown[]): Promise<void>;
  /** No trailing newline, stderr. Async-export only - see the safety constraint above. */
  eprint(...args: unknown[]): Promise<void>;
  /** Trailing newline, stderr. Async-export only - see the safety constraint above. */
  eprintln(...args: unknown[]): Promise<void>;
}
declare const console: Console;
