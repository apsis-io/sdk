// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Runtime guards for the node drainer.
//
//	bun -e 'import("./src/drainer.test.ts").then((m) => m.runtimeGuards())'

import { backstop as declaredBackstop } from './drainer-backstop.js'
import { test } from 'bun:test'
import {
  type Handler,
  type Obs,
  type Outcome,
  runStep,
  known,
  absent,
  unknown,
} from '@apsis-io/perseid/perseid.js'
import {
  type Effs,
  drainerStep,
  NODE,
  DRAIN_KEY,
  NODE_NAME,
  PODS,
  REPLICASETS,
  WORKLOADS,
  nodeOf,
  workloadOf,
  residueOn,
  describeResidue,
} from './drainer.js'

const WL = WORKLOADS[0]!

const node = (opts: { cordoned?: boolean; drain?: boolean }): Obs<string> =>
  known(
    JSON.stringify({
      spec: opts.cordoned ? { unschedulable: true } : {},
      metadata: opts.drain ? { annotations: { 'drain.apsis/requested': 'true' } } : {},
    }),
  )

const deployment = (spec: number, ready: number): Obs<string> =>
  known(JSON.stringify({ spec: { replicas: spec }, status: { readyReplicas: ready } }))

/** A pod as the collection read renders it. */
const pod = (name: string, opts: { node?: string; phase?: string; ds?: boolean } = {}) => ({
  metadata: {
    name,
    ...(opts.ds ? { ownerReferences: [{ kind: 'DaemonSet', name: 'cni', controller: true }] } : {}),
  },
  spec: { nodeName: opts.node ?? NODE_NAME },
  ...(opts.phase === undefined ? {} : { status: { phase: opts.phase } }),
})

const pods = (...items: object[]): Obs<string> => known(JSON.stringify(items))

/**
 * ***THE COLLECTION DEFAULTS TO EMPTY, NOT TO ABSENT.*** An absent default would
 * make every pre-existing arm below take the `ResidueUnreadable` branch, and
 * they would then be asserting the drain refuses rather than what they were
 * written to assert. An empty node is the neutral fixture.
 */
/** A ReplicaSet owned by a Deployment - the middle hop. */
const rsOwnedBy = (name: string, deployment: string) => ({
  metadata: {
    name,
    ownerReferences: [{ kind: 'Deployment', name: deployment, controller: true }],
  },
})

