// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ***THE FIRST TESTS THAT EXERCISE `done` AND `retry` AT ALL.***
//
// Until this file, both finalize verdicts were unreachable everywhere: the
// vendored WIT declared no `interface finalize`, the SDK had no outcome type,
// and every component on the cluster answered `absent`. The host-side decoder
// was tested against hand-written JSON; nothing had ever produced those values
// from a program.
//
// Run:
//
//	bun -e 'import {runtimeGuards} from "./src/janitor.test.ts"; runtimeGuards()'
//
// Possible at all because janitor.ts is the PURE half - it imports no
// `perseid:reconcile/*` module, so a test runner can load it. That split is
// exactly what dag.ts does and is the reason either can be tested.

import { test } from 'bun:test'
import {
  type FinalizeOutcome,
  type Handler,
  type Obs,
  type Outcome,
  runStep,
  runFinalize,
  known,
  absent,
  unknown,
} from '@apsis-io/perseid/perseid.js'
import { type Effs, type FinalizeEffs, janitorStep, janitorFinalize, TARGET, MARKER, WANT } from './janitor.js'

/** A Deployment observation, as the host would return it. */
const dep = (spec: number, ready: number): Obs<string> =>
  known(JSON.stringify({ spec: { replicas: spec }, status: { readyReplicas: ready } }))

// ***TYPED TO BOTH ENTRYPOINTS' EFFECTS, AND THE COMPILER INSISTED.*** `Effs`
// alone is the STEP's set; the finalizer adds `delete`, so a harness typed to one
// cannot drive the other. That is the same property janitor-main.ts relies on -
// one handler serves both because a finalizer's vocabulary is a step's - and here
// it shows up as a type error rather than as a missing case at runtime.
function harness(seen: Obs<string>): { acts: string[]; h: Handler<Effs | FinalizeEffs> } {
  const acts: string[] = []

  return {
    acts,
    h: {
      get: (p) => (String(p) === String(TARGET) ? seen : absent),
      // ***RECORDED IN THE OBLIGATION'S OWN SHAPE***, so a test reads like the
      // expression the host will key its ledger on rather than like a
      // convenience wrapper that no longer exists.
      ensure: (args) => {
        if (!('value' in args)) return
        const v = typeof args.value === 'string' ? JSON.stringify(args.value) : args.value
        acts.push(`ensure(${args.path},${args.field},${v})`)
      },
      create: ({ path, body }) => {
        // Rendered in the obligation's own shape, sorted, so a test reads like
        // the expression the host will key its ledger on.
        const fields = [...body]
          .map((f) => `${f.path}=${String(f.value)}`)
          .sort()
          .join(',')
        acts.push(`create(${path},{${fields}})`)
      },
      delete: (path) => {
        acts.push(`delete(${path})`)
      },
      status: (c) => {
        acts.push(`set(${c.type}=${c.status}/${c.reason})`)
      },
    },
  }
}

const driveFinalize = (seen: Obs<string>): { outcome: FinalizeOutcome; acts: string[] } => {
  const { acts, h } = harness(seen)

  return { outcome: runFinalize(janitorFinalize, h), acts }
}

const driveStep = (seen: Obs<string>): { outcome: Outcome; acts: string[] } => {
  const { acts, h } = harness(seen)

  return { outcome: runStep(janitorStep, h), acts }
}

