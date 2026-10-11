// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// A NODE DRAINER: CORDON A MACHINE, THEN MOVE WHAT IS DECLARED OFF IT.
//
// ***THE FIRST PROGRAM THAT WRITES A CLUSTER-SCOPED OBJECT.*** `spec.replicas`
// on a Deployment is bounded by the grant's namespace; `spec.unschedulable` on a
// Node is bounded by nothing but `spec.writes`, because a Node has no namespace
// to compare. Those are materially different authorities and this is the program
// that shows the second one working.
//
// # WHAT A DEPLOYMENT CANNOT BE, IN ONE SENTENCE
//
// Nothing in the built-in controller set makes a WORKLOAD's scale conditional on
// a MACHINE's state. A Deployment does not know nodes exist; a DaemonSet knows
// only "one per node"; `kubectl drain` is a CLIENT holding a loop open, and if
// the laptop running it closes, the drain stops half-done with the node cordoned
// and the workloads still on it. This is that loop as a level-triggered program
// that survives its own restart.
//
// ⛔ # WHAT THIS DELIBERATELY IS NOT, AND WHY IT CANNOT BE
//
// ***IT DOES NOT EVICT ARBITRARY PODS. THE REASON IS THE WRITE BOUNDARY, NOT
// THE READ SURFACE - AND THIS FILE SAID THE OPPOSITE FOR SIX HOURS.***
//
// What it said, written 2026-09-05 while building this: *"a step cannot
// enumerate a set, so a program can learn that eleven pods are on a node and
// never the name of one, and `delete(path)` needs a name."* That was true when
// written and `03450311c` falsified it the same evening - `observe.get` on a
// COLLECTION path now returns the objects, names and all. The step below
// enumerates.
//
// ***AND IT STILL CANNOT EVICT, FOR A REASON THAT WAS ALWAYS THE REAL ONE.***
// `SpecWrites.Permits` matches a canonical object path EXACTLY, so a program may
// only write what its manifest NAMED. A pod discovered at runtime was not in the
// manifest - and cannot have been, since a pod's name carries a rollout-random
// suffix. Reading a set and writing one are separate authorities and only the
// first arrived.
//
// ***THAT BOUND IS LOAD-BEARING RATHER THAN MISSING***, which is why the fix is
// not to relax it: admission's `WriteConflicts` proves no two Perseids claim the
// same object, and it reasons about OBJECTS. A prefix, a selector or a
// "every pod in this namespace" declaration would make two programs writing one
// pod stop LOOKING like a conflict, and the outage that check exists to reject
// becomes undetectable. The boundary that stops this program is the one that
// makes every other program safe.
//
// ***SO THE UNIT OF DRAINING IS A DECLARED WORKLOAD, NOT A DISCOVERED POD*** -
// which is also the honest boundary: `spec.writes` names what this program may
// move, so an operator reading the manifest sees exactly which workloads a drain
// will disturb. A pod-evicting drainer's blast radius is whatever happens to be
// scheduled there.
//
// ⭐ ***WHAT ENUMERATION DID BUY IS VERIFICATION, AND IT IS NOT A CONSOLATION
// PRIZE.*** Until it landed, `Ready=True/Drained` was a claim about the declared
// workloads that an operator would read as "the machine is empty", and this
// program had no way to tell the difference. Now it checks: the drain completes
// when no movable pod remains on the node, and when one does, the condition
// NAMES it. A drainer that reports what it cannot move is more useful than one
// that silently defines the problem as solved - and `count` could not do this,
// because a pod's node is not a label and `count` takes a label selector.
//
// ⚠ ***AND THE FIRST LIVE RUN FOUND SOMETHING NOBODY WAS LOOKING FOR: THIS
// PROGRAM IS STANDING ON THE MACHINE IT DRAINS.*** Measured 2026-09-05 on
// `engix99-trail-2`, drainer:v3, the residue read back:
//
//	magic-echo-quic-64f76746f4-wr9l2 (ReplicaSet/magic-echo-quic-64f76746f4)
//	perseid-drainer-demo             (Perseid/drainer-demo)      <- ITSELF
//	api-7459df5cc5-frs4q             (ReplicaSet/api-7459df5cc5)
//
// So a drain of this node that ever COMPLETED would have to evict the drainer
// mid-drain, and the program would come back on another machine to find its own
// work half done. That is not a defect introduced here - it was true of every
// earlier version too - it is simply the first time the program could SEE it,
// which is the argument for the whole change: `Ready=True/Drained` was
// previously reported by a program sitting in its own blast radius, with no way
// to notice. A production drainer belongs on a control-plane node or is a
// DaemonSet that skips its own; this one is a demo and stays where it is,
// recorded rather than quietly fixed.
//
// ***THE PURE HALF.*** No `perseid:reconcile/*` imports; the wiring is in
// `drainer-main.ts`.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type EffectsOf,
  path,
  reconcile,
  defineStep,
  yieldStep,
  quiesce,
  anyOf,
  fieldNe,
  fieldIs,
  fieldNoLonger,
  objectGone,
  backstop,
} from '@apsis-io/perseid/perseid.js'
import {
  type K8sObject,
  objectsIn,
  asObject,
  nameOf,
  phaseOf,
  controllerOf,
  onNode,
  childrenOf,
} from '@apsis-io/perseid/collection.js'
import { field, select } from '@apsis-io/perseid/field.js'

