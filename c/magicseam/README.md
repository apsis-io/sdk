# sdk/c/magicseam

The C **host-side** magic-seam SDK (ADR-0028 / ADR-0043) - a QUIC wire-transport
client and server for a genuinely non-WASM C program that wants to act as a
magic-seam provider or consumer, mirroring `sdk/go/magicseam/quic.go` and
`sdk/ts/magicseam/quic.ts`'s own wire protocol exactly (mutual TLS against the
cluster's self-managed trail CA, one persistent connection, a version handshake
on the first bidirectional stream, then every call opens its own stream).

Distinct from `sdk/c/periapsis`, which is the in-component **guest**-side SDK
for the ordinary `periapsis:component/*` host capabilities. This package never
runs inside a WASM component - it's a plain dynamically-linked C library and
binary, built on `libngtcp2` + `libngtcp2_crypto_ossl` + OpenSSL.

## What it covers

The whole public surface is `magicseam_quic.h`:

| Role | API |
|------|-----|
| client | `magicseam_quic_dial`, `magicseam_quic_call`, `magicseam_quic_close` |
| server | `magicseam_quic_serve`, `magicseam_quic_server_close` |
| shared | `magicseam_status` (error enum), `magicseam_free` |

`magicseam_quic_serve` runs a fixed-size worker pool (`server.c`) so a slow
handler never blocks other in-flight calls; every connection (client or
server) drives its own dedicated background I/O thread servicing ngtcp2's
timers continuously (`io.c`'s own doc comment explains why this is required -
ngtcp2 owns no socket/timer/thread itself).

TLS material: `peri.apsis/tls-quic` (`internal/podlaunch/builder.go`)
bind-mounts a fresh cert/key/CA-bundle triple into the pod at
`internal/podlaunch.TLSQuicMountDir` - point `magicseam_quic_dial`/`_serve` at
those three files directly when running as a pod (see
`examples/c/magic-echo-c` for the pattern).

## Build

```sh
make                  # -> libmagicseam_quic.a
make test             # build + run this SDK's own test suite
make analyze          # gcc -fanalyzer static analysis (zig cc/clang has no equivalent)
```

Plain `cc` + `pkg-config` (system `libngtcp2`/`libngtcp2_crypto_ossl`/
`openssl`), dynamically linked - NOT `cmd/meteor/Makefile`'s static-musl `zig
cc` pattern, since this SDK needs real system library dependencies rather than
being a self-contained shim.

`make test` mints throwaway CA + leaf certs via the `openssl` CLI and runs
three real loopback QUIC integration tests (real UDP sockets on 127.0.0.1,
real mTLS handshakes, real streams): a round trip, concurrent calls that
don't serialize behind each other, and the rejected/too-large/other error-tag
mapping.

## Layout

- `magicseam_quic.h` - the whole public API (read its own doc comment first).
- `frame.{c,h}` - wire framing (length-prefixed request/response).
- `tls.c` / `tls_internal.h` - mTLS context setup from the three PEM files.
- `io.c` / `io_internal.h` - the per-connection background I/O thread (the
  actual ngtcp2 driving loop) - this is where flow-control credit
  (`ngtcp2_conn_extend_max_streams_bidi`/`_max_stream_offset`/`_max_offset`)
  gets replenished; see `done/2026-07-16_c-sdk-live-validation.md` if
  touching this file.
- `client.c` - `magicseam_quic_dial`/`_call`/`_close`.
- `server.c` - `magicseam_quic_serve`/`_server_close` + the worker pool.
- `magicseam_quic_test.c` - this SDK's own test suite.

## Other-language bindings that wrap this SDK instead of re-implementing it

`sdk/zig/magicseam` links straight into `libmagicseam_quic.a` via `@cImport`
rather than re-porting the ngtcp2 handling a third time - see its own README
for why that's the right call there (Zig has first-class C interop; Go/TS
don't, hence their native re-implementations).
