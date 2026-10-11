// ═══════════════════════════════════════════════════════════════════════════
// THE REFERENCE PROGRAM. Every capability the SDK offers, used once, in a
// program that would be worth deploying rather than a parade of features.
//
// `sugar.ts` used to be this file and is now a museum piece: it predates
// collections, the quantifiers, `watch`, `where`, `carry`, `create`/`delete` and
// finalizers, so it demonstrates about a third of the surface. It still
// typechecks, which is exactly why nobody noticed.
//
// ───────────────────────────────────────────────────────────────────────────
// WHAT THIS PROGRAM IS
//
// A WARDEN for one tier of workloads. It keeps every DECLARED member of the
// tier at its desired scale, refuses to act while its own node is unhealthy,
// names the pods that are in the way, escalates when drift persists, and
// removes what it created when it is deleted.
//
// ───────────────────────────────────────────────────────────────────────────
// ⭐ THE ONE ASYMMETRY THIS PROGRAM EXISTS TO TEACH: IT CAN SEE MORE THAN IT
// CAN TOUCH.
//
//	WATCH   the whole tier, as a SET, without naming a member -
//	        `anyFieldNe` over a collection. Added 2026-09-06 with min/max.
//	WRITE   only the members named in `spec.writes`, EXACTLY, one path each.
//
// That is not an oversight to be fixed. `spec.writes` matching an exact path is
// what lets admission prove no two Perseids claim the same object, so relaxing
// it would cost every other program its exclusivity guarantee. The consequence
// for an author is concrete and is the shape of this file: a warden REPAIRS a
// declared list and REPORTS on everything else.
//
// ───────────────────────────────────────────────────────────────────────────
// WHERE EACH PIECE IS DEFINED
//
//	path / objects            perseid.ts    paths are BUILT; `ApiPath` is
//	                                        branded, a typed string is not
//	                                        assignable
//	field / select            field.ts      a field path, including the
//	                                        `[?type=Ready]` selector
//	reconcile.*               perseid.ts    the WIT contract pre-applied
//	reader (.get / .need)     perseid.ts    read + three-valued unwrap + decode
//	                                        in one yield
//	where                     perseid.ts    concurrent reads bound to NAMES
//	match / when / matchValue match.ts      exhaustive three-valued dispatch
//	objectsIn / nameOf / …    collection.ts a collection read, structured
//	anyFieldNe / allFieldsAre perseid.ts    the QUANTIFIERS - a question about
//	                                        every member of a set
//	watch (.each / .held)     perseid.ts    declare several conditions, ask
//	                                        which HELD; the program branches
//	wakeCause                 perseid.ts    WHY this pass ran, coarsely - no
//	                                        index, so nothing to drift
//	ready/unready/unsure      perseid.ts    a condition, with the three-valued
//	                                        distinction kept in what is REPORTED
//	backstop                  perseid.ts    "and otherwise, eventually", folded
//	                                        away by anyOf so it costs no operand
//	remember / forget         perseid.ts    state across passes, explicit
//	defineFinalize            perseid.ts    what to do when this is deleted
//
// What it deliberately does NOT use is listed at the foot of the file, with
// reasons - an omission with no reason beside it reads as an oversight.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type EffectsOf,
  path,
  objects,
  reconcile,
  defineStep,
  defineFinalize,
  quiesce,
  yieldStep,
  anyOf,
  held,
  where,
  remember,
  forget,
  retry,
  cleanupDone,
  type Carry,
  carryOf,
  unready,
  unsure,
  reader,
  wakeCause,
  fieldNoLonger,
  anyFieldNe,
  objectGone,
  backstop,
} from '@apsis-io/perseid/perseid.js'
import { match, when } from '@apsis-io/perseid/match.js'
import {
  type K8sObject,
  objectsIn,
  asObject,
  nameOf,
  phaseOf,
  nodeNameOf,
} from '@apsis-io/perseid/collection.js'
import { field, select } from '@apsis-io/perseid/field.js'

// ---------------------------------------------------------------------------
// CAPABILITIES. Each one is a WIT interface this program's world must import,
// and each appears in `spec.capabilities`. There is no way to call a host
// function this list does not name - `defineEffect` is the only constructor and
// `reconcile` is it pre-applied.

