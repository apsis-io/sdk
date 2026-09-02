# Periapsis SDKs

Client libraries for [Periapsis](https://github.com/malformed-c/periapsis) in five
languages. Extracted from the periapsis monorepo on 2026-09-02 with history intact;
`git log` here goes back to the first SDK commit in July.

| Tree | Package | What it is |
| --- | --- | --- |
| [`go/magicseam`](go/magicseam) | `github.com/apsis-io/sdk/go/magicseam` | Magic-seam (ADR-0028) provider/consumer for native Go: MSK1 and the mTLS QUIC transport (ADR-0043). |
| [`ts/periapsis`](ts/periapsis) | `@apsis-io/periapsis-sdk` | The `periapsis:*` WASI interfaces (identity, config, log, metrics, status, checkpoint, exec, magic-seam) for **WASM components** built with dwarf. |
| [`ts/magicseam`](ts/magicseam) | `@apsis-io/magicseam` | Magic-seam for **non-WASM** TypeScript (Node/Bun). Not for use inside a component — that's `ts/periapsis/magic.ts`. |
| [`rust/seamwire`](rust/seamwire) | `apsis-seamwire` | The wire vocabulary: opcodes, capability tokens, negotiation. std-only, deliberately. |
| [`rust/perseid`](rust/perseid) | `apsis-perseid` | The Perseid vocabulary for Rust guests: apiserver paths, the aperture expression language, resume conditions. std-only. |
| [`c/magicseam`](c/magicseam) | — | Magic-seam over mTLS QUIC (ngtcp2 + OpenSSL). |
| [`c/periapsis`](c/periapsis) | — | The `periapsis:*` host interfaces via wit-bindgen; carries its own `wit/`. |
| [`zig/magicseam`](zig/magicseam) | `magicseam` | Magic-seam for Zig 0.16+. |

## Registry names are namespaced; import names are not

The Rust crates are published as `apsis-seamwire` and `apsis-perseid` because
crates.io has no scopes and a bare `seamwire` is a global claim. Both set
`[lib] name`, so `use seamwire::` and `use perseid::` are unchanged at every
call site. Depend on them by the package name and the spelling still works:

```toml
seamwire = { package = "apsis-seamwire", path = "../sdk/rust/seamwire" }
```

## Tests that need a periapsis checkout

Most of this repo tests standalone — `go test ./...`, `cargo test`, `bun test`,
`make test`, `zig build test` all pass against nothing but this tree.

Three checks are different, because they assert this SDK agrees with **trail**,
the reference implementation, and trail lives in periapsis. In the monorepo they
found it with `../../..`; there is no correct number of `..` any more. They read
`PERIAPSIS_SRC` instead:

```sh
PERIAPSIS_SRC=/path/to/periapsis go test ./...            # go/magicseam wire-drift pair
PERIAPSIS_SRC=/path/to/periapsis c/magicseam/interop_test.sh
```

Unset, the Go check **skips** and says so; the C one **exits non-zero** and says
so. Neither reports a pass it did not earn. Set-but-wrong is a hard failure in
both — asking for the check and silently not getting it is the failure mode they
exist to prevent.

The `rust/seamwire` half of the drift check moved *with* this repo, so it needs
nothing: it is read from `rust/seamwire/src/lib.rs` directly.

## Vendoring the TS SDK

`sync-consumer.sh <tree> <dest>` snapshots one tree into a consumer's repo:

```sh
sync-consumer.sh ts/periapsis sdk/ts/periapsis
sync-consumer.sh c/magicseam  sdk/c/magicseam
```

It is for the two ecosystems that cannot pin a version — npm/bun cannot resolve a
private git subdirectory, and C has no package manager at all. It **refuses**
`go/` and `rust/`, which are reachable by version and whose copies would be a
second source of truth no lockfile pins.

## License

Business Source License 1.1 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
