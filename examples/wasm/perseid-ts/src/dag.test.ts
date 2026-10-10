// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// ***EVERY ARM OF THE DAG PARKS ON SOMETHING THAT IS CURRENTLY FALSE.***
//
// `quiesce` sleeps until the resume becomes TRUE, and the host evaluates it
// BEFORE the first tick - deliberately, so a condition already satisfied costs
// no interval (driver.go: "the shortest correct wait is zero"). So a park on a
// condition already true is not a slow program or a wrong answer: it is an
// immediate wake, a re-run, and another identical park. The program spins at the
// pass rate and NOTHING ERRORS.
//
// ⚠ ***THE ABSENT ARM SHIPPED WRONG AND THIS IS WHY THE FILE EXISTS.*** It
// parked on `objectGone(stage.path)` when the stage was ABSENT - `!exists` on an
// object that does not exist, true immediately. Caught by reading the cluster
// before deploying: `worker` did not exist, so that arm was the FIRST one that
// would have run.
//
// ***A TEST PER ARM WOULD NOT HAVE CAUGHT IT; A TEST OF THE INVARIANT DOES.***
// Asserting "the absent arm returns objectGone(...)" restates the code and
// passes for the bug. What is wrong is a RELATION between the park and the state
// that produced it - the resume must be FALSE under the observation it was
// formed in - and that is checkable without knowing which builder is right.
//
// No `bun:test`: this file is in tsconfig's include, and the project types are
// node-only. expr.test.ts and perseid.test.ts use the same shape for the same
// reason - plain throws behind one exported entry.
//
//	bun -e 'import {runtimeGuards} from "./src/dag.test.ts"; runtimeGuards()'
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'bun:test'
import { dagStep, workloadOf, STAGES, type Effs } from './dag.js'
import {
  type Handler,
  type Outcome,
  type Obs,
  known,
  absent,
  unknown,
  runStep,
} from '@apsis-io/perseid/perseid.js'

/** A workload as the apiserver renders one, which is what observe.get returns. */
const workload = (spec: number, ready?: number): string =>
  JSON.stringify({
    metadata: { name: 'x', namespace: 'default' },
    spec: { replicas: spec },
    // ABSENT rather than 0 when nothing is ready - the apiserver omits it, and a
    // fixture that always writes it cannot exercise the parse that matters.
    status: ready === undefined ? {} : { readyReplicas: ready },
  })

/** Drive one pass against canned observations, recording what it did. */
function drive(reads: Record<string, Obs<string>>): { outcome: Outcome; acts: string[] } {
  const acts: string[] = []
  const h: Handler<Effs> = {
    get: (p) => reads[String(p)] ?? absent,
    // ***THE ACT STRING NAMES THE FIELD NOW, AND THAT IS THE POINT OF THE
    // MIGRATION.*** `scale(p,3)` could only ever have meant `spec.replicas`;
    // `ensure` writes whatever field it is given, so a test that did not record
    // the field would pass for a program writing the WRONG one.
    ensure: (args) => {
      if (!('value' in args)) return
      acts.push(`ensure(${args.path},${args.field},${typeof args.value === 'string' ? JSON.stringify(args.value) : String(args.value)})`)
    },
    status: (c) => {
      acts.push(`set(${c.type}=${c.status}/${c.reason})`)
    },
  }

  return { outcome: runStep(dagStep, h), acts }
}

const eq = (got: unknown, want: unknown, what: string) => {
  if (got !== want) throw new Error(`${what}: got ${String(got)}, want ${String(want)}`)
}
const has = (hay: string, needle: string, what: string) => {
  if (!hay.includes(needle)) throw new Error(`${what}: ${needle} not in\n  ${hay}`)
}
const lacks = (hay: string, needle: string, what: string) => {
  if (hay.includes(needle)) throw new Error(`${what}: ${needle} unexpectedly in\n  ${hay}`)
}
const resumeOf = (o: Outcome): string => {
  if (o.o !== 'quiesce') throw new Error(`expected a quiesce, got ${o.o}`)

  return String((o as { resume: unknown }).resume)
}

