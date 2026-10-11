// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// THE FOLLOWER: the reference for `held()`, and the watch set is DATA.
//
// It reads a ConfigMap that lists which Deployments to keep an eye on, then
// watches exactly those. ***THE SUBJECT LIST IS NOT IN THIS FILE***, so no
// condition here can be written at authoring time - every one is DERIVED during
// the pass, from something the pass read.
//
// The other three references, and why this is a fourth rather than a rewrite of
// one of them:
//
//	simple.ts    SHAPE - the smallest program that is still real
//	warden.ts    BREADTH - every capability once
//	sentinel.ts  DISPATCH - N independent subjects, known at authoring time
//	follower.ts  DYNAMISM - the subjects are not known until the pass runs
//
// ⭐ ***THIS PROGRAM COULD NOT HAVE BEEN WRITTEN AGAINST THE TWO DESIGNS BEFORE
// `held()`.*** `on` needed its arms before it dispatched, and `watch` needed its
// set before `held()` could be called - both fixed the question at the top of
// the pass, before any read had happened. `held()` reads the host ONCE and
// returns DATA, so the answer outlives the call and a condition can be tested
// against it whenever the program is able to build one.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE THREE PHASES, AND THE SOURCE IS IN THAT ORDER ON PURPOSE.
//
//	1. why am I awake       `held()` - declares nothing, so it comes first
//	2. do the work          reads, and branches on conditions built from them
//	3. what would wake me   `quiesce(anyOf(...))` - the LAST thing decided
//
// A pass genuinely happens in that order. The park is the last decision a step
// makes, and writing it last is only possible because nothing has to exist
// before the question can be asked.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type EffectsOf,
  path,
  reconcile,
  reader,
  defineStep,
  held,
  quiesce,
  anyOf,
  ready,
  unready,
  unsure,
  fieldNoLonger,
  objectGone,
  backstop,
} from '@apsis-io/perseid/perseid.js'
import { asDeployment, readyReplicas } from '@apsis-io/perseid/k8s.js'

const observe = reconcile.observe<string>()
const report = reconcile.status()

const NS = 'default'

/** The object that says what to watch. This program's only fixed subject. */
const INDEX = path.ns(NS).core('v1', 'configmaps', 'follower-index')

/** Every named Deployment is expected to hold this many ready replicas. */
const WANT = 1

type Index = { data?: { subjects?: string } }

const readIndex = reader(observe, (raw) => JSON.parse(raw) as Index)
const readDeployment = reader(observe, asDeployment)

/**
 * `a,b,c` -> `['a', 'b', 'c']`, empties dropped.
 *
 * Deliberately boring, and deliberately TOTAL: a malformed list yields fewer
 * subjects rather than throwing, because a step that throws on a
 * half-written ConfigMap stops watching the subjects that ARE named.
 */
const parseSubjects = (raw: string | undefined): readonly string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

// ═══════════════════════════════════════════════════════════════════════════
// THE CONDITIONS.
//
// ***ONE IS STATIC AND THE REST CANNOT BE.*** `INDEX_GONE` names an object this
// file knows about, so it is a module constant. A subject's condition names a
// Deployment whose NAME arrives at runtime, so it is a FUNCTION - called once to
// ask about it and once to build the park, which is safe because `has` compares
// what a condition RENDERS TO and not which object it is.
// ═══════════════════════════════════════════════════════════════════════════

/** Somebody deleted the list itself. */
const INDEX_GONE = objectGone(INDEX)

/**
 * The list's CONTENT changed from what this pass saw.
 *
 * ⭐ ***THE PARK CARRIES THE LAST-SEEN VALUE, SO NO `carry` IS NEEDED.*** Parking
 * on `data.subjects != <what I just read>` means the next wake fires exactly when
 * somebody edits the list. The value is baked into the expression the host
 * evaluates, which is the one place a "what did I see last time" fact can live
 * without a second store to keep in step.
 */
const indexMoved = (seen: string) => fieldNoLonger(INDEX, 'data.subjects', seen)

/**
 * One named subject is off its expected count.
 *
 * ⛔ `fieldNoLonger`, NOT `fieldNe` - Kubernetes OMITS `status.readyReplicas` at
 * zero, and zero is the failure a follower exists to notice. An absent operand
 * propagates as UNKNOWN rather than true, so a `!=` park would not fire on the
 * very case it was written for. `fieldNoLonger` emits `!exists || !=`.
 */
const drifted = (name: string) =>
  fieldNoLonger(path.ns(NS).deployments(name), 'status.readyReplicas', WANT)

// ═══════════════════════════════════════════════════════════════════════════
// THE STEP.
// ═══════════════════════════════════════════════════════════════════════════

