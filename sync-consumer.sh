#!/usr/bin/env bash
# Copy one SDK tree into a consumer's own repo - the SDK equivalent of
# periapsis's wit/sync-consumer.sh (same idea, different artifact).
#
# ***VENDORING IS FOR THE ECOSYSTEMS THAT CANNOT PIN A VERSION, AND ONLY THOSE.***
# Go takes this repo as a module at a pseudo-version and Rust as a git dependency
# at a rev; neither should ever be copied. Two cannot:
#
#   ts/*  - npm and bun resolve a git dependency through the GitHub tarball API,
#           which 404s on a private repo, and neither has a subdirectory form.
#           These packages are ts/periapsis and ts/magicseam, not the repo root.
#   c/*   - C has no package manager at all.
#
# so a copy is the mechanism rather than a shortcut. Publishing the TS packages
# retires their half of this without changing a single import, because consumers
# depend on them BY NAME through the copied package.json.
#
# Usage: sync-consumer.sh <tree> <dest-dir> [--exclude PATTERN]...
#   <tree>     is a path in THIS repo - ts/periapsis, ts/magicseam, c/magicseam.
#   <dest-dir> is where that tree's files land DIRECTLY, not nested under a
#              subdirectory of their own name - e.g.
#                  sync-consumer.sh ts/periapsis sdk/ts/periapsis
#              produces sdk/ts/periapsis/{package.json,identity.ts,types/,...}.
#              Resolved relative to the CALLER's cwd.
#
# A TS copy keeps its package.json, so a consumer depends on it by name through a
# path rather than rewriting imports:
#   "@apsis-io/periapsis-sdk": "file:../../../sdk/ts/periapsis"
# which is what lets the same `import ... from "@apsis-io/periapsis-sdk/log.js"`
# serve a vendored copy today and a published package later.
#
# ***AN EXCLUSION MUST BE PASSED ON EVERY RE-SYNC, NOT APPLIED ONCE.*** This
# copies with `rsync --delete`, so a consumer that deletes a file by hand gets it
# back the next time anyone syncs - silently, because the whole point of --delete
# is that the destination equals the source. A consumer omitting something has to
# say so HERE, every time, and record in its own tree that it does. periapsis
# omits fetch-provider/*.wasm on that basis: 1.6M it never reads, not derivable
# from anything tracked, and covered by its own no-binaries rule.
#
# ***AN EXCLUSION PREVENTS ADDING, IT DOES NOT REMOVE.*** `--delete` PROTECTS
# excluded files that are already in the destination - measured, not assumed:
# plant the file in the destination, re-sync with the exclusion, and it survives.
# So a consumer that once synced WITHOUT its exclusion keeps the file until
# someone deletes it by hand; adding the flag afterwards is silently not enough.
# `--delete-excluded` would remove it and would also remove the consumer's own
# node_modules from the destination, which is why it is not the default here.
#
# Re-run any time the tree changes upstream - this is a snapshot copy, not a
# symlink or live reference. A snapshot CAN go stale and nothing here detects
# that; the consumer is expected to record which SDK commit it vendored.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <tree> <dest-dir> [--exclude PATTERN]..." >&2
  echo "  <tree> is a path in this repo, e.g. ts/periapsis or c/magicseam" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$1"
DEST_DIR="$2"
shift 2
EXTRA=("$@")          # passed straight to rsync, e.g. --exclude '*.wasm'
SRC="$SCRIPT_DIR/$TREE"

# ***REFUSES A TREE THAT SHOULD BE A DEPENDENCY INSTEAD.*** go/ and rust/ are
# reachable by version from any consumer, and a copy of them is a second source
# of truth that no lockfile pins and no bump updates - the exact drift these
# SDKs exist to prevent between languages. Refusing here is cheaper than
# discovering the copy months later.
case "$TREE" in
  go/*|rust/*)
    echo "$0: $TREE is a real package - depend on it by version, do not vendor it." >&2
    echo "  go:   require github.com/apsis-io/sdk <version>" >&2
    echo "  rust: { git = \"https://github.com/apsis-io/sdk.git\", rev = \"<sha>\" }" >&2
    exit 2
    ;;
esac
[ -d "$SRC" ] || { echo "$0: no such tree in this repo: $TREE" >&2; exit 2; }

mkdir -p "$DEST_DIR"
# --delete keeps a re-sync honest (a file removed upstream disappears from the
# copy too, instead of silently lingering) - safe here since the whole point of
# the destination is "exactly what $TREE contains right now", nothing
# hand-edited belongs in it.
#
# ***THE EXCLUDES ARE NOT TIDINESS.*** This script used to copy the tree
# verbatim, which was harmless when the SDKs lived in a monorepo nobody ran
# `bun install` or `make` inside. They are their own repo now with real
# dependencies and real build output, so an unfiltered rsync copies node_modules
# and object files - and with --delete it would fight the consumer's own
# installer over the same directory on every re-sync.
rsync -a --delete \
  --exclude node_modules/ \
  --exclude .git/ \
  --exclude bun.lock \
  --exclude package-lock.json \
  --exclude '*.tsbuildinfo' \
  --exclude '*.o' \
  --exclude '*.a' \
  --exclude target/ \
  --exclude .zig-cache/ \
  --exclude zig-out/ \
  "${EXTRA[@]}" \
  "$SRC/" "$DEST_DIR/"

echo "vendored $TREE -> $DEST_DIR"
echo "record the commit you took it from: $(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo '<unknown>')"