export function runtimeGuards(): void {
  const eq = (got: unknown, want: unknown, what: string) => {
    const g = JSON.stringify(got)
    const w = JSON.stringify(want)
    if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE FINALIZER. Every branch, because each one is a decision about whether
  // an object may be deleted.
  // ═══════════════════════════════════════════════════════════════════════

  // ⭐ STILL DRAINING -> retry, and it ASKS FOR THE SCALE. Both halves matter:
  // a retry that did not re-declare the scale would wait for a drain nobody
  // requested, and a finalize attempt runs on a fresh instance so "I asked last
  // time" is not knowable.
  {
    const { outcome, acts } = driveFinalize(dep(2, 2))
    eq(outcome.tag, 'retry', 'draining retries')
    if (!acts.includes(`ensure(${TARGET},spec.replicas,0)`)) {
      throw new Error(`draining did not request the scale-to-zero: ${JSON.stringify(acts)}`)
    }
    if (!String((outcome as { val: string }).val).includes('2 replica')) {
      throw new Error(`the retry reason does not say what it is waiting for: ${JSON.stringify(outcome)}`)
    }
  }

  // ⭐ DRAINED -> done. The pods are gone, so the object may be deleted.
  eq(driveFinalize(dep(0, 0)).outcome, { tag: 'done' }, 'drained completes')

  // ⭐ ***ABSENT -> done, NOT retry.*** The workload is already gone, so there
  // is nothing to drain. Retrying here would hold the object for the full
  // deadline over a cleanup that had already happened.
  eq(driveFinalize(absent).outcome, { tag: 'done' }, 'an absent target is nothing to clean up')

  // ⛔ ***UNKNOWN -> retry, NOT done.*** THE ONE BRANCH WHERE THE SAFE-LOOKING
  // CHOICE IS WRONG. `unknown` means the host could not answer; concluding
  // "nothing to clean up" would release the object on the strength of a FAILED
  // READ. A delayed delete is recoverable and a skipped drain is not.
  {
    const { outcome } = driveFinalize(unknown)
    eq(outcome.tag, 'retry', 'an unreadable target must NOT be read as clean')
  }

  // ⚠ A MALFORMED BODY IS ALSO A RETRY, for the same reason: not being able to
  // parse the workload is not evidence that it is drained.
  eq(driveFinalize(known('not json')).outcome.tag, 'retry', 'an unparseable target retries')

  // ***THE RETRY REASON IS STABLE ACROSS ATTEMPTS FOR AN UNCHANGED WORLD.***
  // The host emits it as an Event on every held tick and the apiserver
  // aggregates only on EXACT text match - a reason carrying elapsed time or an
  // attempt counter produces one row per tick and the apiserver then discards
  // the message entirely. Measured on the cluster at 58 rows for one object.
  {
    const a = driveFinalize(dep(2, 2)).outcome
    const b = driveFinalize(dep(2, 2)).outcome
    eq(a, b, 'the retry reason must not vary between attempts on an unchanged world')

    // ...and it DOES change when the world does, or the assertion above would
    // pass for a reason that says nothing.
    const c = driveFinalize(dep(0, 1)).outcome
    if (JSON.stringify(a) === JSON.stringify(c)) {
      throw new Error('the retry reason is identical for 2 replicas and 1, so it carries no ' +
        'information about what is being waited for')
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE STEP, briefly - it is an ordinary scaler and its job here is to prove
  // the two entrypoints are genuinely different programs over one handler.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { acts } = driveStep(dep(1, 1))
    if (!acts.includes(`ensure(${TARGET},spec.replicas,${WANT})`)) {
      throw new Error(`the step did not ensure spec.replicas = ${WANT}: ${JSON.stringify(acts)}`)
    }
  }
  eq(driveStep(dep(WANT, WANT)).outcome.o, 'quiesce', 'at desired scale the step parks')

  // ⭐ ***THE TWO ENTRYPOINTS DISAGREE ABOUT THE SAME WORLD, WHICH IS THE POINT
  // OF HAVING BOTH.*** Given an identical observation, the step drives the
  // Deployment UP to WANT and the finalizer drives it DOWN to zero. If these
  // ever produced the same acts, one of them would be wired to the wrong
  // generator - and that is invisible at the entrypoint, where both are just
  // `run()`.
  {
    const s = driveStep(dep(1, 1)).acts
    const f = driveFinalize(dep(1, 1)).acts
    if (JSON.stringify(s) === JSON.stringify(f)) {
      throw new Error(`step and finalize produced identical effects (${JSON.stringify(s)}), so ` +
        'the entrypoints are probably driving the same generator')
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CREATE AND DELETE - the two effects that reached a guest on 2026-08-31.
  // ═══════════════════════════════════════════════════════════════════════

  // ⭐ THE STEP CREATES THE OBJECT IT OWNS, on every converged pass. A total step
  // has no memory, so it re-declares; the applier treats AlreadyExists as
  // success and the ledger dedups on the obligation's bytes.
  {
    const { acts } = driveStep(dep(WANT, WANT))
    const created = acts.find((a) => a.startsWith(`create(${MARKER}`))
    if (!created) {
      throw new Error(`the converged step did not create its marker: ${JSON.stringify(acts)}`)
    }
    // The body must carry what the program means, not merely be non-empty.
    for (const want of ['data.owner=janitor', `data.want=${WANT}`, 'metadata.labels.managed-by=perseid']) {
      if (!created.includes(want)) {
        throw new Error(`the create body is missing ${want}: ${created}`)
      }
    }
  }

  // ⭐⭐ ***THE FINALIZER DELETES WHAT THE STEP CREATED.*** This is the whole
  // point of the pair: the ConfigMap exists only because this program made it,
  // so nothing else will remove it. Before `delete` reached a guest, a program
  // could not express this at all - its only cleanup was scaling a workload.
  {
    const { acts } = driveFinalize(dep(2, 2))
    if (!acts.includes(`delete(${MARKER})`)) {
      throw new Error(`the finalizer did not delete its marker: ${JSON.stringify(acts)}`)
    }
  }

  // ⚠ ***AND IT DELETES ON EVERY ATTEMPT, INCLUDING THE ONE THAT COMPLETES.*** A
  // finalize attempt runs on a fresh instance with no memory of the last, so
  // "I already deleted it" is not knowable; the applier treats NotFound as
  // success. A delete issued only on the first attempt would be lost whenever
  // that attempt failed for any other reason.
  {
    const { acts } = driveFinalize(dep(0, 0))
    if (!acts.includes(`delete(${MARKER})`)) {
      throw new Error(`the completing attempt skipped the delete: ${JSON.stringify(acts)}`)
    }
  }

  console.log('janitor.test.ts: runtime guards pass')
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
