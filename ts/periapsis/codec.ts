// Real UTF-8 via dwarf's built-in TextEncoder/TextDecoder (always on, no
// --polyfill, zero extra cost - confirmed with dwarf-main: hand-written by
// dwarf itself and verified byte-for-byte against real TextEncoder/
// TextDecoder, including WHATWG-spec lone-surrogate replacement). This
// replaced an earlier hand-rolled charCodeAt/fromCharCode codec from when
// dwarf had no TextEncoder/TextDecoder at all - that version was ASCII-only
// (silently mangled any genuine non-ASCII text, e.g. multi-byte UTF-8), so
// this is a correctness fix as well as a simplification, not just a style
// change. See types/dwarf.d.ts for the ambient TextEncoder/TextDecoder
// declarations (dwarf's own runtime globals, not derived from any WIT
// interface, hence not in types/periapsis.d.ts or types/wit.d.ts).
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function stringToBytes(s: string): Uint8Array {
  return encoder.encode(s);
}

export function bytesToString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
