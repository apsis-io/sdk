// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ***THE POINT OF THE EFFECT.*** Every arm below - including a `not-allowed`
// spawn, which is what a program with no `spec.execWith` gets on every pass - is
// exercised with no host, no trail and no pod. That is only possible because the
// step YIELDS the spawn instead of calling `exec` directly.

import { test } from 'bun:test'
import { type Handler, type Outcome, runStep, known, absent, unknown } from '@apsis-io/perseid/perseid.js'
import { type Effs, type CheckOutcome, execStep, SUBJECT, CHECKER, MAX_STDIN, project } from './execcheck.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const dep = (status: Record<string, unknown>, replicas = 2, rv = '100') =>
  known(JSON.stringify({ metadata: { name: 'exec-demo', resourceVersion: rv }, spec: { replicas }, status }))

type Run = {
  outcome: Outcome
  reason: string | null
  message: string
  status: string | null
  spawned: { name: string; input: string }[]
}

/** One pass. `answer` is what the read returns; `result` is what the spawn does. */
function drive(
  answer: ReturnType<typeof dep> | typeof absent | typeof unknown,
  result: CheckOutcome = { t: 'verdict', exitCode: 0, stdout: 'checker: exec-demo 2/2 ready' },
): Run {
  const spawned: { name: string; input: string }[] = []
  let reason: string | null = null
  let message = ''
  let status: string | null = null

  const handler = {
    get: () => answer,
    exec: (a: { name: string; input: string }) => {
      spawned.push(a)

      return result
    },
    // Fixed rather than derived from `held`: this fixture drives no wake, and
    // inventing a correlation between the two is the inference `woke.cause` was
    // added to remove.
    cause: () => 'condition',
    status: (c: { reason?: string; message?: string; status?: string }) => {
      reason = c.reason ?? null
      message = c.message ?? ''
      status = c.status ?? null
    },
  } as unknown as Handler<Effs>

  return { outcome: runStep(execStep, handler), reason, message, status, spawned }
}

