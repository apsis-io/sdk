# sdk/c/periapsis

The C (WASM **guest**) SDK for the Periapsis host capabilities — the C
counterpart to `sdk/ts/periapsis`. A guest compiled with this SDK is an ordinary
`wasi:cli` command (exports `wasi:cli/run@0.3.0`) that imports the
`periapsis:component/*` host caps and calls them through a clean C API instead of
the raw component-model bindings.

Distinct from **`sdk/c/magicseam`**, which is a *host-side* QUIC wire-transport
wrapper (native C, not a WASM guest). This package is the in-component guest side.

## What it covers

The **sync** host capabilities of the `trail-host` world (ADR-0026 /
ADR-0028 P7):

| Cap | API |
|-----|-----|
| identity | `periapsis_identity_get` / `_free` |
| config | `periapsis_config_get`, `periapsis_config_get_text`, `_value_free` |
| log | `periapsis_log`, `periapsis_log_emit` |
| metrics | `periapsis_metric_increment_counter` / `_record_gauge` / `_record_histogram` |
| status | `periapsis_status_notify` |
| checkpoint (C/R) | `periapsis_checkpoint_requested` / `_save` / `_load` |

It is an **ergonomic wrapper** over the verbose `wit-bindgen`-generated bindings
in `generated/trail_host.h`: it hides `trail_host_string_t`, the option/result/
list structs, and the `_free` helpers behind plain `const char*`, small enums,
and out-params. `periapsis.h` is the whole public surface; read its header
comment for the memory rules (returned host data is heap-owned and freed with a
matching `_free`/`periapsis_free`; passed-in data is borrowed for the call only).

## Why the magic seam is NOT here

The magic seam (`periapsis:magic/handler`) is out of scope: its `handle()` is
`async func`, and no non-Rust toolchain (C/`wit-bindgen`, TinyGo, jco) can bind
an async component-model export/import today (see
`done/2026-07-16_tinygo-sdk-blocked.md`). Every interface in *this* SDK is
synchronous, so — unlike the seam — it binds cleanly and this SDK is complete,
not a scaffold. If the seam gains a sync guest-facing variant, a `handler`
wrapper drops in beside these.

## Build

Needs a wasi-sdk with `wasm32-wasip3` support (P3 is the target — `trail` is
P3-only). Set `WASI_SDK` if it isn't at `~/.local/share/wasi-sdk-p3`.

```sh
make                 # -> libperiapsis.a
make example         # -> example/c-sdk-example.wasm (a real component)
./bindgen.sh         # regenerate generated/ from wit/ (needs wit-bindgen >= 0.59)
```

A guest links `libperiapsis.a` (which bundles the generated bindings and the
component-type object) and is compiled for `wasm32-wasip3`; the wasi-sdk clang
emits a component directly. See `example/main.c` + `example/build.sh` for the
smallest complete guest — it exercises every cap and, built, yields:

```wit
world root {
  import periapsis:component/identity@0.1.0;
  import periapsis:component/config@0.1.0;
  import periapsis:component/log@0.1.0;
  import periapsis:component/metrics@0.1.0;
  import periapsis:component/status@0.1.0;
  import periapsis:component/checkpoint@0.1.0;
  // ...plus the standard wasi:cli/clocks imports
  export wasi:cli/run@0.3.0;
}
```

## Layout

- `periapsis.h` / `periapsis.c` — the ergonomic SDK (hand-written).
- `generated/` — checked-in `wit-bindgen c` output (`DO NOT EDIT`; refresh via
  `bindgen.sh`).
- `wit/` — vendored `periapsis:component` WIT, the source of truth for `bindgen.sh`.
- `example/` — a minimal guest component using the SDK.
- `Makefile` — builds the archive + example.
