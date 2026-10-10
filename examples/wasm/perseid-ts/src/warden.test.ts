// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// The reference program, DRIVEN. A step is a pure function of its observations,
// so every branch below runs with no host, no cluster and no wasm.
//
// ***THE WRITE LOG IS THE ASSERTION, NOT THE OUTCOME.*** An outcome says what
// the program decided; the obligations say what it would DO, and the branch this
// file exists to protect - a failed read must not scale anything - is invisible
// in the outcome and loud in the log.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'bun:test'
import { type Handler, type Outcome, runStep, known, absent, unknown } from '@apsis-io/perseid/perseid.js'
import {
  type WardenEffects,
  step,
  DECLARED,
  STATE,
  NODE,
  WANT,
  readyOfNode,
  readyReplicasOf,
  streakOf,
} from './warden.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const nodeJSON = (status: string | null) =>
  known(
    JSON.stringify({
      status: {
        conditions:
          status === null
            ? [{ type: 'MemoryPressure', status: 'False' }]
            : [{ type: 'MemoryPressure', status: 'False' }, { type: 'Ready', status }],
      },
    }),
  )

const deployJSON = (ready: number) => known(JSON.stringify({ status: { readyReplicas: ready } }))

const podsJSON = (...pods: { name: string; phase: string; node?: string }[]) =>
  known(
    JSON.stringify(
      pods.map((p) => ({
        metadata: { name: p.name },
        spec: { nodeName: p.node ?? 'engix99-trail-1' },
        status: { phase: p.phase },
      })),
    ),
  )

type World = {
  /** `null` = the node read answers `unknown`; a string = that Ready status. */
  node: string | null | 'unknown' | 'absent'
  /** ready replicas per declared member, in DECLARED order. */
  members: number[]
  pods: { name: string; phase: string; node?: string }[]
  /** The raw carry the host hands back - JSON of the carry OBJECT. */
  carried: string
  held: number[]
}

type Run = {
  outcome: Outcome
  reads: string[]
  writes: string[]
  condition: { status?: string; reason?: string; message?: string }
}

/**
 * One pass against a world you describe.
 *
 * ⚠ ***THE FAKE'S POPULATION IS DERIVED FROM `DECLARED`, NOT HARDCODED.*** A
 * hardcoded if-chain leaves a newly added member unmatched, the fake answers
 * `unknown`, and the test then measures the harness rather than the program.
 */
function drive(w: Partial<World> = {}): Run {
  const world: World = {
    node: 'True',
    members: DECLARED.map(() => WANT),
    pods: [],
    carried: '',
    held: [],
    ...w,
  }

  const reads: string[] = []
  const writes: string[] = []
  const condition: Run['condition'] = {}

  const handler = {
    // ***ONE `get` FOR THREE READS.*** `observe`, `observe-cluster` and
    // `enumerate` all lower to `observe.get`; the production wiring
    // discriminates on the PATH, so the fake must too.
    get: (q: unknown) => {
      const p = String(q)
      reads.push(p)

      if (p === String(NODE)) {
        if (world.node === 'unknown') return unknown
        if (world.node === 'absent') return absent

        return nodeJSON(world.node)
      }
      if (p === String(STATE.path)) return known(JSON.stringify({ data: {} }))
      if (p.endsWith('/pods')) return podsJSON(...world.pods)

      const i = DECLARED.findIndex((d) => String(d) === p)
      if (i >= 0) return deployJSON(world.members[i] ?? 0)

      return unknown
    },
    carry: () => world.carried,
    held: () => world.held,
    // See simple.test.ts: a fixture may derive this, the SDK may not.
    cause: () => (world.held.length > 0 ? 'condition' : 'backstop'),
    ensure: (a: { path: unknown; field: unknown; value: unknown }) => {
      writes.push(`ensure ${String(a.path)} ${String(a.field)}=${String(a.value)}`)
    },
    'ensure-all': (a: { path: unknown; fields: readonly { path: string; value: unknown }[] }) => {
      writes.push(
        `ensure-all ${String(a.path)} ${a.fields.map((f) => `${f.path}=${String(f.value)}`).join(',')}`,
      )
    },
    create: (a: { path: unknown }) => {
      writes.push(`create ${String(a.path)}`)
    },
    delete: (p: unknown) => {
      writes.push(`delete ${String(p)}`)
    },
    status: (c: { status?: string; reason?: string; message?: string }) => {
      condition.status = c.status
      condition.reason = c.reason
      condition.message = c.message
    },
  } as unknown as Handler<WardenEffects>

  return { outcome: runStep(step, handler), reads, writes, condition }
}