export function runtimeGuards(): void {
  // ═══════════════════════════════════════════════════════════════════════
  // The three-valued read. `unknown` and `absent` are DIFFERENT verdicts.
  // ═══════════════════════════════════════════════════════════════════════
  const failed = drive(unknown)
  assert(failed.status === 'Unknown', `a failed read did not report unsure: ${failed.status}`)
  assert(failed.reason === 'ReadFailed', `wrong reason for a failed read: ${failed.reason}`)
  assert(failed.spawned.length === 0, 'a failed read still spawned the checker')

  const gone = drive(absent)
  assert(gone.status === 'False', `an absent subject did not report unready: ${gone.status}`)
  assert(gone.reason === 'SubjectAbsent', `wrong reason for an absent subject: ${gone.reason}`)
  assert(gone.spawned.length === 0, 'an absent subject still spawned the checker')

  // ***THE NEGATIVE ARM THAT MATTERS.*** If these two collapsed into one verdict
  // the program would announce a workload unhealthy because a read half-failed.
  //
  // ⚠ ***VIA A SET, AND `!==` WOULD BE VACUOUS HERE.*** The two asserts above
  // narrow each status to a literal type, so `failed.status !== gone.status` is
  // provably true at compile time - `tsgo` says so (TS2367) and it is right: the
  // check could never fail. Widening through a Set makes it a real runtime
  // comparison again. A guard the type system can prove is a comment.
  const distinct = new Set<string | null>([failed.status, gone.status])
  assert(distinct.size === 2, 'unknown and absent produced the SAME status')

  // ═══════════════════════════════════════════════════════════════════════
  // The seam. `not-allowed` is the fleet's current state and is NOT a failure.
  // ═══════════════════════════════════════════════════════════════════════
  const unwired = drive(dep({ readyReplicas: 2 }), { t: 'unavailable', kind: 'not-allowed', reason: 'not-allowed' })
  assert(unwired.status === 'Unknown',
    `an unwired checker did not report unsure: ${unwired.status}`)
  assert(unwired.reason === 'NoChecker', `wrong reason for an unwired checker: ${unwired.reason}`)
  assert(unwired.message.includes('not-allowed'),
    `the unwired message does not name the cause: ${unwired.message}`)

  // ⛔ ***`spawn-failed` IS A DIFFERENT PLACE TO LOOK THAN `not-allowed`, AND
  // THIS HAD NO TEST UNTIL A LIVE RUN PRODUCED IT.*** Both are `unsure`, and that
  // is not the distinction: `not-allowed` means the spec is wrong,
  // `spawn-failed` means the spec is RIGHT and the artifact on the node did not
  // load. Measured by moving the checker out of /var/lib/apsis/wasm-exec while
  // the grant stayed correct - the program said `NoChecker`, which points at a
  // spec with nothing wrong with it.
  const broken = drive(dep({ readyReplicas: 2 }), { t: 'unavailable', kind: 'failed', reason: 'spawn-failed' })
  assert(broken.status === 'Unknown', `a broken checker did not report unsure: ${broken.status}`)
  assert(broken.reason === 'CheckerUnavailable',
    `a broken artifact must not read as a missing grant: ${broken.reason}`)
  const wheres = new Set<string | null>([unwired.reason, broken.reason])
  assert(wheres.size === 2,
    'not-allowed and spawn-failed reported the SAME reason, so the condition cannot say ' +
      'whether to fix the spec or the node')
  assert(broken.message.includes('node'), `the message does not point at the node: ${broken.message}`)

  // ⛔ The whole point: a check that did not RUN must not read as a check that
  // FAILED. A program that reported `unready` here would page an operator about a
  // healthy workload on the strength of its own missing configuration.
  const failing = drive(dep({ readyReplicas: 0 }), { t: 'verdict', exitCode: 1, stdout: 'checker: exec-demo 0/2 ready' })
  assert(failing.status === 'False', `a failing check did not report unready: ${failing.status}`)
  // Same widening, same reason as above: narrowed literals make `!==` vacuous.
  const runVsRan = new Set<string | null>([unwired.status, failing.status])
  assert(runVsRan.size === 2,
    'an UNAVAILABLE checker and a FAILING one produced the same status')

  // ═══════════════════════════════════════════════════════════════════════
  // The verdict is the exit code, not the text.
  // ═══════════════════════════════════════════════════════════════════════
  const passed = drive(dep({ readyReplicas: 2 }))
  assert(passed.status === 'True', `a passing check did not report ready: ${passed.status}`)
  assert(passed.reason === 'CheckPassed', `wrong reason for a passing check: ${passed.reason}`)
  assert(passed.message.includes('2/2 ready'),
    `the checker's own text did not reach the condition: ${passed.message}`)

  // A checker that exits 0 while printing an alarm is still a pass - the exit
  // code is the contract. Asserted so a future "read the text too" cannot land
  // quietly.
  const quiet = drive(dep({ readyReplicas: 2 }), { t: 'verdict', exitCode: 0, stdout: '' })
  assert(quiet.status === 'True', 'an empty-stdout pass was not ready')
  assert(quiet.message.includes('(no output)'), `an empty stdout lost its placeholder: ${quiet.message}`)

  // ═══════════════════════════════════════════════════════════════════════
  // What the checker is HANDED. The contract is the projection, not the object.
  // ═══════════════════════════════════════════════════════════════════════
  assert(passed.spawned.length === 1, `expected exactly one spawn, got ${passed.spawned.length}`)
  assert(passed.spawned[0]!.name === CHECKER,
    `spawned the wrong name: ${passed.spawned[0]!.name}`)

  const sent = JSON.parse(passed.spawned[0]!.input) as Record<string, unknown>
  assert('readyReplicas' in (sent.status as object),
    'the projection dropped readyReplicas, which is the field the checker exists to read')

  // ⛔ ***ABSENT MUST SURVIVE AS null, NOT BECOME 0.*** Kubernetes OMITS
  // `readyReplicas` when nothing is ready - the failure a checker exists for
  // arrives as a MISSING field. A projection that manufactured a 0 here would be
  // inventing an observation the apiserver never made.
  const downProjection = JSON.parse(project({ status: { replicas: 2 } })) as {
    status: { readyReplicas: unknown }
  }
  assert(downProjection.status.readyReplicas === null,
    `absent readyReplicas was not preserved as null: ${JSON.stringify(downProjection.status.readyReplicas)}`)

  // ═══════════════════════════════════════════════════════════════════════
  // The bounded pipe. Over MAX_STDIN the program REFUSES rather than deadlocks.
  // ═══════════════════════════════════════════════════════════════════════
  const huge = drive(dep({ conditions: Array.from({ length: 400 }, (_, i) => ({ type: `c${i}`, status: 'True' })) }))
  assert(huge.spawned.length === 0,
    'an over-sized projection was still written to the child, which is the deadlock')
  assert(huge.reason === 'ProjectionTooLarge', `wrong reason for an over-sized projection: ${huge.reason}`)
  assert(huge.status === 'Unknown', `an over-sized projection did not report unsure: ${huge.status}`)
  assert(project({ status: { conditions: Array.from({ length: 400 }, (_, i) => ({ type: `c${i}` })) } }).length > MAX_STDIN,
    'the over-size fixture is not actually over MAX_STDIN - the guard above proves nothing')

  // ⛔ ***BYTES, NOT CHARACTERS - AND THE CHARACTER COUNT PASSES.*** A JS string's
  // `.length` is UTF-16 code units, so a projection of multi-byte characters can
  // sit under a 4096 "character" bound and write well over 4096 BYTES into a pipe
  // whose capacity is 8192. That is a deadlock, not an error, and it is reachable
  // from any Kubernetes field carrying non-ASCII text.
  //
  // The fixture is chosen so the two measurements DISAGREE: under the bound by
  // characters, over it by bytes. A guard written against `.length` passes this
  // and the program deadlocks.
  const wide = 'é'.repeat(2600)
  const wideProjection = project({ metadata: { name: wide } })
  assert(wideProjection.length < MAX_STDIN,
    `the fixture must be UNDER the bound by characters or it proves nothing: ${wideProjection.length}`)
  assert(new TextEncoder().encode(wideProjection).length > MAX_STDIN,
    'the fixture must be OVER the bound by bytes - that disagreement is the whole test')
  const wideRun = drive(known(JSON.stringify({ metadata: { name: wide } })))
  assert(wideRun.spawned.length === 0,
    'a projection over the BYTE bound was written to the child - the size check is ' +
      'counting UTF-16 code units, and the pipe counts bytes')
  assert(wideRun.reason === 'ProjectionTooLarge',
    `wrong reason for an over-size projection: ${wideRun.reason}`)

  // ═══════════════════════════════════════════════════════════════════════
  // Every arm parks, and names the subject.
  // ═══════════════════════════════════════════════════════════════════════
  for (const [what, run] of [
    ['failed read', failed], ['absent', gone], ['unwired', unwired],
    ['failing', failing], ['passing', passed], ['over-size', huge],
  ] as const) {
    assert(run.outcome.o === 'quiesce', `${what} did not quiesce: ${run.outcome.o}`)
    const rendered = String((run.outcome as { resume: { render(): string } }).resume.render())
    assert(rendered.includes(String(SUBJECT)), `${what} parked without naming the subject: ${rendered}`)
  }
}

test('execcheck.test.ts: runtime guards pass', () => {
  runtimeGuards()
})