export const step = defineStep(function* () {
  // ───────────────────────────────────────────────────────────────────────
  // 1. WHY AM I AWAKE.
  //
  // The first statement, before any read. ***THE ANSWER DESCRIBES THE WAKE THAT
  // STARTED THIS PASS***, and work that yields could change the world underneath
  // a later read of it - so asking first is not style, it is the only moment the
  // answer is about the thing it claims to be about.
  // ───────────────────────────────────────────────────────────────────────
  const woke = yield* held()

  // ───────────────────────────────────────────────────────────────────────
  // 2. DO THE WORK.
  // ───────────────────────────────────────────────────────────────────────

  // The list, which every condition below is derived from. `unsure` and not
  // `unready`: a failed read establishes nothing about the subjects, and saying
  // they are unhealthy because we could not read their INDEX would be a verdict
  // about one object reported as a verdict about several.
  const idx = yield* readIndex.get(INDEX)
  if (idx.t === 'unknown') {
    yield* report(unsure('IndexUnreadable', `could not read ${INDEX}; nothing was judged`))

    return quiesce(anyOf(INDEX_GONE, backstop()))
  }
  if (idx.t === 'absent') {
    yield* report(unready('IndexAbsent', `${INDEX} does not exist; create it to name subjects`))

    return quiesce(anyOf(INDEX_GONE, backstop()))
  }

  const seen = idx.v.data?.subjects ?? ''
  const subjects = parseSubjects(seen)

  const found: string[] = []

  /** Read one subject and judge it. Used by dispatch AND by the fallback. */
  function* check(name: string) {
    const got = yield* readDeployment.get(path.ns(NS).deployments(name))
    if (got.t === 'unknown') {
      found.push(`${name}: unreadable`)

      return
    }
    if (got.t === 'absent') {
      found.push(`${name}: does not exist`)

      return
    }
    // An omitted `readyReplicas` IS zero - the same asymmetry `fieldNoLonger`
    // exists for, one layer up in the program instead of in the park. The rule
    // now lives in the SDK rather than being re-decided here; this read
    // `?? 0` inline, which was right, and three sibling programs spelled the
    // same class of default differently.
    const ready = readyReplicas(got.v)
    if (ready !== WANT) found.push(`${name}: ${ready}/${WANT} ready`)
  }

  // ⭐ ***THE CONDITIONS ARE BUILT HERE, FROM A VALUE THAT DID NOT EXIST WHEN
  // `held()` RAN.*** This is the whole point of the file. `woke` is data; asking
  // it about `drifted(name)` needs nothing to have been registered in advance.
  //
  // ⚠ Count BRANCHES, not `woke.size`. `size` counts OPERANDS, and
  // `fieldNoLonger` renders two - both can hold at one wake, so a single subject
  // moving could report 2.
  let dispatched = 0
  for (const name of subjects) {
    if (!woke.has(drifted(name))) continue
    yield* check(name)
    dispatched++
  }

  // ⚠ ***THE FALLBACK IS THE CORRECTNESS, AND HERE IT IS ALSO THE INTERESTING
  // CASE.*** It runs on a backstop tick, on the first pass, and on a host that
  // does not serve `woke` - all ordinary. But it ALSO runs when the list itself
  // changed, and that is worth understanding rather than working around:
  //
  // If somebody edited the ConfigMap, the operand that held is
  // `data.subjects != <the OLD value>`, and this pass can only build
  // `indexMoved(<the NEW value>)` - a different expression, which correctly does
  // not match. Nothing matches, so this reads everything.
  //
  // ***THAT IS THE RIGHT ANSWER, NOT A MISS.*** The set of things being watched
  // just changed; re-reading all of it is exactly what should happen. A design
  // that "fixed" this would be claiming to dispatch on a world it had not seen.
  if (dispatched === 0) for (const name of subjects) yield* check(name)

  const healthy = found.length === 0
  const how = dispatched === 0 ? `via ${subjects.length} of ${subjects.length}, no dispatch` : `via ${dispatched} of ${subjects.length}`
  yield* report(
    healthy
      ? ready('AllSubjectsHealthy', `${subjects.length} subject(s) healthy (${how}): ${subjects.join(', ') || 'none named'}`)
      : unready('SubjectUnhealthy', `${found.join('; ')} (${how})`),
  )

  // ───────────────────────────────────────────────────────────────────────
  // 3. WHAT WOULD WAKE ME.
  //
  // Assembled from the SAME functions the branches above called. They are
  // referenced twice, not written twice - `drifted` is one expression, and a
  // misspelled reference does not compile.
  //
  // `backstop()` is folded away by `anyOf` (`X || false` is `X`), so saying it
  // costs no operand; the host renders `|| Backstop()` onto every park anyway,
  // and this states the intent where a reader is looking.
  // ───────────────────────────────────────────────────────────────────────
  return quiesce(anyOf(INDEX_GONE, indexMoved(seen), ...subjects.map(drifted), backstop()))
})

export type Effs = EffectsOf<typeof step>
export { INDEX, NS, WANT, parseSubjects, drifted, indexMoved, INDEX_GONE }
