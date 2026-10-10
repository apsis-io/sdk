// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// THE SENTINEL: several INDEPENDENT subjects, one park, one branch per subject.
//
// ***THIS IS THE PROGRAM KEYED DISPATCH WAS BUILT FOR, AND IT IS THE FIRST
// ONE.*** Every other Perseid in this tree parks on conditions over objects its
// step reads anyway - the drainer gets `drainWanted` and `ready` from ONE Node
// read - so dispatch would save it nothing and was correctly left unused. Here
// the conditions are over THREE DIFFERENT OBJECTS, the case ADR-0107 names:
//
//	"With N conditions over N objects, re-deriving which state you are in
//	 costs N reads. The handler for the condition that held reads what it
//	 needs anyway; what is saved is reading the N-1 that did not."
//
// ⭐ AND THE SECOND REASON IS THE ONE THAT SURVIVES EVEN WHEN READS ARE CHEAP:
// ***THE PARK AND THE DISPATCH CANNOT DRIFT, BECAUSE THEY COME FROM ONE SET.***
// Written as an if-chain, a program parks on X and then branches on a re-derived
// X' - two spellings of one intent, free to disagree, and the disagreement is
// silent. `WATCH.resume` is the disjunction of the very conditions `held()`
// answers about, so there is only ever one declaration to be wrong about.
//
// ⚠ ***THE MECHANISM HAS BEEN RENAMED TWICE AND THIS HEADER DESCRIBED BOTH DEAD
// ONES.*** It said "the EXPRESSION IS THE KEY - `Resume` is a branded string and
// object keys are strings, so `{[expr]: handler}` is literal TypeScript", then
// `.when(cond, handler)` arms. Both are gone: a `Resume` is a TREE, and a
// condition no longer carries a handler at all. ***The property those sentences
// were about is real and is restated above; only the spelling changed.***
//
// ⚠ AND THE DRIFT WARNING THAT USED TO SIT HERE IS RETIRED. It said the arm list
// had to be built from module constants in a fixed order, because the host's
// INDICES named operands of the park this program parked on LAST time. An
// operand names itself since 2026-09-07, so a set that changed between passes
// simply fails to match - late, never wrong.
//
// ⛔ IT WRITES NOTHING. `spec.writes` is empty and the world imports no write
// interface at all - a sentinel that could act is a different program with a
// different blast radius, and the empty write set is what makes that
// enforceable rather than a convention (the same argument probe.ts's world
// makes).
//
// ⚠ ***THE HINT IS NEVER THE CORRECTNESS.*** `held` is empty on a backstop tick,
// and empty on a host that does not serve `perseid:reconcile/woke` at all. So
// the step must reach the same verdict with NOTHING having matched: when the
// host names nothing, it falls back to reading every subject. Dispatch makes the
// common case CHEAP, not the uncommon case WRONG - and this file is the place
// that property is demonstrated rather than asserted.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type EffectsOf,
  path,
  reconcile,
  defineStep,
  quiesce,
  anyOf,
  held,
  fieldNoLonger,
  backstop,
} from '@apsis-io/perseid/perseid.js'
import { field, select } from '@apsis-io/perseid/field.js'

const observe = reconcile.observe<string>()
const observeCluster = reconcile.observeCluster<string>()
const report = reconcile.status()

const NS = 'default'
const NODE_NAME = 'engix99-trail-1'
const NODE = path.nodes(NODE_NAME)

/**
 * The Node's `Ready` condition, selected BY TYPE.
 *
 * ***THERE IS NO SCALAR FORM OF THIS FACT*** - readiness lives only as an
 * element of `status.conditions`, keyed by `type`. Without `[?type=Ready]` a
 * park cannot name it, and `status.conditions[0]` is not an alternative because
 * condition ORDER IS NOT API. Requires `spec.language: 3`.
 */
const READY_COND = field('status', 'conditions', select('type', 'Ready'), 'status')

// ⛔ There was a `const RECHECK_MS = 60_000` here and it was DEAD - declared,
// re-exported, and read by nothing. It existed for `deadline(Date.now() + …)`;
// `backstop()` replaced that and the host bounds every park regardless. warden
// carried the identical corpse. A knob that looks adjustable and adjusts nothing
// is worse than no knob: it invites a reader to tune it.

