# zig/magicseam

The Zig **host-side** magic-seam SDK (ADR-0028 / ADR-0043) - an idiomatic Zig
wrapper over `c/magicseam`'s own QUIC implementation, for a genuinely
non-WASM Zig program that wants to act as a magic-seam provider or consumer.

Unlike `go/magicseam` and `ts/magicseam` (which re-implement the wire
protocol natively against their own languages' QUIC libraries), this SDK
**links straight into `libmagicseam_quic.a`** via `@cImport` instead of
re-porting the ngtcp2 handling a third time. Zig has first-class C interop and
C is already the one ngtcp2 binding in this repo, so wrapping it is the
correct scope here - this package has no protocol logic of its own; every
behavior (flow control, framing, the worker pool, TLS) is `c/magicseam`'s.

## API

`magicseam.zig` is the whole public surface:

- **`Client`** - `dial(...)` / `call(allocator, req) ![]u8` / `close()`.
  `call`'s returned slice is copied into `allocator` (never the C SDK's raw
  malloc'd buffer) - free it the normal Zig way.
- **`Server`** - `serve(allocator, ..., handler: HandlerFn, user_data) !Server`
  / `close()`. `HandlerFn` is `fn (user_data, req: []const u8) anyerror![]const
  u8` - any allocator, any error set; a C-ABI trampoline copies the returned
  slice into a `malloc`'d buffer for the C SDK and frees the handler's own
  slice immediately after, so the handler never has to reason about the C
  side's allocator lifetime.
- **`Error`** - mirrors `magicseam_status`'s non-OK values
  (`Arg`/`Tls`/`Dial`/`Io`/`Protocol`/`Version`/`Rejected`/`TooLarge`/
  `Unavailable`).
- **`sni`** - the fixed CommonName/DNS-SAN every trail-CA-signed QUIC leaf
  carries (`magicseam_quic.h`'s `MAGICSEAM_QUIC_SNI`).

## Build

```sh
zig build test        # compiles c/magicseam's own 5 sources + runs this SDK's tests
```

`build.zig` compiles `c/magicseam/{frame,tls,io,client,server}.c`
directly (not the Makefile's prebuilt `.a`) into a static lib, links system
`ngtcp2`/`ngtcp2_crypto_ossl`/`ssl`/`crypto`/`pthread` (hardcoded - Zig's
build system has no pkg-config integration), then builds `magicseam.zig` as
a module on top.

**Known environment gotcha (as of Zig 0.16.0 on a system with GCC 16):**
Zig's own linker can't relocate the `.sframe` sections this GCC's crt
objects carry (`fatal linker error: unhandled relocation type R_X86_64_PC64`
in `crt1.o`) - this affects ANY libc-linked native Zig source on this kind of
host, not just this SDK. `build.zig`'s test step works around it by compiling
the test to a plain object (`emit_object`) and linking + running it via the
system `cc` instead of `zig build-exe`'s own linker. See
periapsis's internal notes for the full diagnosis - if a
future Zig release fixes this upstream, that workaround (and its two related
flag gotchas: `-fno-sanitize=undefined` on the C sources, and `cc` needing NO
`-nostartfiles`/`-no-pie` for this specific object-emission path) can likely
be simplified back to a plain `b.addRunArtifact`.

`zig build test` mints throwaway CA + leaf certs via the `openssl` CLI
(mirroring `c/magicseam`'s own test harness) and runs the same three real
loopback QUIC integration tests every magic-seam SDK's test suite has: a
round trip, concurrent calls that don't serialize behind each other (proving
the Zig handler trampoline doesn't accidentally serialize either), and the
rejected/too-large/other error-tag mapping.

## Layout

- `magicseam.zig` - the whole public API.
- `magicseam_test.zig` - this SDK's own test suite.
- `build.zig` / `build.zig.zon` - see the build section above; the top of
  `build.zig` has the fuller doc comment on the C-source-compilation choice.
