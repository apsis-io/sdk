#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-perseid-ts.wasm}"
DWARF_BIN="${DWARF_BIN:-dwarf}"
command -v "$DWARF_BIN" >/dev/null 2>&1 || DWARF_BIN="$HOME/git/dwarf/target/release/dwarf"
echo "1/5 tsgo --noEmit (enforces the capability-typing assertion in src/main.ts"
echo "    and the SDK type guards in @apsis-io/periapsis-sdk perseid.test.ts)"
nub exec tsgo --noEmit -p .

# THE ONLY INSTRUMENT IN THE TREE THAT CAN SEE THIS. `Wit` must offer the known
# interface ids AND reject a malformed one; dropping the `& {}` that makes both
# true at once silently loses the completion half, and step 1 is GREEN for it.
# Mutation-tested both ways - see tools/check-completions.ts.
echo "2/5 check-completions (the wit argument still offers the known interface ids)"
nub tools/check-completions.ts

echo "3/5 derive-wit --check (derived demand matches the code AND wit/world.wit supplies it and exports the entrypoint)"
nub tools/derive-wit.ts src/main.ts step --check --world wit/world.wit --world-name perseid-ts

echo "4/5 vite build -> dist/main.js"
nub exec vite build
echo "5/6 dwarf componentize -> $OUT"
"$DWARF_BIN" --wit wit --js dist/main.js --world perseid-ts --minify --opt-size --no-vendor -o "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1))"

# AFTER componentization, because componentize-js cannot emit a wasm custom
# section - the bound is appended to the finished component. WARNS rather than
# fails when the program declares none: that is legitimate (the host's default
# applies), unlike a missing spec.language below, which means radiant cannot
# check for skew at all.
echo "6/6 attach perseid:backstop (REFUSES if this program declares none)"
bun tools/attach-backstop.ts "$OUT" src/backstop.ts

# ---------------------------------------------------------------------------
# THE SECOND COMPONENT: the dependency DAG (src/dag-main.ts).
#
# ***SAME WORLD, DIFFERENT ENTRY, AND ITS OWN DERIVED FILE.*** The DAG demands
# exactly the three reconcile imports main.ts does - it observes, it scales, it
# reports - so wit/world.wit serves both and there is no second world to keep in
# step. What it does NOT share is `derived/step.wit`: that file is one ENTRY's
# demand, read out of that entry's own Generator yield type, so pointing both at
# it would compare one component's code against the other's capabilities and
# call it a match.
#
# Built here rather than in a second script so it cannot fall behind: the
# world.wit header records what a component that is never rebuilt costs, and a
# component that is never BUILT AT ALL by the standard build is the same defect
# one step earlier.
DAG_OUT="${DAG_OUT:-perseid-dag.wasm}"
# ***DERIVED FROM src/dag.ts, THE PURE HALF, NOT FROM THE WIRING.*** derive-wit
# reads a step's capability demand out of its inferred Generator yield type, and
# after the pure/wiring split that generator lives in `dag.ts`. That is the
# better subject anyway: the demand is a property of the PROGRAM, and reading it
# from the file that imports the host modules would make it a property of how the
# program happens to be wired up.
echo "dag 1/3 derive-wit --check (the DAG's demand matches the same world)"
nub tools/derive-wit.ts src/dag.ts step --check --world wit/world.wit \
    --world-name perseid-ts --derived derived/dag-step.wit
echo "dag 2/3 vite build -> dist/dag.js"
ENTRY=src/dag-main.ts OUTFILE=dag.js nub exec vite build
echo "dag 3/3 dwarf componentize -> $DAG_OUT"
"$DWARF_BIN" --wit wit --js dist/dag.js --world perseid-ts --minify --opt-size --no-vendor -o "$DAG_OUT"
echo "built $DAG_OUT ($(du -h "$DAG_OUT" | cut -f1))"
# ***EVERY COMPONENT, NOT JUST THE FIRST.*** Each is a separate PROGRAM with its
# own park behaviour, so each declares its own bound. The census at the bottom of
# this script is what makes that true rather than aspirational: a step wired for
# SOME of the artifacts is a gate pointed at files the act does not write, and it
# passes by never running.
bun tools/attach-backstop.ts "$DAG_OUT" src/dag-backstop.ts

