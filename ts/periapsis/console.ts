// Splits the single `console` global (types/dwarf.d.ts) into two narrower,
// world-shape-specific views - consoleP2 (log/info/debug/warn/error) and
// consoleP3 (print/println/eprint/eprintln) - because MIXING
// wasi:cli/stdout@0.2.x (which log/info/debug need; warn/error need
// wasi:cli/stderr@0.2.x) with wasi:cli/command@0.3.0 (any p3 world) in the
// SAME world FAILS at WIT-resolution time. Confirmed empirically, not just
// inferred: `dwarf --wit` on a world with BOTH `include wasi:cli/command@
// 0.3.0;` and `import wasi:cli/stdout@0.2.12;` errors "package 'wasi:cli@
// 0.2.12' not found" during auto-vendoring - dwarf's WIT tooling can't
// resolve two different versions of the same package name in one world,
// even via a clean full auto-vendor (not just careless manual vendoring).
//
// A p3 component (wasi:cli/command@0.3.0) can safely use ONLY
// print/println/eprint/eprintln, which work against the 0.3.x stdout/stderr
// it already has as part of that include - reaching for
// log/info/debug/warn/error too would need ALSO importing
// wasi:cli/stdout@0.2.x, which won't build alongside a p3 world's own
// wasi:cli@0.3.0.
//
// Both exports are views onto the SAME runtime `console` global (zero-cost
// type narrowing, not a separate object per world type) - import only the
// one matching your world's shape, so an accidental call to the wrong
// family is a type error at author time, not a runtime surprise. `Console`
// (the type) is declared ambiently in types/dwarf.d.ts - no import needed,
// same as every other ambient global in this package.

/** For a p2 world (imports wasi:cli/stdout@0.2.x, warn/error need stderr@0.2.x too - no wasi:cli/command@0.3.0). */
export const consoleP2: Pick<Console, "log" | "info" | "debug" | "warn" | "error"> = console;

/**
 * For a p3 world (includes wasi:cli/command@0.3.0). Do NOT ALSO import
 * wasi:cli/stdout@0.2.x to get consoleP2 too - that combination fails at
 * WIT-resolution time, confirmed empirically (see this file's header
 * comment). print/println/eprint/eprintln are async-export-only - see
 * types/dwarf.d.ts's Console doc comment for the safety constraint.
 */
export const consoleP3: Pick<Console, "print" | "println" | "eprint" | "eprintln"> = console;
