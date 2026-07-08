// A standard fetch(input, init) -> Response over dwarf:fetch/client (a
// SEPARATE component, fetch-provider/fetch-provider.wasm, built from dwarf's
// own examples/fetch-provider - backed by real wasi:http/client@0.3.0).
// Adapted from that example's own fetch.js DX wrapper.
//
// Unlike every other module in this package, this one does NOT just work by
// importing it - it needs a build-time compose step, because
// dwarf:fetch/client's OWN implementation needs wit.Future/wit.Stream type
// indices that only make sense inside fetch-provider's own fixed, minimal
// world (see fetch-provider/package.wit's header comment). Two things a
// consumer must do beyond the usual relative import:
//
//   1. Vendor fetch-provider/package.wit's `interface client {...}` block
//      into your own wit/deps/dwarf-fetch/package.wit, and
//      `import dwarf:fetch/client;` in your world.
//   2. Build with `--polyfill fetch-classes` (for Request/Response/Headers),
//      then compose fetch-provider.wasm in via wac plug:
//        dwarf --wit wit --js dist/main.js -o my-app.wasm --polyfill fetch-classes
//        wac plug --plug .../fetch-provider/fetch-provider.wasm my-app.wasm -o my-app.composed.wasm
//      Run the COMPOSED output, not the plain one - the plain one has an
//      unsatisfied dwarf:fetch/client import and fails to instantiate.
//
// fetch is an async func end to end - only callable from an async export.
//
// Known limits (inherited from fetch-provider, not fixed here): response
// bodies are read with a single read(65536) call, not a drain loop - bodies
// larger than 64KB are truncated (see fetch-provider/package.wit's producer
// for why: no proven end-of-stream signal for this exact stream type was
// verified at the time it was written - periapsis's exec.ts drain-loop *is*
// now verified safe for periapsis:host/exec's stream<u8>, but that's a
// different producer than wasi:http/types' Response.consumeBody, so treat
// them as separate until dwarf-main confirms the same holds here too).
// request.url is parsed with a small regex (http(s)://host[:port]/path?query),
// not full WHATWG URL parsing - no userinfo, no fragments.
import { fetch as wireFetch } from "dwarf:fetch/client";

export async function fetch(input: string | Request, init: RequestInit = {}): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);

  const headers: { name: string; value: string }[] = [];
  for (const [name, value] of request.headers.entries()) {
    headers.push({ name, value });
  }

  // See fetch-provider/README.md's "fetch.js's body handling" note: a body
  // that started out binary must be read via arrayBuffer() (text() would
  // corrupt non-ASCII/UTF-8 bytes on re-encoding); anything else via text().
  let body: number[] | null = null;
  if ((request as unknown as { _bodyArrayBuffer?: unknown })._bodyArrayBuffer) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 0) body = Array.from(new Uint8Array(buf));
  } else {
    const text = await request.text();
    if (text.length > 0) body = Array.from(new TextEncoder().encode(text));
  }

  const wireResponse = await wireFetch({
    url: request.url,
    method: request.method,
    headers,
    body,
  });

  const responseHeaders = new Headers();
  for (const h of wireResponse.headers) {
    responseHeaders.append(h.name, h.value);
  }

  return new Response(Uint8Array.from(wireResponse.body), {
    status: wireResponse.status,
    headers: responseHeaders,
  });
}