# ---------------------------------------------------------------------------
# THE READINESS-GATED CANARY - promotion is conditional on another workload's
# observed status. Metrics-backed value gates are expressible now, but this
# component intentionally does not implement one.
CANARY_OUT="${CANARY_OUT:-perseid-canary.wasm}"
echo "canary 1/3 derive-wit --check (demand matches the canary world)"
nub tools/derive-wit.ts src/canary.ts step --check --world wit/world.wit \
    --world-name perseid-ts-canary --derived derived/canary-step.wit
echo "canary 2/3 vite build -> dist/canary.js"
ENTRY=src/canary-main.ts OUTFILE=canary.js nub exec vite build
echo "canary 3/3 dwarf componentize -> $CANARY_OUT"
"$DWARF_BIN" --wit wit --js dist/canary.js --world perseid-ts-canary --minify --opt-size --no-vendor -o "$CANARY_OUT"
echo "built $CANARY_OUT ($(du -h "$CANARY_OUT" | cut -f1))"
bun tools/attach-backstop.ts "$CANARY_OUT" src/canary-backstop.ts

# ---------------------------------------------------------------------------
# THE MEASURING PROGRAM - it derives a metric over TIME and publishes it as data.
#
# ***THE FIRST COMPONENT HERE THAT IS NOT A TOTAL STEP, AND ITS WORLD SAYS SO.***
# `perseid-ts-probe` imports `perseid:reconcile/carry`, which is the host handing
# a program its previous samples back; nothing else in this tree asks for it.
# ADR-0075's invariant 3 - a step may not depend on having observed a previous
# event - is what a probe deliberately trades away, and `carry.go` is the
# argument for why that stays debuggable: the data is on the OBJECT, not in a
# module global, so it survives a restart and shows up in `kubectl get -o yaml`.
#
# It writes NOTHING. The canary is the program that acts on this measurement, and
# keeping the two apart is what makes "who decided" answerable.
PROBE_OUT="${PROBE_OUT:-perseid-probe.wasm}"
echo "probe 1/3 derive-wit --check (demand matches the probe world)"
nub tools/derive-wit.ts src/probe.ts step --check --world wit/world.wit \
    --world-name perseid-ts-probe --derived derived/probe-step.wit
echo "probe 2/3 vite build -> dist/probe.js"
ENTRY=src/probe-main.ts OUTFILE=probe.js nub exec vite build
echo "probe 3/3 dwarf componentize -> $PROBE_OUT"
"$DWARF_BIN" --wit wit --js dist/probe.js --world perseid-ts-probe --minify --opt-size --no-vendor -o "$PROBE_OUT"
echo "built $PROBE_OUT ($(du -h "$PROBE_OUT" | cut -f1))"
bun tools/attach-backstop.ts "$PROBE_OUT" src/probe-backstop.ts

# ---------------------------------------------------------------------------
# THE NODE DRAINER - the first component that writes a CLUSTER-SCOPED object.
#
# Cordons a machine (`spec.unschedulable` on a Node, bounded by spec.writes
# ALONE - a Node has no namespace) and then scales its DECLARED workloads off it.
# It does not evict arbitrary pods and cannot - but NOT because it cannot see
# them. It enumerates the pods on the node and names the ones blocking a drain;
# what stops it moving one is `spec.writes`, which matches an object path exactly,
# so a pod discovered at runtime was never declared. See src/drainer.ts's header.
DRAINER_OUT="${DRAINER_OUT:-perseid-drainer.wasm}"
echo "drainer 1/3 derive-wit --check (demand matches the drainer world)"
nub tools/derive-wit.ts src/drainer.ts step --check --world wit/world.wit \
    --world-name perseid-ts-drainer --derived derived/drainer-step.wit
echo "drainer 2/3 vite build -> dist/drainer.js"
ENTRY=src/drainer-main.ts OUTFILE=drainer.js nub exec vite build
echo "drainer 3/3 dwarf componentize -> $DRAINER_OUT"
"$DWARF_BIN" --wit wit --js dist/drainer.js --world perseid-ts-drainer --minify --opt-size --no-vendor -o "$DRAINER_OUT"
echo "built $DRAINER_OUT ($(du -h "$DRAINER_OUT" | cut -f1))"
bun tools/attach-backstop.ts "$DRAINER_OUT" src/drainer-backstop.ts

