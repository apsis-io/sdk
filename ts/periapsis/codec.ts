// dwarf's QuickJS runtime has no TextEncoder/TextDecoder - a plain byte<->char
// codec is enough for the ASCII/UTF-8-passthrough payloads (JSON checkpoint
// state, exec() stdio, magic-seam request/response bytes) every helper here
// deals with. Shared so every module in this package (and every consumer) uses
// exactly one implementation instead of the ad-hoc per-example copies this
// package replaces.

export function stringToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export function bytesToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
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
