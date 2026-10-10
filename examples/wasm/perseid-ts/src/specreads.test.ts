// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ A PROGRAM'S `spec.reads` AGAINST THE PARK IT ACTUALLY BUILDS.
//
// `spec.reads` names the CLUSTER-SCOPED objects a Perseid may read. It is
// hand-written in each program's YAML, in a different file and a different
// language from the park that depends on it, and until now nothing compared the
// two.
//
// ***THE DRIFT IS SILENT AND IT IS SILENT IN THE REASSURING DIRECTION.*** A path
// the manifest does not declare reads ABSENT on every wake; an absent operand
// compares UNKNOWN rather than true; so the park never fires and the program
// falls back to its backstop. It looks subscribed and it polls.
// `drainer.yaml`'s header is an account of exactly that shape costing up to 60
// seconds of delay that nobody could see from the outside.
//
// The park is a TREE now, so what it reads is derivable rather than declarable -
// the same move `derive-wit.ts` makes for the component's world.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import { type Handler, type Outcome, runStep, unknown } from '@apsis-io/perseid/perseid.js'
import { clusterReadsOf } from '@apsis-io/perseid/resume.js'
import { sentinelStep } from './sentinel.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * The `spec.reads` a manifest declares.
 *
 * ⚠ ***IT ASSERTS IT PARSED SOMETHING.*** An empty result from a regex that
 * stopped matching is indistinguishable from a program that declares no reads,
 * and the comparison below would then pass by finding nothing on either side -
 * a guard measuring itself. The caller states how many it expects to find.
 */
function declaredReads(yaml: string, atLeast: number): readonly string[] {
  const src = readFileSync(new URL(`../${yaml}`, import.meta.url), 'utf8')
  const block = /^ {2}reads:\n((?: {4}- .*\n)+)/m.exec(src)
  const got =
    block === null
      ? []
      : block[1]!
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => l.replace(/^\s*-\s*/, '').trim())

  assert(got.length >= atLeast,
    `${yaml}: parsed ${got.length} spec.reads entries, expected at least ${atLeast} - ` +
      'the YAML shape has probably changed and this guard is measuring itself')

  return got
}

/**
 * Drive a step to its park.
 *
 * Everything answers `unknown`: a step that cannot read still has to say what
 * would change its mind, and the PARK is what this file is about. `held` is
 * empty, so no arm dispatches and the resume is the whole disjunction.
 */
function parkOf(step: () => Generator<never, Outcome, never>): Outcome {
  return runStep(step, {
    get: () => unknown,
    held: () => [],
    status: () => undefined,
    ensure: () => undefined,
  } as unknown as Handler<never>)
}

export function runtimeGuards(): void {
  // ═══════════════════════════════════════════════════════════════════════
  // sentinel: one node, cluster-scoped, declared in sentinel.yaml.
  // ═══════════════════════════════════════════════════════════════════════
  const outcome = parkOf(sentinelStep as unknown as () => Generator<never, Outcome, never>)
  assert(outcome.o === 'quiesce',
    `sentinel did not park, so there is no resume to derive reads from: ${outcome.o}`)

  // `assert` above narrows `outcome` to the quiesce variant, so `resume` is
  // reachable without a cast - and a cast here would have been the thing that
  // hid a wrong type rather than the thing that expressed one.
  const derived = clusterReadsOf(outcome.resume)
  assert(derived.length > 0,
    'derived NO cluster reads from a park that watches a Node - the derivation is ' +
      'broken and every comparison below would pass vacuously')

  const declared = declaredReads('sentinel.yaml', 1)

  for (const p of derived) {
    assert(declared.includes(p),
      `sentinel's park reads ${p}, which sentinel.yaml's spec.reads does not declare. ` +
        'The host answers ABSENT for it on every wake, an absent operand compares ' +
        'UNKNOWN, and the park never fires - the program looks subscribed and polls.')
  }

  // ⚠ THE OTHER DIRECTION IS A WARNING, NOT AN ERROR, AND THE ASYMMETRY IS
  // DELIBERATE. A declared path the park does not read is harmless today - it
  // grants a read nobody performs - and a program may legitimately declare one
  // it reads from the STEP BODY rather than from the park. Undeclared-but-read
  // is the defect; declared-but-unread is at worst untidy.
  for (const p of declared) {
    if (!derived.includes(p)) {
      // eslint-disable-next-line no-console
      console.log(`  note: sentinel.yaml declares ${p}, which its park does not read`)
    }
  }
}

test('specreads.test.ts: a park reads only what its manifest declares', () => {
  runtimeGuards()
})
