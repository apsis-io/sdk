// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import { fieldIs, fieldNoLonger, fieldNe, path } from './perseid.js'
import { eqScalar, neScalar, get } from './expr.js'

// ═══════════════════════════════════════════════════════════════════════════
// PARKING ON A STRING OR BOOLEAN FIELD.
//
// The host's `compare` has had `case string` and `case bool` arms all along;
// this SDK's `cmp` takes `IntLike`, so every park an author could write was
// about a number. Found trying to park on a node's drain annotation.
//
// ***THE ASSERTIONS ARE ON THE EMITTED TEXT, because that text is the contract
// with a Go parser*** - a builder producing something the grammar rejects fails
// on the host, silently, as a park that never holds. `String()` unwraps the
// brand: `Expr<'bool'>` is a branded string and `toBe` compares against the
// brand, not the text.
//
// ⭐ ***A CLUSTER PATH IS ACCEPTED HERE AND NOWHERE ELSE IT SHOULD NOT BE.***
// These builders take `E.ReadPathLike`, which is `PathLike | ClusterPath` - a
// SEPARATE type rather than a widening of `PathLike`, because `PathLike` also
// feeds `del` and there is no cluster delete in the host. `Get` is scope-generic
// (the host tells the scopes apart from the path, exactly as `ensure` does);
// `del` is not.
// ═══════════════════════════════════════════════════════════════════════════

const pod = path.ns('default').core('v1', 'pods', 'web')

test('a string field renders JSON-quoted, matching the host decoder', () => {
  expect(String(eqScalar(get(pod, 'status.phase'), 'Running'))).toBe(
    'Get("/api/v1/namespaces/default/pods/web", "status.phase") == "Running"',
  )
  expect(String(neScalar(get(pod, 'status.phase'), 'Running'))).toBe(
    'Get("/api/v1/namespaces/default/pods/web", "status.phase") != "Running"',
  )
})

// A boolean is BARE, not quoted - `== true` and `== "true"` are different
// comparisons to the host, and its bool arm ERRORS on a string operand rather
// than coercing, so getting this wrong is a park that never evaluates.
test('a boolean field renders bare', () => {
  expect(String(eqScalar(get(pod, 'spec.hostNetwork'), true))).toBe(
    'Get("/api/v1/namespaces/default/pods/web", "spec.hostNetwork") == true',
  )
  expect(String(eqScalar(get(pod, 'spec.hostNetwork'), false))).toContain('== false')
})

// A value containing a quote is ESCAPED rather than refused - the grammar's
// string token takes JSON escapes and the host decodes with encoding/json, so
// producer and consumer are the same dialect by construction.
test('a quote in the value is escaped, not refused', () => {
  expect(String(eqScalar(get(pod, 'metadata.name'), 'we"b'))).toContain('"we\\"b"')
})

test('fieldIs is the scalar sibling of fieldNe, which is untouched', () => {
  expect(String(fieldIs(pod, 'status.phase', 'Running'))).toBe(
    'Get("/api/v1/namespaces/default/pods/web", "status.phase") == "Running"',
  )
  expect(String(fieldNe(pod, 'spec.replicas', 3))).toBe(
    'Get("/api/v1/namespaces/default/pods/web", "spec.replicas") != 3',
  )
})

// ⛔ ***THE `!exists` HALF IS THE WHOLE REASON `fieldNoLonger` IS NOT A BARE
// `!=`.*** Deleting an annotation makes the field ABSENT, and an absent operand
// propagates as unknown - so `absent != "true"` is UNKNOWN, not true, and a park
// written as a plain inequality never fires on the withdrawal it exists to
// catch. It waits out its backstop instead, which reads as a slow program rather
// than a wrong park.
test('fieldNoLonger also fires when the field is DELETED', () => {
  const r = String(fieldNoLonger(pod, 'metadata.annotations.drain', 'true'))
  expect(r).toContain('.exists')
  expect(r).toContain('!')
  expect(r).toContain('||')
  expect(r).toContain('!= "true"')
})

// ...and both halves must name the SAME field. A builder that drifted here would
// wake on one field's absence and another field's value - two conditions that
// look like one.
test('both halves of fieldNoLonger name the same field', () => {
  const r = String(fieldNoLonger(pod, 'status.phase', 'Running'))
  expect(r.split('"status.phase"').length - 1).toBe(2)
})

// ⭐ ***A CLUSTER PATH PARKS, WHICH IS AS MUCH A COMPILE-TIME ASSERTION AS A
// RUNTIME ONE*** - if `ReadPathLike` did not admit a `ClusterPath` this file
// would not typecheck, and `bun test` alone would not notice (it strips types).
// The SDK's own `tsc --noEmit` is what makes this arm mean anything.
const node = path.nodes('worker-1')

test('a cluster-scoped path can be parked on', () => {
  expect(String(fieldIs(node, 'spec.unschedulable', true))).toBe(
    'Get("/api/v1/nodes/worker-1", "spec.unschedulable") == true',
  )
  // The drain trigger the node drainer actually waits for: an annotation, whose
  // WITHDRAWAL must wake it as surely as its arrival.
  const withdrawn = String(fieldNoLonger(node, 'metadata.annotations.drain', 'true'))
  expect(withdrawn).toContain('/api/v1/nodes/worker-1')
  expect(withdrawn).toContain('.exists')
})

// ⭐ ***AND IT TAKES A NUMBER, BECAUSE `status.readyReplicas` IS OMITTED AT
// ZERO.*** `fieldNoLonger` was string|boolean only, so a numeric field that
// Kubernetes DELETES rather than writing 0 had no builder that could fire on its
// absence - and zero is exactly the state a watchdog exists to catch.
//
// MEASURED LIVE, not reasoned: `examples/.../sentinel.ts` parked on
// `fieldNe(dep, 'status.readyReplicas', 1)`; scaling that Deployment to 0 left a
// `status` of only `conditions`, `observedGeneration` and `terminatingReplicas`,
// so the Get read ABSENT, propagated UNKNOWN, and the park did not fire. The
// program caught it on its 60s timer instead - correct, late, and subscribed to
// something it could never be woken by.
test('fieldNoLonger takes a NUMBER and keeps the !exists half', () => {
  const dep = path.ns('default').deployments('api')
  const r = String(fieldNoLonger(dep, 'status.readyReplicas', 1))

  // The absence half must be there, or this is `fieldNe` with extra steps and
  // the scale-to-zero case is invisible again.
  expect(r).toContain('.exists')
  expect(r).toContain('||')
  // A NUMERIC comparison, unquoted - `!= "1"` would compare against a string and
  // never match an integer field.
  expect(r).toContain('!= 1')
  expect(r).not.toContain('!= "1"')
})

// The string arm must be unchanged by the widening - a quoted comparison, not a
// bare one, or every annotation park silently starts comparing against a number.
test('widening fieldNoLonger to numbers left the string arm quoted', () => {
  const n = path.nodes('n1')
  const r = String(fieldNoLonger(n, 'metadata.annotations["k"]', 'true'))
  expect(r).toContain('!= "true"')
  expect(r).toContain('.exists')
})
