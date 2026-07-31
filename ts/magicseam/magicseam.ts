// Lets a genuinely non-WASM TypeScript program (plain Node.js or Bun, no
// dwarf/trail/WASM at all) expose the magic seam (periapsis:magic/handler,
// ADR-0028) as a remote provider a trail-run WASM consumer can bind to via
// --plug-remote-simple <addr>[#tier].
//
// NOT the same thing as ../periapsis/magic.ts (definePlugProvider/callSeam),
// which wraps the WIT-level periapsis:magic/handler import/export for a
// component running INSIDE dwarf/trail. This package is the OTHER side of
// ADR-0028's non-WASM-provider gap: for a program that is not a WASM
// component at all, running the provider (server) side of the magic sock's
// revived MSK1 protocol (tools/trail/src/remote_simple.rs) directly over a
// real socket. Same protocol, same wire bytes, as sdk/go/magicseam - see
// that package's doc comment for the fuller rationale (why MSK1 instead of
// the wRPC-based --plug-remote: wRPC's generality buys nothing for this
// seam's actual interface, a single list<u8> -> result<list<u8>, error>
// function, and there is no mature non-Rust wRPC implementation to adopt
// instead).
//
// Version gating happens on the CONSUMER (trail) side, not here: serve()
// always accepts a connecting consumer's handshake regardless of the
// version it requires - trail's own --plug-remote-simple gate is the
// enforcement point, same as sdk/go/magicseam.

import net from "node:net";
import fs from "node:fs";

/** A seam call handler: request in, response out (sync or async). */
export type Handler = (caller: Caller, request: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/**
 * WHO is calling, as established by the calling trail rather than claimed by
 * the guest: a consumer's imported handle() has no caller parameter, so a
 * component cannot name itself. mTLS establishes that the peer asserting it is
 * a trail at all.
 *
 * All fields empty means UNATTRIBUTED - the MSK1 path has no caller frame, and
 * a plain consumer may not be a trail-managed pod. Treat that as a provider
 * decision to refuse; the transport delivers it rather than dropping the call.
 */
export interface Caller {
  namespace: string;
  podName: string;
  podUid: string;
  component: string;
}

/** Tab-separated, matching tools/trail/src/remote_quic.rs's encode_caller. */
export function encodeCaller(c: Caller): Uint8Array {
  return Buffer.from([c.namespace, c.podName, c.podUid, c.component].join("\t"), "utf8");
}

/** A short or garbled frame yields empty fields rather than throwing. */
export function decodeCaller(b: Uint8Array): Caller {
  const f = Buffer.from(b).toString("utf8").split("\t");
  return {
    namespace: f[0] ?? "",
    podName: f[1] ?? "",
    podUid: f[2] ?? "",
    component: f[3] ?? "",
  };
}

/**
 * Thrown by a Handler to signal the seam's `rejected` error variant, instead
 * of the transport-neutral `unavailable` default every other thrown error
 * maps to. Mirrors sdk/go/magicseam's ErrRejected.
 */
export class SeamRejectedError extends Error {}
/** Thrown by a Handler to signal the seam's `too-large` error variant. */
export class SeamTooLargeError extends Error {}

// Wire constants - see tools/trail/src/remote_simple.rs's module doc comment
// for the authoritative protocol description this mirrors exactly (also
// mirrored in sdk/go/magicseam).
const PREAMBLE = "MSK1";
// Matches remote_simple.rs's own MAX_FRAME (64 MiB, the seam's own
// too-large rejection ballpark) - bounds a single frame so a hostile/
// garbled peer can't make this process allocate unbounded.
export const MAX_FRAME = 64 << 20;

export const TAG_OK = 0;
export const TAG_UNAVAILABLE = 1;
export const TAG_REJECTED = 2;
export const TAG_TOO_LARGE = 3;

type ParsedAddr = { path: string } | { host: string; port: number };

// Mirrors tools/trail/src/remote_simple.rs's parse_addr exactly: "unix:<path>"
// or "tcp:<host:port>", nothing else accepted.
function parseAddr(addr: string): ParsedAddr {
  if (addr.startsWith("unix:")) {
    const path = addr.slice("unix:".length);
    if (!path) throw new Error(`magicseam: unix address needs a path: ${JSON.stringify(addr)}`);
    return { path };
  }
  if (addr.startsWith("tcp:")) {
    const hostPort = addr.slice("tcp:".length);
    if (!hostPort) throw new Error(`magicseam: tcp address needs host:port: ${JSON.stringify(addr)}`);
    const i = hostPort.lastIndexOf(":");
    if (i < 0) throw new Error(`magicseam: invalid tcp address ${JSON.stringify(addr)}`);
    const host = hostPort.slice(0, i);
    const port = Number(hostPort.slice(i + 1));
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`magicseam: invalid port in ${JSON.stringify(addr)}`);
    }
    return { host, port };
  }
  throw new Error(`magicseam: address must be unix:<path> or tcp:<host:port>, got ${JSON.stringify(addr)}`);
}