const observe = reconcile.observe<string>()
const observeCluster = reconcile.observeCluster<string>()
const enumerate = reconcile.enumerate<string>()
const ensure = reconcile.ensure()
const report = reconcile.status()

/**
 * The machine this program drains.
 *
 * ***THE BARE NAME IS THE SOURCE AND THE PATH IS DERIVED***, because the two
 * must agree and a step compares them: `spec.nodeName` on a pod is a bare name,
 * `spec.writes` names a path. Written as two literals they would drift, and the
 * failure is silent - every pod's node compares unequal, the node reads as
 * empty, and the drain reports success over a full machine.
 */
const NODE_NAME = 'engix99-trail-2'
const NODE = path.nodes(NODE_NAME)

/** The namespace this program is granted. `path.ns` confines every read below. */
const NS = 'default'

/**
 * The pods this program can see, as a COLLECTION rather than an object.
 *
 * ***THE GRANT IS ALREADY THERE: `perseid:reconcile/observe@0.1.0` CONFERS
 * `pods:read`***, and a collection read is bounded by that same capability plus
 * the grant's namespace. So this needed no manifest change - not a shortcut,
 * it is the same authority `count` was already using on the same objects.
 *
 * ⚠ ***AND IT IS THE GRANT'S NAMESPACE, WHICH IS WHY `Drained` STAYS A BOUNDED
 * CLAIM.*** Pods in `kube-system` are on this node too and this program cannot
 * see one of them. Enumeration made the claim CHECKABLE, not universal, and the
 * condition message below says which it is.
 */
const PODS = path.ns(NS).collection('pods')

/**
 * The ReplicaSets, which are the MIDDLE HOP between a declared workload and a
 * pod on the node.
 *
 * ***A POD'S CONTROLLER IS NEVER THE DEPLOYMENT.*** `spec.writes` names
 * Deployments; `metadata.ownerReferences` on a pod names a ReplicaSet, which in
 * turn names the Deployment. So deciding whether a residual pod belongs to a
 * workload this program declared takes two hops, and without the middle one the
 * question cannot be asked at all.
 *
 * `observe` already confers `replicasets:read` alongside `pods:read`, so this
 * needed no manifest change either.
 */
const REPLICASETS = path.ns(NS).collectionOf('apps', 'v1', 'replicasets')

/**
 * The workloads that must not run on it, and their scale when they may.
 *
 * ***DECLARED, NOT DISCOVERED - AND NOT BECAUSE DISCOVERY IS IMPOSSIBLE.*** The
 * step below discovers pods perfectly well; it may not WRITE one it discovered,
 * because `spec.writes` matches an exact object path and a runtime name was
 * never in it. See the header. So this program moves what its manifest names,
 * `spec.writes` must list every path here plus the node itself, and admission's
 * `WriteConflicts` then guarantees no other program claims them.
 */
const WORKLOADS = [{ at: path.ns(NS).deployments('drain-demo'), scale: 2 }] as const

/**
 * The annotation an operator sets to ask for a drain.
 *
 * ***AN ANNOTATION AND NOT A TAINT, FOR ONE REASON: A TAINT IS A LIST.*** Adding
 * one means read-modify-write of `spec.taints`, and `ensure` writes a FIELD to a
 * value - it has no append. Two programs appending to one list through a
 * merge patch is also how a taint gets lost. An annotation is a scalar at a
 * stable key, which is what this vocabulary can express correctly.
 */
// ⛔ ***THE BRACKET FORM, AND THE BACKSLASH FORM THAT WAS HERE UNTIL 2026-09-05
// IS SILENTLY WRONG.*** `fieldSegments` splits on `.` and has NO escape - a
// backslash is an ordinary character - so `drain\.apsis/requested` walks to the
// segments `drain\` and `apsis/requested` and reads ABSENT. A literal key with
// dots or slashes is subscripted: `labels["a.b/c"]`. Measured both arms:
//
//	metadata.annotations.drain\.apsis/requested    -> absent
//	metadata.annotations["drain.apsis/requested"]  -> known "true"
//
// ***IT NEVER FAILED BECAUSE IT WAS NEVER USED*** - declared, exported, and read
// by nothing until the park below. Had it been used as written, the condition
// would have been unknown forever and the park would never have fired: a
// program that looks subscribed and only ever wakes on its backstop.
const DRAIN_KEY = field('metadata', 'annotations', 'drain.apsis/requested')

