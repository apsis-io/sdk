// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { test } from 'bun:test'
import {
  type Handler,
  type Outcome,
  type Resume,
  runStep,
  known,
  unknown,
  fieldNoLonger,
} from '@apsis-io/perseid/perseid.js'
import {
  type Effs,
  sentinelStep,
  NODE,
  NODE_NAME,
  DEPLOYMENTS,
  READY_COND,
  readyOf,
  readyOf_node,
} from './sentinel.js'

/**
 * The `n`th operand of a condition, as the host reports it.
 *
 * ***THE HOST ANSWERS WITH OPERAND SOURCE TEXT.*** Each arm here is a
 * `fieldNoLonger`, which renders `(!exists) || (!= v)` - two operands, either of
 * which holding means that arm held. This says "the host reported THIS operand"
 * without the test having to know how many there are or where they sit.
 */
const operandOf = (c: Resume, n: number): string => {
  const out: string[] = []
  const walk = (x: Resume): void => {
    if (x.of.length > 0) x.of.forEach(walk)
    else out.push(x.render())
  }
  walk(c)
  const got = out[n]
  if (got === undefined) throw new Error(`operandOf: no operand ${n} (has ${out.length})`)

  return got
}

/** An operand of the arm watching a Deployment. */
const leaf = (at: (typeof DEPLOYMENTS)[number]['at'], n: number): string =>
  operandOf(fieldNoLonger(at, 'status.readyReplicas', DEPLOYMENTS.find((d) => d.at === at)!.want), n)

/** An operand of the arm watching the node. */
const nodeLeaf = (n: number): string => operandOf(fieldNoLonger(NODE, READY_COND, 'True'), n)

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

/**
 * Drive one pass with the host reporting `held`, and RECORD WHICH OBJECTS WERE
 * READ. The read log is the point: this program's whole claim is that dispatch
 * lets it read one subject instead of three.
 */
function drive(held: string[], healthy = true): { outcome: Outcome; read: string[]; msg: string } {
  const read: string[] = []
  let msg = ''
  const handler: Handler<Effs> = {
    // One `get` for both reads - `observe.get` and `observeCluster.get` share the
    // op, exactly as the production wiring must discriminate on the path.
    get: (q: unknown) => {
      const p = String(q)
      read.push(p)
      if (p === String(NODE)) return nodeJSON(healthy ? 'True' : 'False')
      // ⚠ ***DERIVED FROM `DEPLOYMENTS`, NOT A HARDCODED CHAIN.*** It was an
      // if-chain over two entries; adding a third subject left that one
      // unmatched, so the fake answered `unknown` and the FALLBACK reported it
      // unreadable while a dispatched pass never touched it - which surfaced as
      // "the verdict differs with and without dispatch". The harness's
      // population has to track the program's, or the test measures the harness.
      const d = DEPLOYMENTS.find((x) => String(x.at) === p)
      if (d !== undefined) return deployJSON(healthy ? d.want : 0)

      return unknown
    },
    held: () => held,
    status: (c: { message?: string }) => {
      msg = c.message ?? ''
    },
  } as unknown as Handler<Effs>
  const outcome = runStep(sentinelStep, handler)

  return { outcome, read, msg }
}

