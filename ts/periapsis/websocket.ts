// A real WebSocket SERVER, hand-rolled on top of wasi:sockets@0.3 (see
// sockets.ts) - extracted from examples/wasm/js-dwarf-websocket, the first
// (and only, as of writing) proof that this works at all on dwarf/trail.
//
// wasi:http/service has no socket-hijack/upgrade primitive (WASI's HTTP
// abstraction deliberately doesn't expose the raw underlying connection of
// an inbound request), so there is no way to "upgrade" a trail --serve
// connection to WebSocket. The only real path is a command-style component
// (wasi:cli/command, not wasi:http/service) whose own run() binds+listens
// on wasi:sockets@0.3 directly and speaks just enough raw HTTP (the upgrade
// handshake, parseUpgradeRequest/computeAcceptKey below) plus WebSocket
// framing (RFC 6455, readFrame/buildTextFrame/buildCloseFrame below) itself
// - see that example's README for the full story, including a real
// usage-pattern bug (not a platform bug) this surfaced in TcpSender's
// design (sockets.ts).

import { bytesToString, stringToBytes } from "./codec.js";
import { readExact } from "./sockets.js";
import { sha1 } from "./sha1.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC 6455 1.3, fixed magic value

/** RFC 6455 1.3: base64(SHA1(client's Sec-WebSocket-Key + fixed GUID)). */
export function computeAcceptKey(clientKey: string): string {
  const digest = sha1(stringToBytes(clientKey + WS_GUID));
  return Buffer.from(digest).toString("base64");
}

/**
 * Reads raw bytes from `readable` until the HTTP header terminator
 * (`\r\n\r\n`). Doesn't handle a pipelined first WS frame arriving in the
 * same read (a real WebSocket client always waits for the 101 response
 * first) - only ever a concern for a deliberately adversarial/broken
 * client, not a real one.
 */
export async function readHttpHeaders(readable: { read(n: number): Promise<Uint8Array> }): Promise<string> {
  let text = "";
  for (;;) {
    const chunk = await readable.read(1024);
    if (chunk.length === 0) throw new Error("connection closed during handshake");
    text += bytesToString(chunk);
    if (text.includes("\r\n\r\n")) return text;
  }
}

/** Extracts the client's Sec-WebSocket-Key from raw request header text, or `null` if this isn't a WS upgrade request. */
export function parseUpgradeRequest(headerText: string): { key: string } | null {
  const match = /Sec-WebSocket-Key:\s*(\S+)/i.exec(headerText);
  return match ? { key: match[1] } : null;
}

/** The full `101 Switching Protocols` response for a given client key - send this once, as the very first bytes on the connection. */
export function buildUpgradeResponse(clientKey: string): Uint8Array {
  const acceptKey = computeAcceptKey(clientKey);
  return stringToBytes(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
  );
}

export interface WebSocketFrame {
  opcode: number;
  payload: Uint8Array;
}

/** RFC 6455 5.2 frame parse. Client->server frames MUST be masked; unmask here so callers see plain payload bytes. Returns `null` on EOF. */
export async function readFrame(readable: { read(n: number): Promise<Uint8Array> }): Promise<WebSocketFrame | null> {
  let head: Uint8Array;
  try {
    head = await readExact(readable, 2);
  } catch {
    return null;
  }
  const opcode = head[0] & 0x0f;
  const masked = (head[1] & 0x80) !== 0;
  let len = head[1] & 0x7f;
  if (len === 126) {
    const ext = await readExact(readable, 2);
    len = (ext[0] << 8) | ext[1];
  } else if (len === 127) {
    const ext = await readExact(readable, 8);
    len = 0;
    for (let i = 0; i < 8; i++) len = len * 256 + ext[i];
  }
  const maskKey = masked ? await readExact(readable, 4) : null;
  const payload = await readExact(readable, len);
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }
  return { opcode, payload };
}

// Server->client frames MUST NOT be masked (RFC 6455 5.1).
function buildFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const header = len < 126 ? [0x80 | opcode, len] : [0x80 | opcode, 126, (len >> 8) & 0xff, len & 0xff];
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

export function buildTextFrame(text: string): Uint8Array {
  return buildFrame(0x1, stringToBytes(text));
}
export function buildBinaryFrame(bytes: Uint8Array): Uint8Array {
  return buildFrame(0x2, bytes);
}
export function buildCloseFrame(): Uint8Array {
  return new Uint8Array([0x88, 0x00]);
}

export const WS_OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;