# ═══════════════════════════════════════════════════════════════════════════
# THE SENTINEL - the first component that DISPATCHES on which arm of its own
# resume held.
#
# ***A SEPARATE WORLD BECAUSE IT IMPORTS `woke`, AND NOTHING ELSE HERE DOES.***
# `perseid:reconcile/woke@0.1.0` hands a program the arms of its own park that
# held at the wake. Adding it to a shared world would put the import into every
# component built from that world - a linker binding they do not need and an
# entry in every manifest's closure - for a hint only this program reads.
#
# ⚠ ***AND THE HOST MUST SERVE IT.*** A component importing `woke` will not
# instantiate on a trail that does not export it (trail has since 2026-09-06).
# That is the same fleet-cutover property `carry` has, which is why ADR-0107
# argued the interface rather than a `step.run` parameter.
SENTINEL_OUT="${SENTINEL_OUT:-perseid-sentinel.wasm}"
echo "sentinel 1/3 derive-wit --check (demand matches the sentinel world)"
nub tools/derive-wit.ts src/sentinel.ts step --check --world wit/world.wit \
    --world-name perseid-ts-sentinel --derived derived/sentinel-step.wit
echo "sentinel 2/3 vite build -> dist/sentinel.js"
ENTRY=src/sentinel-main.ts OUTFILE=sentinel.js nub exec vite build
echo "sentinel 3/3 dwarf componentize -> $SENTINEL_OUT"
"$DWARF_BIN" --wit wit --js dist/sentinel.js --world perseid-ts-sentinel --minify --opt-size --no-vendor -o "$SENTINEL_OUT"
echo "built $SENTINEL_OUT ($(du -h "$SENTINEL_OUT" | cut -f1))"
bun tools/attach-backstop.ts "$SENTINEL_OUT" src/sentinel-backstop.ts

# ═══════════════════════════════════════════════════════════════════════════
# EXECCHECK - the first Perseid here that spawns a child COMPONENT.
#
# ***ITS VERDICT IS NOT COMPILED IN.*** It hands a projection of its subject to
# an allowlisted child called `check` and publishes what that child says, so the
# policy is swapped with `--exec-with check=<other>.wasm` at pod launch rather
# than by rebuilding this. The world is its own because `periapsis:host/exec` is
# a host capability, not a reconcile one.
#
# ⚠ ***IT CANNOT REACH ITS CHECKER ON THE FLEET AS IT STANDS, AND IT IS BUILT
# ANYWAY.*** `--exec-with` comes from the `trail.apsis/exec-with` pod annotation
# and radiant builds a Perseid's pod itself, setting only `trail.apsis/serve-quic`
# (internal/trailop/perseidpod.go:151) - so every spawn returns `not-allowed`.
# That is FAILS-CLOSED and the program's `NoChecker` arm reports it as `unsure`
# rather than as a failing check. See ../perseid-exec/README.md.
EXECCHECK_OUT="${EXECCHECK_OUT:-perseid-execcheck.wasm}"
echo "execcheck 1/3 derive-wit --check (demand matches the execcheck world)"
nub tools/derive-wit.ts src/execcheck.ts step --check --world wit/world.wit \
    --world-name perseid-ts-execcheck --derived derived/execcheck-step.wit
echo "execcheck 2/3 vite build -> dist/execcheck.js"
ENTRY=src/execcheck-main.ts OUTFILE=execcheck.js nub exec vite build
echo "execcheck 3/3 dwarf componentize -> $EXECCHECK_OUT"
"$DWARF_BIN" --wit wit --js dist/execcheck.js --world perseid-ts-execcheck --minify --opt-size --no-vendor -o "$EXECCHECK_OUT"
echo "built $EXECCHECK_OUT ($(du -h "$EXECCHECK_OUT" | cut -f1))"
bun tools/attach-backstop.ts "$EXECCHECK_OUT" src/execcheck-backstop.ts

