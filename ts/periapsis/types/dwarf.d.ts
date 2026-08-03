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
// structured per-pod config (peri.apsis/config.<key> annotations). Safe to
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
/**
 * The same object as `process` - a real, separately-nameable binding dwarf
 * builds FIRST (process is aliased FROM processP3, never the reverse), so
 * code depending on "the WASI 0.3 process implementation, specifically"
 * keeps working even if `process` is ever repointed at a future WASI
 * version. See `console`'s own `consoleP3` note just below for the same
 * pattern.
 */
declare const processP3: Process;

// dwarf's built-in `console` global (see dwarf's own README's "Console"
// section, and confirmed directly with dwarf-main throughout - the README
// was still catching up on print/println/eprint/eprintln, and then on
// log/info/debug/warn/error's p3 fallback, at various points this was
// written against). `console` always EXISTS regardless of what's imported;
// calling a method whose backing import is missing throws or rejects with a
// clear error naming what to add, rather than being silently absent.
//
// log/info/debug (need wasi:cli/stdout) and warn/error (need
// wasi:cli/stderr) now try WASI 0.2 first (get-stdout/get-stderr - SYNC,
// returns void) and fall back to WASI 0.3's write-via-stream (ASYNC, returns
// a Promise) when only that's imported - this directly unblocks a p3-only
// world, which per the mixing constraint below can never get the 0.2.x
// import: console.log/error etc. now just work there via the 0.3 fallback
// instead of throwing. Format non-string args via JSON.stringify (a compact
// single-line dump, NOT Node's multi-line util.inspect - plain objects/
// arrays print fine, but console.log(undefined) prints a BLANK line, not
// "undefined" - JSON.stringify(undefined) is the JS value undefined,
// coerced to '' by the internal join - and a circular-reference object
// THROWS SYNCHRONOUSLY at the call site, in EITHER backing).
//
//   SAFETY CONSTRAINT (0.3 fallback only - the 0.2 path is unaffected,
//   always synchronous/complete-on-return): the returned Promise MUST be
//   awaited. Confirmed empirically, not just documented: two UNAWAITED
//   log() calls followed by an AWAITED third one all flushed correctly (the
//   await forces the prior writes through) - but an unawaited call made as
//   the LAST statement before an async export returns produced NO output at
//   all, silently. `await console.log(...)` is the safe pattern in a
//   p3-only world; fire-and-forget (fine under the 0.2 sync path) is not.
//
// print/println/eprint/eprintln are ALWAYS async (return a Promise, reject
// on failure, never throw synchronously) and write raw args with no
// JSON.stringify formatting - println/eprintln add a trailing newline,
// print/eprint don't; the e-prefixed pair go to stderr instead of stdout.
// Same backing priority as log/info/debug/warn/error: wasi:cli/stdout@0.3.x/
// stderr@0.3.x if imported (genuinely async, real stream<u8> writes) else
// wasi:cli/stdout@0.2.x/stderr@0.2.x (a sync write wrapped in an async fn,
// still Promise-returning for API uniformity) else the promise rejects
// naming both import options.
//
//   SAFETY CONSTRAINT: the 0.3-backed path uses component-model-async stream/
//   future machinery that has NO task state outside an active async export
//   call - calling print/println/eprint/eprintln (even indirectly) from a
//   PLAIN SYNC export crashes outright ("no active task state" panic, not a
//   graceful error/rejection). Only call these four (or log/info/debug/warn/
//   error, when only a 0.3 backing is available) from within an async
//   export (e.g. wasi:cli/run@0.3.0, or periapsis:magic/handler's handle -
//   the magic seam's own handle IS async func, see magic.ts).
//
// MIXING CONSTRAINT (confirmed empirically, a wkg/wit-parser dependency-
// resolution limit, not a dwarf bug dwarf can paper over): a world can't
// vendor/resolve BOTH wasi:cli@0.2.x AND wasi:cli@0.3.0 at once - `include
// wasi:cli/command@0.3.0;` plus `import wasi:cli/stdout@0.2.12;` in the same
// world fails auto-vendoring ("package 'wasi:cli@0.2.12' not found") even via
// a clean full auto-vendor. So a p3 world (anything with `include
// wasi:cli/command@0.3.0`) can NEVER get the SYNC (guaranteed-void,
// fire-and-forget-safe) behavior for log/info/debug/warn/error - only the
// async 0.3 fallback, with the must-await constraint above. See
// console.ts's consoleP3 export for a typed view reflecting this.
//
// This whole family is a lower-level alternative to log.ts's info/warn/etc
// (which go through periapsis:component/log -> the host -> journald/kubectl
// logs, not stdout/stderr directly) - reach for console during local/
// interactive debugging (e.g. against a real terminal via `trail
// --component`, no host log plumbing needed), and log.ts for anything meant
// to actually reach `kubectl logs` in a deployed pod.
interface Console {
  /** void when backed by WASI 0.2 (sync, fire-and-forget safe); Promise<void> (must be awaited) when only WASI 0.3 is available - see the safety constraint above. */
  log(...args: unknown[]): void | Promise<void>;
  info(...args: unknown[]): void | Promise<void>;
  debug(...args: unknown[]): void | Promise<void>;
  warn(...args: unknown[]): void | Promise<void>;
  error(...args: unknown[]): void | Promise<void>;
  /** No trailing newline, stdout. Always async - see the safety constraints above. */
  print(...args: unknown[]): Promise<void>;
  /** Trailing newline, stdout. Always async - see the safety constraints above. */
  println(...args: unknown[]): Promise<void>;
  /** No trailing newline, stderr. Always async - see the safety constraints above. */
  eprint(...args: unknown[]): Promise<void>;
  /** Trailing newline, stderr. Always async - see the safety constraints above. */
  eprintln(...args: unknown[]): Promise<void>;
}
declare const console: Console;
/**
 * The same object as `console` - a real, separately-nameable binding dwarf
 * builds FIRST (console is aliased FROM consoleP3, never the reverse), for
 * code that wants "the WASI 0.3 implementation, specifically" and doesn't
 * want to be affected if `console` is ever repointed at a future WASI
 * version. This is what `console.ts`'s own `consoleP3` export now binds to
 * directly, instead of casting the (possibly-sync) plain `console`.
 */
declare const consoleP3: Console;