const observe = reconcile.observe<string>()
const observeCluster = reconcile.observeCluster<string>()
const enumerate = reconcile.enumerate<string>()
const ensure = reconcile.ensure()
const create = reconcile.create()
const del = reconcile.delete()
const report = reconcile.status()
const carry = reconcile.carry()

/** The declared members, read and decoded in one yield. See the loop below. */
const read = reader(observe, parsed)

// ---------------------------------------------------------------------------
// THE SUBJECTS.

const NS = 'default'

/** The tier, as a LABEL. This is what makes the set askable without naming it. */
const TIER = 'app=warden-demo'

/**
 * The machine this warden runs beside.
 *
 * CLUSTER-SCOPED, so it needs `observe-cluster` for the verb AND an entry in
 * `spec.reads` naming this exact object - two separate authorities, and the
 * commonest admission surprise. `spec.reads` is not consulted for collections;
 * it exists for cluster-scoped objects, which have no namespace to bound them.
 */
const NODE_NAME = 'engix99-trail-1'
const NODE = path.nodes(NODE_NAME)

/**
 * The Node's `Ready` condition, selected BY TYPE.
 *
 * ***THERE IS NO SCALAR FORM OF THIS FACT.*** Readiness lives only as an element
 * of `status.conditions`, keyed by `type`, and `status.conditions[0]` is not an
 * alternative because condition ORDER IS NOT API. Requires `spec.language >= 3`.
 */
const READY_COND = field('status', 'conditions', select('type', 'Ready'), 'status')

/** Every Deployment in the namespace. The SELECTOR narrows it to the tier. */
const TIER_DEPLOYMENTS = path.ns(NS).collectionOf('apps', 'v1', 'deployments')

/** Pods, for naming what is in the way. `observe` already confers `pods:read`. */
const PODS = path.ns(NS).collection('pods')

/** The field the whole tier is judged on, and the one value it should hold. */
const READY_FIELD = 'status.readyReplicas'
const WANT = 2

// ═══════════════════════════════════════════════════════════════════════════
// THE CONDITIONS. Declared once, referenced twice - by the branches that act on
// them and by the park at the foot of the step. A `const` referenced twice is
// ONE expression, so there is no second spelling to drift; writing the
// expression itself twice is the thing this avoids.
// ═══════════════════════════════════════════════════════════════════════════

/** The machine went away under us. */
const NODE_LEFT_READY = fieldNoLonger(NODE, READY_COND, 'True')

/**
 * ⭐ THE QUANTIFIER. "Does ANY member of this set differ from WANT" - a question
 * the language could not ask before 2026-09-06, when `.min`/`.max` landed.
 * `.length` cannot see it: three members at 2,2,2 and at 2,2,3 have the same
 * count. Without this, watching N objects meant NAMING all N.
 */
const TIER_DRIFTED = anyFieldNe(TIER_DEPLOYMENTS, TIER, READY_FIELD, WANT)

/**
 * ***THE MEMBERS THIS WARDEN MAY WRITE, AND THE LIST IS SHORTER THAN THE TIER
 * ON PURPOSE.*** Each of these appears verbatim in `spec.writes`. A member of
 * the tier that is not here is watched and reported and never touched - see the
 * header. Keeping the two lists in step is the author's job; `spec.writes` is
 * what refuses at runtime if they diverge, naming the path it declined.
 */
const DECLARED = [
  path.ns(NS).deployments('warden-a'),
  path.ns(NS).deployments('warden-b'),
] as const

/** This program's own object, which it CREATES and therefore must DELETE. */
const STATE = objects.ns(NS).configMap('warden-state')

/** Somebody deleted this program's own stamp. */
const STAMP_GONE = objectGone(STATE.path)

// ⛔ There was a `const RECHECK_MS = 60_000` here, and it was DEAD. It existed
// for `deadline(Date.now() + RECHECK_MS)`; `backstop()` replaced that, and the
// host bounds every park regardless. It survived as an export and a comment -
// a knob that looked adjustable and adjusted nothing.

/** Consecutive drifting passes before the condition turns from Progressing to False. */
const ESCALATE_AFTER = 3

// ---------------------------------------------------------------------------
// READING. Ordinary TypeScript over the raw JSON the host handed back - the
// step is a pure function of its observations, so everything below is testable
// without a host.

