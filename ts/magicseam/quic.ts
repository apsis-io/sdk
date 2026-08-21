// QUIC transport (ADR-0043) for a genuinely non-WASM TS/Bun magic-seam
// provider/consumer - mirrors cmd/trail/src/remote_quic.rs's wire
// protocol EXACTLY (see that file's own module doc comment, the
// authoritative spec this was ported from, also mirrored in
// sdk/go/magicseam/quic.go): mutual TLS against the cluster's self-managed
// trail CA, one persistent connection, a version handshake on the first
// bidirectional stream, then every subsequent call opens its OWN stream (so
// unrelated calls never queue behind each other - unlike serve()/MSK1's
// single-connection serialization in magicseam.ts).
//
// Built on @matrixai/quic (js-quic, a napi-rs binding over Cloudflare's
// quiche) - Bun's own experimental node:quic module (docs describe it, but
// it is not present in the currently-installed Bun release) was not
// available to build against.
//
// TLS material: peri.apsis/tls-quic (internal/podlaunch/builder.go)
// bind-mounts a fresh cert/key/CA-bundle triple, signed by the trail CA,
// into the pod - callers running as a pod should point dialQUIC/serveQUIC
// at those three files directly.

import fs from "node:fs";
import nodeCrypto from "node:crypto";
import type { ReadableStream, ReadableStreamDefaultReader } from "node:stream/web";
import {
  CONV_ASK, CONV_DONE,
  OP_CALL, OP_CONVERSE, OP_MARKER, OP_MARKER_ACK, OP_RESUME, OP_STREAM,
  capsOffered, opcodeOnWire, parseCaps, streamsAgreed,
} from "./stream";
import { Barrier, DEFAULT_DRAIN_TIMEOUT_MS } from "./barrier";
import { QUICClient, QUICServer, QUICConnection, QUICStream as QUICStreamT, events as quicEvents } from "@matrixai/quic";
import {
  decodeCaller,
  encodeCaller,
  type Caller,
  type Handler,
  SeamRejectedError,
  SeamTooLargeError,
  MAX_FRAME,
  TAG_OK,
  TAG_UNAVAILABLE,
  TAG_REJECTED,
  TAG_TOO_LARGE,
  encodeFrame,
  tagFor,
} from "./magicseam.js";

/**
 * The fixed CommonName/DNS-SAN every trail-CA-signed QUIC leaf carries -
 * must match internal/podlaunch/trailtls.go's TrailQuicSNI and
 * cmd/trail/src/remote_quic.rs's SERVER_NAME exactly.
 */
export const TRAIL_QUIC_SNI = "trail-quic-peer";

// ALPN placeholder: quiche (unlike rustls/quinn's config in remote_quic.rs,
// which sets none) REQUIRES a non-empty applicationProtos list or every
// handshake fails NO_APPLICATION_PROTOCOL. remote_quic.rs's rustls side
// leaves ALPN unconfigured entirely, which tolerates a peer that DOES offer
// one (no protocol is selected, and rustls/quinn here do not require one to
// have been) - confirmed by live testing, not just read from docs.
const ALPN = ["trail-quic"];

function parseQUICAddr(addr: string): { host: string; port: number } {
  if (!addr.startsWith("tcp:")) {
    throw new Error(`magicseam: QUIC address must be tcp:<host:port>, got ${JSON.stringify(addr)}`);
  }
  const hostPort = addr.slice("tcp:".length);
  const i = hostPort.lastIndexOf(":");
  if (i < 0) throw new Error(`magicseam: invalid tcp address ${JSON.stringify(addr)}`);
  const host = hostPort.slice(0, i);
  const port = Number(hostPort.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`magicseam: invalid port in ${JSON.stringify(addr)}`);
  }
  return { host, port };
}

const clientCrypto = {
  ops: {
    async randomBytes(data: ArrayBuffer): Promise<void> {
      nodeCrypto.getRandomValues(new Uint8Array(data));
    },
  },
};