export function runtimeGuards(): void {
  // ═══════════════════════════════════════════════════════════════════════
  // THE PARSERS. Three-valued, and the third value is NOT "unhealthy".
  // ═══════════════════════════════════════════════════════════════════════
  assert(readyOfNode(JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'True' }] } })) === true,
    'a Ready node did not read as ready')
  assert(readyOfNode(JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'False' }] } })) === false,
    'a NotReady node did not read as not-ready')
  // ⛔ A node with no Ready condition is `null`, never `false`. Collapsing them
  // makes the warden refuse to act on a machine that is merely young.
  assert(readyOfNode(JSON.stringify({ status: { conditions: [] } })) === null,
    'a node with no Ready condition read as a definite answer')
  assert(readyOfNode('not json') === null, 'unparseable JSON read as a definite answer')

  assert(readyReplicasOf({ status: { readyReplicas: 3 } }) === 3, 'readyReplicas was not read')
  // A Deployment that has never scheduled carries no field at all.
  assert(readyReplicasOf({ status: {} }) === 0, 'an absent readyReplicas was not zero')
  assert(readyReplicasOf({}) === 0, 'an absent status was not zero')

  // ***A KEY IN THE CARRY OBJECT, NOT THE WHOLE CARRY.*** Every not-a-number
  // shape is a zero streak rather than a throw: the carry survives a version of
  // this program that no longer exists, and a step that dies on its own memory
  // can never write the value that would replace it.
  assert(streakOf({}) === 0, 'an empty carry was not a zero streak')
  assert(streakOf({ streak: 3 }) === 3, 'a carried streak was not read')
  assert(streakOf({ streak: 'banana' }) === 0, 'a corrupt streak was not zero')
  assert(streakOf({ other: 9 }) === 0, 'an unrelated key was read as the streak')

  // ⭐ AND THE POINT OF THE OBJECT: a program key and an SDK key coexist.
  assert(streakOf({ streak: 2, $on: ['a', 'b'] }) === 2,
    'a reserved SDK key disturbed the program\'s own value')

  // ═══════════════════════════════════════════════════════════════════════
  // ⛔ THE BRANCH THIS FILE EXISTS FOR: A FAILED READ IS NOT AN UNHEALTHY NODE.
  //
  // `unknown` must produce NO writes whatsoever. Not a scale, not a stamp, not
  // even the ConfigMap - the program has no idea what the world looks like.
  // ═══════════════════════════════════════════════════════════════════════
  const blind = drive({ node: 'unknown', members: [0, 0] })
  assert(blind.writes.length === 0,
    `an unreadable node produced writes: ${blind.writes.join(' | ')}`)
  assert(blind.outcome.o === 'quiesce', 'an unreadable node did not park')

  // ⛔ ***AND IT MUST SAY SO. THIS BRANCH REPORTED NOTHING AT ALL.*** It returned
  // early with no condition, so a warden that could not read its node left the
  // PREVIOUS condition standing - `Ready=True` from the pass before, for as long
  // as the blindness lasted. An operator reading the object saw a healthy warden.
  assert(blind.condition.reason === 'NodeUnreadable',
    `an unreadable node reported ${String(blind.condition.reason)} - it used to report ` +
      'nothing, leaving the last condition to stand while the program was blind')

  // ⚠ ***`Unknown`, NOT `False`.*** False asserts the tier is not ready; this
  // pass established nothing of the kind. Reporting a failed READ as a failed
  // THING is the three-valued defect arriving in what an operator is told - and
  // it would page someone about a tier that may be perfectly healthy.
  assert(blind.condition.status === 'Unknown',
    `an unreadable node reported status ${String(blind.condition.status)}, not Unknown`)

  // ⛔⛔ ***AND IT MUST NOT ERASE THE STREAK, WHICH IT DID.*** The host reads
  // `carry` as a POINTER: ABSENT keeps the previous value, `""` CLEARS it. This
  // path used to `forget(...)`, i.e. send `""`, on a pass that measured nothing
  // about the tier.
  //
  // The failure was silent and in the reassuring direction: the drift streak
  // escalates at ESCALATE_AFTER, so an intermittently unreadable node reset it
  // before it ever got there and `DriftPersists` could never fire. A tier
  // drifting for an hour would report `Repairing` the whole time.
  //
  // `'carry' in outcome` is the assertion, not its VALUE - absent and `""` are
  // different messages to the host and the same falsy thing in JavaScript.
  const blindWithHistory = drive({ node: 'unknown', members: [0, 0], carried: JSON.stringify({ streak: 2 }) })
  assert(!('carry' in blindWithHistory.outcome),
    'a pass that could not read the node sent a carry - if it is "" the host CLEARS the ' +
      'streak, so escalation can never be reached when reads are flaky')

  // An ABSENT node is a different fact and says so - `spec.reads` is the usual
  // cause, and a message naming it is the difference between a five-minute fix
  // and an afternoon.
  const gone = drive({ node: 'absent' })
  assert(gone.writes.length === 0, 'an absent node produced writes')
  assert(gone.condition.reason === 'NodeAbsent',
    `an absent node reported ${String(gone.condition.reason)}, not NodeAbsent`)
  assert((gone.condition.message ?? '').includes('spec.reads'),
    'the absent-node message does not name spec.reads, which is the usual cause')

  // A node that is genuinely NotReady: still no writes, and a distinct reason.
  const down = drive({ node: 'False', members: [0, 0] })
  assert(down.writes.length === 0, 'a NotReady node produced writes')
  assert(down.condition.reason === 'NodeNotReady',
    `a NotReady node reported ${String(down.condition.reason)}`)

  // ═══════════════════════════════════════════════════════════════════════
  // REPAIR. A drifted DECLARED member is scaled, and the pass yields rather
  // than parking - the obligation has not been applied yet, so parking on a
  // condition it is about to satisfy is how a program sleeps through its own
  // repair.
  // ═══════════════════════════════════════════════════════════════════════
  const drift = drive({ members: [0, WANT] })
  assert(drift.writes.some((w) => w === `ensure ${String(DECLARED[0])} spec.replicas=${WANT}`),
    `the drifted member was not rescaled: ${drift.writes.join(' | ')}`)
  assert(!drift.writes.some((w) => w.startsWith(`ensure ${String(DECLARED[1])} spec.replicas`)),
    'the CONVERGED member was rescaled too - the repair is not conditional')
  assert(drift.outcome.o === 'yield', `a repairing pass parked instead of yielding: ${drift.outcome.o}`)
  assert(drift.condition.status === 'False' && drift.condition.reason === 'Repairing',
    `a repairing pass reported ${String(drift.condition.reason)}`)

  // ═══════════════════════════════════════════════════════════════════════
  // THE STREAK. Carried across passes, and it ESCALATES the reason without
  // changing what the program does - an operator reads the reason, the program
  // keeps repairing.
  // ═══════════════════════════════════════════════════════════════════════
  const persisting = drive({ members: [0, WANT], carried: JSON.stringify({ streak: 3 }) })
  assert(persisting.condition.reason === 'DriftPersists',
    `a 4th consecutive drifting pass reported ${String(persisting.condition.reason)}`)
  assert((persisting.condition.message ?? '').includes('4 consecutive'),
    `the streak is not in the message: ${String(persisting.condition.message)}`)
  // ⭐ The COUNT is in the message, not only the reason. A guard reading only the
  // reason cannot see a wrong count, and the message is what an operator acts on.
  assert((drift.condition.message ?? '').includes('1 declared member'),
    `the repair count is not in the message: ${String(drift.condition.message)}`)

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCKED PODS. Reported, never touched - `spec.writes` matches an exact
  // path and a pod name carries a rollout-random suffix, so it could not have
  // been declared.
  // ═══════════════════════════════════════════════════════════════════════
  const stuck = drive({ pods: [{ name: 'warden-a-abc123', phase: 'Pending' }] })
  assert((stuck.condition.message ?? '').includes('warden-a-abc123'),
    `the blocking pod was not named: ${String(stuck.condition.message)}`)
  assert(!stuck.writes.some((w) => w.includes('warden-a-abc123')),
    'the program wrote to a pod it merely observed')
  // A Running pod is not in the way, and must not turn the tier red.
  const fine = drive({ pods: [{ name: 'warden-a-abc123', phase: 'Running' }] })
  assert(fine.condition.status === 'True',
    `a Running pod was counted as blocking: ${String(fine.condition.message)}`)

  // ═══════════════════════════════════════════════════════════════════════
  // CONVERGED. The stamp is re-declared every pass, and the program parks.
  // ═══════════════════════════════════════════════════════════════════════
  const calm = drive()
  assert(calm.outcome.o === 'quiesce', `a converged pass did not park: ${calm.outcome.o}`)
  assert(calm.condition.status === 'True' && calm.condition.reason === 'TierConverged',
    `a converged pass reported ${String(calm.condition.reason)}`)
  assert(calm.writes.some((w) => w === `create ${String(STATE.path)}`),
    'the stamp was not re-declared on a converged pass')
  assert(calm.writes.some((w) => w.startsWith('ensure-all ') && w.includes('data.streak=0')),
    `ensure-all did not carry the reset streak: ${calm.writes.join(' | ')}`)
  assert(!calm.writes.some((w) => w.startsWith('ensure ') && w.includes('spec.replicas')),
    'a converged tier was rescaled anyway')

  // ***THE PARK NAMES ALL THREE SUBJECTS.*** If an arm stops contributing to
  // the resume the program sleeps through that subject, and nothing else here
  // would notice.
  assert(calm.outcome.o === 'quiesce', 'unreachable')
  const resume = String((calm.outcome as { resume: unknown }).resume)
  assert(resume.includes(String(NODE)), 'the park does not mention the node')
  assert(resume.includes('deployments'), 'the park does not mention the tier collection')
  assert(resume.includes(String(STATE.path)), 'the park does not mention the state object')
  // The quantifier, specifically: `.min`/`.max` is what lets this watch the tier
  // without naming a member, and a park that lost it would still look healthy.
  assert(resume.includes('.min') && resume.includes('.max'),
    `the park lost the quantifier - the tier is being watched by name: ${resume}`)
}

test('warden.test.ts: runtime guards pass', () => {
  runtimeGuards()
})
