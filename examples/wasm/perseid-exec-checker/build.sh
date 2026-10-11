#!/usr/bin/env bash
# Build the perseid-exec checker child.
#
# wasm32-wasip2 emits a component directly, so there is no `wasm-tools component
# new` step and no adapter; the async wasi:cli/run@0.3.0 export comes from
# wit-bindgen rather than from the target - see ../trail-p3/README.md.
set -euo pipefail
cd "$(dirname "$0")"

# ⛔ NOT /tmp - tmpfs, and a cold cargo target SIGBUSes the linker there.
export CARGO_TARGET_DIR="${PERSEID_EXEC_CHECKER_TARGET:-/mnt/nvme_data/perseid-exec-checker-target}"

# The pure half is testable on the host, where a component cannot run. Native
# target on purpose: `cargo test --target wasm32-wasip2` has no runner.
cargo test --release

cargo build --release --target wasm32-wasip2

OUT="$CARGO_TARGET_DIR/wasm32-wasip2/release/perseid_exec_checker.wasm"
wasm-tools validate --features all "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
echo "wire it with: --exec-with check=$OUT"