// The server's own retry-token signing key (NOT the TLS private key) -
// @matrixai/quic requires this for stateless retry / connection ID
// validation, independent of the mTLS identity below.
function makeServerCrypto() {
  const key = nodeCrypto.getRandomValues(new Uint8Array(32)).buffer;
  return {
    key,
    ops: {
      async sign(signKey: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer> {
        const hmac = nodeCrypto.createHmac("sha256", Buffer.from(signKey));
        hmac.update(Buffer.from(data));
        return Uint8Array.from(hmac.digest()).buffer;
      },
      async verify(verifyKey: ArrayBuffer, data: ArrayBuffer, sig: ArrayBuffer): Promise<boolean> {
        const hmac = nodeCrypto.createHmac("sha256", Buffer.from(verifyKey));
        hmac.update(Buffer.from(data));
        const expected = hmac.digest();
        const actual = Buffer.from(sig);
        return expected.length === actual.length && nodeCrypto.timingSafeEqual(expected, actual);
      },
    },
  };
}

// Buffers a QUICStream's readable side so callers can read an exact byte
// count at a time - the Web Streams equivalent of magicseam.ts's
// SocketReader.
class QUICStreamReader {
  private buf = Buffer.alloc(0);
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }
  async readExact(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("magicseam: QUIC stream closed");
      this.buf = Buffer.concat([this.buf, Buffer.from(value)]);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

async function readQUICFrame(reader: QUICStreamReader): Promise<Buffer> {
  const lenBuf = await reader.readExact(4);
  const len = lenBuf.readUInt32LE(0);
  if (len > MAX_FRAME) {
    throw new Error(`magicseam: frame length ${len} exceeds max ${MAX_FRAME}`);
  }
  return reader.readExact(len);
}

/**
 * Ask the caller one question and wait for its answer. Handed to a
 * {@link ConverseHandler} so a provider can reach back mid-call.
 */
export type Ask = (question: Uint8Array) => Promise<Uint8Array>

/**
 * Serve one conversation: answer `request`, using `ask` as many times as needed.
 *
 * THE RETURNED BYTES BECOME THE FINAL CONV_DONE PAYLOAD. Throwing is also a
 * complete conversation - the error text is sent as CONV_DONE rather than by
 * closing the stream, so the caller can tell "I heard you, and no" from "you are
 * talking to nothing". Matching cmd/trail's serve_conversation exactly.
 */
export type ConverseHandler = (request: Uint8Array, ask: Ask) => Promise<Uint8Array>

async function writeAndClose(stream: QUICStreamT, ...chunks: Uint8Array[]): Promise<void> {
  const writer = stream.writable.getWriter();
  try {
    for (const chunk of chunks) {
      await writer.write(chunk);
    }
  } finally {
    await writer.close();
  }
}

/** A bound connection to one QUIC magic-seam provider. */
export class QUICSeamClient {
  constructor(
    private readonly client: QUICClient,
    /** The provider's self-reported version (may be ""). */
    public readonly served: string,
    /**
     * Announced on every call. The all-empty value means UNATTRIBUTED and is the
     * honest default for a consumer with nothing to declare - the frame is
     * written either way, mirroring sdk/go/magicseam's `Caller` field. A
     * provider decodes a short or absent frame to empty fields rather than
     * throwing, so an unattributed caller is a value and not a special case.
     */
    public caller: Caller = { namespace: "", podName: "", podUid: "", component: "" },
  ) {}

  /**
   * Opens a NEW bidirectional stream for this one request - concurrent
   * call() invocations on the same client never serialize behind each
   * other, unlike serve()/MSK1's Client.
   */
  async call(request: Uint8Array): Promise<Uint8Array> {
    const stream = this.client.connection.newStream("bidi");
    // ***CALLER FRAME FIRST, THEN THE REQUEST.*** This SDK's own server has read
    // two frames here since 3d68f4882 ("Go/TS providers receive the caller") and
    // this client kept writing one, so every call it made hung: the provider
    // read the REQUEST as the caller frame and then waited for a request that
    // had already been sent and whose stream was closed.
    //
    // A FRAME-COUNT MISMATCH HAS NO ERROR PATH - both ends are still reading, so
    // it presents as SILENCE rather than as a protocol error, and the provider's
    // per-stream failure is swallowed by handleQUICConnection's `.catch(() => {})`.
    // That is why this survived: the whole quic.test.ts suite timed out at 15s
    // per test with no diagnostic, and a suite that hangs reads as an
    // environment problem rather than a wire bug.
    //
    // The unused `type Caller` import that sat in this file was the fossil of
    // the half that was never written.
    await writeAndClose(stream, encodeFrame(encodeCaller(this.caller)), encodeFrame(request));

    const reader = new QUICStreamReader(stream.readable);
    const tag = (await reader.readExact(1))[0];
    switch (tag) {
      case TAG_OK:
        return readQUICFrame(reader);
      case TAG_REJECTED:
        throw new SeamRejectedError();
      case TAG_TOO_LARGE:
        throw new SeamTooLargeError();
      default:
        throw new Error(`magicseam: provider unavailable (tag ${tag})`);
    }
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }
}

/**
 * Connects to a QUIC magic-seam provider at addr ("tcp:<host:port>") and
 * performs the version handshake: requiredVersion is this consumer's own
 * required version ("" = none). Gating on the provider's served version
 * (returned via QUICSeamClient.served) is the caller's job, same
 * "gating is not this package's job" convention serve()/MSK1 already use.
 */
export async function dialQUIC(
  addr: string,
  certPath: string,
  keyPath: string,
  caPath: string,
  requiredVersion: string,
): Promise<QUICSeamClient> {
  const { host, port } = parseQUICAddr(addr);
  const cert = fs.readFileSync(certPath, "utf8");
  const key = fs.readFileSync(keyPath, "utf8");
  const ca = fs.readFileSync(caPath, "utf8");

  const client = await QUICClient.createQUICClient({
    host,
    port,
    serverName: TRAIL_QUIC_SNI,
    crypto: clientCrypto,
    config: { key, cert, ca, verifyPeer: true, applicationProtos: ALPN },
  });

  const handshakeStream = client.connection.newStream("bidi");
  await writeAndClose(handshakeStream, encodeFrame(Buffer.from(requiredVersion, "utf8")));

  const reader = new QUICStreamReader(handshakeStream.readable);
  const acceptByte = (await reader.readExact(1))[0];
  const servedFrame = await readQUICFrame(reader);
  const served = servedFrame.toString("utf8");
  if (acceptByte === 0) {
    await client.destroy();
    throw new Error(`magicseam: provider rejected required version ${JSON.stringify(requiredVersion)} (serves ${JSON.stringify(served)})`);
  }

  return new QUICSeamClient(client, served);
}

/**
 * Listens for QUIC magic-seam consumers at addr ("tcp:<host:port>", e.g.
 * "tcp:0.0.0.0:9400") and serves handler forever, mirroring
 * remote_quic.rs's serve_provider/serve_connection/serve_one_call: one
 * accepted CONNECTION runs its own handshake once (its first stream), then
 * every subsequent STREAM on it is one call, handled independently so
 * concurrent calls never serialize (unlike serve()/MSK1 above).
 */
export async function serveQUIC(
  addr: string,
  certPath: string,
  keyPath: string,
  caPath: string,
  version: string,
  handler: Handler,
  barrier?: Barrier,
  /**
   * Optional. Supplying one is what makes this provider ADVERTISE `converse`;
   * omitting it means a caller is refused up front rather than mid-stream.
   */
  converse?: ConverseHandler,
): Promise<QUICServer> {
  const { host, port } = parseQUICAddr(addr);
  const cert = fs.readFileSync(certPath, "utf8");
  const key = fs.readFileSync(keyPath, "utf8");
  const ca = fs.readFileSync(caPath, "utf8");

  const server = new QUICServer({
    crypto: makeServerCrypto(),
    config: { key, cert, ca, verifyPeer: true, applicationProtos: ALPN },
  });

  server.addEventListener(quicEvents.EventQUICServerConnection.name, ((evt: InstanceType<typeof quicEvents.EventQUICServerConnection>) => {
    handleQUICConnection(evt.detail, version, handler, barrier, converse);
  }) as EventListener);

  await server.start({ host, port });
  console.error(`[magicseam][quic] serving handler@${version} on ${addr}`);
  return server;
}

interface Negotiated {
  /** OP_STREAM may arrive (bulk seam agreed by both ends). */
  streams: boolean
  /** An opcode byte prefixes every stream - either capability puts it there. */
  opcodes: boolean
}

function handleQUICConnection(
  connection: QUICConnection,
  version: string,
  handler: Handler,
  barrier?: Barrier,
  converse?: ConverseHandler,
): void {
  let handshakeDone = false;
  // Resolved by the handshake; call streams wait on it so a call that races
  // ahead of the handshake still learns whether the opcode is on the wire.
  let negotiated: Promise<Negotiated> = Promise.resolve({ streams: false, opcodes: false });
  connection.addEventListener(quicEvents.EventQUICConnectionStream.name, ((evt: InstanceType<typeof quicEvents.EventQUICConnectionStream>) => {
    const stream = evt.detail;
    if (!handshakeDone) {
      handshakeDone = true;
      negotiated = handleHandshakeStream(stream, version, barrier, converse !== undefined).catch(
        () => ({ streams: false, opcodes: false }),
      );
      return;
    }
    negotiated
      .then((n) => handleCallStream(stream, handler, n, barrier, converse))
      .catch(() => {});
  }) as EventListener);
}

async function handleHandshakeStream(
  stream: QUICStreamT,
  version: string,
  barrier?: Barrier,
  hasConverse: boolean = false,
): Promise<Negotiated> {
  const reader = new QUICStreamReader(stream.readable);
  // The client's required version - read and discarded; this package always
  // accepts (see magicseam.ts's module doc comment on why gating is the
  // caller's job, not this package's).
  await readQUICFrame(reader);
  // OPTIONAL second frame: the peer's capabilities. A consumer from before
  // negotiation existed sends none, so a read failure means "classic only",
  // never an error. See stream.ts.
  let peerCaps: string[] = [];
  try {
    peerCaps = parseCaps(await readQUICFrame(reader));
  } catch {
    peerCaps = [];
  }
  // Our capabilities go AFTER the served version, so an older consumer - which
  // reads exactly the accept byte and one frame - never sees them and is
  // unaffected.
  await writeAndClose(
    stream,
    new Uint8Array([1]),
    encodeFrame(Buffer.from(version, "utf8")),
    encodeFrame(Buffer.from(capsOffered(barrier !== undefined, hasConverse), "utf8")),
  );

  return {
    streams: streamsAgreed(peerCaps),
    opcodes: opcodeOnWire(peerCaps, barrier !== undefined),
  };
}

async function handleCallStream(
  stream: QUICStreamT,
  handler: Handler,
  negotiated: Negotiated,
  barrier?: Barrier,
  converse?: ConverseHandler,
): Promise<void> {
  const reader = new QUICStreamReader(stream.readable);
  // The opcode is on the wire when EITHER opcode-using capability is agreed.
  // Against a peer using neither, nothing is read and the bytes are exactly what
  // this SDK has always spoken.
  let op = OP_CALL;
  if (negotiated.opcodes) {
    op = (await reader.readExact(1))[0];
  }
  // MARKERS FIRST: a marker carries no caller frame and no payload, and it has to
  // be able to observe a channel with zero calls in it. No enter() guard is taken
  // for one - the marker arrives AS a stream, so counting it would make the drain
  // wait for itself and always time out.
  if (op === OP_MARKER || op === OP_RESUME) {
    return handleMarkerStream(stream, reader, op, barrier);
  }
  // REFUSED WHILE ARMED, and the connection stays open (§8 rule 4): OP_RESUME has
  // no other way to arrive, and a provider that closes on arm destroys the very
  // stream its ack is written on.
  if (barrier?.armed === true) {
    await writeAndClose(stream, new Uint8Array([TAG_UNAVAILABLE]));
    return;
  }
  const done = barrier?.enter();
  try {
    return await handleAdmittedCall(stream, reader, handler, op, converse);
  } finally {
    done?.();
  }
}

/**
 * One marker: apply it, then ack with the SAME barrier ID.
 *
 * The ack is written only after arm() resolves, which means in-flight actually
 * reached zero - that is the contract the coordinator depends on. A failed drain
 * must NOT ack: the stream closes without one, the barrier stays ARMED (§8 rule
 * 3), and the coordinator's abort path sends the Resume.
 *
 * A provider with NO barrier REFUSES rather than acking. "No barrier" is not
 * "nothing to drain" - it is serving handler calls right now with nothing
 * counting them. Unreachable from a peer that honours capabilities, since
 * capsOffered omits the token; kept as the fail-closed floor because the
 * advertisement is a claim and this is what has to be true if something ignores it.
 */
async function handleMarkerStream(
  stream: QUICStreamT,
  reader: QUICStreamReader,
  op: number,
  barrier?: Barrier,
): Promise<void> {
  const barrierId = await readQUICFrame(reader);
  if (barrier === undefined) {
    await stream.writable.close();
    return;
  }
  if (op === OP_RESUME) {
    barrier.resume();
    console.error(`[magicseam][barrier] resumed (barrier ${idText(barrierId)}) - admitting calls again`);
  } else {
    try {
      await barrier.arm(DEFAULT_DRAIN_TIMEOUT_MS);
    } catch (e) {
      console.error(
        `[magicseam][barrier] REFUSED barrier ${idText(barrierId)}: ${String(e)} - staying armed ` +
          `until the coordinator resumes`,
      );
      await stream.writable.close();
      return;
    }
    console.error(
      `[magicseam][barrier] armed for barrier ${idText(barrierId)} - refusing calls until resumed`,
    );
  }
  // The barrier ID is ECHOED rather than assumed: a consumer that has moved to a
  // later barrier must be able to discard an ack for an earlier one.
  await writeAndClose(stream, new Uint8Array([OP_MARKER_ACK]), encodeFrame(barrierId));
}

function idText(id: Uint8Array): string {
  return JSON.stringify(Buffer.from(id).toString("utf8"))
}

/**
 * Serve ONE conversation on a stream whose OP_CONVERSE has already been read.
 *
 * ONE WRITER FOR THE WHOLE EXCHANGE, which is why writeAndClose is not used:
 * that helper closes, and a conversation interleaves many writes with reads on
 * the same stream. Closing after the first question would end the call before
 * the answer could arrive.
 */
async function handleConverseStream(
  stream: QUICStreamT,
  reader: QUICStreamReader,
  converse: ConverseHandler | undefined,
): Promise<void> {
  const writer = stream.writable.getWriter();
  const tagged = (tag: number, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(body.length + 1);
    out[0] = tag;
    out.set(body, 1);
    return out;
  };
  try {
    // CALLER FRAME FIRST, THEN THE REQUEST - the order the caller writes them.
    // Reading these in the wrong order does not produce an error: both ends are
    // still reading, so a frame-count mismatch presents as a HANG. The caller
    // frame is read and discarded here for the same reason the handshake
    // discards the required version - gating is the caller's job, not this
    // package's.
    await readQUICFrame(reader);
    const request = await readQUICFrame(reader);

    const ask: Ask = async (question) => {
      await writer.write(encodeFrame(tagged(CONV_ASK, question)));
      // THE ANSWER CARRIES NO TAG. Only the callee can end the conversation, so
      // only callee frames need to say which kind they are.
      return await readQUICFrame(reader);
    };

    let payload: Uint8Array;
    try {
      // A HANDLER THAT WAS NEVER SUPPLIED IS A PROTOCOL ERROR, NOT A CRASH.
      // Unreachable from a peer that honours capabilities, since converse is
      // advertised only when one exists - but a caller can send any opcode, and
      // the far side is waiting on frames rather than on a connection error.
      if (converse === undefined) {
        throw new Error("this provider advertises no converse handler");
      }
      payload = await converse(request, ask);
    } catch (e) {
      // REFUSAL TRAVELS AS CONV_DONE, NOT AS A CLOSED STREAM. EOF means the
      // callee died; an error frame means it ran and said no, and the caller
      // must be able to tell those apart.
      payload = Buffer.from(
        `converse refused: ${e instanceof Error ? e.message : String(e)}`,
        "utf8",
      );
    }
    await writer.write(encodeFrame(tagged(CONV_DONE, payload)));
  } finally {
    await writer.close();
  }
}

async function handleAdmittedCall(
  stream: QUICStreamT,
  reader: QUICStreamReader,
  handler: Handler,
  op: number,
  converse?: ConverseHandler,
): Promise<void> {
  if (op === OP_CONVERSE) {
    return handleConverseStream(stream, reader, converse);
  }
  if (op === OP_STREAM) {
    return handleStreamCallStream(stream, reader, handler);
  }
  // Caller frame FIRST, then the request - matching trail's own client
  // (remote_quic.rs Client::call), which writes both before finishing.
  const callerFrame = await readQUICFrame(reader);
  const request = await readQUICFrame(reader);
  try {
    const response = await handler(decodeCaller(callerFrame), request);
    await writeAndClose(stream, new Uint8Array([TAG_OK]), encodeFrame(response));
  } catch (e) {
    await writeAndClose(stream, new Uint8Array([tagFor(e)]));
  }
}


/**
 * One BULK call: caller frame, then request chunk frames terminated by a
 * zero-length frame, and the same shape in reply behind the usual tag byte.
 */
async function handleStreamCallStream(
  stream: QUICStreamT,
  reader: QUICStreamReader,
  handler: Handler,
): Promise<void> {
  const callerFrame = await readQUICFrame(reader);
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await readQUICFrame(reader);
    if (chunk.length === 0) break; // zero-length frame ends the request
    chunks.push(chunk);
  }
  const request = Buffer.concat(chunks);
  try {
    const response = await handler(decodeCaller(callerFrame), request);
    const frames: Uint8Array[] = [new Uint8Array([TAG_OK])];
    for (let off = 0; off < response.length; off += STREAM_CHUNK) {
      frames.push(encodeFrame(response.subarray(off, off + STREAM_CHUNK)));
    }
    // Zero-length frame ends the reply. Written even for an empty response,
    // where it is the whole reply - without it the consumer blocks waiting for
    // a terminator that never arrives.
    frames.push(encodeFrame(new Uint8Array(0)));
    await writeAndClose(stream, ...frames);
  } catch (e) {
    await writeAndClose(stream, new Uint8Array([tagFor(e)]));
  }
}

/** Reply framing size, matching trail's STREAM_CHUNK. */
const STREAM_CHUNK = 64 * 1024;
