# Periapsis WIT package

This directory contains the public Periapsis WebAssembly component SDK surface.

The package name is `periapsis:component@0.1.0`. It is intentionally named for
the platform, not the `perigeos` daemon, so the same components can run in the
future proxy host, conformance host, Wazero adapter path, or other Periapsis
hosts.

Initial contents:

- host capability imports: `identity`, `config`, `log`, `metrics`, `status`
- exported transform ABI: `extension-transform`
- HTTP-filter helper world: `filter-http`

`status.notify` is best-effort component status. It is not Kubernetes PodStatus
and must not become authoritative lifecycle state.

The HTTP filter world deliberately does not pin `wasi:http/proxy` yet. The first
proxy host should pin the exact WASI HTTP version and include it beside the
Periapsis helper imports.

Validation:

```sh
make test-wit
```

This parses the WIT package, generates Rust bindings for both initial worlds,
checks the sample Rust components under `examples/wasm`, and composes the
`extension-transform` sample with the local `host-capabilities` stub via
`wac plug`. The link
check verifies that Periapsis `identity` and `status` imports are satisfied
locally while the `transform` export remains available.

Build the sample component with:

```sh
make build-wasm-samples
```

Invoke the transform sample through a native Wasmtime component host with:

```sh
make test-component-host
```

The helper lives at `tools/periapsis-component-host` and is installed as
`periapsis-component-host`. This test provides the Periapsis host imports from
Rust, calls the exported `transform` ABI with
`examples/wasm/extension-transform/transform-request.json`, emits JSON output,
and asserts that `status.notify` reports reached the host.

Go code should use `periapsis's component-host Invoker` to call the helper. That
keeps the first integration boundary explicit while the long-term runtime host
shape is still being settled.

Atrapos, from `Ατραπός`, is the local Varlink service for reusing a running
component host instead of spawning the helper per invocation. It uses the same
WIT package and exposes the `io.periapsis.ComponentHost` Varlink interface over
a Unix socket.

The apsis-facing path is:

```sh
apsis component invoke <component.wasm> \
  --request transform-request.json
```

By default, `apsis` tries Atrapos at `$PERIAPSIS_ATRAPOS_SOCKET` or
`/run/apsis/atrapos.sock`. If it cannot connect, it falls back to the helper
from `$PERIAPSIS_COMPONENT_HOST` or `periapsis-component-host`. Pass `--helper`
to force one-shot helper mode.

Component references currently support local paths and `file://` URLs. Both
resolve through `periapsis's component-host Resolver`, which returns an absolute
path, SHA-256 digest, media type, size, source kind, and cache state before
invocation.

The Atrapos Varlink request accepts resolved artifact metadata (`component_ref`
plus `artifact`) and keeps the legacy `component_path` field optional for
compatibility.

Inspect resolution with:

```sh
apsis component resolve <component-ref>
```

or, through Atrapos:

```sh
apsis component invoke <component.wasm> \
  --atrapos-socket /run/apsis/atrapos.sock \
  --request transform-request.json
```

`make test-apsis-component` exercises that command against the sample component
and helper.