/**
 * The Node's `Ready` condition, selected BY TYPE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⭐ ***THERE IS NO SCALAR FORM OF THIS FACT, WHICH IS WHY THE SELECTOR EXISTS.***
 * Every other thing this program parks on is a plain field - an annotation, a
 * boolean. Node readiness lives only as an element of `status.conditions`, keyed
 * by `type`, so without `[?type=Ready]` a park cannot name it at all: the program
 * would have to wake, read the whole Node, and walk the list in the guest, which
 * is a pass per poll instead of a wake per change.
 *
 * ⛔ ***AND THE INDEX FORM IS NOT AN ALTERNATIVE.*** `status.conditions[0]` is
 * not a stable address - condition order is not API, so a program written that
 * way reads a DIFFERENT condition on a different day and is wrong silently.
 * `field()`/`select()` refuse to build one.
 *
 * Requires `spec.language: 3`; a radiant that speaks 2 refuses this program at
 * admission rather than admitting it and reading Absent forever.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const READY_COND = field('status', 'conditions', select('type', 'Ready'), 'status')

// ⛔ There was a `const RECHECK_MS = 60_000` here and it was DEAD once the
// `deadline(Date.now() + RECHECK_MS)` operands became `backstop()`. The bound
// this program actually runs under is the one it DECLARES - see its
// `-backstop.ts` - and the host takes the MINIMUM of that and its own flag
// (`internal/perseidrun/assemble.go`, `backstopFor`), so the declared value was
// already tighter and the operand could never fire first.
//
// A knob that looks adjustable and adjusts nothing is worse than no knob.

/**
 * The park for a state whose only trigger is the NODE changing, when this
 * program cannot READ the node and so has no condition to state.
 *
 * ***A BARE DEADLINE HERE IS CORRECT RATHER THAN A FALLBACK.*** These are the
 * branches where the read came back unknown, absent or unparseable: the program
 * has no idea what the node says, so there is no field condition it could write
 * that would not be a guess. The backstop is the honest answer.
 */
const clusterRecheck = () => backstop()

/**
 * Park until somebody ASKS for a drain.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⭐ ***THIS WAS A BARE DEADLINE UNTIL 2026-09-05, AND THE COMMENT EXPLAINING WHY
 * WAS CORRECT WHEN WRITTEN.*** It said a cluster-scoped subject cannot be
 * wake-indexed - `NormalizeSubject` refuses any subject whose namespace differs
 * from the grant's, and a Node has none - so a field condition here would
 * contribute no subject, LOOK subscribed, and wake only on the backstop. That
 * was true, and writing one anyway would have been worse than the deadline.
 *
 * Three changes landed that evening and it took all three: the wake index grew a
 * cluster arm bounded by `spec.reads` (`Host.Watches`), radiant grew a node
 * informer to feed it, and `Get` learned to READ a cluster path so the condition
 * can evaluate at all. Any two without the third leaves exactly the "looks
 * subscribed" state the old comment warned about - the index alone shipped first
 * and was inert for an hour.
 *
 * ⚠ ***THE DEADLINE IS STILL HERE AND IS NOT REDUNDANT.*** A wake index is an
 * optimisation over a poll, never a replacement: an informer can miss, a
 * subscription can be dropped on reconnect, and `spec.reads` could stop naming
 * this node. `anyOf` keeps the backstop as the floor, so the worst case is the
 * behaviour this program had yesterday.
 *
 * ***MEASURED LIVE, drainer:v4 ON `engix99-trail-2`, 2026-09-05*** - and read
 * off radiant's own log rather than inferred from timing, because a fast poll
 * and a real wake look identical from outside:
 *
 *	annotation SET      128ms   "condition became true (via the wake index)"
 *	annotation DELETED  125ms   same, on this park's sibling below
 *	the same program before     "backstop elapsed (via poll, NOT the index)"
 *
 * Both log lines are in one window, which is the before/after pair.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const untilDrainRequested = () =>
  anyOf(
    fieldIs(NODE, DRAIN_KEY, 'true'),
    // ⭐ ***THE SECOND ARM, AND IT IS A WAKE THIS PROGRAM COULD NOT PREVIOUSLY
    // EXPRESS.*** Node readiness has no scalar field, so before the selector this
    // park had no way to name it and the program learned a node had gone
    // NotReady only when its 60s backstop next elapsed - reported, correctly and
    // uselessly, as `backstop`.
    //
    // ***`fieldNoLonger` FOR THE SAME REASON THE WITHDRAWAL PARK USES IT***: a
    // Node that loses its Ready condition entirely (a fresh object, a
    // partially-written status) makes `Get(...)` ABSENT, and an absent operand
    // propagates as unknown - so a bare `!= "True"` would be UNKNOWN rather than
    // true and would not fire on the case it exists for. `!exists || !=` covers
    // the deletion and `"False"`/`"Unknown"` alike.
    fieldNoLonger(NODE, READY_COND, 'True'),
    backstop(),
  )

/**
 * Park until the drain request is WITHDRAWN, or until a named blocker is gone.
 *
 * ⛔ ***`fieldNoLonger` AND NOT A BARE INEQUALITY, BECAUSE WITHDRAWAL IS A
 * DELETION.*** An operator clears this with `kubectl annotate node X key-`, which
 * REMOVES the field. An absent operand propagates as unknown, so
 * `Get(...) != "true"` would be UNKNOWN rather than true and the park would not
 * fire on the one event it exists to catch - the program would sit cordoned
 * until its backstop. `fieldNoLonger` emits `!exists || !=`, which covers both
 * the deletion and a change to some other value.
 *
 * ⛔ ***`blockers` IS THE OTHER HALF, AND OMITTING IT MADE THE PROGRAM IGNORE THE
 * REMEDY IT HAD JUST ASKED FOR.*** The blocked branches publish a condition
 * naming pods an operator must clear, and used to park on the annotation alone -
 * so doing exactly what the condition said produced no wake until the backstop
 * expired, and the operator's own fix was reported back to them as still-blocked.
 *
 * ***THE NAMES ARE NOT KNOWN AT AUTHORING TIME AND DO NOT NEED TO BE.*** The
 * blockers are enumerated during the pass and the condition is built from what
 * that pass read - `follower.ts`'s shape. `countNe` cannot express this: a
 * LabelSelector is `key=value` and foreign pods carry labels this program has
 * never seen.
 *
 * A blocker whose name could not be read is dropped rather than turned into a
 * path - see {@link UNREADABLE}. The backstop still covers it.
 */
