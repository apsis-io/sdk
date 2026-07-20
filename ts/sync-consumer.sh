#!/usr/bin/env bash
# Copy the canonical sdk/ts/periapsis TS SDK into a consumer's own tree - the
# TS-SDK equivalent of wit/sync-consumer.sh (same idea, different artifact).
#
# The SDK has no package.json and isn't published anywhere (see its own
# README) - every in-repo example just reaches back into it with a relative
# import (`../../../../sdk/ts/periapsis/identity.js`), which only resolves
# because the example lives at a fixed depth inside THIS monorepo. A
# consumer outside apsis-io/periapsis has no way to import it at all, so
# vendoring a local copy (same pattern already used for periapsis:component's
# WIT) is the only option today - not a workaround, the actual mechanism.
#
# Usage: sdk/ts/sync-consumer.sh <dest-dir>
#   <dest-dir> is where the SDK's files land directly (not nested under a
#   "periapsis" subdir) - e.g. `sdk/ts/sync-consumer.sh vendor/periapsis-sdk`
#   produces vendor/periapsis-sdk/identity.ts, vendor/periapsis-sdk/types/, etc.
#   Resolved relative to the CALLER's cwd, same convention as
#   wit/sync-consumer.sh.
#
# After syncing, update your own imports to point at <dest-dir> instead of
# the old `../../../../sdk/ts/periapsis/...` depth, e.g.:
#   import { identity } from "../vendor/periapsis-sdk/identity.js"
#
# Re-run any time sdk/ts/periapsis changes upstream - this is a snapshot
# copy, not a symlink or live reference, matching wit/sync-consumer.sh's own
# model (JS/TS toolchains need a physical directory, not a registry fetch).
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <dest-dir>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/periapsis"
DEST_DIR="$1"

mkdir -p "$DEST_DIR"
# --delete keeps a re-sync honest (a file removed upstream disappears from
# the vendor copy too, instead of silently lingering) - safe here since the
# whole point of this directory is "exactly what periapsis/ contains right
# now", nothing hand-edited belongs in it.
rsync -a --delete "$SRC/" "$DEST_DIR/"

echo "vendored sdk/ts/periapsis -> $DEST_DIR"
echo "update your imports to point at this directory relative to your own"
echo "source files, e.g.: import { identity } from \"../$DEST_DIR/identity.js\""