# ═══════════════════════════════════════════════════════════════════════════
# THE JANITOR - the first component that cleans up after itself.
#
# ***BUILT AGAINST A DIFFERENT WORLD, AND THAT IS THE WHOLE REASON IT IS A
# SEPARATE BLOCK.*** `--world perseid-ts-finalizing` exports `step` AND
# `finalize`; the two components above use `perseid-ts`, which exports `step`
# alone. A world's exports are MANDATORY, so adding finalize to the shared world
# would make main.ts and dag.ts - both live on the cluster - fail to instantiate
# until each grew an entrypoint it does not need.
#
# TWO derive-wit CHECKS, ONE PER ENTRYPOINT, because the tool reads the demand
# out of ONE generator's yield type. Both must pass: the step's demand and the
# finalizer's are checked against the same world separately, which is also what
# caught that they had diverged - the finalizer did not report a condition at
# first, so the world declared a capability that entrypoint never used.
JANITOR_OUT="${JANITOR_OUT:-perseid-janitor.wasm}"
echo "janitor 1/4 derive-wit --check step (demand matches the finalizing world)"
nub tools/derive-wit.ts src/janitor.ts step --check --world wit/world.wit \
    --world-name perseid-ts-finalizing \
    --world-union derived/janitor-step.wit,derived/janitor-finalize.wit \
    --derived derived/janitor-step.wit
echo "janitor 2/4 derive-wit --check finalize (the SECOND entrypoint, same world)"
nub tools/derive-wit.ts src/janitor.ts finalize --check --world wit/world.wit \
    --world-name perseid-ts-finalizing \
    --world-union derived/janitor-step.wit,derived/janitor-finalize.wit \
    --derived derived/janitor-finalize.wit
echo "janitor 3/4 vite build -> dist/janitor.js"
ENTRY=src/janitor-main.ts OUTFILE=janitor.js nub exec vite build
echo "janitor 4/4 dwarf componentize -> $JANITOR_OUT"
"$DWARF_BIN" --wit wit --js dist/janitor.js --world perseid-ts-finalizing --minify --opt-size --no-vendor -o "$JANITOR_OUT"
echo "built $JANITOR_OUT ($(du -h "$JANITOR_OUT" | cut -f1))"
bun tools/attach-backstop.ts "$JANITOR_OUT" src/janitor-backstop.ts

# ═══════════════════════════════════════════════════════════════════════════
# THE PODMAKER - the only component in the tree that exercises `create`.
#
# ***ITS OWN WORLD, AND FOR THE OPPOSITE REASON TO THE JANITOR'S.*** The janitor
# needed a separate world to ADD a mandatory `finalize` export. `perseid-ts-podmaker`
# exists to SUBTRACT: create + status and nothing else. It does not import
# `observe` at all, because the step never reads - it parks on `objectGone(POD)`,
# which is a RESUME expression the HOST evaluates while the program sleeps, not an
# effect the guest performs. Pointing it at the shared world would hand it a read
# capability its own types say it cannot use.
#
# ***AND THE PARK NEEDS NO READ GRANT, BECAUSE THE DECLARED WRITE CONFERS IT***
# (9dcbbcfe3): a program's own spec.writes confers the read of what it writes, FOR
# A PARK ONLY, and podmaker parks on the pod it declared.
#
# ⚠ THIS COMMENT SAID THE OPPOSITE FOR ABOUT AN HOUR ON 2026-09-01 - "the manifest
# still owes a read grant", i.e. add `observe` to spec.capabilities. That was
# eb9ac1a95, it WORKED, and it was reverted anyway: a grant every author would copy
# is a workaround that OCCUPIES the defect, and perseidrun.DerivedRules already
# grants `get` on every object in spec.writes - the aperture was refusing a read
# the apiserver would have served to that program's own ServiceAccount.
#
# Still true and still the reason this block is long: the step SUCCEEDS and the
# program dies PARKING - "resume expression could not be evaluated: unresolved
# identifier: Get" - so anyone watching whether the write landed sees a success.
# And derive-wit cannot catch a park's demand: it reads the STEP's yield type, and
# a park is not part of it.
#
# ⚠ TWO DERIVED IMPORTS, NOT THREE, AND `ensure` IS NOT AMONG THEM. `interface
# create` does `use ensure.{value}` - one value type for every generalized write -
# so the COMPONENT's import closure carries `perseid:reconcile/ensure@0.1.0`
# transitively even though the program never calls it. derive-wit reads the
# PROGRAM's demand out of the generator, so it reports two; `trail --inspect` reads
# the ARTIFACT and reports three. Both are right about different questions, and
# podmaker.yaml has to declare the artifact's answer because that is what admission
# compares against.
PODMAKER_OUT="${PODMAKER_OUT:-perseid-podmaker.wasm}"
echo "podmaker 1/3 derive-wit --check (demand matches the create-only world)"
nub tools/derive-wit.ts src/podmaker.ts step --check --world wit/world.wit \
    --world-name perseid-ts-podmaker --derived derived/podmaker-step.wit