const untilDrainWithdrawn = (blockers: readonly string[] = []) =>
  anyOf(
    fieldNoLonger(NODE, DRAIN_KEY, 'true'),
    ...blockers.filter((n) => n !== UNREADABLE).map((n) => objectGone(path.ns(NS).pods(n))),
    backstop(),
  )

type Node = { unschedulable: boolean; drainWanted: boolean; ready: boolean | null }

/**
 * Read the two facts this program acts on out of a Node.
 *
 * ⚠ ***AN ABSENT `spec.unschedulable` IS `false`, AND AN ABSENT ANNOTATION IS
 * "NOT REQUESTED" - BUT AN UNPARSEABLE OBJECT IS NEITHER.*** Kubernetes omits
 * `unschedulable` on a schedulable node rather than writing `false`, so absence
 * is a real answer here. A body that does not parse is not, and returns null so
 * the caller can hold rather than act on a guess.
 */
export const nodeOf = (raw: string): Node | null => {
  try {
    const o = JSON.parse(raw) as {
      spec?: { unschedulable?: unknown }
      metadata?: { annotations?: Record<string, unknown> }
      status?: { conditions?: { type?: unknown; status?: unknown }[] }
    }
    if (typeof o !== 'object' || o === null) return null
    const ann = o.metadata?.annotations ?? {}

    // ***THE GUEST WALKS THE SAME LIST THE PARK SELECTS, AND THE TWO MUST AGREE
    // ON WHAT `Ready` MEANS.*** The park uses `[?type=Ready].status`, so this
    // matches on `type` and reads `status` - not the first element, and not a
    // truthiness test on the condition object.
    //
    // ⚠ THREE-VALUED ON PURPOSE, MIRRORING THE HOST. Kubernetes writes `"True"`,
    // `"False"` or `"Unknown"`, and a Node with no Ready condition at all is a
    // fourth case. Only `"True"` is ready; `null` covers the rest, because
    // "not ready" and "cannot tell" must not collapse - a drain that treats
    // unknown as NotReady would report a machine down on a read failure.
    // ⛔ ***EXPLICIT ON ALL THREE STRINGS, NOT `=== 'True'`.*** The first version
    // of this line read `status === 'True'`, which is two-valued: `"Unknown"`
    // fell through to `false` and collapsed "cannot tell" into "not ready" -
    // the precise thing the comment above forbids, in the code the comment is
    // attached to. The test caught it; the comment did not, because a comment
    // cannot.
    const cond = (o.status?.conditions ?? []).find((c) => c?.type === 'Ready')
    const readyStatus = cond?.status === 'True' || cond?.status === 'False' ? cond.status : null

    return {
      unschedulable: o.spec?.unschedulable === true,
      // ***EXACTLY THE STRING `"true"`.*** An annotation value is always a
      // string, so `"false"`, `""` and a typo all mean NOT REQUESTED - the safe
      // direction for a flag whose true value drains a machine.
      drainWanted: ann['drain.apsis/requested'] === 'true',
      ready: readyStatus === null ? null : readyStatus === 'True',
    }
  } catch {
    return null
  }
}

/** A workload's desired and current scale. */
type Workload = { spec: number; ready: number }

export const workloadOf = (raw: string): Workload | null => {
  try {
    const o = JSON.parse(raw) as {
      spec?: { replicas?: unknown }
      status?: { readyReplicas?: unknown }
    }
    if (typeof o.spec?.replicas !== 'number') return null

    return {
      spec: o.spec.replicas,
      ready: o.status?.readyReplicas === undefined ? 0 : Number(o.status.readyReplicas),
    }
  } catch {
    return null
  }
}

/**
 * What is still on the node: the pods a drain would have to move, plus counts of
 * the two kinds it correctly would not.
 */
