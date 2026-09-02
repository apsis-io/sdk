#!/usr/bin/env bash
# Rebuild fetch-provider.wasm from dwarf's own examples/fetch-provider
# (dwarf:fetch/client, backed by real wasi:http/client@0.3.0).
#
# ***THE PUBLISHED PACKAGE DOES NOT CARRY THE .wasm - RUNNING THIS IS THE ONLY
# WAY TO GET IT.*** package.json excludes fetch-provider/*.wasm, so npm ships
# this script, package.wit and wkg.lock - the recipe - and not the artefact. A
# consumer who wants fetch() has to build it, and needs a dwarf checkout plus
# the dwarf binary to do so. That is a real cost and it is stated here rather
# than discovered: the artefact used to be committed and shipped precisely so
# nobody had to.
#
# Source of truth is dwarf's own repo - this script only runs dwarf's own build
# command against it. Re-run whenever picking up a newer dwarf with
# fetch-provider changes.
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
