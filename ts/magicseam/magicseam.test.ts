import { describe, expect, test } from "bun:test";
import net from "node:net";
import { serve, SeamRejectedError, SeamTooLargeError } from "./magicseam.js";

const PREAMBLE = "MSK1";

function encodeFrame(bytes: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(4 + bytes.length);
  out.writeUInt32LE(bytes.length, 0);
  Buffer.from(bytes).copy(out, 4);
  return out;
}

class Reader {
  private buf = Buffer.alloc(0);
  private readonly iter: AsyncIterator<Buffer>;
  constructor(socket: net.Socket) {
    this.iter = socket[Symbol.asyncIterator]();
  }
  async readExact(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      const { value, done } = await this.iter.next();
      if (done) throw new Error("connection closed");
      this.buf = Buffer.concat([this.buf, value]);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}
async function readFrame(r: Reader): Promise<Buffer> {
  const len = (await r.readExact(4)).readUInt32LE(0);
  return r.readExact(len);
}

// A minimal hand-rolled MSK1 CLIENT (mirroring tools/trail/src/remote_simple.rs's
// Client exactly), used ONLY by these tests - the real client lives in
// Rust/trail; this proves serve()'s server-side wire behavior independently
// of it, same approach as sdk/go/magicseam's own tests.
async function handshakeAndCall(
  socket: net.Socket,
  request: Uint8Array,
): Promise<{ accept: boolean; served: string; tag: number; response?: Buffer }> {
  const r = new Reader(socket);
  socket.write(Buffer.from(PREAMBLE, "latin1"));
  socket.write(encodeFrame(Buffer.from("0.1.0", "utf8")));
  const accept = (await r.readExact(1))[0] === 1;
  const served = (await readFrame(r)).toString("utf8");
  socket.write(encodeFrame(request));
  const tag = (await r.readExact(1))[0];
  const response = tag === 0 ? await readFrame(r) : undefined;
  return { accept, served, tag, response };
}

function freeUnixSocketPath(): string {
  return `/tmp/magicseam-test-${process.pid}-${Math.floor(Math.random() * 1e9)}.sock`;
}

describe("serve", () => {
  test("echoes a request over a real round trip", async () => {
    const path = freeUnixSocketPath();
    await serve(`unix:${path}`, "0.1.0", (request) => request);

    const socket = net.createConnection({ path });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const result = await handshakeAndCall(socket, Buffer.from("hello from the test client"));
    socket.destroy();

    expect(result.accept).toBe(true);
    expect(result.served).toBe("0.1.0");
    expect(result.tag).toBe(0);
    expect(result.response?.toString("utf8")).toBe("hello from the test client");
  });

  test("maps SeamRejectedError/SeamTooLargeError/other errors to their wire tags", async () => {
    const path = freeUnixSocketPath();
    await serve(`unix:${path}`, "0.1.0", (request) => {
      const text = Buffer.from(request).toString("utf8");
      if (text === "reject") throw new SeamRejectedError();
      if (text === "toolarge") throw new SeamTooLargeError();
      throw new Error("boom"); // an arbitrary, un-sentinel'd error -> unavailable
    });

    const dial = async (): Promise<net.Socket> => {
      const socket = net.createConnection({ path });
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      return socket;
    };

    const cases: [string, number][] = [
      ["reject", 2],
      ["toolarge", 3],
      ["anything-else", 1],
    ];
    for (const [request, wantTag] of cases) {
      const socket = await dial();
      const result = await handshakeAndCall(socket, Buffer.from(request));
      socket.destroy();
      expect(result.tag).toBe(wantTag);
    }
  });

  test("rejects an address that is neither unix: nor tcp:", () => {
    expect(() => serve("bogus:whatever", "0.1.0", (r) => r)).toThrow();
  });

  test("multiple calls reuse one connection", async () => {
    const path = freeUnixSocketPath();
    let calls = 0;
    await serve(`unix:${path}`, "0.1.0", (request) => {
      calls++;
      return request;
    });

    const socket = net.createConnection({ path });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const r = new Reader(socket);
    socket.write(Buffer.from(PREAMBLE, "latin1"));
    socket.write(encodeFrame(Buffer.from("", "utf8")));
    await r.readExact(1);
    await readFrame(r);

    for (let i = 0; i < 5; i++) {
      socket.write(encodeFrame(Buffer.from(`msg-${i}`)));
      const tag = (await r.readExact(1))[0];
      const response = await readFrame(r);
      expect(tag).toBe(0);
      expect(response.toString("utf8")).toBe(`msg-${i}`);
    }
    socket.destroy();
    expect(calls).toBe(5);
  });
});
