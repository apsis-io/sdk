// Lets a genuinely non-WASM TypeScript program (plain Node.js or Bun, no
// dwarf/trail/WASM at all) expose the magic seam (periapsis:magic/handler,
// ADR-0028) as a remote provider.
//
// It said "a trail-run WASM consumer can bind to via --plug-remote-simple
// <addr>[#tier]" here until 2026-08-27. *** NO TRAIL CONSUMER CAN BIND TO
// THIS. *** See the MSK1 note below.
//
// NOT the same thing as ../periapsis/magic.ts (definePlugProvider/callSeam),
// which wraps the WIT-level periapsis:magic/handler import/export for a
// component running INSIDE dwarf/trail. This package is the OTHER side of
// ADR-0028's non-WASM-provider gap: for a program that is not a WASM
// component at all, running the provider (server) side of the magic sock's
// revived MSK1 protocol directly over a real socket.
//
// *** TRAIL NO LONGER SPEAKS THIS PROTOCOL. *** This cited
// trail's MSK1 transport until 2026-08-27; ADR-0044 (commit 5fe956bf1)
// removed MSK1 and its --plug-remote-simple consumer flag from trail, so that
// file has not existed for some time. For a provider a trail consumer can bind
// to today use quic.ts. Trail's unix-socket rung (--ipc) exists again but
// speaks a DIFFERENT wire - see docs/ipc-wire.md, which leads with that
// warning.
//
// Same protocol, same wire bytes, as go/magicseam - see
// that package's doc comment for the fuller rationale (why MSK1 instead of
// the wRPC-based --plug-remote: wRPC's generality buys nothing for this
// seam's actual interface, a single list<u8> -> result<list<u8>, error>
// function, and there is no mature non-Rust wRPC implementation to adopt
// instead).
//
// *** VERSION GATING IS ENFORCED HERE, AS OF 2026-08-27. *** serve() compares
// the consumer's required version against the one it serves and refuses an
// incompatible handshake with accept = 0. `versionCompatible` mirrors
// trail's plug negotiation's version_compatible and go/magicseam's copy
// exactly, 0.x rules included.
//
// It previously always accepted, which was CORRECT while trail's
// --plug-remote-simple gate sat on the other end - ADR-0044 deleted that gate
// with the transport, and the comment went on delegating to a counterparty that
// no longer existed. The delegation rotted, not the code. Same note, same
// reason, in go/magicseam.

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

/** Tab-separated, matching trail's QUIC transport's encode_caller. */
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
 * maps to. Mirrors go/magicseam's ErrRejected.
 */
export class SeamRejectedError extends Error {}
/** Thrown by a Handler to signal the seam's `too-large` error variant. */
export class SeamTooLargeError extends Error {}

// Wire constants. These are AUTHORITATIVE now, not a mirror: this pointed at
// trail's MSK1 transport's module doc comment "for the authoritative
// protocol description this mirrors exactly" until 2026-08-27, and ADR-0044
// removed that file. go/magicseam carries the same values and the same
// note.
const PREAMBLE = "MSK1";
// Matches trail's QUIC transport's own MAX_FRAME (64 MiB, the seam's own
// too-large rejection ballpark) - bounds a single frame so a hostile/
// garbled peer can't make this process allocate unbounded. That equality is
// ENFORCED across all five speakers by
// TestEverySeamSpeakerSharesOneFrameBound in
// periapsis's cross-language seam tests, seamframebound_test.go, which is why this one citation
// could be repointed at a live file when parseAddr's below could not.
export const MAX_FRAME = 64 << 20;

export const TAG_OK = 0;
export const TAG_UNAVAILABLE = 1;
export const TAG_REJECTED = 2;
export const TAG_TOO_LARGE = 3;

/** Major/minor/patch, or null if this is not an "X.Y.Z". */
function parseVersion(v: string): [number, number, number] | null {
  const cut = v.search(/[-+]/)
  const core = cut >= 0 ? v.slice(0, cut) : v
  const parts = core.split(".")
  if (parts.length !== 3) return null
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN))
  if (nums.some(Number.isNaN)) return null
  return [nums[0], nums[1], nums[2]]
}

/**
 * Whether a provider serving `served` satisfies a consumer requiring
 * `required`.
 *
 * *** MIRRORS trail's plug negotiation's version_compatible EXACTLY, and
 * go/magicseam's versionCompatible line for line. *** The 0.x rules are not
 * plain semver and are where three implementations would silently diverge:
 *
 *   major differs   never compatible
 *   0.y.z           minor must be EQUAL - 0.x minors are breaking
 *   0.0.z           patch must be EQUAL - every 0.0.z is its own API
 *   otherwise       (minor, patch) >= required
 *
 * An unparseable version on either side is ACCEPTED, matching trail's "serving
 * unversioned": a provider declaring no version cannot gate, and failing closed
 * would refuse every consumer of an unversioned provider rather than the
 * incompatible ones.
 */
export function versionCompatible(required: string, served: string): boolean {
  const rq = parseVersion(required)
  const sv = parseVersion(served)
  if (!rq || !sv) return true
  if (rq[0] !== sv[0]) return false
  if (rq[0] === 0) {
    if (rq[1] !== sv[1]) return false
    if (rq[1] === 0) return sv[2] === rq[2]
    return sv[2] >= rq[2]
  }
  return sv[1] > rq[1] || (sv[1] === rq[1] && sv[2] >= rq[2])
}

type ParsedAddr = { path: string } | { host: string; port: number };

// Accepts "unix:<path>" or "tcp:<host:port>", nothing else.
//
// *** DO NOT REPOINT THIS AT A FILE THAT EXISTS. *** It read "mirrors
// trail's MSK1 transport's parse_addr exactly" until 2026-08-27.
// `fn parse_addr` is now in no trail source file at all. Trail SPLIT that
// grammar rather than moving it - `--ipc unix:<path>[#tier]` takes unix only,
// `--remote tcp:<host:port>[#tier]` takes tcp only and refuses unix outright -
// and both carry a #tier suffix this function does not know. Pointing at
// either would be a wrong citation that RESOLVES, which stops the next reader
// checking. See go/magicseam's parseAddr for the same note.
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
// matters: the original Rust implementation (remote_simple.rs, removed by
// ADR-0044) wrote the length
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

    // The client's REQUIRED version, and this package now enforces it.
    //
    // *** IT USED TO BE "read and discarded; this package always accepts". ***
    // That was safe while trail's --plug-remote-simple gate sat on the other
    // end; ADR-0044 deleted the gate with the transport, and the comment went on
    // delegating to a counterparty that no longer existed.
    const required = await readFrameFromSocketReader(reader)
    if (!versionCompatible(required.toString("utf8"), version)) {
      // accept = 0, then the served version anyway - so the consumer's error can
      // name what it asked for AND what was on offer.
      socket.write(Buffer.from([0]))
      socket.write(encodeFrame(Buffer.from(version, "utf8")))
      socket.end()
      return
    }
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
 * Listens on addr ("unix:<path>" or "tcp:<host:port>"). This said "the exact
 * same syntax trail's own --plug-remote/--plug-remote-simple already use"
 * until 2026-08-27; ADR-0079 renamed the tiers and BOTH those names are dead.
 * Trail's live spellings are --remote (tcp only) and --ipc (unix only), so the
 * syntax is not "the same" either - see parseAddr's note. It
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
    // A stale socket file from a prior run would make bind() fail; clear it.
    // Ported from the pre-wRPC Rust serve_provider, which ADR-0044 removed;
    // go/magicseam's Serve is now the only other implementation.
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