// One length-prefixed frame as a SINGLE buffer (length + payload together),
// written with one socket.write() call - not two separate writes. This
// matters: tools/trail/src/remote_simple.rs originally wrote the length
// prefix and payload as two separate write_all calls, which combined with
// Nagle's algorithm + delayed ACKs to add real per-call latency over a
// genuine network (confirmed live building examples/go/magic-echo-go -
// see that example's README). Encoding as one buffer here avoids the
// two-small-writes shape entirely, on top of the explicit setNoDelay below
// - belt and suspenders, not relying on just one fix.
export function encodeFrame(bytes: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(4 + bytes.length);
  out.writeUInt32LE(bytes.length, 0);
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(out, 4);
  return out;
}

// Buffers a socket's incoming chunks so callers can read an exact byte count
// at a time, regardless of how the underlying TCP/unix stream happened to
// chunk them. Node/Bun sockets are async-iterable over their raw data
// chunks, which is all this needs.
class SocketReader {
  private buf = Buffer.alloc(0);
  private readonly iter: AsyncIterator<Buffer>;
  constructor(socket: net.Socket) {
    this.iter = socket[Symbol.asyncIterator]();
  }
  async readExact(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      const { value, done } = await this.iter.next();
      if (done) throw new Error("magicseam: connection closed");
      this.buf = Buffer.concat([this.buf, value]);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

export async function readFrameFromSocketReader(reader: SocketReader): Promise<Buffer> {
  const lenBuf = await reader.readExact(4);
  const len = lenBuf.readUInt32LE(0);
  if (len > MAX_FRAME) {
    throw new Error(`magicseam: frame length ${len} exceeds max ${MAX_FRAME}`);
  }
  return reader.readExact(len);
}

export function tagFor(e: unknown): number {
  if (e instanceof SeamRejectedError) return TAG_REJECTED;
  if (e instanceof SeamTooLargeError) return TAG_TOO_LARGE;
  return TAG_UNAVAILABLE;
}

// Per-connection loop: validate the preamble, handshake (always accepting -
// see the module doc comment on why version gating is the consumer's job,
// not this package's), then loop request/response frames until the peer
// disconnects. Errors here just end this one connection - never fatal to
// serve()'s own accept loop.
async function handleConnection(socket: net.Socket, version: string, handler: Handler): Promise<void> {
  // Explicit, not relying on either runtime's own TCP default (Node/Bun
  // sockets have Nagle's algorithm ENABLED by default, same as Rust's
  // std::net::TcpStream) - see encodeFrame's comment for why this matters.
  socket.setNoDelay(true);
  const reader = new SocketReader(socket);
  try {
    const pre = await reader.readExact(4);
    if (pre.toString("latin1") !== PREAMBLE) return; // not a magic-sock client - silently drop

    // The client's required version - read and discarded; this package
    // always accepts (see module doc comment).
    await readFrameFromSocketReader(reader);
    socket.write(Buffer.from([1])); // accept = 1
    socket.write(encodeFrame(Buffer.from(version, "utf8")));

    for (;;) {
      let request: Buffer;
      try {
        request = await readFrameFromSocketReader(reader);
      } catch {
        return; // clean EOF or any read error ends the connection
      }
      try {
        // MSK1 has no caller frame, so this path is always unattributed.
        const response = await handler(
          { namespace: "", podName: "", podUid: "", component: "" },
          request,
        );
        socket.write(Buffer.from([TAG_OK]));
        socket.write(encodeFrame(response));
      } catch (e) {
        socket.write(Buffer.from([tagFor(e)]));
      }
    }
  } catch {
    // A handshake-phase failure (bad preamble read, broken pipe, etc.) - end
    // this connection, never fatal to the accept loop.
  } finally {
    socket.destroy();
  }
}

/**
 * Listens on addr ("unix:<path>" or "tcp:<host:port>", the exact same
 * syntax trail's own --plug-remote/--plug-remote-simple already use) and
 * serves the magic seam via handler. version is this provider's own
 * self-declared seam version (e.g. "0.1.0", matching
 * periapsis:magic/handler@0.1.0) reported at every handshake - purely
 * informational from this package's own point of view; the connecting
 * trail consumer's gate is what actually enforces compatibility against it.
 *
 * Returns a Promise that resolves once listening has started successfully,
 * or rejects on a listener-level failure (bind error, or a later fatal
 * server error) - it does NOT resolve when the server later stops; a
 * long-running provider process should just let the active listener keep
 * the event loop alive (the normal Node/Bun idiom), not await this forever.
 */
export function serve(addr: string, version: string, handler: Handler): Promise<void> {
  const parsed = parseAddr(addr);
  if ("path" in parsed) {
    // A stale socket file from a prior run would make bind() fail; clear it
    // (mirrors the pre-wRPC Rust serve_provider this protocol was ported
    // from - tools/trail/src/remote_simple.rs's own module doc comment).
    fs.rmSync(parsed.path, { force: true });
  }

  const server = net.createServer((socket) => {
    handleConnection(socket, version, handler).catch(() => {});
  });

  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const onListening = () => {
      server.off("error", reject);
      console.error(`[magicseam] serving handler@${version} on ${addr}`);
      resolve();
    };
    if ("path" in parsed) {
      server.listen(parsed.path, onListening);
    } else {
      server.listen(parsed.port, parsed.host, onListening);
    }
  });
}