// ═══════════════════════════════════════════════════════════════════════════
// THE SUBJECTS. Three objects, three independent facts.
// ═══════════════════════════════════════════════════════════════════════════

const DEPLOYMENTS = [
  { name: 'dag-a', at: path.ns(NS).deployments('dag-a'), want: 2 },
  { name: 'dag-b', at: path.ns(NS).deployments('dag-b'), want: 1 },
  // ⭐ ***A SUBJECT NO OTHER PROGRAM OWNS, AND IT IS HERE FOR A MEASUREMENT
  // REASON RATHER THAN A DEMONSTRATION ONE.*** `dag-a` and `dag-b` are driven by
  // `dag-demo`, which restores them in UNDER THREE SECONDS - faster than one
  // pass - so a drift in either heals before this program can be woken by it.
  // Four attempts on the live cluster produced four passes that all reported
  // `backstop`, not because dispatch is broken but because the condition was
  // never true when a pass ran.
  //
  // ⇒ A watchdog cannot be exercised against subjects something else repairs.
  // This one is managed by nobody, so a change to it PERSISTS and the wake, the
  // dispatch and the handler are all observable.
  { name: 'sentinel-subject', at: path.ns(NS).deployments('sentinel-subject'), want: 1 },
] as const

// ═══════════════════════════════════════════════════════════════════════════
// THE CONDITIONS. Declared once, at module level, and referenced TWICE - by the
// branches that act on them and by the park that waits for them.
//
// ⭐ ***THAT IS NOT TWO SPELLINGS OF ONE INTENT.*** The drift this design exists
// to prevent is writing the EXPRESSION twice; a `const` referenced twice is one
// expression, and a misspelled reference does not compile. It is what lets the
// park be assembled at the END of the step, where a pass actually decides it,
// instead of at the top because a set object had to exist before the question
// could be asked.
// ═══════════════════════════════════════════════════════════════════════════

/** The machine left Ready. */
const NODE_DOWN = fieldNoLonger(NODE, READY_COND, 'True')

/**
 * One subject is off its declared count.
 *
 * ⛔ `fieldNoLonger`, NOT `fieldNe` - Kubernetes OMITS `status.readyReplicas` at
 * zero, and zero is the failure a watchdog exists for. This shipped as `fieldNe`
 * and was measured blind on the live cluster: scaling a watched Deployment to 0
 * left the field ABSENT, an absent operand propagates as UNKNOWN rather than
 * true, and the park did not fire. `fieldNoLonger` emits `!exists || !=`, which
 * covers the deletion and the difference alike.
 */
const drifted = (d: (typeof DEPLOYMENTS)[number]) =>
  fieldNoLonger(d.at, 'status.readyReplicas', d.want)

/** `status.readyReplicas`, absent meaning zero - Kubernetes omits it at zero. */
const readyOf = (raw: string): number | null => {
  try {
    const o = JSON.parse(raw) as { status?: { readyReplicas?: unknown } }
    if (typeof o !== 'object' || o === null) return null
    const r = o.status?.readyReplicas

    return r === undefined ? 0 : typeof r === 'number' ? r : null
  } catch {
    return null
  }
}

/**
 * ⚠ ***THREE-VALUED, AND THE THIRD VALUE IS NOT "UNHEALTHY".*** Kubernetes
 * writes `"True"`, `"False"` or `"Unknown"`, and a Node with no Ready condition
 * is a fourth case. Collapsing `Unknown` or absent into NotReady would have this
 * program announce a machine is down because a read was half-written - which is
 * the defect the drainer's own parse committed for one commit until a test
 * caught it.
 */
