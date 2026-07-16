# sdk/tinygo/magicseam

The TinyGo (WASM **guest**) SDK for the magic seam (ADR-0028,
`periapsis:magic/handler`) — the Go counterpart to the Rust examples'
`impl Guest for ... { async fn handle }`, for a program compiled by TinyGo into a
WASM component that acts as a magic-seam **provider** or **consumer** inside
`trail`.

Distinct from `sdk/go/magicseam` (a *non-WASM* Go program serving the seam over a
socket / QUIC). This is the in-component guest side.

## ⚠️ Async gap — this SDK is intentionally partial today

The seam's `handle()` is `async func` in the WIT (component-model-async, P3) as of
2026-07-16. **TinyGo / `wit-bindgen-go` have no async-component-model support**
(that's Rust `wit-bindgen` + experimental wasmtime only — see
`done/2026-07-16_tinygo-sdk-blocked.md`). So the actual WIT binding glue — the
generated `periapsis:magic/handler` bindings and wiring a `Handler` to the
component's async export/import — **is deliberately not in this package yet**;
TinyGo cannot compile it.

What is here is the **language-neutral, non-async surface** a guest needs
regardless of the ABI:

- **`Handler`** — the provider contract (`request []byte` → `response []byte, error`).
- **`ErrUnavailable` / `ErrRejected` / `ErrTooLarge`** — the seam's `error` variant
  as Go sentinels.
- **`SeamError(err)`** — provider side: a `Handler`'s Go error → the seam variant
  string (mirrors `sdk/go/magicseam`'s `tagFor`; fail-closed default `unavailable`;
  matches wrapped sentinels via `errors.Is`).
- **`FromSeamError(variant)`** — consumer side: a seam variant string → the Go
  sentinel (`errors.Is`-usable; unknown → `ErrUnavailable`).

This compiles with plain `go build` today (no TinyGo needed) *because* it omits the
async glue.

## How the binding drops in later

When TinyGo/`wit-bindgen-go` gain async support (or a sync guest-facing seam WIT
variant is added), the generated bindings wire in without changing guest code:

- **Provider:** the generated `handler.Guest` export calls your `Handler`, then
  `SeamError(err)` to build the component-model `result<list<u8>, error>`.
- **Consumer:** a `Call(request []byte) ([]byte, error)` wrapper `.await`s the
  generated async import and maps a returned error variant back with
  `FromSeamError`.

Guest code written against the `Handler` contract + these sentinels is correct and
unchanged across that transition.

## Unblock conditions

1. TinyGo / `wit-bindgen-go` gain async-component-model support (upstream).
2. A deliberate sync guest-facing seam WIT variant (a design decision — see the
   blocked-doc; the seam is async-only by an explicit choice today).

Until one of those, this package is a ready scaffold, not a runnable component's
binding.
