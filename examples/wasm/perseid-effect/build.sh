#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-perseid-effect.wasm}"
DWARF_BIN="${DWARF_BIN:-dwarf}"
command -v "$DWARF_BIN" >/dev/null 2>&1 || DWARF_BIN="$HOME/git/dwarf/target/release/dwarf"
echo "1/2 vite build -> dist/main.js"
nub exec vite build
echo "2/2 dwarf componentize -> $OUT"
"$DWARF_BIN" --wit wit --js dist/main.js --world perseid-effect --polyfill url --minify --opt-size --no-vendor -o "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