echo "podmaker 2/3 vite build -> dist/podmaker.js"
ENTRY=src/podmaker-main.ts OUTFILE=podmaker.js nub exec vite build
echo "podmaker 3/3 dwarf componentize -> $PODMAKER_OUT"
"$DWARF_BIN" --wit wit --js dist/podmaker.js --world perseid-ts-podmaker --minify --opt-size --no-vendor -o "$PODMAKER_OUT"
echo "built $PODMAKER_OUT ($(du -h "$PODMAKER_OUT" | cut -f1))"
bun tools/attach-backstop.ts "$PODMAKER_OUT" src/podmaker-backstop.ts

# ═══════════════════════════════════════════════════════════════════════════
# 5b. GOVERNANCE - THE ONE THAT IS ACTUALLY RUNNING, AND WAS NOT BUILT HERE.
#
# ⛔ ***`gazer-governance` IS LIVE (Running, not Parked) AND THIS SCRIPT DID NOT
# BUILD IT.*** Its source, its world and its manifest were all in the tree; the
# build step was not, so every change to the contract reached five components and
# skipped the one serving traffic. Found 2026-09-04 while planning the async
# cutover: it imports `observe-cluster` - an `async func` - so it is in the skew
# blast radius, and under the I/O rule a trail at HEAD REFUSES to serve a reader
# that exports no `signal`. It had none, because its world never declared one.
#
# It has its own world (wit/governance.wit) rather than a `perseid-ts-*` variant:
# it is the only program here that reads cluster-scoped, and that import is what
# a grant has to justify.
# ═══════════════════════════════════════════════════════════════════════════
GOVERNANCE_OUT="${GOVERNANCE_OUT:-perseid-governance.wasm}"
echo "governance 1/3 vite build -> dist/governance.js"
ENTRY=src/governance-main.ts OUTFILE=governance.js nub exec vite build
echo "governance 2/3 dwarf componentize -> $GOVERNANCE_OUT"
"$DWARF_BIN" --wit wit --js dist/governance.js --world governance --minify --opt-size --no-vendor -o "$GOVERNANCE_OUT"
echo "built $GOVERNANCE_OUT ($(du -h "$GOVERNANCE_OUT" | cut -f1))"
bun tools/attach-backstop.ts "$GOVERNANCE_OUT" src/governance-backstop.ts

# ═══════════════════════════════════════════════════════════════════════════
# 6. WIT SKEW - WILL THESE ARTIFACTS INSTANTIATE ON THE HOST THEY ARE BUILT ON?
#
# The build-side half of the function-level skew gate (engi, 2026-09-02: "both,
# admission and build"). A component built against a newer reconcile.wit than a
# host's trail demands an import that host cannot bind, and fails at first pass
# with "missing import" - a message about the world file, not about skew.
# Admission catches the artifact-vs-RADIANT case; this catches artifact-vs-THIS-
# HOST's-trail, which admission structurally cannot (N hosts, one admission).
#
# SKIPPED LOUDLY, NEVER SILENTLY. A build box with no /usr/local/bin/trail is not
# a fleet host and has nothing to compare against; the line says so and names the
# command to run against a real host. A PASS here means something only because
# `ci/wit-skew.sh --selftest` has both arms.
# ═══════════════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════════════════
# ***EVERY COMPONENT THIS SCRIPT BUILDS, IN ONE PLACE, BECAUSE TWO LISTS DRIFTED
# TWICE.***
#
# The wit-skew block below carries a warning that governance was added to the
# BUILD and not to the GATE, so "the one Perseid actually Running on the fleet
# was the one artifact this step never checked". That warning was written, and
# then the backstop census a hundred lines further down was left with the SAME
# omission - plus `probe` when it landed 2026-09-05. Two gates, one mistake,
# made twice, with the second copy sitting under a comment describing the first.
#
# A gate's population is not a detail of the gate: a check pointed at a list that
# excludes the new thing PASSES, and the newest artifact is always the one most
# worth checking. So there is one list, both loops read it, and adding a
# component to the build without adding it here now breaks the count assertion
# rather than quietly shrinking what is examined.
ALL_COMPONENTS=("$OUT" "$DAG_OUT" "$CANARY_OUT" "$PROBE_OUT" "$DRAINER_OUT" "$EXECCHECK_OUT" "$JANITOR_OUT" "$PODMAKER_OUT" "$GOVERNANCE_OUT" "$SENTINEL_OUT")