const readyOf_node = (raw: string): boolean | null => {
  try {
    const o = JSON.parse(raw) as { status?: { conditions?: { type?: unknown; status?: unknown }[] } }
    if (typeof o !== 'object' || o === null) return null
    // Matched on `type`, mirroring the park's `[?type=Ready]` - NOT element zero.
    const c = (o.status?.conditions ?? []).find((x) => x?.type === 'Ready')

    return c?.status === 'True' ? true : c?.status === 'False' ? false : null
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE STEP.
// ═══════════════════════════════════════════════════════════════════════════

const step = defineStep(function* () {
  // Findings accumulate here; the handlers append and the step reports ONCE.
  // A handler that reported directly would race its siblings - two arms can
  // hold at the same wake, and the last `set` would win silently.
  const found: string[] = []
  // ⛔ ***THE FALLBACK ASKS "DID THE HOST TELL ME ANYTHING", NEVER "DID I FIND
  // ANYTHING WRONG".*** The first version keyed it on `found.length` and was
  // wrong in the COMMON case: a dispatched subject that turns out HEALTHY
  // appends nothing, so an empty `found` is indistinguishable from "nothing
  // dispatched" and the fallback re-read all three. Measured by the read log: a
  // single held operand read FOUR objects, worse than not dispatching at all.
  //
  // ✅ That question is now answered by `held.size` directly - see the park
  // below. It used to need a counter incremented inside the handlers, which the
  // fallback also calls, so it had to be snapshotted before the fallback ran.

  /** Read the node and judge it. Called on dispatch, or by the fallback. */
  function* checkNode() {
    const seen = yield* observeCluster(NODE)
    if (seen.t !== 'known') {
      found.push(`${NODE_NAME}: unreadable`)

      return
    }
    const ready = readyOf_node(seen.v)
    if (ready === false) found.push(`${NODE_NAME}: NOT Ready`)
    else if (ready === null) found.push(`${NODE_NAME}: no Ready condition`)
  }

  /** Read one Deployment and judge it. */
  function* checkDeployment(d: (typeof DEPLOYMENTS)[number]) {
    const seen = yield* observe(d.at)
    if (seen.t !== 'known') {
      found.push(`${d.name}: unreadable`)

      return
    }
    const ready = readyOf(seen.v)
    if (ready === null) found.push(`${d.name}: unparseable status`)
    else if (ready !== d.want) found.push(`${d.name}: ${ready}/${d.want} ready`)
  }

  // ⛔ ***THE LIST IS BUILT FROM MODULE CONSTANTS AND ITS ORDER IS FIXED.*** An
  // index is an arm's POSITION in the sequence the program PARKED on, so a list
  // that reorders between passes lets the host name arms that have moved. The
  // conditions below are derived from `NODE`, `READY_COND` and `DEPLOYMENTS` -
  // none of which is per-pass - and nothing here is conditional.
  //
  // The handlers close over `found`, which IS per-pass. That is fine and is the
  // distinction worth stating: what must be stable is the CONDITION SEQUENCE,
  // not the closures behind it.
  //
  // ⭐ ***AND THE SUBJECTS ARE MAPPED, NOT TRANSCRIBED.*** This was three
  // hand-written `DEPLOYMENTS[0]`/`[1]`/`[2]` entries, because an object
  // literal's keys cannot be produced by a loop. Adding a fourth subject meant
  // remembering to add a fourth arm; now the arms ARE the subject list, so they
  // cannot disagree with it.
  //
  // ⛔ ***`fieldNoLonger` AND NOT `fieldNe`, BECAUSE KUBERNETES OMITS
  // `readyReplicas` AT ZERO - AND ZERO IS THE FAILURE A WATCHDOG EXISTS FOR.***
  // This shipped as `fieldNe` and was MEASURED BLIND on the live cluster:
  // scaling a watched Deployment to 0 left `status` carrying only `conditions`,
  // `observedGeneration` and `terminatingReplicas`, so the `Get` read ABSENT, an
  // absent operand propagates as UNKNOWN rather than true, and the park did not
  // fire. The step still caught it on its 60s timer and reported `0/1 ready` -
  // correct, and up to a minute late, which is exactly the "looks subscribed and
  // polls" shape the wake index exists to remove.
  //
  // `fieldNoLonger` emits `!exists || !=`, which covers the deletion and the
  // difference alike. The drainer's withdrawal park documents the identical trap
  // for an annotation; this is the same defect one field over, and I wrote it
  // anyway with that comment two files away.

  // ***THE SET IS DECLARED, THEN ASKED.*** `node` is named; the Deployments are
  // keyed by the ITEM, so the subject list is never transcribed a second time
  // and cannot disagree with itself.
  // ***1. WHY AM I AWAKE.*** First statement of the pass, because it is the first
  // thing that happened. It declares nothing and needs nothing declared.
  const woke = yield* held()

  // ***2. DO THE WORK for whatever moved.*** `has` takes the CONDITION, so these
  // branches and the park below read the same values - `NODE_DOWN` and
  // `drifted` are module constants, and a misspelled reference is a compile
  // error exactly as a misspelled key would have been.
  //
  // ⚠ ***COUNT THE BRANCHES, NOT `woke.size`.*** `size` counts OPERANDS, and
  // `fieldNoLonger` renders two - both can hold at one wake, so a single subject
  // moving can report 2. What the message needs is how many SUBJECTS were read.
  let byHost = 0
  if (woke.has(NODE_DOWN)) {
    yield* checkNode()
    byHost++
  }
  for (const d of DEPLOYMENTS) {
    if (!woke.has(drifted(d))) continue
    yield* checkDeployment(d)
    byHost++
  }

  // ⚠ ***THE FALLBACK IS THE CORRECTNESS, AND IT IS NOT AN ERROR PATH.*** It is
  // what runs on a backstop tick, on the FIRST pass, and on any host that does
  // not serve `woke` - all three of which are ordinary. Reading everything is
  // what this program would do if dispatch did not exist; the hint only lets it
  // skip that when the host could tell it which subject moved.
  //
  // ✅ ***THE COUNT IS INCREMENTED AT THE BRANCH, NOT INSIDE THE HANDLER.***
  // `dispatched` used to be incremented inside `checkNode`/`checkDeployment`,
  // which the FALLBACK also calls - so it had to be snapshotted before the
  // fallback ran, or a pass that dispatched nothing reported 4-of-4. Counting at
  // the branch cannot be moved by the fallback, so the snapshot and its trap are
  // gone.
  //
  // Zero here covers both "the host named nothing" and "it named an operand this
  // pass no longer watches" - and reading everything is right for both.
  if (byHost === 0) {
    yield* checkNode()
    for (const d of DEPLOYMENTS) yield* checkDeployment(d)
  }

  // ⭐ ***THE MESSAGE NAMES HOW THE PASS DECIDED, NOT ONLY WHAT IT DECIDED.***
  // A dispatched pass and a fallback pass reach the SAME verdict - that is the
  // property the tests assert - which also makes them indistinguishable from
  // outside. Publishing the read count is the only way an operator (or the next
  // person doubting that dispatch works live) can see the mechanism rather than
  // infer it: `via 1 of 4` is a dispatch, `via 4 of 4` is the fallback.
  const total = 1 + DEPLOYMENTS.length
  // No nested parentheses: the whole thing is wrapped in `(...)` at the call
  // site, and a `(no dispatch)` inside it defeats any `\(via [^)]*\)` a reader
  // or a test writes to strip it - which is exactly what happened.
  const how = byHost === 0 ? `via ${total} of ${total}, no dispatch` : `via ${byHost} of ${total}`
  const healthy = found.length === 0
  yield* report({
    type: 'Ready',
    status: healthy ? 'True' : 'False',
    reason: healthy ? 'AllSubjectsHealthy' : 'SubjectUnhealthy',
    message: healthy
      ? `${total} subjects healthy (${how}): ${NODE_NAME}, ${DEPLOYMENTS.map((d) => d.name).join(', ')}`
      : `${found.join('; ')} (${how})`,
  })

  // ***`backstop()` FOLDS AWAY, WHICH RETIRES THE HAZARD THIS COMMENT USED TO
  // DESCRIBE.*** It read: "the backstop is disjoined LAST and the order is
  // load-bearing - putting the deadline first would shift every arm by one and
  // dispatch the wrong handler, silently." That was true of
  // `deadline(Date.now() + …)`, which is a real operand. `anyOf` drops a
  // `backstop()` operand entirely (`X || false` is `X`), so there is no ordering
  // left to get wrong - and the host disjoins its own `Backstop()` regardless.
  return quiesce(anyOf(NODE_DOWN, ...DEPLOYMENTS.map(drifted), backstop()))
})

export type Effs = EffectsOf<typeof step>
export { step as sentinelStep, NODE, NODE_NAME, NS, DEPLOYMENTS, READY_COND, readyOf, readyOf_node }
