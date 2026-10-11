// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { test } from 'bun:test'
import {
  type Handler,
  type Outcome,
  type Resume,
  runStep,
  known,
  absent,
  unknown,
} from '@apsis-io/perseid/perseid.js'
import { type Effs, step, INDEX, WANT, parseSubjects, drifted, indexMoved } from './follower.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** The `n`th leaf of a condition, as the host reports it. */
const leafOf = (c: Resume, n: number): string => {
  const out: string[] = []
  const walk = (x: Resume): void => {
    if (x.of.length > 0) x.of.forEach(walk)
    else out.push(x.render())
  }
  walk(c)
  const got = out[n]
  if (got === undefined) throw new Error(`leafOf: no leaf ${n} (has ${out.length})`)

  return got
}

const indexJSON = (subjects: string) => known(JSON.stringify({ data: { subjects } }))
const depJSON = (ready: number) => known(JSON.stringify({ status: { readyReplicas: ready } }))

/**
 * Drive one pass and RECORD WHICH OBJECTS WERE READ.
 *
 * The read log is the point: this program's claim is that a wake naming one
 * subject reads the index plus that ONE subject, not the index plus all of them.
 */
function drive(
  held: string[],
  subjects: string,
  healthy: (name: string) => number | 'missing' | 'unreadable' = () => WANT,
): { outcome: Outcome; read: string[]; msg: string } {
  const read: string[] = []
  let msg = ''
  const handler: Handler<Effs> = {
    get: (q: unknown) => {
      const p = String(q)
      read.push(p)
      if (p === String(INDEX)) return indexJSON(subjects)
      const name = p.split('/').pop() ?? ''
      const v = healthy(name)
      if (v === 'missing') return absent
      if (v === 'unreadable') return unknown

      return depJSON(v)
    },
    held: () => held,
    status: (c: { message?: string }) => {
      msg = c.message ?? ''
    },
  } as unknown as Handler<Effs>

  return { outcome: runStep(step, handler), read, msg }
}