# ⛔ ***THE PARAGRAPH ABOVE CLAIMED ADDING A COMPONENT WITHOUT LISTING IT HERE
# "BREAKS THE COUNT ASSERTION". IT DID NOT, AND `sentinel` PROVED IT.*** The
# sentinel was built by this script, left out of the list, and every gate below
# passed while examining eight of nine artifacts. The only count assertion was
# `bs_seen -eq 0`, which catches an EMPTY population and cannot see a SHORT one -
# and a short population is the case that actually happens, because it is what
# adding a component does.
#
# ⚠ The existing direction is NAMED-BUT-NOT-BUILT (`$w: NOT BUILT`). This is the
# other one, and it is the dangerous half: a named-and-missing artifact fails
# loudly, while a built-and-unnamed one is invisible by construction - the gates
# never look at it, so nothing can report it.
#
# So the list is checked against the DIRECTORY rather than trusted: every
# `perseid-*.wasm` this script produced must appear in ALL_COMPONENTS.
missing_from_list=0
for built in perseid-*.wasm; do
    [ -f "$built" ] || continue
    listed=0
    for named in "${ALL_COMPONENTS[@]}"; do [ "$named" = "$built" ] && listed=1 && break; done
    if [ "$listed" -eq 0 ]; then
        echo "build.sh: $built was BUILT and is not in ALL_COMPONENTS - every gate below would skip it" >&2
        missing_from_list=1
    fi
done
[ "$missing_from_list" -eq 0 ] || { echo "build.sh: the gate population is short - add it to ALL_COMPONENTS" >&2; exit 1; }

echo "6/7 wit-skew: every built artifact vs this host's trail"
if [ -x /usr/local/bin/trail ]; then
    skew_rc=0
    # ⚠ GOVERNANCE IS IN THIS LIST AND WAS NOT, FOR ONE COMMIT. It was added to
    # the BUILD (5b) and not to the GATE, so the one Perseid that is actually
    # Running on the fleet was the one artifact this step never checked - a gate
    # whose only omission is the component with traffic on it. Caught by counting
    # the PASS lines against the artifacts built: five against six.
    for art in "${ALL_COMPONENTS[@]}"; do
        # wit-skew.sh is monorepo infra (it reads the periapsis tree's wit): the
        # moved example points across at the sibling checkout, where trail lives.
        ../../../../periapsis/ci/wit-skew.sh "$art" || skew_rc=$?
    done
    # exit 2 (INCONCLUSIVE: an artifact importing no reconcile function) is
    # reported by the script and is not a build failure; 1 and 3 are.
    if [ "$skew_rc" -eq 1 ] || [ "$skew_rc" -eq 3 ]; then
        echo "build.sh: wit-skew FAILED (exit $skew_rc) - see the lines above" >&2
        exit 1
    fi
else
    echo "  SKIPPED: no /usr/local/bin/trail on this machine, so there is no host to compare against."
    echo "  Before ingesting on a fleet host run:  ci/wit-skew.sh <artifact> --trail <that host's trail>"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 7/7 LANGUAGE STAMP. The one skew the artifact cannot carry: a resume is