/**
 * ***`K8sObject` IS `Record<string, unknown>`, SO EVERY HOP IS NARROWED.*** The
 * collection module returns raw items rather than a typed shape on purpose: a
 * cast would let a field that is not there read as `undefined` and compare
 * equal to something. `asObject` is the one narrowing, used at every hop.
 */
function parsed(raw: string): K8sObject | null {
  try {
    return asObject(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * `true` / `false` / `null`, and the third one is not a decoration: a Node with
 * no `Ready` condition yet is NOT an unready Node, and treating it as one
 * refuses to ward a machine that is merely young.
 */
function readyOfNode(raw: string): boolean | null {
  const status = asObject(parsed(raw)?.['status'])
  const conds = status?.['conditions']
  if (!Array.isArray(conds)) return null

  for (const item of conds) {
    const cond = asObject(item)
    if (cond?.['type'] === 'Ready') return cond['status'] === 'True'
  }

  return null
}

/** `status.readyReplicas`, absent-as-zero: a Deployment that has never scheduled has no field. */
function readyReplicasOf(o: K8sObject): number {
  const n = asObject(o['status'])?.['readyReplicas']

  return typeof n === 'number' ? n : 0
}

/**
 * The consecutive-drift streak, read out of the carry OBJECT.
 *
 * ***A NAMED KEY, NOT THE WHOLE CARRY.*** It used to be the entire carry, parsed
 * with `parseInt` - which meant this program could never remember a second thing
 * without inventing an encoding, and the SDK could never put anything beside it.
 * A key belongs to whoever named it.
 */
function streakOf(mem: Carry): number {
  const n = mem['streak']

  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

// ---------------------------------------------------------------------------
// THE STEP.

const step = defineStep(function* () {
  // ***THREE READS, CONCURRENT, BOUND TO NAMES.*** `group` returns a positional
  // tuple and a reader has to count; renaming a binding here is a compile error
  // and reordering one is a no-op. The arms cannot see each other - they are
  // dispatched together - so anything derived from one belongs below the yield.
  const { node, pods, carried } = yield* where({
    node: observeCluster(NODE),
    pods: enumerate(PODS),
    carried: carry(),
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. THE NODE GATE. Exhaustive, and the `unknown` arm is the one that matters.
  //
  // A failed read is NOT an unhealthy node. Concluding "unhealthy" from a blip
  // is the single most repeated defect in this codebase, which is why `Obs` is
  // three-valued and why `match` will not compile with an arm missing.
  // ═══════════════════════════════════════════════════════════════════════════
  const healthy = yield* match(node, 't', {
    // The node is not in this program's world - `spec.reads` does not name it,
    // or it is genuinely gone. Either way this warden has no business acting.
    absent: function* () {
      yield* report(unready('NodeAbsent', `${NODE_NAME} is not readable: check spec.reads`))

      return false
    },

    // Could not tell. Do nothing, come back next tick - a warden that scales on
    // a failed read is worse than one that is briefly late.
    //
    // ⛔ ***BUT IT MUST SAY SO, AND THIS BRANCH SAID NOTHING AT ALL.*** It
    // returned `false` and reported no condition, so a warden that could not
    // read its node left the LAST condition standing - `Ready=True` from the
    // pass before, indefinitely. An operator reading the object sees a healthy
    // warden; the truth is that it has been blind since then.
    //
    // `unsure` is `Ready=Unknown`, which is the honest third value: `False`
    // asserts the tier is not ready, and this pass established nothing of the
    // kind. Collapsing it into `unready` would be the same defect one layer up -
    // a failed read reported as a failed thing.
    unknown: function* () {
      yield* report(
        unsure('NodeUnreadable', `could not read ${NODE_NAME}; the tier was not judged this pass`),
      )

      return false
    },

    known: when(function* ({ v }: { v: string }) {
      const ready = readyOfNode(v)
      if (ready === true) return true

      yield* report(
        unready(
          ready === null ? 'NodeConditionMissing' : 'NodeNotReady',
          `${NODE_NAME} is ${ready === null ? 'missing its Ready condition' : 'not Ready'}`,
        ),
      )

      return false
    }),
  })

  // Parked on the node alone: nothing else this program does is meaningful
  // until the machine is back, and waking for tier drift we refuse to act on
  // would burn passes.
  //
  // ⛔ ***NO `forget` HERE, AND IT USED TO BE ONE.*** `forget` sets `carry: ''`,
  // which the host reads as CLEAR; omitting the call entirely leaves carry
  // ABSENT, which the host reads as KEEP (carry.go treats it as a pointer). This
  // path is reached when the node is unhealthy or UNREADABLE - a pass that
  // measured nothing about the tier - and it was erasing the drift streak.
  //
  // The consequence was silent and it failed in the reassuring direction: the
  // streak escalates at ESCALATE_AFTER, so with an intermittently unreadable
  // node it reset before it ever got there and `DriftPersists` could never
  // fire. A tier drifting for an hour would report `Repairing` the whole time.
  //
  // ⇒ A pass that learned nothing must not destroy what earlier passes learned.
  if (!healthy) {
    return quiesce(anyOf(fieldNoLonger(NODE, READY_COND, 'True'), backstop()))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. REPAIR WHAT IS DECLARED. One `ensure` per member, absolute not delta.
  //
  // A step re-derives from a fresh observation every tick, so two ticks before
  // one obligation lands would apply a delta twice; an absolute target is
  // idempotent under exactly that.
  // ═══════════════════════════════════════════════════════════════════════════
  let repaired = 0
  for (const at of DECLARED) {
    // ***`read.get`, NOT `observe` + PARSE BY HAND.*** It does the read and the
    // decode in one yield and keeps the answer three-valued; a body that will
    // not decode comes back `unknown`, which is what it is - we got an answer
    // and could not interpret it - rather than being conflated with absent.
    //
    // ⚠ NOT `read.need` here: absent means this member is not ours to create and
    // is not a drift, so the loop skips it. `need` would TERMINATE the whole
    // program over one missing member of a tier.
    const seen = yield* read.get(at)
    if (seen.t !== 'known' || readyReplicasOf(seen.v) === WANT) continue

    yield* ensure({ path: at, field: 'spec.replicas', value: WANT })
    repaired++
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. NAME WHAT IS IN THE WAY. A collection read, structured.
  //
  // This is reporting, not repair: `spec.writes` matches an exact path and a pod
  // discovered at runtime was never declared - and could not have been, since
  // its name carries a rollout-random suffix.
  // ═══════════════════════════════════════════════════════════════════════════
  const blocked: string[] = []
  if (pods.t === 'known') {
    // `objectsIn` answers `null` for a body that is not a JSON array - which is
    // NOT an empty collection, and collapsing the two would report "nothing is
    // in the way" on a malformed read.
    for (const item of objectsIn(pods.v) ?? []) {
      const p = asObject(item)
      if (p === null) continue

      const phase = phaseOf(p)
      if (phase === 'Running' || phase === 'Succeeded') continue
      blocked.push(`${nameOf(p) ?? '?'}=${phase ?? 'unknown'}@${nodeNameOf(p) ?? 'unscheduled'}`)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. THE STREAK, AND WHY IT IS CARRIED RATHER THAN GLOBAL.
  //
  // A pass runs on a FRESH instance: a module-level counter resets every tick
  // and reads as "no drift" forever. `carry` is the only state that survives,
  // and it is explicit in the outcome so a reader can see what persists.
  // ═══════════════════════════════════════════════════════════════════════════
  const drifting = repaired > 0 || blocked.length > 0
  const mem = carryOf(carried)
  const runs = drifting ? streakOf(mem) + 1 : 0

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. THE STAMP. `create` is re-declared EVERY pass, not once - a total step
  // has no memory, so it re-declares its conclusions and the applier treats
  // AlreadyExists as success. `ensure` with a body then sets several fields on
  // that one object in a single obligation - the merged form (engi, 2026-10-06:
  // "remove ensure-all, combine into ensure"); the torn-write incident the body
  // form exists for is recorded on EnsureBodyArgs in the SDK.
  //
  // ⚠ EVERY VALUE IS A STRING. A ConfigMap's `data` is `map[string]string`; a
  // number here is refused by the apiserver at apply, and no layer between here
  // and it knows the target's schema.
  //
  // ⚠ ***THE WASM HOST DOES NOT KNOW THE MERGED OP YET.*** This program is on
  // the wasm stack, whose host still dispatches `ensure-all` as its own WIT
  // function; a warden rebuilt against the merged SDK emits `ensure` with a
  // body, which THAT host must learn to lower before this rebuild deploys.
  // The kinetics engine (`internal/kinetics`) already runs this shape.
  // ═══════════════════════════════════════════════════════════════════════════
  yield* create({
    path: STATE.path,
    body: [
      { path: 'data.tier', value: TIER },
      { path: 'metadata.labels.managed-by', value: 'perseid' },
    ],
  })
  yield* ensure({
    path: STATE.path,
    body: {
      'data.repaired': String(repaired),
      'data.blocked': String(blocked.length),
      'data.streak': String(runs),
    },
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. REPORT. The message carries the counts, because the message is the part
  // an operator acts on - a condition's `reason` is a coarse projection and a
  // guard that checks only the reason cannot see a wrong count.
  // ═══════════════════════════════════════════════════════════════════════════
  // ***THE CAUSE IS CONTEXT IN THE MESSAGE, NEVER THE VERDICT.*** `status` and
  // `reason` come from what this pass MEASURED; `why` says what got us here. An
  // operator seeing a tier reported converged every 60s on `backstop` and never
  // on `resume` is looking at a program whose park is not firing - which is the
  // failure that otherwise shows up as nothing at all.
  const why = yield* wakeCause()
  yield* report({
    type: 'Ready',
    status: drifting ? 'False' : 'True',
    reason: !drifting ? 'TierConverged' : runs >= ESCALATE_AFTER ? 'DriftPersists' : 'Repairing',
    message:
      (drifting
        ? `${repaired} declared member(s) rescaled, ${blocked.length} pod(s) not running` +
          `${blocked.length > 0 ? ` (${blocked.join(', ')})` : ''}, ${runs} consecutive pass(es)`
        : `tier ${TIER} converged at ${WANT}`) + `; woke on ${why}`,
  })

  // A pass that changed something re-runs immediately rather than parking: the
  // obligations above have not been applied yet, so parking on a condition they
  // are about to satisfy is how a program sleeps through its own repair.
  if (drifting) return remember(yieldStep, { ...mem, streak: runs })

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. THE PARK, AND WHAT TO DO ABOUT WHATEVER WOKE US.
  //
  // ***THE CONDITIONS ARE DECLARED ONCE, NAMED, AND THE WORK IS BELOW THEM.***
  // A name is not a second spelling of the condition - `has()` is checked
  // against these keys, so a typo or a rename is a compile error, where two
  // hand-written copies of an expression drift in silence.
  //
  // ⚠ The host reports FLATTENED disjunction operands, and a condition
  // containing its own `||` (which `fieldNoLonger` and `anyFieldNe` both do)
  // contributes several. `has()` collapses that: either operand of a condition
  // means that condition held, once. `apsis aperture eval` prints the raw
  // operands if you need to see them.
  // ═══════════════════════════════════════════════════════════════════════════
  // ***ASK FIRST, THEN ACT - AND THE ORDER ON THE PAGE IS THE ORDER IN TIME.***
  // This was three `on(...)` arms, each pairing a condition with a handler. The
  // handler never ran when the condition fired - nothing exists to call it, the
  // instance is gone by then - it ran HERE, at the top of the next pass. Now it
  // is written where it runs, and the park is written LAST, where a pass decides
  // it.
  const woke = yield* held()

  if (woke.has(NODE_LEFT_READY)) {
    yield* report(unready('NodeNotReady', `${NODE_NAME} left Ready while the tier was converged`))
  }
  if (woke.has(TIER_DRIFTED)) {
    yield* report(unready('TierDrifted', `a member of ${TIER} left ${WANT}: rechecking`))
  }
  // ⛔ NOT A REPORT - A WRITE. This program recreates its own stamp, which is why
  // it is not a "name the cause" program however much the two branches above
  // look like one.
  if (woke.has(STAMP_GONE)) {
    yield* create({ path: STATE.path, body: [{ path: 'data.tier', value: TIER }] })
  }

  // ***`backstop()`, NOT `deadline(Date.now() + RECHECK_MS)`.*** The host renders
  // `(<the whole user resume>) || Backstop()` onto every park, so the old idiom
  // was redundant; it was also stale by construction, because `Date.now()` runs
  // while the step BUILDS the expression and the host evaluates it at WAKE time.
  // `anyOf` folds this operand away, so saying it costs no disjunct - hygiene
  // rather than correctness, since an operand no condition owns simply matches
  // nothing. (This said "an extra operand shifts every arm index after it" until
  // 2026-09-07, when indices went away.)
  return forget(quiesce(anyOf(NODE_LEFT_READY, TIER_DRIFTED, STAMP_GONE, backstop())))
})

// ---------------------------------------------------------------------------
// THE FINALIZER: what happens when this Perseid is DELETED.
//
// It runs on a fresh instance with no memory of the last attempt, bounded by the
// host's deadline, and it HOLDS THE OBJECT UNDELETABLE until it returns `done` -
// which is why `retry` demands a reason and an empty one is a compile error.

const finalize = defineFinalize(function* () {
  const seen = yield* observe(STATE.path)

  // ⚠ ***`unknown` IS A RETRY, NOT `done`, AND THIS IS THE BRANCH WHERE THE
  // SAFE-LOOKING CHOICE IS WRONG.*** Concluding "nothing to clean up" from a
  // failed read releases the object on the strength of an answer we did not get.
  if (seen.t === 'unknown') return retry('cannot read the state ConfigMap')

  // Already gone - nothing to remove, and retrying would hold the object for the
  // full deadline over a cleanup that had already happened.
  if (seen.t === 'absent') return cleanupDone

  // ***DELETE WHAT THIS PROGRAM CREATED.*** It exists only because the step made
  // it, so nothing else will remove it, and an object that outlives the program
  // owning it is the orphan this path exists to prevent. Re-declared on every
  // attempt; the applier treats NotFound as success.
  yield* del(STATE.path)

  // ⛔ IT DOES NOT SCALE THE TIER DOWN. Deleting a warden means "stop warding",
  // not "destroy the workloads" - a finalizer that tears down what it merely
  // supervised turns an operator's `kubectl delete perseid` into an outage.
  return retry('waiting for the state ConfigMap to disappear')
})

export type WardenEffects = EffectsOf<typeof step>
export { step, finalize, DECLARED, STATE, NODE, TIER, WANT, ESCALATE_AFTER }
export { readyOfNode, readyReplicasOf, streakOf }

// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS DELIBERATELY DOES NOT USE, AND WHY.
//
// An omission with no reason beside it reads as an oversight, and the next
// author "fixes" it.
//
//	group / race        POSITIONAL siblings of `where`. `group` returns a tuple
//	                    a reader has to count; `race` takes whichever sub-step
//	                    settles first and cannot cancel the losers, because
//	                    effects are declarations the host may already have acted
//	                    on. `where` is the one to reach for.
//	                    (`race` was `select` until 2026-09-06; the field-path
//	                    selector has that name now.)
//	read.need           the BAILING half of `reader`. The `.get` half is used
//	                    below. `need` short-circuits the whole step on an absent
//	                    or unreadable object, which is right for a program with
//	                    ONE subject and wrong here: a tier member that is missing
//	                    is not this warden's to create and must not terminate it.
//	defineEffect        the raw constructor. `reconcile` is it pre-applied to
//	                    every symbol in reconcile.wit; reach for this only when
//	                    the host grows an interface the SDK has not wrapped yet.
//	unsafeApiPath       the escape hatch that defeats the branding. If you need
//	                    it, the vocabulary is missing an entry.
//	podTemplate /       building a Pod or Deployment BODY. `podmaker.ts` is the
//	  objects….spec()   worked example; a warden supervises objects it did not
//	                    make, so putting it here would be a parade.
//	count               `observe.count(selector)`. Subsumed by `enumerate` plus
//	                    the quantifiers, which answer the same question and can
//	                    also name the members.
//	matchValue          the non-generator `match`, for reading an `Outcome`
//	                    outside a step. It belongs in HOST code - see
//	                    `warden-main.ts`.
//	allFieldsAre        the AND-shaped quantifier. It is `anyFieldNe`'s exact
//	                    complement and using both here would demonstrate nothing
//	                    the one above does not.
// ═══════════════════════════════════════════════════════════════════════════
