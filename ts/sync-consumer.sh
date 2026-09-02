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
# Usage: ts/sync-consumer.sh <package> <dest-dir>
#   <package>  is periapsis or magicseam.
#   <dest-dir> is where that package's files land DIRECTLY, not nested under a
#   subdirectory of its own name - e.g.
#       ts/sync-consumer.sh periapsis sdk/ts/periapsis
#   produces sdk/ts/periapsis/{package.json,identity.ts,types/,...}.
#   Resolved relative to the CALLER's cwd.
#
# The copy keeps its package.json, so a consumer depends on it BY NAME through a
# path rather than rewriting imports:
#   "@apsis-io/periapsis-sdk": "file:../../../sdk/ts/periapsis"
# which is what lets the same `import ... from "@apsis-io/periapsis-sdk/log.js"`
# serve a vendored copy today and a published package later.
#
# Re-run any time the package changes upstream - this is a snapshot copy, not a
# symlink or live reference (JS/TS toolchains need a physical directory, not a
# registry fetch). A snapshot CAN go stale, and nothing here detects that; the
# consumer is expected to record which SDK commit it vendored.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <package> <dest-dir>" >&2
  echo "  <package> is periapsis or magicseam" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$1"
DEST_DIR="$2"
SRC="$SCRIPT_DIR/$PKG"

# NAMED, NOT GLOBBED. There are two TS packages now and a consumer wants one of
# them; an unrecognised name is a typo that must not silently vendor nothing.
case "$PKG" in
  periapsis|magicseam) ;;
  *) echo "$0: unknown package '$PKG' - expected periapsis or magicseam" >&2; exit 2 ;;
esac
[ -d "$SRC" ] || { echo "$0: $SRC does not exist" >&2; exit 2; }

mkdir -p "$DEST_DIR"
# --delete keeps a re-sync honest (a file removed upstream disappears from the
# vendor copy too, instead of silently lingering) - safe here since the whole
# point of this directory is "exactly what $PKG contains right now", nothing
# hand-edited belongs in it.
#
# ***THE EXCLUDES ARE NOT TIDINESS.*** This script used to copy the source tree
# verbatim, which was harmless when the SDK lived in a monorepo nobody ran
# `bun install` inside. It is its own repo now and its packages have real
# dependencies, so an unfiltered rsync copies node_modules - tens of megabytes,
# a nested dependency tree, and with --delete it would fight the consumer's own
# installer over the same directory on every re-sync.
rsync -a --delete \
  --exclude node_modules/ \
  --exclude .git/ \
  --exclude bun.lock \
  --exclude '*.tsbuildinfo' \
  "$SRC/" "$DEST_DIR/"

echo "vendored ts/$PKG -> $DEST_DIR"
echo "add it as a dependency by path, e.g. in the consumer's package.json:"
case "$PKG" in
  periapsis) echo "  \"@apsis-io/periapsis-sdk\": \"file:<path-to>/$DEST_DIR\"" ;;
  magicseam) echo "  \"@apsis-io/magicseam\": \"file:<path-to>/$DEST_DIR\"" ;;
esac
