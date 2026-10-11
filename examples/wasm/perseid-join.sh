#!/usr/bin/env bash
# What a Perseid IS, in three commands — run this instead of reading a definition.
#
# A Perseid is a wasm component that reconciles. It IMPORTS the effects it may
# perform and EXPORTS a step. It cannot do I/O; it can only observe and emit.
# The capabilities are supplied by composition, and a capability nobody supplies
# is not a permission it lacks — it is a function that does not exist.
#
# ***THIS WAS FOUR COMMANDS UNTIL 2026-08-21 AND THE FOURTH RAN THE PROGRAM.***
# Steps 3 and 4 used to `wac plug` the step into a DRIVER component and
# `wasmtime run` the result, which was loop B: the artifact exported
# wasi:cli/run and sequenced itself. ADR-0082 as amended has RADIANT drive, so
# that driver was deleted (d321b04cf) along with the composition path in the
# node. Nothing here builds it and nothing should.
#
# ***WHAT IS LOST IS REAL AND IS NOT WORTH FAKING.*** The old step 4 composed a
# step with a provider missing `emit`, ran it, and let you watch it fail to
# start — the most convincing thing in the file. A step alone is NOT RUNNABLE:
# reconcile.wit gives it no wasi:cli/run, so there is no local command that
# drives one. Driving now means radiant dialling a pod over QUIC and invoking
# the export once per pass, which is a cluster, not a shell script.
#
# So this shows the SHAPE and the BOUNDARY, and says plainly where the running
# went. A demo that quietly dropped its most vivid step would read as though
# there had never been one.
set -euo pipefail
cd "$(dirname "$0")"
TRAIL="${TRAIL:-../../cmd/trail/target/debug/trail}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

for f in perseid-component/perseid-component.wasm perseid-provider/provider.wasm \
         perseid-partial/partial.wasm; do
  [ -f "$f" ] || { echo "missing $f — build it in its own directory first"; exit 1; }
done

say "1. THE STEP: imports what it may do, exports the step. No I/O."
$TRAIL --inspect perseid-component/perseid-component.wasm |
  python3 -c 'import json,sys;d=json.load(sys.stdin);print("   imports:",d["imports"]["seam_candidates"]);print("   exports:",d["exports"])'
echo "   ^ perseid:reconcile/step is the export RADIANT INVOKES, once per pass."
echo "     Keep it: composing a driver over this would CONSUME it, which is why"
echo "     the pod runs the step uncomposed."

say "2. COMPOSE with a provider that supplies BOTH capabilities."
wac plug perseid-component/perseid-component.wasm --plug perseid-provider/provider.wasm -o /tmp/pj-joined.wasm
$TRAIL --inspect /tmp/pj-joined.wasm |
  python3 -c 'import json,sys;d=json.load(sys.stdin);print("   unsatisfied:",d["imports"]["seam_candidates"],"  <- nothing left to supply");print("   exports:    ",d["exports"],"  <- step SURVIVES the compose")'

say "3. THE BOUNDARY. Compose with a provider missing 'emit'."
wac plug perseid-component/perseid-component.wasm --plug perseid-partial/partial.wasm -o /tmp/pj-part.wasm
echo "   wac composed it ANYWAY ($(stat -c%s /tmp/pj-part.wasm) bytes) - composition does not fail closed,"
echo "   which is why the check below is the one that matters:"
$TRAIL --inspect /tmp/pj-part.wasm |
  python3 -c 'import json,sys;d=json.load(sys.stdin);print("   still unsatisfied:",d["imports"]["seam_candidates"])'
cat <<'TXT'

   THAT is the difference between a framework and a runtime. A framework asks you
   not to call things. Here there is nothing to call: the step cannot emit because
   no `emit` exists in its instance, and the program cannot start.

   You are reading that from --inspect rather than from a crash, because a step
   has no entry point of its own. The old version of this demo ran the crippled
   composition and showed you the failure directly. The FACT is the same one and
   the evidence is now one step further from you — said rather than hidden,
   because "unsatisfied import" is a claim and a trap is a demonstration.

   spec.capabilities on the Perseid object is the cluster-side statement of what
   gets composed in. Admission refuses a program importing more than it was
   granted BEFORE any of this runs - so the same boundary is checked twice, once
   as a claim and once as a fact.
TXT