export function runtimeGuards(): void {
  // ═══════════════════════════════════════════════════════════════════════
  // THE PARSERS. Three-valued, and the third value is not "unhealthy".
  // ═══════════════════════════════════════════════════════════════════════
  assert(readyOf_node(JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'True' }] } })) === true,
    'a Ready node was not read as ready')
  assert(readyOf_node(JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'False' }] } })) === false,
    'a NotReady node was not read as not-ready')
  // ⛔ `Unknown` AND ABSENT ARE `null`, NOT `false`. Collapsing either into
  // NotReady makes this program announce a machine is down because a read was
  // half-written - the exact defect the drainer's own parse shipped for one
  // commit until a test caught it.
  assert(readyOf_node(JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } })) === null,
    '`Unknown` was not read as null')
  assert(readyOf_node('{}') === null, 'a Node with no status was not read as unknown readiness')
  // ***AND IT MUST NOT TAKE THE FIRST CONDITION.*** Order is not API; the park
  // selects by `[?type=Ready]` and this walk must agree.
  assert(
    readyOf_node(
      JSON.stringify({
        status: { conditions: [{ type: 'DiskPressure', status: 'False' }, { type: 'Ready', status: 'True' }] },
      }),
    ) === true,
    'readiness was read positionally - a Ready condition that is not first was missed',
  )
  assert(readyOf(JSON.stringify({ status: {} })) === 0, 'an omitted readyReplicas is not zero')
  assert(readyOf('nonsense') === null, 'unparseable status was not read as null')

  // ═══════════════════════════════════════════════════════════════════════
  // ⭐ THE DISPATCH SAVES READS - THE CLAIM THIS PROGRAM EXISTS TO MAKE.
  // ═══════════════════════════════════════════════════════════════════════
  // ⭐ ***THE HOST NAMES THE OPERAND, SO A TEST NAMES IT TOO.*** These were HOST
  // INDICES, and the comment here had to explain that every arm is two operands
  // wide - `fieldNoLonger` emits `(!exists) || (!= v)` - so the node owned 0..1,
  // dag-a 2..3, and so on. The test had already caught one silent change of
  // meaning: it asserted `drive([1])` reads dag-a, true only while the arms were
  // single-operand `fieldNe`.
  //
  // An operand identifies itself now. There is no width to know and no ordering
  // to preserve, and this file no longer encodes either.
  const one = drive([leaf(DEPLOYMENTS[0].at, 1)])
  assert(one.read.length === 1, `a dispatched pass read ${one.read.length} objects, want 1: ${one.read.join(', ')}`)
  assert(one.read[0] === String(DEPLOYMENTS[0].at), `the dag-a operand read ${one.read[0]}, not ${DEPLOYMENTS[0].name}`)

  // ***EITHER OPERAND OF ONE ARM REACHES THE SAME HANDLER*** - and both halves
  // can hold at one wake, which must still run it ONCE.
  assert(drive([leaf(DEPLOYMENTS[0].at, 0)]).read[0] === String(DEPLOYMENTS[0].at),
    "an arm's OTHER operand must reach the same handler")
  assert(drive([leaf(DEPLOYMENTS[0].at, 0), leaf(DEPLOYMENTS[0].at, 1)]).read.length === 1,
    'both operands of one arm must run its handler ONCE')

  const nodeArm = drive([nodeLeaf(0)])
  assert(nodeArm.read.length === 1 && nodeArm.read[0] === String(NODE),
    `the node operand must read the node alone, read: ${nodeArm.read.join(', ')}`)
  assert(drive([leaf(DEPLOYMENTS[2].at, 1)]).read[0] === String(DEPLOYMENTS[2].at),
    'the LAST arm must be reachable - the case that ran the wrong handler live')

  // Two DIFFERENT arms holding run both handlers - a `switch` would drop one.
  const two = drive([nodeLeaf(0), leaf(DEPLOYMENTS[1].at, 0)])
  assert(two.read.length === 2, `two held arms read ${two.read.length} objects, want 2`)

  // ═══════════════════════════════════════════════════════════════════════
  // ⛔ AND THE FALLBACK IS THE CORRECTNESS. `held` is empty on a backstop tick
  // and on any host that does not serve `woke`, so the step must reach the same
  // verdict having dispatched nothing - by reading everything.
  // ═══════════════════════════════════════════════════════════════════════
  const none = drive([])
  assert(none.read.length === 1 + DEPLOYMENTS.length,
    `an undispatched pass read ${none.read.length} objects, want ${1 + DEPLOYMENTS.length} - the fallback is what makes the hint optional`)

  // ***THE VERDICT MUST NOT DEPEND ON THE HINT.*** Same world, dispatched and
  // not: both must call it healthy. If these ever disagree, `on()` has stopped
  // being an optimisation and become part of the answer.
  // ***THE MODE IS STRIPPED, BECAUSE THE MODE IS SUPPOSED TO DIFFER.*** What must
  // NOT differ is the finding. Comparing whole messages was right until the
  // status began publishing how the pass decided; keeping it would have asserted
  // the opposite of the design.
  const verdict = (m: string) => m.replace(/\s*\(via [^)]*\)/, '')
  const all = drive([nodeLeaf(0), leaf(DEPLOYMENTS[0].at, 0), leaf(DEPLOYMENTS[1].at, 0), leaf(DEPLOYMENTS[2].at, 0)])
  assert(verdict(none.msg) === verdict(all.msg),
    `the verdict differs with and without dispatch:\n  none: ${none.msg}\n  all:  ${all.msg}`)

  // And an unhealthy world is reported as such, or every assertion above is
  // satisfied by a program that always says "healthy".
  // The dispatch mode is PUBLISHED, so the mechanism is visible live rather than
  // inferred - a dispatched pass and a fallback pass otherwise look identical.
  const dispatched = drive([leaf(DEPLOYMENTS[0].at, 1)])
  assert(dispatched.msg.includes('via 1 of 4'), `a dispatched pass did not publish its read count: ${dispatched.msg}`)
  assert(none.msg.includes('via 4 of 4, no dispatch'), `the fallback did not publish itself: ${none.msg}`)

  const bad = drive([], false)
  assert(bad.msg.includes(NODE_NAME) && bad.msg.includes(DEPLOYMENTS[0].name),
    `an unhealthy world did not name its subjects: ${bad.msg}`)
}

test('runtime guards', runtimeGuards)
