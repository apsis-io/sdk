// Generic component-model-async stream plumbing - NOT periapsis-specific
// (periapsis.d.ts) and NOT a dwarf-only runtime feature (dwarf.d.ts): the
// `wit` global and the `stream<u8>` structural shapes it produces are part of
// dwarf's WIT<->JS mapping for ANY WASI 0.3/p3 world that uses component-
// model-async streams, periapsis-derived or not.

// Minimal structural type for the `stream<u8>` readable/writable halves -
// matches the shape dwarf's own generated bindings produce (see e.g.
// examples/wasm/js-dwarf-server-p3/src/wit.d.ts's StreamReadableU8).
interface StreamReadableU8 {
  read(count?: number): Promise<Uint8Array>;
  drop(): void;
}
interface StreamWritableU8 {
  writeAll(data: Uint8Array): Promise<number>;
  drop(): void;
}

// The `wit` runtime global dwarf provides whenever a world uses component-
// model-async streams (exec.ts's spawn() needs it to create the stdin pair it
// hands to ChildProcess.spawn). Declared here too, same as every p3 example's
// own wit.d.ts - harmless duplication across ambient .d.ts files, and this
// package has no build/typecheck step of its own to conflict over (dwarf
// consumes plain post-Vite JS, never these types).
declare const wit: {
  Stream: {
    (type?: number): { readable: StreamReadableU8; writable: StreamWritableU8 };
    U8: number;
  };
};
