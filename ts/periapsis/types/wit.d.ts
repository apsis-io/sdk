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

// wasi:sockets/types@0.3.0 - declared here rather than imported, because there
// is no published .d.ts for a WASI 0.3 world and dwarf generates bindings per
// component rather than shipping one.
//
// ***DELIBERATELY ONLY WHAT sockets.ts TOUCHES.*** A fuller transcription of
// the WIT would be a second, unverified copy of an interface this package does
// not implement - and a wrong member here type-checks just as happily as a
// right one. What is written down is the part that is exercised: send(), and
// the fact that it returns a FUTURE rather than a promise.
declare module "wasi:sockets/types@0.3.0" {
  // send: func(data: stream<u8>) -> future<result<_, error-code>>
  //
  // NOT async: the return is a future value that must be .read() explicitly.
  // TcpSender's constructor documents at length what awaiting it directly
  // costs, because that was a real bug - the send silently never waited.
  export interface TcpSocket {
    send(data: StreamReadableU8): { read(): Promise<unknown> };
  }
}
