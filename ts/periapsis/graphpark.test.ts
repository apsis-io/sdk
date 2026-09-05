// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import { ownedBy, nodeOf } from './expr'
import { fieldNe, objectExists, objectGone, path, quiesce } from './perseid'

// ═══════════════════════════════════════════════════════════════════════════
// ***A STEP CAN PARK ON A TRAVERSAL.***
//
// The object-graph edges landed in aperture, were tested there, and were
// UNREACHABLE from a program: `expr.ts` accepted `ApiPath | Expr<'path'>` while
// the step-side resume helpers narrowed it back to `ApiPath`. A park is the only
// place a program ever writes a resume, so the mechanism had no possible user.
//
// These assert the RENDERED TEXT, because that string is what the host parses -
// a helper that accepted an edge and emitted the wrong thing would type-check
// and fail at evaluation, which is a park that never holds.
// ═══════════════════════════════════════════════════════════════════════════

const pod = path.ns('default').pods('web-7d9f')

test('a park can compare a field of the OWNER', () => {
  expect(String(fieldNe(ownedBy(pod), 'spec.replicas', 3))).toBe(
    'Get(OwnedBy("/api/v1/namespaces/default/pods/web-7d9f"), "spec.replicas") != 3',
  )
})

test('a park can ask whether the traversal resolves at all', () => {
  // `objectExists` reads `metadata.name`, so an unowned pod makes the whole
  // expression ABSENT rather than false - which is the three-valued behaviour
  // the aperture guarantees and the reason this is expressible at all.
  expect(String(objectExists(ownedBy(pod)))).toContain('OwnedBy(')
  expect(String(objectGone(ownedBy(pod)))).toContain('OwnedBy(')
})

test('edges compose, and the park still reads as one expression', () => {
  expect(String(fieldNe(ownedBy(ownedBy(pod)), 'spec.replicas', 1))).toBe(
    'Get(OwnedBy(OwnedBy("/api/v1/namespaces/default/pods/web-7d9f")), "spec.replicas") != 1',
  )
})

test('quiesce accepts a traversal park, so a step can actually return one', () => {
  // ***THE ARM THAT MAKES THE REST MEAN ANYTHING.*** The helpers could render
  // correctly and still be unusable if `quiesce` refused the Resume they
  // produce - which is exactly the shape the narrowing created.
  const outcome = quiesce(fieldNe(ownedBy(pod), 'spec.replicas', 3))
  expect(outcome.o).toBe('quiesce')
})

test('nodeOf renders, and its CLUSTER path is the constraint worth remembering', () => {
  // ⛔ This is expressible and usually NOT usable: a Node is cluster-scoped, so
  // reading it needs `observe-cluster` AND the node named in `spec.reads`. A
  // program can only traverse to a machine it declared in advance - which
  // "whichever node my pod landed on" cannot do. `ownedBy` has no such limit,
  // because an owner is namespaced.
  expect(String(fieldNe(nodeOf(pod), 'spec.unschedulable', 1))).toBe(
    'Get(NodeOf("/api/v1/namespaces/default/pods/web-7d9f"), "spec.unschedulable") != 1',
  )
})