export type Residue = {
  /**
   * Pods a drain must account for. EMPTY means the node is drained.
   *
   * Each carries its CONTROLLING owner where it has one, because that is what
   * an operator acts on: a stray pod's name is a dead end, and `ReplicaSet/web`
   * is the thing to go and scale.
   */
  movable: { name: string; controlledBy: string | null }[]
  /** Pods pinned to this machine by a DaemonSet. Not movable, not a failure. */
  daemonSet: number
  /** Pods that have finished. They hold no capacity and block nothing. */
  terminal: number
}

/**
 * Read the residue out of a collection read.
 *
 * ⚠ ***THE TWO SKIPS ARE WHAT KEEPS `Drained` REACHABLE, AND LEAVING THEM OUT
 * WOULD HAVE MADE THIS AN ABSORBING STATE.*** Every node runs DaemonSet pods -
 * CNI, node-exporter, the log shipper - and they are placed BECAUSE the machine
 * exists, so they never leave while it does. A drain that waited for zero pods
 * would wait forever on a correctly drained node and report `Draining` for the
 * life of the cluster. `kubectl drain` skips them for the same reason and refuses
 * to run without `--ignore-daemonsets` rather than hanging. Terminal pods are the
 * milder case: `Succeeded`/`Failed` hold no capacity and are only awaiting GC.
 *
 * ⛔ ***AN ITEM THIS CANNOT READ COUNTS AS RESIDUE, WHICH IS THE UNSAFE-LOOKING
 * DIRECTION AND THE CORRECT ONE.*** The two errors are not symmetric: counting a
 * phantom pod delays a drain and someone investigates; dropping a real one
 * reports an occupied machine as empty, and an operator powers it off. So a
 * malformed entry is named `<unreadable>` and keeps the drain open.
 *
 * Returns null only when the ARRAY itself does not parse - that is a host or
 * wire fault rather than a fact about the node, and the caller reports it as
 * such rather than deciding.
 */
/**
 * The name given to a residual pod whose own name could not be read.
 *
 * ⛔ ***A CONST BECAUSE TWO SITES MUST AGREE, NOT FOR TIDINESS.*** It is written
 * here and FILTERED OUT in `untilDrainWithdrawn` - `pods/<unreadable>` is a path
 * naming nothing, so parking on it is a condition that can never hold. If the two
 * spellings ever diverged the park would grow a dead arm and nothing would fail:
 * the backstop still covers the pod, so the defect is a slow drain nobody sees.
 */
const UNREADABLE = '<unreadable>'

export const residueOn = (raw: string, nodeName: string): Residue | null => {
  const items = objectsIn(raw)
  if (items === null) return null

  const out: Residue = { movable: [], daemonSet: 0, terminal: 0 }

  // ***AN UNREADABLE ITEM IS COUNTED WITHOUT KNOWING ITS NODE, WHICH IS ON
  // PURPOSE.*** It cannot be filtered by `spec.nodeName` - that is what
  // unreadable means - so it is either counted everywhere or nowhere, and
  // nowhere is the direction that reports an occupied machine as empty.
  const objects: K8sObject[] = []
  for (const item of items) {
    const o = asObject(item)
    if (o === null) {
      out.movable.push({ name: UNREADABLE, controlledBy: null })
      continue
    }
    objects.push(o)
  }

  // ***THE NODE FILTER IS THE ENTIRE QUERY***, and the one a label selector
  // cannot express - which is why it is `onNode` from the SDK rather than
  // `observe.count`.
  for (const o of onNode(objects, nodeName)) {
    const phase = phaseOf(o)
    if (phase === 'Succeeded' || phase === 'Failed') {
      out.terminal += 1
      continue
    }

    const owner = controllerOf(o)
    if (owner?.kind === 'DaemonSet') {
      out.daemonSet += 1
      continue
    }

    out.movable.push({
      name: nameOf(o) ?? UNREADABLE,
      controlledBy: owner === null ? null : `${owner.kind}/${owner.name}`,
    })
  }

  return out
}

/**
 * The names of the ReplicaSets a declared workload controls.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ ***THIS EXISTS BECAUSE `ResidueRemains` WAS SAYING SOMETHING FALSE.***
 *
 * The drain path reaches the residue check once every declared workload reports
 * `status.readyReplicas == 0`. Readiness drops at the START of termination, not
 * at its end - so a pod of a DECLARED Deployment is routinely still on the node,
 * still `Running`, still counted as residue at that moment. The message called
 * every one of those "pod(s) this program does not declare", which is exactly
 * backwards: it declared the workload, it scaled it to zero, and it is watching
 * its own pods go away.
 *
 * The difference matters to the reader it is written for. "Still draining" is a
 * wait; "this program has no authority over these" is an escalation, and the
 * second sends an operator looking for a program that does not exist.
 *
 * ***THE TRAVERSAL IS THE REMEDY AND IT IS TWO HOPS***, Deployment ->
 * ReplicaSet -> Pod, because a pod's controller is never the Deployment. Both
 * hops are `childrenOf` over a collection this program already reads.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const replicaSetsOfDeclared = (
  replicaSets: readonly K8sObject[],
  deployments: readonly string[],
): Set<string> => {
  const out = new Set<string>()
  for (const dep of deployments) {
    for (const rs of childrenOf(replicaSets, { kind: 'Deployment', name: dep })) {
      const n = nameOf(rs)
      if (n !== null) out.add(n)
    }
  }

  return out
}

/**
 * Is this residual pod descended from a declared workload?
 *
 * ***MATCHES ON THE CONTROLLING REFERENCE ONLY***, which `residueOn` already
 * rendered as `Kind/name`. A pod with no controller, or one controlled by
 * something other than a ReplicaSet, is not a declared workload's - a bare pod
 * an operator created by hand is precisely the case this must NOT absorb.
 */
