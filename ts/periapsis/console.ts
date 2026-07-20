// A typed, documented re-export of dwarf's built-in `consoleP3` global -
// reflects a real, empirically-confirmed constraint, not just organization:
//
// A world can't mix wasi:cli@0.2.x AND wasi:cli@0.3.0 at once - `include
// wasi:cli/command@0.3.0;` plus `import wasi:cli/stdout@0.2.12;` in the same
// world fails auto-vendoring ("package 'wasi:cli@0.2.12' not found") even via
// a clean full auto-vendor. So a p3 world (`include wasi:cli/command@0.3.0`)
// can NEVER get a synchronous (guaranteed-void) console backing - only
// WASI 0.3's async write-via-stream. Since trail dropped WASI P2 support
// entirely (ADR-0045), every world in this repo is p3-only now, so that's
// the only shape that still matters here.
//
// Binds to dwarf's own `consoleP3` ambient global (types/dwarf.d.ts) via
// `globalThis` (not a bare identifier reference - this module's own export
// is named identically, which would otherwise self-shadow and throw
// "Cannot access 'consoleP3' before initialization"). dwarf builds
// `consoleP3` FIRST and aliases the plain `console` FROM it, so this is a
// real pinned runtime binding - the exact same object every time, unaffected
// if `console` itself is ever repointed at a future WASI version.

interface ConsoleP3 {
  log(...args: unknown[]): Promise<void>;
  info(...args: unknown[]): Promise<void>;
  debug(...args: unknown[]): Promise<void>;
  warn(...args: unknown[]): Promise<void>;
  error(...args: unknown[]): Promise<void>;
  /** No trailing newline, stdout. */
  print(...args: unknown[]): Promise<void>;
  /** Trailing newline, stdout. */
  println(...args: unknown[]): Promise<void>;
  /** No trailing newline, stderr. */
  eprint(...args: unknown[]): Promise<void>;
  /** Trailing newline, stderr. */
  eprintln(...args: unknown[]): Promise<void>;
}

/**
 * ALL nine methods are async - `await` every call. An unawaited call is
 * fine ONLY if something else in the same async export subsequently
 * awaits/yields afterward; as the last statement before the export
 * returns, it silently produces no output at all (confirmed empirically).
 * Only callable from an async export (e.g. `wasi:cli/run@0.3.0`) - calling
 * from a plain sync export crashes outright ("no active task state" panic,
 * not a graceful error).
 */
export const consoleP3: ConsoleP3 = (globalThis as unknown as { consoleP3: ConsoleP3 }).consoleP3;
