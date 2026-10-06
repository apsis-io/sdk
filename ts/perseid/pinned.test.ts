// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test'
import { allOf, fieldIs, fieldNoLonger, path, pinned, quiesce } from './perseid.js'
import { readsOf, clusterReadsOf } from './resume.js'
import { field, select } from './field.js'

// THE chain the Pinned Trace pattern was designed on: a Pod -> PVC -> PV
// scalar-edge chain, each hop resolved while the step was awake.
const POD = path.ns('default').pods('app-1')
const PVC = path.ns('default').core('v1', 'persistentvolumeclaims', 'data-vol')
const PV = path.clusterCore('v1', 'persistentvolumes', 'pvc-84df12')

const claimField = field(
  'spec',
  'volumes',
  select('name', 'data'),
  'persistentVolumeClaim',
  'claimName',
)

const trace = pinned(
  [
    { path: POD, field: claimField, value: 'data-vol' },
    { path: PVC, field: 'spec.volumeName', value: 'pvc-84df12' },
  ],
  fieldIs(PV, 'status.phase', 'Bound'),
)

test('the pinned trace renders every hop as a fieldNoLonger guard over a literal path', () => {
  expect(String(trace)).toBe(
    `((!Get("/api/v1/namespaces/default/pods/app-1", "${claimField}").exists) || (Get("/api/v1/namespaces/default/pods/app-1", "${claimField}") != "data-vol")) && ((!Get("/api/v1/namespaces/default/persistentvolumeclaims/data-vol", "spec.volumeName").exists) || (Get("/api/v1/namespaces/default/persistentvolumeclaims/data-vol", "spec.volumeName") != "pvc-84df12")) && (Get("/api/v1/persistentvolumes/pvc-84df12", "status.phase") == "Bound")`,
  )
})

// ⛔ ***THE LIVENESS PROOF.*** A bare `==` edge guard reads ABSENT when the
// hop's object is deleted, absent propagates UNKNOWN, and the conjunction
// never fires - the park sleeps through the edit that invalidates the trace.
// Every hop arm here must carry the `!exists ||` half so deletion WAKES.
test('every hop guard wakes on deletion, not only on re-pointing', () => {
  const text = String(trace)
  const guards = text.split(' && ').slice(0, -1)
  expect(guards.length).toBe(2)
  for (const g of guards) {
    expect(g).toContain('.exists')
    expect(g).toContain('||')
    // No arm may be a bare comparison - that is the silent-park bug.
    expect(g.startsWith('((!Get(')).toBe(true)
  }
})

test('a numeric hop renders through the numeric comparator, unquoted', () => {
  const r = String(
    pinned([{ path: PVC, field: 'status.capacity.storage', value: 10 }], fieldIs(PV, 'status.phase', 'Bound')),
  )
  expect(r).toContain('!= 10')
  expect(r).not.toContain('"10"')
})

test('zero hops is the bare target, still parenthesised by the conjunction', () => {
  expect(String(pinned([], fieldIs(PV, 'status.phase', 'Bound')))).toBe(
    '(Get("/api/v1/persistentvolumes/pvc-84df12", "status.phase") == "Bound")',
  )
})

// ⭐ ***THE SUBSCRIBE-EVERY-HOP PROOF.*** The static walk collects literal Get
// targets; if a hop were hidden - behind a variable, a computed path, anything
// - it would be missing here and the park would poll while looking subscribed.
test('readsOf names all three objects of the chain', () => {
  const reads = readsOf(trace)
  for (const p of [String(POD), String(PVC), String(PV)]) {
    expect(reads).toContain(p)
  }
  // The PV is cluster-scoped; the other two are not.
  expect(clusterReadsOf(trace)).toEqual([String(PV)])
})

test('a pinned trace quiesces into an outcome carrying the guarded resume', () => {
  const outcome = quiesce(trace)
  if (outcome.o !== 'quiesce') throw new Error('a pinned trace parks, it does not yield')
  expect(String(outcome.resume)).toBe(String(trace))
})

// The root guard of a SET hop composes the same way; golden lives beside the
// other set parks in setpark.test.ts.
test('the root-guard composition is itself a pinned trace shape', () => {
  const dep = path.ns('default').deployments('frontend')
  const r = allOf(fieldNoLonger(dep, 'metadata.generation', 5))
  expect(String(r)).toBe(
    `((!Get("/apis/apps/v1/namespaces/default/deployments/frontend", "metadata.generation").exists) || (Get("/apis/apps/v1/namespaces/default/deployments/frontend", "metadata.generation") != 5))`,
  )
})
