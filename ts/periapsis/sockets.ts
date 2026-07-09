// Ergonomic wrapper around wasi:sockets@0.3's server-side (accepted)
// tcp-socket - NOT periapsis-specific (this is plain WASI, not
// periapsis:component/*), but lives here because getting it wrong is a real
// footgun worth fixing centrally: see TcpSender below. Client-side connect()
// usage (examples/wasm/js-dwarf-socket) doesn't need this - only a socket
// you intend to send MULTIPLE messages on does.
//
// p3-only: wasi:sockets@0.3's bind/listen/accept has no p2 equivalent in
// this codebase, and a real TCP server needs a command-style component
// (wasi:cli/command, not wasi:http/service) - see
// examples/wasm/js-dwarf-websocket's README for why trail --serve/--persistent
// can't host a raw socket server at all (wasi:http has no socket-hijack/
// upgrade primitive).

import type { TcpSocket } from "wasi:sockets/types@0.3.0";

/**
 * Owns the ONE send() stream for a connection's whole lifetime.
 *
 * tcp-socket.send() takes a `stream<u8>` per call - the natural-looking
 * "one stream per message, dropped after each write" is a real footgun,
 * confirmed live (examples/wasm/js-dwarf-websocket): dropping the writable
 * after every individual message correctly end-of-streams that send() call,
 * which correctly triggers a genuine TCP half-close of this side's WRITE
 * direction. A well-behaved peer reacts to that FIN by closing its own
 * write side too - so the NEXT receive()-side read then legitimately (not
 * buggily) sees EOF, even though you meant to send more. This looked
 * exactly like a platform bug in wasi:sockets/wasmtime-wasi/dwarf (two
 * independent investigation passes were spent on it) before the actual
 * mechanism was found - it was a usage-pattern bug in application code.
 *
 * The correct pattern - what this class does - is symmetric with how
 * receive() is already always used (called ONCE per connection, its
 * readable stream reused for every subsequent read): open exactly one
 * send() stream at accept time, write every message to that SAME writable,
 * and only drop() it when the connection is genuinely done.
 *
 * Usage:
 *   const sender = new TcpSender(conn);
 *   try {
 *     await sender.send(responseBytes);
 *     await sender.send(moreBytes);
 *   } finally {
 *     await sender.close();
 *   }
 */
export class TcpSender {
  private readonly writable: { writeAll(bytes: Uint8Array): Promise<number>; drop(): void };
  private readonly sendFuture: { read(): Promise<unknown> };

  constructor(sock: TcpSocket) {
    const { readable, writable } = wit.Stream(wit.Stream.U8);
    this.writable = writable;
    // send's WIT signature is `send: func(...) -> future<result<_, error-code>>`
    // - a NON-async func returning a future value. dwarf's .d.ts generator
    // can't textually tell that apart from a genuinely async func at a
    // function's own top-level return position (both show as Promise<T> in
    // generated types - see dwarf's types.rs doc comment on
    // patch_future_positions), so this is NOT a real Promise - it's a
    // FutureReadable wrapper needing an explicit .read() (see close()
    // below). A bare `await sock.send(readable)` (or handing it straight to
    // Promise.all) silently never waits on the send at all - a real,
    // independently-confirmed bug, found while chasing the one above.
    this.sendFuture = sock.send(readable);
  }

  /** Write one message to this connection's shared send stream. */
  async send(bytes: Uint8Array): Promise<void> {
    await this.writable.writeAll(bytes);
  }

  /**
   * Call ONCE, when the connection is genuinely done. Drops the writable
   * (the correct point for send()'s stream to end, and so for a real
   * write-side TCP half-close to happen) and consumes the send future to
   * surface any error.
   */
  async close(): Promise<void> {
    this.writable.drop();
    const result = await this.sendFuture.read();
    if (result && typeof result === "object" && "tag" in result && (result as { tag: string }).tag === "err") {
      throw new Error(`send stream ended with error: ${JSON.stringify((result as { tag: string; val: unknown }).val)}`);
    }
  }
}

/** Reads exactly `n` bytes from a stream<u8> readable, or throws on EOF before that. */
export async function readExact(readable: { read(n: number): Promise<Uint8Array> }, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  let filled = 0;
  while (filled < n) {
    const chunk = await readable.read(n - filled);
    if (chunk.length === 0) throw new Error("connection closed mid-read");
    out.set(chunk, filled);
    filled += chunk.length;
  }
  return out;
}
