#!/usr/bin/env bash
# Rebuild fetch-provider.wasm from dwarf's own examples/fetch-provider
# (dwarf:fetch/client, backed by real wasi:http/client@0.3.0) - checked in
# here as a build artifact (like wit/.registry's periapsis:* packages)
# rather than requiring every consumer to build it themselves.
#
# Source of truth is dwarf's own repo, not periapsis's - this script only
# runs dwarf's own build command against it. Re-run whenever picking up a
# newer dwarf with fetch-provider changes.
set -euo pipefail
cd "$(dirname "$0")"

DWARF_REPO="${DWARF_REPO:-$HOME/git/dwarf}"
SRC="$DWARF_REPO/examples/fetch-provider"
if [ ! -d "$SRC" ]; then
  echo "error: $SRC not found (set DWARF_REPO to your dwarf checkout)" >&2
  exit 1
fi

DWARF_BIN="${DWARF_BIN:-dwarf}"
if ! command -v "$DWARF_BIN" >/dev/null 2>&1; then
  echo "error: dwarf binary not found on PATH" >&2
  exit 1
fi

OUT="$(pwd)/fetch-provider.wasm"
(cd "$SRC" && "$DWARF_BIN" --wit . --js main.js -o "$OUT" --world fetch-provider)

echo "built fetch-provider.wasm ($(du -h fetch-provider.wasm | cut -f1)) from $SRC"
