// Splits the single `console` global (types/dwarf.d.ts) into two narrower,
// world-shape-specific views - consoleP2 (log/info/debug/warn/error,
// guaranteed synchronous) and consoleP3 (all nine methods, all
// Promise-returning) - reflecting a real, empirically-confirmed pair of
// constraints, not just organization:
//
// 1. MIXING: a world can't vendor/resolve BOTH wasi:cli@0.2.x AND
//    wasi:cli@0.3.0 at once - `include wasi:cli/command@0.3.0;` plus
//    `import wasi:cli/stdout@0.2.12;` in the same world fails auto-vendoring
//    ("package 'wasi:cli@0.2.12' not found") even via a clean full
//    auto-vendor, not just careless manual vendoring. So a p3 world (`include
//    wasi:cli/command@0.3.0`) can NEVER get the SYNC (guaranteed-void)
//    backing for log/info/debug/warn/error - only the async 0.3 fallback.
// 2. Because of (1), dwarf itself now makes log/info/debug/warn/error fall
//    back to WASI 0.3's async write-via-stream when only that's imported
//    (matching print/println's existing fallback) - unblocking a p3-only
//    world instead of throwing, but with a real await requirement: confirmed
//    empirically that an UNAWAITED call made as the last statement before an
//    async export returns produces NO output at all, silently (two
//    unawaited calls followed by an awaited third one DO all flush
//    correctly - it's specifically about nothing subsequent forcing the
//    write through, not "unawaited is always lost").
//
// Both exports are views onto the SAME runtime `console` global (zero-cost
// type narrowing, not a separate object per world type) - import only the
// one matching your world's shape, so an accidental fire-and-forget call in
// a p3-only world (safe under consoleP2, NOT safe under consoleP3) is a type
// error at author time instead of silently-missing output at runtime.
// `Console` (the type) is declared ambiently in types/dwarf.d.ts - no import
// needed, same as every other ambient global in this package.

/**
 * For a p2 world (imports wasi:cli/stdout@0.2.x, warn/error need stderr@0.2.x
 * too - no wasi:cli/command@0.3.0). Guaranteed synchronous (returns void,
 * not a Promise) - safe to call fire-and-forget, including from a plain
 * sync export.
 */
export const consoleP2: Pick<Console, "log" | "info" | "debug" | "warn" | "error"> = console;

/**
 * For a p3 world (includes wasi:cli/command@0.3.0). Do NOT ALSO import
 * wasi:cli/stdout@0.2.x to force the sync path - that combination fails at
 * WIT-resolution time (see this file's header comment). ALL nine methods
 * are async here (typed Promise<void>, not the void|Promise<void> union
 * `console` itself has, since a p3-only world always goes through the async
 * backing) - `await` every call. An unawaited call is fine ONLY if
 * something else in the same async export subsequently awaits/yields
 * afterward; as the last statement before the export returns, it silently
 * produces no output at all (confirmed empirically - see the header
 * comment). Only callable from an async export in the first place (e.g.
 * wasi:cli/run@0.3.0) - calling from a plain sync export crashes outright
 * ("no active task state" panic, not a graceful error).
 */
export const consoleP3 = console as unknown as {
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
};