export function runtimeGuards(): void {
  const [S0, S1] = STAGES
  const ready0: Record<string, Obs<string>> = {
    [String(S0.path)]: known(workload(S0.want, S0.want)),
  }

  // A MISSING STAGE STOPS THE DAG AND PARKS ON IT APPEARING.
  {
    const { outcome, acts } = drive({ ...ready0, [String(S1.path)]: absent })
    const r = resumeOf(outcome)
    eq(
      acts.some((a) => a.startsWith('ensure(')),
      false,
      'a missing stage was scaled',
    )
    // ***THE INVARIANT.*** The stage is absent, so `.exists` is false and the
    // park holds. `!exists` would be true right now and spin.
    has(r, '.exists', 'absent arm parks on existence')
    lacks(r, `!Get("${S1.path}"`, 'absent arm must NOT park on !exists - that is already true')
  }

  // NOT YET ASKED FOR ITS TARGET: scale it, then YIELD.
  {
    const { outcome, acts } = drive({ ...ready0, [String(S1.path)]: known(workload(0)) })
    if (!acts.includes(`ensure(${S1.path},spec.replicas,${S1.want})`)) {
      throw new Error(`a stage below target was not scaled: ${acts.join(', ')}`)
    }
    // Yield, not quiesce: the write is in flight and the next pass re-derives
    // from a fresh observation rather than parking on a state nobody reached.
    eq(outcome.o, 'yield', 'a pass that emitted a write')
  }

  // ═══ ASKED FOR BUT NOT SERVING: the edge no Deployment has. ═══
  {
    // ***DERIVED FROM THE STAGE, NOT A LITERAL.*** This said `workload(S1.want,
    // 1)` and asserted `!= 1`. When the stage's target changed to 1 the fixture
    // became "asked for 1, 1 ready" - CONVERGED - so the test drove a different
    // arm and failed on a message about a missing condition. A fixture that
    // encodes a constant it does not own is a premise that expires quietly.
    const partial = S1.want - 1
    const { outcome, acts } = drive({
      ...ready0,
      [String(S1.path)]: known(workload(S1.want, partial)),
    })
    const r = resumeOf(outcome)
    has(r, 'status.readyReplicas', 'the DAG edge parks on READINESS, not the desired count')
    // ...and on the value it SAW, so the park is false now and true when
    // readiness moves in either direction.
    has(r, `"status.readyReplicas") != ${partial}`, 'parks on the observed readiness')
    if (!acts.some((a) => a.includes('WaitingForStage'))) {
      throw new Error(`no WaitingForStage condition: ${acts.join(', ')}`)
    }
  }

  // UNKNOWN YIELDS AND NEVER ADVANCES.
  {
    const { outcome, acts } = drive({ ...ready0, [String(S1.path)]: unknown })
    eq(outcome.o, 'yield', 'an unreadable stage must yield, not park')
    eq(
      acts.some((a) => a.startsWith('ensure(')),
      false,
      'an unreadable stage was acted on',
    )
  }

  // ═══ THE DEPENDENCY ITSELF, ASSERTED AS AN ABSENCE OF ACTION. ═══
  {
    const { acts } = drive({
      [String(S0.path)]: known(workload(S0.want, 0)), // stage 0 not serving
      [String(S1.path)]: absent,
    })
    eq(
      acts.some((a) => a.includes(String(S1.path))),
      false,
      'stage 1 was touched while stage 0 was not serving - the whole point',
    )
  }

  // ALL SERVING: report Ready and park on EVERY edge.
  {
    const { outcome, acts } = drive({
      ...ready0,
      [String(S1.path)]: known(workload(S1.want, S1.want)),
    })
    const r = resumeOf(outcome)
    if (!acts.some((a) => a.includes('Ready=True'))) {
      throw new Error(`converged pass did not report Ready=True: ${acts.join(', ')}`)
    }
    // Every stage, not just the last: a predecessor losing a replica must wake
    // the program, and noticing only when the tail drifts leaves the chain
    // silently out of order.
    for (const s of STAGES) {
      has(r, `Get("${s.path}", "spec.replicas")`, `converged park covers ${s.name} spec`)
      has(r, `Get("${s.path}", "status.readyReplicas")`, `converged park covers ${s.name} ready`)
    }
  }

  // PARSING. A missing readyReplicas is 0, not NaN: the apiserver OMITS it when
  // none are ready, and reading that as unknown would make a fresh stage look
  // unreadable rather than un-ready - the program would yield forever.
  {
    const a = workloadOf(workload(3))
    eq(a.spec, 3, 'spec parsed')
    eq(a.ready, 0, 'a missing readyReplicas is 0')
    const b = workloadOf(workload(3, 2))
    eq(b.ready, 2, 'a present readyReplicas is read')
  }

  // TOTAL: unparseable input is NaN, never a throw. A throw escapes into the
  // step and fails the pass; NaN makes every comparison false, so the stage
  // reads UN-ready and the DAG waits. An unparseable object must never be
  // "ready".
  {
    const bad = workloadOf('not json at all')
    eq(Number.isNaN(bad.spec), true, 'unparseable spec is NaN')
    eq(Number.isNaN(bad.ready), true, 'unparseable ready is NaN')
    eq(bad.ready === STAGES[0].want, false, 'NaN must not compare equal to a target')
  }

  console.log('dag.test.ts: runtime guards pass')
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
