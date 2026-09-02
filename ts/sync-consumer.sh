#!/usr/bin/env bash
# Copy the canonical ts/periapsis TS SDK into a consumer's own tree - the
# TS-SDK equivalent of periapsis's wit/sync-consumer.sh (same idea, different
# artifact).
#
# ***THIS IS NO LONGER THE ONLY OPTION, AND THE REASON IT USED TO BE IS GONE.***
# This script was written when the SDK had no package.json and lived inside the
# periapsis monorepo, where every example imported it by counting `../` to a
# fixed depth - a consumer outside that repo simply could not import it, so
# vendoring was the mechanism rather than a workaround.
#
# Since 2026-09-02 the SDK is its own repo and a real package,
# @apsis-io/periapsis-sdk, whose exports map resolves `./x.js` to `./x.ts`. Most
# consumers should just depend on it:
#
#   import { identity } from "@apsis-io/periapsis-sdk/identity.js"
#
# Vendoring remains for the cases a registry dependency cannot serve: an air-gapped
# build, a toolchain that insists on a physical directory it controls, or pinning
# an exact tree in-repo rather than through a lockfile.
#
# Usage: ts/sync-consumer.sh <dest-dir>
#   <dest-dir> is where the SDK's files land directly (not nested under a
#   "periapsis" subdir) - e.g. `ts/sync-consumer.sh vendor/periapsis-sdk`
#   produces vendor/periapsis-sdk/identity.ts, vendor/periapsis-sdk/types/, etc.
#   Resolved relative to the CALLER's cwd.
#
# After syncing, point your imports at <dest-dir> instead of the package name:
#   import { identity } from "../vendor/periapsis-sdk/identity.js"
#
# Re-run any time ts/periapsis changes upstream - this is a snapshot copy, not a
# symlink or live reference (JS/TS toolchains need a physical directory, not a
# registry fetch).
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

echo "vendored ts/periapsis -> $DEST_DIR"
echo "update your imports to point at this directory relative to your own"
echo "source files, e.g.: import { identity } from \"../$DEST_DIR/identity.js\""