function drive(
  n: Obs<string>,
  w: Obs<string>,
  p: Obs<string> = pods(),
  rs: Obs<string> = pods(),
): { outcome: Outcome; acts: string[]; msgs: string[] } {
  const acts: string[] = []
  // ***THE MESSAGE, NOT ONLY THE REASON.*** A mutation that leaves the reason
  // alone and corrupts the COUNTS is invisible to an `acts` assertion - measured:
  // treating an unreadable ReplicaSet list as "all ours" kept `ResidueRemains`
  // and changed only what the message claimed.
  const msgs: string[] = []
  const handler: Handler<Effs> = {
    // ***ONE `get` SERVES ALL THREE READS, BECAUSE `Handler` IS KEYED ON THE OP
    // AND `observe.get`, `observeCluster.get` AND `enumerate` SHARE IT.*** That
    // is fine for these - all take a path and return an `Obs` - and it is why
    // the production wiring has to discriminate on the PATH rather than on the
    // handler key. This mirrors that dispatch instead of hiding it behind fakes.
    get: (q: unknown) =>
      String(q) === String(WL.at)
        ? w
        : String(q) === String(NODE)
          ? n
          : String(q) === String(PODS)
            ? p
            : String(q) === String(REPLICASETS)
              ? rs
              : absent,
    ensure: (args) => {
      if (!('value' in args)) return
      const rendered = typeof args.value === 'string' ? args.value : String(args.value)
      acts.push(`ensure(${args.path},${args.field},${rendered})`)
    },
    status: (c) => {
      acts.push(`set(${c.type}=${c.status}/${c.reason})`)
      msgs.push(c.message ?? '')
    },
  }

  return { outcome: runStep(drainerStep, handler), acts, msgs }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const has = (acts: string[], text: string, msg: string) =>
  assert(acts.includes(text), `${msg}: ${acts.join(', ')}`)

export function runtimeGuards(): void {
  const CORDON = `ensure(${NODE},spec.unschedulable,true)`
  const UNCORDON = `ensure(${NODE},spec.unschedulable,false)`
  const SCALE_DOWN = `ensure(${WL.at},spec.replicas,0)`
  const SCALE_UP = `ensure(${WL.at},spec.replicas,${WL.scale})`

  // ═════════════════════════════════════════════════════════════════════════
  // ⭐ THE ORDERING, WHICH IS THE WHOLE CORRECTNESS ARGUMENT.
  // ═════════════════════════════════════════════════════════════════════════

  // Cordon FIRST. Scaling a workload down on a schedulable node lets the
  // scheduler put its replacement straight back, so a drain that scaled first
  // could run forever without converging - and nothing would look broken.
  {
    const { acts } = drive(node({ drain: true }), deployment(WL.scale, WL.scale))
    has(acts, CORDON, 'a drain request did not cordon first')
    assert(
      !acts.includes(SCALE_DOWN),
      `the workload was scaled down before the node was cordoned: ${acts.join(', ')}`,
    )
  }

  // ...and only THEN scale down.
  {
    const { acts } = drive(node({ drain: true, cordoned: true }), deployment(WL.scale, WL.scale))
    has(acts, SCALE_DOWN, 'a cordoned node did not scale its declared workload down')
    assert(!acts.includes(CORDON), `an already-cordoned node was cordoned again: ${acts.join(', ')}`)
  }

  // The REVERSE order on the way back: scale up BEFORE uncordoning, so the
  // scheduler is never invited onto a node whose workloads are still elsewhere.
  {
    const { acts } = drive(node({ cordoned: true }), deployment(0, 0))
    has(acts, SCALE_UP, 'withdrawing the drain did not restore the workload')
    assert(
      !acts.includes(UNCORDON),
      `the node was uncordoned before its workloads came back: ${acts.join(', ')}`,
    )
  }
  {
    const { acts } = drive(node({ cordoned: true }), deployment(WL.scale, WL.scale))
    has(acts, UNCORDON, 'a restored workload did not uncordon the node')
  }

  // ═════════════════════════════════════════════════════════════════════════
  // FAIL-SAFE DIRECTIONS. Each of these is a state where doing SOMETHING would
  // be worse than doing nothing.
  // ═════════════════════════════════════════════════════════════════════════

  // ⛔ AN UNREADABLE NODE MUST NOT DRAIN AND MUST NOT REPORT SUCCESS. `absent`
  // is also what an out-of-grant read looks like, so this is the arm that fires
  // when `spec.reads` does not name the node.
  for (const [what, n] of [
    ['an absent node', absent],
    ['an unknown node', unknown],
    ['an unparseable node', known('{not json')],
  ] as const) {
    const { acts } = drive(n as Obs<string>, deployment(WL.scale, WL.scale))
    assert(
      !acts.some((a) => a.startsWith('ensure(')),
      `${what} caused a write: ${acts.join(', ')}`,
    )
    assert(
      !acts.some((a) => a.includes('Drained')),
      `${what} was reported as drained: ${acts.join(', ')}`,
    )
  }

  // A node with no drain annotation is NOT a drain request. The safe direction
  // for a flag whose true value empties a machine.
  for (const raw of ['{}', '{"metadata":{"annotations":{}}}', '{"metadata":{"annotations":{"drain.apsis/requested":"false"}}}']) {
    const parsed = nodeOf(raw)
    assert(parsed !== null, `a well-formed node did not parse: ${raw}`)
    assert(!parsed.drainWanted, `a drain was inferred from ${raw}`)
  }
  // ...and the exact string does request one, or every arm above passes because
  // NOTHING is ever read as a request.
  assert(
    nodeOf('{"metadata":{"annotations":{"drain.apsis/requested":"true"}}}')?.drainWanted === true,
    'the drain annotation was not recognised, so the negative cases prove nothing',
  )

  // An omitted `spec.unschedulable` is `false` - Kubernetes does not write the
  // field on a schedulable node, so absence is a real answer here.
  assert(nodeOf('{}')?.unschedulable === false, 'an omitted unschedulable was not read as false')
  assert(
    nodeOf('{"spec":{"unschedulable":true}}')?.unschedulable === true,
    'a cordoned node was not read as cordoned',
  )

  // ⭐ READINESS IS THREE-VALUED, AND THE THIRD VALUE IS THE ONE THAT MATTERS.
  // The park uses `status.conditions[?type=Ready].status`; this guest walk must
  // agree with it, so it matches on `type` rather than taking element zero.
  const ready = (conds: unknown) => nodeOf(JSON.stringify({ status: { conditions: conds } }))?.ready
  assert(ready([{ type: 'Ready', status: 'True' }]) === true, 'a Ready node was not read as ready')
  assert(
    ready([{ type: 'Ready', status: 'False' }]) === false,
    'a NotReady node was not read as not-ready',
  )

  // ⛔ ***`Unknown` AND ABSENT BOTH BECOME null, NOT false.*** Collapsing either
  // into NotReady would have this program announce a machine is down because a
  // read failed or a status was half-written. "Not ready" and "cannot tell" are
  // different answers and only one of them is about the node.
  assert(ready([{ type: 'Ready', status: 'Unknown' }]) === null, '`Unknown` was not read as null')
  assert(ready([]) === null, 'a Node with no conditions was not read as unknown readiness')
  assert(ready(undefined) === null, 'a Node with no status was not read as unknown readiness')

  // ***AND IT MUST NOT TAKE THE FIRST CONDITION.*** Condition ORDER IS NOT API -
  // this is the defect `select()` exists to make unbuildable in a path, and the
  // guest walk can still commit it by hand. A Ready:True sitting behind two other
  // conditions must read `true`, and a leading MemoryPressure must not be
  // mistaken for it.
  assert(
    ready([
      { type: 'MemoryPressure', status: 'False' },
      { type: 'DiskPressure', status: 'False' },
      { type: 'Ready', status: 'True' },
    ]) === true,
    'readiness was read positionally - a Ready condition that is not first was missed',
  )
  assert(
    ready([{ type: 'MemoryPressure', status: 'True' }]) === null,
    'a non-Ready condition was mistaken for the Ready one',
  )

  // ⚠ `Drained` IS ONLY CLAIMED ONCE THE DECLARED WORKLOAD IS ACTUALLY AT ZERO
  // READY - not merely scaled to zero. A workload at spec=0 with replicas still
  // terminating is `Draining`.
  {
    const { acts } = drive(node({ drain: true, cordoned: true }), deployment(0, 1))
    assert(acts.some((a) => a.includes('Draining')), `a terminating replica was not reported as draining: ${acts.join(', ')}`)
    assert(!acts.some((a) => a.includes('Drained')), `a node with a serving replica was reported drained: ${acts.join(', ')}`)
  }
  {
    const { acts } = drive(node({ drain: true, cordoned: true }), deployment(0, 0))
    assert(acts.some((a) => a.includes('Drained')), `a fully drained node was not reported: ${acts.join(', ')}`)
  }

  // The workload parser keeps Kubernetes' distinction, same as the other
  // programs: omitted readiness is zero, an omitted desired count is unknown.
  assert(
    workloadOf(JSON.stringify({ spec: { replicas: 2 }, status: {} }))?.ready === 0,
    'omitted readyReplicas is not interpreted as zero',
  )
  assert(
    workloadOf(JSON.stringify({ status: {} })) === null,
    'a workload with no desired replica count was guessed at',
  )

  // ═══════════════════════════════════════════════════════════════════════
  // THE RESIDUE CHECK. `Drained` used to be a claim about the DECLARED
  // workloads that an operator would read as "the machine is empty"; these are
  // the arms that make it mean what it says.
  // ═══════════════════════════════════════════════════════════════════════

  const drained = node({ drain: true, cordoned: true })
  const empty = deployment(0, 0)

  // ⭐ AN UNDECLARED POD ON THE NODE BLOCKS `Drained` AND IS NAMED.
  {
    const { acts } = drive(drained, empty, pods(pod('stray-7d9f')))
    assert(
      acts.some((a) => a.includes('ResidueRemains')),
      `an undeclared pod on the node did not block the drain: ${acts.join(', ')}`,
    )
    assert(
      !acts.some((a) => a.includes('Drained')),
      `a node with a pod still on it was reported drained: ${acts.join(', ')}`,
    )
  }

  // ⛔ ***THE PARK MUST NAME THE BLOCKER, OR THE OPERATOR'S OWN FIX GOES
  // UNNOTICED.*** `ResidueRemains` tells an operator to clear the pod, and the
  // park used to watch only the drain ANNOTATION - so doing exactly what the
  // condition asked produced no wake until the 45s backstop. The blocking pod is
  // enumerated, so its name is available and the condition is built DURING the
  // pass, which is what makes this expressible at all.
  {
    const { outcome } = drive(drained, empty, pods(pod('stray-7d9f')))
    assert(outcome.o === 'quiesce', `a blocked drain did not park: ${outcome.o}`)
    const resume = String((outcome as { resume: { render(): string } }).resume.render())
    assert(
      resume.includes('stray-7d9f'),
      `the park does not watch the pod it just told an operator to clear: ${resume}`,
    )
    // The annotation arm must SURVIVE - withdrawing the drain is still a wake,
    // and replacing one arm with the other trades this defect for its twin.
    assert(
      resume.includes('drain.apsis/requested'),
      `the park lost the drain-withdrawn arm: ${resume}`,
    )
  }

  // ⛔ ***THE REASON CARRIES THE BOUND, NOT ONLY THE MESSAGE.*** Automation
  // watches `reason`; a teardown keyed on a bare `Drained` would evacuate a
  // machine still running workloads in namespaces this program cannot see.
  {
    const { acts: done } = drive(drained, empty, pods())
    assert(
      done.some((a) => a.includes('DrainedInNamespace')),
      `the drained reason does not carry its own bound: ${done.join(', ')}`,
    )
  }

  // ⭐ A RESIDUAL POD NAMES ITS CONTROLLER, WHICH IS THE ACTIONABLE HALF. The
  // pod's own name is a dead end - it has a random suffix and will be replaced -
  // so an operator needs the workload behind it.
  {
    const owned = {
      metadata: {
        name: 'other-app-7d9f',
        ownerReferences: [{ kind: 'ReplicaSet', name: 'other-app-5c4', controller: true }],
      },
      spec: { nodeName: NODE_NAME },
    }
    const { acts } = drive(drained, empty, pods(owned))
    assert(
      acts.some((a) => a.includes('ResidueRemains')),
      `an owned stray pod did not block the drain: ${acts.join(', ')}`,
    )
    const r = residueOn(JSON.stringify([owned]), NODE_NAME)
    assert(r !== null && r.movable.length === 1, 'the owned pod was not counted as residue')
    assert(
      r.movable[0]!.controlledBy === 'ReplicaSet/other-app-5c4',
      `the controlling owner was not recorded: ${JSON.stringify(r.movable[0])}`,
    )
    assert(
      describeResidue(r).includes('ReplicaSet/other-app-5c4'),
      `the operator-facing text omits the owner: ${describeResidue(r)}`,
    )
  }

  // ⛔ THE TWO SKIPS, WHICH ARE WHAT KEEP `Drained` REACHABLE AT ALL. Every node
  // runs DaemonSet pods for as long as it exists, so counting them would make
  // this state absorbing - `Draining` forever on a correctly drained machine.
  for (const [what, p] of [
    ['a DaemonSet pod', pod('cni-abc', { ds: true })],
    ['a Succeeded pod', pod('job-1', { phase: 'Succeeded' })],
    ['a Failed pod', pod('job-2', { phase: 'Failed' })],
    ['a pod on ANOTHER node', pod('elsewhere', { node: 'other-machine' })],
  ] as const) {
    const { acts } = drive(drained, empty, pods(p))
    assert(
      acts.some((a) => a.includes('Drained')),
      `${what} blocked the drain, so Drained is unreachable: ${acts.join(', ')}`,
    )
  }

  // ⛔ AN UNVERIFIABLE COLLECTION IS NOT AN EMPTY ONE. This is the branch that
  // would silently restore the old defect - reporting success because nothing
  // contradicted it - and the two causes stay distinct because they need
  // different fixes.
  for (const [what, p, reason] of [
    ['an absent collection', absent, 'ResidueUnreadable'],
    ['an unknown collection', unknown, 'ResidueUnknown'],
    ['an unparseable collection', known('{not json'), 'ResidueUnreadable'],
    ['a collection that is not an array', known('{"items":[]}'), 'ResidueUnreadable'],
  ] as const) {
    const { acts } = drive(drained, empty, p as Obs<string>)
    assert(
      !acts.some((a) => a.includes('Drained')),
      `${what} was reported as a drained node: ${acts.join(', ')}`,
    )
    assert(
      acts.some((a) => a.includes(reason)),
      `${what} did not report ${reason}: ${acts.join(', ')}`,
    )
  }

  // ***AN ITEM THAT DOES NOT READ COUNTS AS RESIDUE.*** Dropping it would report
  // an occupied machine as empty, which is the error an operator acts on by
  // powering the node off.
  {
    const r = residueOn(JSON.stringify([null, 7, 'x']), NODE_NAME)
    assert(r !== null, 'a well-formed array did not parse')
    assert(
      r.movable.length === 3,
      `unreadable items were dropped rather than counted: ${JSON.stringify(r)}`,
    )
  }

  // The array itself failing to parse is a HOST fault, not a fact about the
  // node, and is reported as such rather than decided.
  assert(residueOn('{not json', NODE_NAME) === null, 'an unparseable body was not refused')
  assert(residueOn('{"items":[]}', NODE_NAME) === null, 'a non-array body was read as a list')

  // The counts are exact and the names are a bounded sample - a namespace can
  // hold hundreds of pods and this string is read in a terminal.
  {
    const many = Array.from({ length: 9 }, (_, i) => pod(`p-${i}`))
    const r = residueOn(JSON.stringify(many), NODE_NAME)
    assert(r !== null && r.movable.length === 9, 'the residue count is not exact')
    const text = describeResidue(r)
    assert(text.includes('4 more'), `the sample did not summarise the rest: ${text}`)
    assert(!text.includes('p-8'), `the sample was not bounded: ${text}`)
  }
  // ...and a short list carries no summary, or the arm above passes on a
  // function that always appends one.
  {
    const r = residueOn(JSON.stringify([pod('only')]), NODE_NAME)
    assert(r !== null && describeResidue(r) === 'only', 'a short list was summarised')
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WHOSE POD IS IT? The two-hop traversal, Deployment -> ReplicaSet -> Pod.
  //
  // ⛔ These exist because `ResidueRemains` said something FALSE. The drain
  // path reaches the residue check once `status.readyReplicas == 0`, and
  // readiness drops at the START of termination - so a pod of a DECLARED
  // workload is routinely still on the node, and every one was being reported
  // as "pod(s) this program does not declare".
  // ═══════════════════════════════════════════════════════════════════════

  const DEP = String(WL.at).split('/').pop()!
  const declaredRS = pods(rsOwnedBy('drain-demo-7c4', DEP))
  const ownedPod = pod('drain-demo-7c4-abc', {})
  ;(ownedPod.metadata as Record<string, unknown>)['ownerReferences'] = [
    { kind: 'ReplicaSet', name: 'drain-demo-7c4', controller: true },
  ]

  // ⭐ A TERMINATING POD OF A DECLARED WORKLOAD IS `Draining`, NOT BLOCKED.
  {
    const { acts } = drive(drained, empty, pods(ownedPod), declaredRS)
    assert(
      acts.some((a) => a.includes('Draining')),
      `a declared workload's own terminating pod was not reported as draining: ${acts.join(', ')}`,
    )
    assert(
      !acts.some((a) => a.includes('ResidueRemains')),
      `this program's OWN pod was reported as one it cannot move - the false escalation ` +
        `this traversal exists to remove: ${acts.join(', ')}`,
    )
  }

  // ⭐ ...AND A GENUINELY FOREIGN POD STILL BLOCKS, or the arm above passes
  // because everything is now classified as ours.
  {
    const { acts } = drive(drained, empty, pods(pod('stray-1')), declaredRS)
    assert(
      acts.some((a) => a.includes('ResidueRemains')),
      `an undeclared pod stopped blocking the drain: ${acts.join(', ')}`,
    )
  }

  // ⛔ A POD OWNED BY AN *UNDECLARED* DEPLOYMENT'S ReplicaSet IS FOREIGN. This is
  // the arm that fails if the traversal matches any ReplicaSet rather than only
  // those descending from a declared workload.
  {
    const other = pod('other-app-1', {})
    ;(other.metadata as Record<string, unknown>)['ownerReferences'] = [
      { kind: 'ReplicaSet', name: 'other-app-9z9', controller: true },
    ]
    const bothRS = pods(rsOwnedBy('drain-demo-7c4', DEP), rsOwnedBy('other-app-9z9', 'other-app'))
    const { acts } = drive(drained, empty, pods(other), bothRS)
    assert(
      acts.some((a) => a.includes('ResidueRemains')),
      `a pod of an UNDECLARED deployment was absorbed as ours: ${acts.join(', ')}`,
    )
  }

  // ⛔ AN UNREADABLE MIDDLE HOP MUST NOT SILENTLY ABSORB ANYTHING. If the
  // ReplicaSets cannot be read the question cannot be asked, and the safe answer
  // is "not attributable" - reported as such rather than as "all mine".
  {
    const { acts, msgs } = drive(drained, empty, pods(ownedPod), absent)
    assert(
      acts.some((a) => a.includes('ResidueRemains')),
      `an unreadable ReplicaSet list was treated as proof the pods are ours: ${acts.join(', ')}`,
    )
    // ⛔ ***THE REASON ALONE DOES NOT CATCH THIS, AND THAT IS MEASURED.*** A
    // mutation making an unreadable middle hop mean "all ours" keeps
    // `ResidueRemains` and changes only the COUNTS in the message - it passed a
    // version of this arm that checked the reason. What must hold is that the
    // pod is counted as NOT ATTRIBUTABLE and the message says why.
    const m = msgs.join(' | ')
    assert(
      m.includes('unreadable'),
      `the message does not say the attribution failed, so a reader takes the counts at ` +
        `face value: ${m}`,
    )
    assert(
      m.includes('1 pod(s) this program does not declare'),
      `an unattributable pod was not counted as undeclared - the unsafe direction, ` +
        `because it reads as "your workload is still terminating" when nothing was ` +
        `checked: ${m}`,
    )
    assert(
      !m.includes('declared pod(s) are still terminating'),
      `the message claims pods are DECLARED after failing to read the ReplicaSets ` +
        `that would say so: ${m}`,
    )
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE CLUSTER PARK. Until 2026-09-05 every branch here parked on a bare
  // deadline, because a cluster subject could not be wake-indexed. Three
  // changes made a real condition possible; these arms are what stop it
  // regressing into a park that LOOKS subscribed.
  // ═══════════════════════════════════════════════════════════════════════

  // ⛔ ***THE ANNOTATION KEY IS SUBSCRIPTED, NOT BACKSLASH-ESCAPED, AND THIS IS
  // THE HIGHEST-VALUE ASSERTION IN THIS FILE.*** `fieldSegments` splits on `.`
  // and has NO escape, so `drain\.apsis/requested` walks to `drain\` then
  // `apsis/requested` and reads ABSENT - forever, silently. The park would never
  // fire and the program would look subscribed while polling. Measured both
  // ways against the host; see DRAIN_KEY's comment.
  assert(
    DRAIN_KEY.includes('["drain.apsis/requested"]'),
    `DRAIN_KEY must subscript a dotted key, or the read is silently absent: ${DRAIN_KEY}`,
  )
  assert(!DRAIN_KEY.includes('\\'), `DRAIN_KEY uses a backslash escape the host ignores: ${DRAIN_KEY}`)

  // ⭐ WAITING FOR A REQUEST: the condition names the NODE and the value that
  // starts a drain, so an annotation write wakes this program instead of its
  // backstop.
  {
    const { outcome } = drive(node({}), deployment(WL.scale, WL.scale))
    assert(outcome.o === 'quiesce', 'an idle drainer did not park')
    const r = String(outcome.resume)
    assert(r.includes(String(NODE)), `the park does not name the node: ${r}`)
    assert(r.includes('"true"'), `the park does not name the drain value: ${r}`)
    // ⭐ ***THE PARK IS STILL BOUNDED - BUT THIS GUARD HAD TO BE RE-AIMED, NOT
    // DELETED (2026-09-07).*** It asserted `Now() >=` in the park text, which was
    // right while the program disjoined its own `deadline(Date.now() + …)`. That
    // operand was DEAD - `drainer-backstop.ts` declares 45s and the host takes
    // the MINIMUM of declared and flag (`backstopFor`), so a 60s operand could
    // never fire first - and it is gone.
    //
    // The boundedness it was guarding is REAL and now lives somewhere else: the
    // declared section, plus the host rendering `|| Backstop()` onto every park.
    // So the assertion moved to the thing that actually provides it. A wake index
    // is an optimisation over a poll, never a replacement - an informer can miss
    // and a subscription can drop - which is why SOMETHING must still bound this.
    assert(declaredBackstop.ms > 0, `this program declares no park bound: ${declaredBackstop.ms}`)
    assert(!r.includes('Now() >='), `the park still carries a redundant time operand: ${r}`)
  }

  // ⭐ WAITING FOR A WITHDRAWAL: the condition must fire on DELETION, which is
  // how an operator actually clears it (`kubectl annotate node X key-`). A bare
  // `!=` is unknown against an absent field, so `.exists` must appear.
  {
    const { outcome } = drive(drained, empty, pods())
    assert(outcome.o === 'quiesce', 'a drained node did not park')
    const r = String(outcome.resume)
    assert(
      r.includes('.exists'),
      `the withdrawal park cannot fire on a DELETED annotation - an absent field ` +
        `compares UNKNOWN, so this waits out its backstop: ${r}`,
    )
    assert(r.includes(String(NODE)), `the withdrawal park does not name the node: ${r}`)
  }

  // ...and the two parks are DIFFERENT, or one of the arms above is passing on
  // a program that emits the same condition in every state.
  {
    const idle = String(
      (drive(node({}), deployment(WL.scale, WL.scale)).outcome as { resume: unknown }).resume,
    )
    const done = String((drive(drained, empty, pods()).outcome as { resume: unknown }).resume)
    assert(idle !== done, `the request park and the withdrawal park are identical: ${idle}`)
  }

  console.log('drainer.test.ts: runtime guards pass')
}

// ⭐ ***WIRED INTO `bun test`, BECAUSE UNTIL 2026-09-06 IT RAN NOWHERE.***
//
// `runtimeGuards` was exported and called only by a hand-typed `bun -e` line in
// the header comment. `bun test` collects files by their `test()` blocks and
// this file declared none, so bun loaded it, found nothing to run, and reported
// SUCCESS - `0 pass, 0 fail, Ran 0 tests across 5 files`, exit 0. An exit code
// that means "nothing ran" is indistinguishable from one that means "all
// passed" unless you read the count.
//
// The SDK had the identical defect and fixed it in 0f2f5ad3a; this is that fix,
// applied to the examples, which nobody had pointed it at.
test('runtime guards', runtimeGuards)
