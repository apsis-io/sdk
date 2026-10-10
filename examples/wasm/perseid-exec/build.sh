#!/usr/bin/env bash
# Build perseid-exec into a component.
#
# ***BUILT FROM A STAGED COPY, NOT IN PLACE.*** `wit_bindgen::generate!` reads the
# CRATE's own wit/, so the deps have to sit beside world.wit - and vendoring
# reconcile.wit into the tracked crate would be a copy that can drift from
# wit/reconcile (only perseid-ts's copy is guarded). Staging keeps the tracked
# source dep-free and always compiles against HEAD's contract. Same reasoning, and
# the same shape, as the `signal-rust` recipe in cmd/trail/tests/fixtures/justfile.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"

# ⛔ NOT /tmp. It is tmpfs on this host and a cold cargo target SIGBUSes the
# linker there; the symptom is a non-zero exit with no useful output.
scratch="${PERSEID_EXEC_SCRATCH:-/mnt/nvme_data/perseid-exec-build}"
stage="$scratch/src"
tdir="$scratch/target"
out="${1:-$here/perseid-exec.wasm}"

command -v cargo >/dev/null || { echo "need cargo" >&2; exit 1; }
command -v wasm-tools >/dev/null || { echo "need wasm-tools" >&2; exit 1; }

rm -rf "$stage"
mkdir -p "$stage"
cp -r "$here/." "$stage/"
rm -rf "$stage/target" "$stage/wit/deps"
mkdir -p "$stage/wit/deps"

# The wasi packages reconcile.wit refers to, then HEAD's own copies on top.
cp -r "$repo/examples/wasm/perseid-ts/wit/deps/." "$stage/wit/deps/"
# ⛔ BOTH removed before HEAD's copies go in, and periapsis-host is the one that
# bit: perseid-ts vendors it too (since the TS arm landed), so copying that tree
# AND HEAD's gives `package periapsis:host@0.1.0 is defined in two different
# locations` - a WIT-resolution error that presents as thirty "cannot find module
# `exports`" lines, because bindgen produced nothing at all.
rm -rf "$stage/wit/deps/reconcile" "$stage/wit/deps/periapsis-host-0.1.0" "$stage/wit/deps/periapsis-host"
mkdir -p "$stage/wit/deps/reconcile" "$stage/wit/deps/periapsis-host"
cp "$repo/wit/reconcile/reconcile.wit" "$stage/wit/deps/reconcile/"
cp "$repo/wit/host/exec.wit" "$stage/wit/deps/periapsis-host/"

( cd "$stage" && CARGO_TARGET_DIR="$tdir" \
    cargo build --release --target wasm32-unknown-unknown )

wasm-tools component new \
    "$tdir/wasm32-unknown-unknown/release/perseid_exec.wasm" -o "$out"

# The program's OWN park bound, as a `perseid:backstop` custom section.
#
# ***IT HAS TO BE AT COMPONENT TOP LEVEL, WHICH IS WHY THIS IS NOT A RUST
# `#[link_section]`.*** trail's decoder matches `depth == 0`
# (`inspectdecode.rs:428`); a link_section lands inside the CORE MODULE, one level
# down, where nothing looks for it. So it is appended here instead - a custom
# section is legal anywhere at top level, so appending is well-formed.
#
# Without it `trail --inspect` reports `"backstop":null` and the program is paced
# only by the host's `-perseid-backstop` flag: `backstopFor`
# (`internal/perseidrun/assemble.go:450`) takes the TIGHTER of the two and falls
# back to the program's own when the host's is `off` - so a program that declares
# nothing and meets a host with the flag off has an UNBOUNDED park.
python3 - "$out" <<'PY'
import sys

NAME = b"perseid:backstop"
PAYLOAD = b'{"ms":60000}'

def uleb(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)

path = sys.argv[1]
blob = open(path, "rb").read()
assert NAME not in blob, "a perseid:backstop section is already present"
body = uleb(len(NAME)) + NAME + PAYLOAD
open(path, "ab").write(b"\x00" + uleb(len(body)) + body)
PY

wasm-tools validate --features all "$out"

echo "built $out"
wasm-tools component wit "$out" | head -20