export function runtimeGuards(): void {
  // ═══════════════════════════════════════════════════════════════════════
  // THE PARSER. Total, because a half-written ConfigMap must not stop the
  // program watching the subjects that ARE named.
  // ═══════════════════════════════════════════════════════════════════════
  assert(parseSubjects('a,b,c').join('|') === 'a|b|c', 'a plain list did not parse')
  assert(parseSubjects(' a , b ').join('|') === 'a|b', 'whitespace was not trimmed')
  assert(parseSubjects('a,,b').join('|') === 'a|b', 'an empty entry was not dropped')
  assert(parseSubjects('').length === 0, 'an empty list is not empty')
  assert(parseSubjects(undefined).length === 0, 'a missing field is not an empty list')

  // ═══════════════════════════════════════════════════════════════════════
  // ⭐ THE CLAIM: A WAKE NAMING ONE SUBJECT READS THAT ONE, NOT ALL OF THEM.
  //
  // The conditions asked about here did not exist when `held()` ran - they are
  // built from `subjects`, which came out of the index READ. That is the whole
  // reason this program exists.
  // ═══════════════════════════════════════════════════════════════════════
  const one = drive([leafOf(drifted('b'), 1)], 'a,b,c')
  assert(one.read.length === 2, `a dispatched pass read ${one.read.length} objects, want 2 (index + b): ${one.read.join(', ')}`)
  assert(one.read[1]!.endsWith('/b'), `the dispatched read was ${one.read[1]}, not b`)

  // EITHER operand of one subject reaches it, and both together run it ONCE.
  assert(drive([leafOf(drifted('b'), 0)], 'a,b,c').read[1]!.endsWith('/b'), "a subject's OTHER operand must reach it")
  assert(drive([leafOf(drifted('b'), 0), leafOf(drifted('b'), 1)], 'a,b,c').read.length === 2,
    'both operands of one subject must read it ONCE')

  // Two different subjects holding read both.
  const two = drive([leafOf(drifted('a'), 1), leafOf(drifted('c'), 1)], 'a,b,c')
  assert(two.read.length === 3, `two held subjects read ${two.read.length} objects, want 3 (index + 2)`)

  // ⛔ THE FALLBACK. Nothing named - a backstop tick, the first pass, or a host
  // without `woke` - reads everything.
  const none = drive([], 'a,b,c')
  assert(none.read.length === 4, `an undispatched pass read ${none.read.length}, want 4 (index + 3)`)

  // ⭐⭐ ***THE LIST CHANGED, AND THE FALLBACK IS THE RIGHT ANSWER.*** The host
  // reports `data.subjects != <OLD>`; this pass can only build the condition for
  // the NEW value, which correctly does not match. Nothing dispatches, so
  // everything is read - the set being watched just changed.
  const moved = drive([leafOf(indexMoved('a,b'), 0)], 'a,b,c')
  assert(moved.read.length === 4,
    `after the list moved the pass read ${moved.read.length}, want 4 - a changed set must be re-read in full`)

  // ***AND AN OPERAND FOR A SUBJECT NO LONGER NAMED MATCHES NOTHING.*** `z` was
  // watched last pass and has been removed from the list; asking about it now is
  // not an error and must not dispatch anything.
  const dropped = drive([leafOf(drifted('z'), 1)], 'a,b,c')
  assert(dropped.read.length === 4,
    `an operand for a dropped subject dispatched something: read ${dropped.read.join(', ')}`)

  // ═══════════════════════════════════════════════════════════════════════
  // ⛔ THE VERDICT MUST NOT DEPEND ON THE HINT. Same world, dispatched and not.
  // If these ever disagree, dispatch has stopped being an optimisation.
  // ═══════════════════════════════════════════════════════════════════════
  const sick = (n: string) => (n === 'b' ? 0 : WANT)
  const viaHint = drive([leafOf(drifted('b'), 1)], 'a,b,c', sick)
  const viaAll = drive([], 'a,b,c', sick)
  const verdict = (m: string) => m.replace(/\s*\(via [^)]*\)/, '')
  assert(verdict(viaHint.msg) === verdict(viaAll.msg),
    `the verdict differs with and without dispatch:\n  hint: ${viaHint.msg}\n  all:  ${viaAll.msg}`)
  assert(viaHint.msg.includes('b: 0/1 ready'), `an unhealthy subject was not named: ${viaHint.msg}`)

  // The dispatch MODE is published, or a dispatched and a fallback pass are
  // indistinguishable from outside and "it works" is unfalsifiable.
  assert(viaHint.msg.includes('via 1 of 3'), `a dispatched pass did not publish its read count: ${viaHint.msg}`)
  assert(none.msg.includes('no dispatch'), `the fallback did not publish itself: ${none.msg}`)

  // ═══════════════════════════════════════════════════════════════════════
  // THE INDEX ITSELF. A failed read is not an unhealthy fleet.
  // ═══════════════════════════════════════════════════════════════════════
  const unreadable = (() => {
    const read: string[] = []
    let msg = ''
    const outcome = runStep(step, {
      get: (q: unknown) => {
        read.push(String(q))

        return unknown
      },
      held: () => [],
      status: (c: { message?: string }) => {
        msg = c.message ?? ''
      },
    } as unknown as Handler<Effs>)

    return { outcome, read, msg }
  })()
  assert(unreadable.read.length === 1, 'an unreadable index must not read any subject')
  assert(unreadable.msg.includes('nothing was judged'), `an unreadable index was not reported honestly: ${unreadable.msg}`)

  // An EMPTY list is healthy-vacuous, not an error - and reads nothing but the index.
  const empty = drive([], '')
  assert(empty.read.length === 1, `an empty list read ${empty.read.length} objects, want 1`)
  assert(empty.msg.includes('none named'), `an empty list was not reported: ${empty.msg}`)
}

test('runtime guards', runtimeGuards)
