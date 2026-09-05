// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import {
  objectsIn,
  asObject,
  nameOf,
  nodeNameOf,
  phaseOf,
  ownersOf,
  controllerOf,
  onNode,
  childrenOf,
  type K8sObject,
} from './collection.js'

const pod = (o: unknown): K8sObject => o as K8sObject

test('a collection body decodes to its items', () => {
  expect(objectsIn('[{"a":1},{"b":2}]')).toHaveLength(2)
  expect(objectsIn('[]')).toEqual([])
})

// ***A BODY THAT IS NOT AN ARRAY IS NULL, NOT AN EMPTY LIST.*** An empty list is
// a fact about the cluster ("nothing matched") and null is a fault; collapsing
// them makes a broken read indistinguishable from a drained node.
test('a non-array or unparseable body is refused rather than read as empty', () => {
  for (const bad of ['{not json', '{"items":[]}', 'null', '7', '"[]"']) {
    expect(objectsIn(bad)).toBeNull()
  }
})

// The items stay RAW so the caller decides what a malformed entry means - a
// drainer counts it as still-there, a reporter may skip it.
test('items are returned unfiltered and asObject sees what is skippable', () => {
  const items = objectsIn('[{"a":1},null,7,[]]')
  expect(items).toHaveLength(4)
  expect(items!.map((i) => asObject(i) !== null)).toEqual([true, false, false, false])
})

test('the field readers distinguish absent from present', () => {
  expect(nameOf(pod({ metadata: { name: 'web' } }))).toBe('web')
  expect(nameOf(pod({ metadata: {} }))).toBeNull()
  expect(nameOf(pod({}))).toBeNull()
  // An EMPTY string is not a name. It would compare equal to a missing field in
  // some places and not others, which is the kind of difference that survives
  // review and fails once.
  expect(nameOf(pod({ metadata: { name: '' } }))).toBeNull()
  expect(phaseOf(pod({ status: { phase: 'Succeeded' } }))).toBe('Succeeded')
  expect(phaseOf(pod({ status: {} }))).toBeNull()
})

// ⚠ AN UNSCHEDULED POD HAS NO NODE. `spec.nodeName` is empty until the scheduler
// places it, and reading that as a node acts on the wrong machine.
test('an unscheduled pod has no node', () => {
  expect(nodeNameOf(pod({ spec: { nodeName: 'worker-1' } }))).toBe('worker-1')
  expect(nodeNameOf(pod({ spec: { nodeName: '' } }))).toBeNull()
  expect(nodeNameOf(pod({ spec: {} }))).toBeNull()
})

test('malformed ownerReferences are skipped, not guessed at', () => {
  const o = pod({
    metadata: {
      ownerReferences: [null, { kind: 'ReplicaSet' }, { name: 'x' }, { kind: 'Job', name: 'j' }],
    },
  })
  expect(ownersOf(o)).toEqual([{ kind: 'Job', name: 'j', controller: false }])
  expect(ownersOf(pod({ metadata: { ownerReferences: 'nope' } }))).toEqual([])
  expect(ownersOf(pod({}))).toEqual([])
})

// ⛔ THE CONTROLLER IS NOT INDEX ZERO. Taking the first reference follows a
// different edge with the same shape, and both are named `ownerReferences`.
test('controllerOf picks the controlling reference and not the first', () => {
  const o = pod({
    metadata: {
      ownerReferences: [
        { kind: 'Decoy', name: 'first' },
        { kind: 'ReplicaSet', name: 'web-7d9f8', controller: true },
      ],
    },
  })
  expect(controllerOf(o)).toEqual({ kind: 'ReplicaSet', name: 'web-7d9f8', controller: true })
  // ...and no controlling reference is null rather than a fallback to index 0,
  // or the assertion above passes on an implementation that always takes one.
  expect(controllerOf(pod({ metadata: { ownerReferences: [{ kind: 'D', name: 'f' }] } }))).toBeNull()
})

const onA = { metadata: { name: 'a' }, spec: { nodeName: 'n1' } }
const onB = { metadata: { name: 'b' }, spec: { nodeName: 'n2' } }
const unscheduled = { metadata: { name: 'c' }, spec: {} }

test('onNode selects one machine and excludes the unscheduled', () => {
  const items = [onA, onB, unscheduled] as K8sObject[]
  expect(onNode(items, 'n1').map(nameOf)).toEqual(['a'])
  expect(onNode(items, 'n2').map(nameOf)).toEqual(['b'])
  // An unscheduled pod belongs to no node, so no node name selects it - `''`
  // least of all, which is what a naive equality would match.
  expect(onNode(items, '')).toEqual([])
})

const owned = (name: string, kind: string, owner: string, controller = true) => ({
  metadata: { name, ownerReferences: [{ kind, name: owner, controller }] },
})

test('childrenOf follows the controlling edge exactly', () => {
  const items = [
    owned('p1', 'ReplicaSet', 'web-1'),
    owned('p2', 'ReplicaSet', 'web-2'),
    owned('p3', 'StatefulSet', 'web-1'),
    // Owned by the right thing but NOT controlled by it.
    owned('p4', 'ReplicaSet', 'web-1', false),
  ] as K8sObject[]

  expect(childrenOf(items, { kind: 'ReplicaSet', name: 'web-1' }).map(nameOf)).toEqual(['p1'])
  // ***KIND IS COMPARED EXACTLY.*** An ownerReference carries the Kind spelling,
  // so a wrong capital is an owner that silently never resolves - which reads as
  // "this workload owns nothing" rather than as an error.
  expect(childrenOf(items, { kind: 'replicaset', name: 'web-1' })).toEqual([])
})

// The two edges compose, which is the point of calling them a graph.
test('the edges compose: the pods a workload owns, on one machine', () => {
  const items = [
    { ...owned('p1', 'ReplicaSet', 'web-1'), spec: { nodeName: 'n1' } },
    { ...owned('p2', 'ReplicaSet', 'web-1'), spec: { nodeName: 'n2' } },
  ] as K8sObject[]

  expect(onNode(childrenOf(items, { kind: 'ReplicaSet', name: 'web-1' }), 'n1').map(nameOf)).toEqual(
    ['p1'],
  )
})