# assembled at runtime from the SDK's constructors, so what a program CAN emit is
# a property of the SDK it was built with - here, @apsis-io/periapsis-sdk's LANGUAGE_VERSION
# this build just compiled against. The Perseid declares it as spec.language and
# radiant's admission refuses a program declaring a language newer than the
# radiant speaks. This step refuses a YAML whose stamp disagrees with the SDK it
# was built with, or that carries no stamp at all - an unstamped program is not
# refused by radiant (it is unchecked, and fails at first park instead), which
# is exactly why the build is the place to insist on it.
# ═══════════════════════════════════════════════════════════════════════════
echo "7/7 language stamp: every Perseid YAML declares the SDK's LANGUAGE_VERSION"
# Read from the INSTALLED package, not a relative walk: node_modules is where
# this example's own dependency resolves to - so this reads the exact SDK the
# build is about to compile against, which is the property the stamp check
# below actually needs. The constant moved packages with the extraction
# (periapsis-sdk -> perseid, 2026-10-07).
sdk_expr=node_modules/@apsis-io/perseid/expr.ts
sdk_lang="$(sed -n 's/^export const LANGUAGE_VERSION = \([0-9][0-9]*\)$/\1/p' "$sdk_expr")"
if [ -z "$sdk_lang" ]; then
    echo "build.sh: cannot read LANGUAGE_VERSION from $sdk_expr - the anchor moved, or the SDK is not installed (bun install)" >&2
    exit 1
fi
lang_rc=0
for y in ./*.yaml; do
    stamp="$(sed -n 's/^  language: \([0-9][0-9]*\)$/\1/p' "$y")"
    case "$stamp" in
        "")         echo "  $y: NO spec.language - add 'language: $sdk_lang' under spec (radiant would not refuse this; it fails at first park instead)"; lang_rc=1 ;;
        "$sdk_lang") echo "  $y: language $stamp = SDK $sdk_lang" ;;
        *)          echo "  $y: language $stamp but this build's SDK is $sdk_lang - restamp it"; lang_rc=1 ;;
    esac
done
if [ "$lang_rc" -ne 0 ]; then
    echo "build.sh: language stamp FAILED - see the lines above" >&2
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════
# ***EVERY COMPONENT THIS SCRIPT PRODUCES CARRIES A BACKSTOP - CHECKED, NOT
# ASSUMED.***
#
# The five attach steps above are five chances to forget. A sixth component
# added later gets built, gets stamped for spec.language by the block below, and
# would ship with NO bound at all - silently, because the requirement lives in a
# step that simply never runs for it. That is the shape CLAUDE.md calls a gate
# pointed at a file the act does not write: it passes 100% of the time, because
# it is about the wrong object.
#
# So the population is derived from the artifacts rather than from the list of
# calls: whatever this script built, all of it must carry the section.
#
# ⚠ THE COUNT IS ASSERTED NON-ZERO FIRST. A glob that matches nothing makes the
# loop body run zero times and the check pass while examining no artifact -
# which is the same silent green the whole thing exists to prevent.
echo "census: every built component carries perseid:backstop"
bs_rc=0
bs_seen=0
for w in "${ALL_COMPONENTS[@]}"; do
    [ -f "$w" ] || { echo "  $w: NOT BUILT - the census names an artifact this script did not produce" >&2; bs_rc=1; continue; }
    bs_seen=$((bs_seen + 1))
    if grep -qa 'perseid:backstop' "$w"; then
        echo "  $w: carries perseid:backstop"
    else
        echo "  $w: NO perseid:backstop section - it was built but never attached" >&2
        bs_rc=1
    fi
done
if [ "$bs_seen" -eq 0 ]; then
    echo "build.sh: the backstop census examined ZERO components - it is passing by looking at nothing" >&2
    exit 1
fi
# ***AND THE COUNT MUST BE THE WHOLE LIST, NOT MERELY NON-ZERO.*** Non-zero
# catches a glob that matched nothing; it does NOT catch the failure this list
# was created for, which is a census that examines five of seven and reports
# five passes. Only an equality can see that.
if [ "$bs_seen" -ne "${#ALL_COMPONENTS[@]}" ]; then
    echo "build.sh: the backstop census examined $bs_seen of ${#ALL_COMPONENTS[@]} components -" >&2
    echo "  it is reporting PASS for a population smaller than the one it was given" >&2
    exit 1
fi
if [ "$bs_rc" -ne 0 ]; then
    echo "build.sh: backstop census FAILED - see the lines above" >&2
    exit 1
fi