const RS_PREFIX = 'ReplicaSet/'
export const fromDeclared = (controlledBy: string | null, declaredRS: Set<string>): boolean =>
  controlledBy !== null &&
  controlledBy.startsWith(RS_PREFIX) &&
  declaredRS.has(controlledBy.slice(RS_PREFIX.length))

/** How many residue names a condition message carries before it summarises. */
const NAMES_SHOWN = 5

/**
 * The residue as an operator wants to read it.
 *
 * Bounded on purpose: a namespace can hold hundreds of pods and a condition
 * message is read in a terminal. The COUNT is always exact; the names are a
 * sample, and the text says so rather than letting a truncated list read as the
 * whole set.
 */
export const describeResidue = (r: Residue): string => {
  const shown = r.movable
    .slice(0, NAMES_SHOWN)
    .map((p) => (p.controlledBy === null ? p.name : `${p.name} (${p.controlledBy})`))
    .join(', ')
  const rest = r.movable.length - Math.min(NAMES_SHOWN, r.movable.length)

  return rest === 0 ? shown : `${shown} and ${rest} more`
}

const step = defineStep(function* () {
  // ***THE CLUSTER READ, WHICH IS A DIFFERENT GRANT FROM THE WORKLOAD READS
  // BELOW.*** `observe-cluster` confers the verb and `spec.reads` names this
  // exact node; a program cannot reach a second machine by constructing a path.
  const seen = yield* observeCluster(NODE)
  if (seen.t === 'unknown') {
    // ⛔ ***A SILENT `yieldStep` HERE WAS A DEFECT, AND IT COST AN HOUR OF
    // DIAGNOSIS ON THE FIRST LIVE DEPLOY.*** Every other branch reports; this
    // one returned without a word, so a drainer whose cluster read was not
    // being served was INDISTINGUISHABLE from a drainer with nothing to do -
    // 93 passes, `Running`, zero conditions, zero obligations, and no way to
    // tell from the object which of the two it was.
    //
    // `unknown` is the host saying "I could not tell", which for a cluster read
    // means a wiring fault on the host side (no route for the kind, no reader,
    // an apiserver error) - never a fact about the node. So it is worth saying
    // out loud even though the program can do nothing about it: the condition
    // is the only channel that reaches an operator.
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: 'NodeUnobservable',
      message:
        `the host could not tell whether ${NODE} exists (observe-cluster returned unknown); ` +
        'this is a host-side read fault, not a state of the node',
    })

    return quiesce(clusterRecheck())
  }
  if (seen.t === 'absent') {
    // ***A MISSING NODE IS NOT A DRAINED ONE.*** Reporting success here would
    // say "everything is off that machine" about a machine this program cannot
    // see - which is also what an ungranted read looks like, since an
    // out-of-grant path reports absent by design.
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: 'NodeUnreadable',
      message: `${NODE} is absent - it does not exist, or spec.reads does not name it`,
    })

    return quiesce(backstop())
  }

  const node = nodeOf(seen.v)
  if (node === null) {
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: 'NodeUnreadable',
      message: `${NODE} could not be parsed; no drain decision was made this pass`,
    })

    return quiesce(backstop())
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE UNCORDON PATH. Level-triggered: withdrawing the annotation reverses
  // everything, in the opposite order to the drain.
  // ═══════════════════════════════════════════════════════════════════════
  if (!node.drainWanted) {
    // ***SCALE BACK BEFORE UNCORDONING, WHICH IS THE ORDER THAT CANNOT STRAND
    // A POD.*** Uncordoning first would let the scheduler place pods on the
    // node while this program still intends them elsewhere; nothing breaks,
    // but the node briefly holds pods the drain had just moved. The reverse
    // order has no such window.
    for (const w of WORKLOADS) {
      const have = yield* observe(w.at)
      if (have.t !== 'known') continue
      const parsed = workloadOf(have.v)
      if (parsed === null) continue
      if (parsed.spec !== w.scale) {
        yield* ensure({ path: w.at, field: 'spec.replicas', value: w.scale })

        return yieldStep
      }
    }
    if (node.unschedulable) {
      // ⭐ THE CLUSTER-SCOPED WRITE. Same `ensure` symbol as the scale above;
      // the PATH is what makes it a different authority.
      yield* ensure({ path: NODE, field: 'spec.unschedulable', value: false })

      return yieldStep
    }

    // ⚠ ***REPORTING READINESS SEPARATELY FROM SCHEDULABILITY, BECAUSE THEY ARE
    // DIFFERENT FACTS AND THIS PROGRAM USED TO ASSERT ONLY ONE.*** A NotReady
    // node is still schedulable-by-spec, so the old message - true as written -
    // read as "all well" about a machine that might be down. Now the program can
    // see readiness, so staying silent about it would be a choice rather than a
    // limitation.
    //
    // `Ready=True` still means SCHEDULABLE AND AT FULL SCALE - this program's own
    // job, which it has done - and node health is named in the message rather
    // than folded into the status. Folding it in would make an unreachable node
    // look like a drainer that had failed.
    const health =
      node.ready === true
        ? 'the node is Ready'
        : node.ready === false
          ? '⚠ THE NODE IS NOT READY'
          : '⚠ the node reports no Ready condition'

    yield* report({
      type: 'Ready',
      status: 'True',
      reason: 'NodeSchedulable',
      message: `${NODE} is schedulable and its declared workloads are at full scale; ${health}`,
    })

    // Nothing to do until somebody asks. This is the branch the program sits in
    // almost all the time, so it is the one whose latency an operator notices -
    // and since 2026-09-06 it also wakes on the node ceasing to be Ready, which
    // needed the field-path selector to express.
    return quiesce(untilDrainRequested())
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE DRAIN PATH.
  // ═══════════════════════════════════════════════════════════════════════

  // ⭐ CORDON FIRST, AND THE ORDER IS THE WHOLE CORRECTNESS ARGUMENT. Scaling a
  // workload down on an uncordoned node lets the scheduler put its replacement
  // straight back, so a drain that scaled first could run forever without
  // converging - the machine never empties and nothing looks broken.

  if (!node.unschedulable) {
    yield* ensure({ path: NODE, field: 'spec.unschedulable', value: true })

    return yieldStep
  }

  // ***ONE WORKLOAD PER PASS, RE-DERIVED.*** A loop that emitted every
  // obligation at once would be correct too - obligations are declarative - but
  // acting on the FIRST unsatisfied edge and parking is what makes each pass a
  // total function of the world, and what lets an operator watch a drain
  // progress one workload at a time.
  for (const w of WORKLOADS) {
    const have = yield* observe(w.at)
    if (have.t === 'unknown') return yieldStep
    if (have.t === 'absent') continue
    const parsed = workloadOf(have.v)
    if (parsed === null) continue

    if (parsed.spec !== 0) {
      yield* ensure({ path: w.at, field: 'spec.replicas', value: 0 })

      return yieldStep
    }
    if (parsed.ready !== 0) {
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'Draining',
        message: `${w.at} is scaled to zero and ${parsed.ready} replica(s) are still serving`,
      })

      return quiesce(
        anyOf(fieldNe(w.at, 'status.readyReplicas', parsed.ready), backstop()),
      )
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE VERIFICATION. Every DECLARED workload is now at zero and serving
  // nothing. That used to be where this program stopped, reporting `Drained`
  // and appending a disclaimer that it could not see anything else.
  //
  // ⭐ ***IT CAN NOW, SO THE DISCLAIMER IS REPLACED BY A CHECK.*** Anything
  // still on the machine at this point is by definition UNDECLARED - the
  // declared half is handled above - so this is the branch that tells an
  // operator the drain is blocked on something this program may not touch.
  // Reporting it is the entire remedy available: `spec.writes` is an exact
  // match, so a discovered pod cannot be written. See the header.
  // ═══════════════════════════════════════════════════════════════════════
  const pods = yield* enumerate(PODS)
  if (pods.t !== 'known') {
    // ⛔ ***AN UNVERIFIABLE NODE IS NOT A DRAINED ONE.*** Falling through to
    // `Ready=True` here would restore the exact defect this block removes, and
    // do it in the branch nobody tests. The two causes are separated because
    // they need different fixes: `absent` is this program's grant (no
    // `pods:read`, or the collection is in another namespace), `unknown` is the
    // host (no lister, an apiserver error, or more than the read cap allows).
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: pods.t === 'absent' ? 'ResidueUnreadable' : 'ResidueUnknown',
      message:
        pods.t === 'absent'
          ? `${PODS} reads absent, so this program cannot check what remains on ` +
            `${NODE_NAME}; its capabilities must confer pods:read in ${NS}`
          : `the host could not list ${PODS}, so the drain of ${NODE_NAME} is ` +
            'unverified this pass; the declared workloads ARE at zero',
    })

    return quiesce(untilDrainWithdrawn())
  }

  const residue = residueOn(pods.v, NODE_NAME)
  if (residue === null) {
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: 'ResidueUnreadable',
      message: `${PODS} did not parse as a list of objects; the drain is unverified this pass`,
    })

    return quiesce(untilDrainWithdrawn())
  }

  if (residue.movable.length > 0) {
    // ***THE SECOND HOP, READ ONLY WHEN THERE IS SOMETHING TO CLASSIFY.*** A
    // drained node takes neither this read nor the branch below.
    const sets = yield* enumerate(REPLICASETS)
    const rsItems = sets.t === 'known' ? objectsIn(sets.v) : null
    const declaredRS =
      rsItems === null
        ? null
        : replicaSetsOfDeclared(
            rsItems.map(asObject).filter((o): o is K8sObject => o !== null),
            WORKLOADS.map((w) => String(w.at).split('/').pop() ?? ''),
          )

    // ⚠ ***UNREADABLE REPLICASETS MEANS THE QUESTION CANNOT BE ASKED, AND THE
    // ANSWER IS NOT "THEY ARE ALL FOREIGN".*** Treating an unreadable middle hop
    // as "descended from nothing" would restore the false escalation this whole
    // block exists to remove, in the branch nobody tests. An empty set is the
    // honest degradation only if the message says the classification failed.
    const mine = declaredRS === null ? [] : residue.movable.filter((p) => fromDeclared(p.controlledBy, declaredRS))
    const foreign =
      declaredRS === null ? residue.movable : residue.movable.filter((p) => !fromDeclared(p.controlledBy, declaredRS))

    if (foreign.length === 0 && declaredRS !== null) {
      // ***STILL DRAINING, NOT BLOCKED.*** Every pod left belongs to a workload
      // this program declared and scaled to zero; they are terminating. This is
      // a wait with a known end, so it reads as one.
      yield* report({
        type: 'Ready',
        status: 'False',
        reason: 'Draining',
        message:
          `${NODE_NAME} is cordoned and every declared workload is at zero; ` +
          `${mine.length} of their pod(s) are still terminating on it: ` +
          `${describeResidue({ ...residue, movable: mine })}`,
      })

      // ***PARK ON `mine`, WHICH IS THE ONLY NON-EMPTY SET IN THIS BRANCH.***
      // The guard above is `foreign.length === 0`, so parking on `foreign` here
      // maps over an empty array and adds NOTHING - a fix that reads correctly,
      // type-checks, and leaves the defect exactly where it was.
      //
      // These pods are terminating on their own, so this is a wait with a known
      // end rather than a remedy; watching them still turns a 45s backstop into
      // a wake at the moment the node actually empties.
      return quiesce(untilDrainWithdrawn(mine.map((p) => p.name)))
    }

    // ***BLOCKED, NOT DRAINING.*** This program has done everything it may and
    // the machine is still occupied by pods no manifest gave it authority over.
    // Only an operator can clear it, so the condition names what to look at
    // rather than implying a wait.
    yield* report({
      type: 'Ready',
      status: 'False',
      reason: 'ResidueRemains',
      message:
        `${NODE_NAME} is cordoned and every declared workload is at zero, but ` +
        `${foreign.length} pod(s) this program does not declare remain on it: ` +
        `${describeResidue({ ...residue, movable: foreign })}. It has no authority to ` +
        'move them - spec.writes names objects exactly and these were discovered, ' +
        `not declared${mine.length > 0 ? `; a further ${mine.length} declared pod(s) are still terminating` : ''}` +
        `${declaredRS === null ? ` (${REPLICASETS} was unreadable, so none could be attributed to a declared workload)` : ''}`,
    })

    // ⛔ ***THE BRANCH THIS MATTERS MOST IN.*** The message directly above says
    // an operator must clear these pods; parking on the annotation alone told
    // that operator to act and then slept through them acting. `mine` is
    // included because this branch is also reached with declared pods still
    // terminating alongside the foreign ones, and either emptying is progress.
    return quiesce(untilDrainWithdrawn([...foreign, ...mine].map((p) => p.name)))
  }

  // ⚠ ***STILL A BOUNDED CLAIM, AND THE BOUND IS THE NAMESPACE RATHER THAN THE
  // DECLARATION.*** This is checked where it used to be assumed, which is the
  // upgrade; it is not "the machine is empty". Pods in namespaces this program
  // cannot read are invisible to it and the message says so, because an
  // operator about to power a node off is exactly the reader who must not
  // round this up.
  yield* report({
    type: 'Ready',
    status: 'True',
    // ⛔ ***THE REASON IS WHAT TRAVELS.*** This read `Drained`, and the message
    // below correctly says "in ${NS}" and "Namespaces other than ${NS} are not
    // visible to this program" - but automation watches `reason`, and a node
    // teardown keyed on `Drained` would evacuate a machine still running
    // kube-system or monitoring workloads this program cannot see.
    //
    // A reason travels and a message gets truncated; the bound belongs in both.
    reason: 'DrainedInNamespace',
    message:
      `${NODE_NAME} is cordoned, all ${WORKLOADS.length} declared workload(s) are at zero, ` +
      `and no movable pod remains on it in ${NS} ` +
      `(${residue.daemonSet} DaemonSet and ${residue.terminal} finished pod(s) ignored). ` +
      `Namespaces other than ${NS} are not visible to this program`,
  })

  return quiesce(untilDrainWithdrawn())
})

export type Effs = EffectsOf<typeof step>
export {
  step as drainerStep,
  NODE,
  NODE_NAME,
  NS,
  PODS,
  REPLICASETS,
  WORKLOADS,
  DRAIN_KEY,
}
