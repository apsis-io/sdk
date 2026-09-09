// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ***EVERY TEST HERE IS AN OMITTED FIELD.*** The types are erased and untestable;
// what can be wrong is which default a missing field means, and each one is wrong
// in a different direction. The fixtures are the shapes the apiserver actually
// emits - a Deployment with no `readyReplicas` key at all, a schedulable Node
// with no `unschedulable` key - because that is the case every inline reader in
// this repo got to decide for itself.

import { test } from 'bun:test'
import {
  type Deployment,
  asConfigMap,
  asDeployment,
  asNode,
  conditionStatus,
  isReady,
  readyReplicas,
  unschedulable,
  wantedReplicas,
} from './k8s.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function runtimeGuards(): void {
  // ═══════════════════════════════════════════════════════════════════════
  // The three defaults, and each one's WRONG value.
  // ═══════════════════════════════════════════════════════════════════════

  // ⛔ ABSENT `spec.replicas` IS 1. Zero would make a fully-down single-replica
  // Deployment look satisfied - the verdict inverts.
  assert(wantedReplicas({}) === 1, `absent spec.replicas must default to 1, got ${wantedReplicas({})}`)
  assert(wantedReplicas({ spec: {} }) === 1, 'an empty spec must still default to 1')
  assert(wantedReplicas({ spec: { replicas: 0 } }) === 0,
    'an EXPLICIT 0 must survive - scaled-to-zero is a real declaration, not a missing field')

  // ⛔ ABSENT `status.readyReplicas` IS 0, and this is the exact shape the
  // apiserver emits for a workload with nothing ready.
  const down: Deployment = { spec: { replicas: 2 }, status: { replicas: 2 } }
  assert(readyReplicas(down) === 0, `absent readyReplicas must be 0, got ${readyReplicas(down)}`)
  assert(readyReplicas(down) !== wantedReplicas(down),
    'a fully-down Deployment read as satisfied - the two defaults collapsed into one')

  // ⛔ ABSENT `spec.unschedulable` IS false: Kubernetes omits it on a
  // schedulable node rather than writing false.
  assert(unschedulable({}) === false, 'an absent unschedulable must read schedulable')
  assert(unschedulable({ spec: { unschedulable: true } }) === true, 'a cordoned node must read cordoned')

  // ***THE RAW FIELD MUST STILL BE REACHABLE, OR THE DEFAULTS ARE A TRAP OF
  // THEIR OWN.*** execcheck.ts projects `readyReplicas ?? null` onto a wire a
  // CHILD parses; defaulting there would invent an observation the apiserver
  // never made. The type keeps the optional, so absent stays distinguishable.
  assert(down.status?.readyReplicas === undefined,
    'the raw optional was lost - a caller can no longer tell absent from zero')

  // ═══════════════════════════════════════════════════════════════════════
  // Conditions: by TYPE, three-valued, order-independent.
  // ═══════════════════════════════════════════════════════════════════════
  const conds = [
    { type: 'Progressing', status: 'True' as const },
    { type: 'Ready', status: 'False' as const },
  ]
  assert(conditionStatus(conds, 'Ready') === 'False',
    'searched by position rather than type - condition ORDER IS NOT API')
  assert(conditionStatus(conds, 'Absent') === undefined, 'a missing condition must be undefined')
  assert(conditionStatus(undefined, 'Ready') === undefined, 'no conditions at all must be undefined')

  // ⛔ `Unknown` IS NOT `false`. Collapsing it reports a machine down because a
  // controller has not decided yet.
  assert(isReady([{ type: 'Ready', status: 'True' }]) === true, 'Ready=True must be true')
  assert(isReady([{ type: 'Ready', status: 'False' }]) === false, 'Ready=False must be false')
  assert(isReady([{ type: 'Ready', status: 'Unknown' }]) === null,
    'Ready=Unknown collapsed to a boolean - the third value is the whole point')
  assert(isReady([]) === null, 'no Ready condition must be null, not false')
  const unknown = isReady([{ type: 'Ready', status: 'Unknown' }])
  const missing = isReady([])
  assert(unknown === missing,
    'Unknown and absent must agree: a program has not been told in either case')

  // ═══════════════════════════════════════════════════════════════════════
  // Decoders. `null` is "not that object", which `reader` maps to `unknown`.
  // ═══════════════════════════════════════════════════════════════════════
  const d = asDeployment('{"spec":{"replicas":3}}')
  assert(d !== null && wantedReplicas(d) === 3, 'a well-formed Deployment did not decode')
  assert(asDeployment('not json') === null, 'a malformed body must be null, never a partial object')

  // ⚠ A JSON SCALAR OR ARRAY IS WELL-FORMED AND IS NOT AN OBJECT. Casting one
  // through would hand every accessor `undefined` and read as a Deployment with
  // no spec - indistinguishable from a real one at its defaults.
  for (const body of ['7', '"a string"', 'null', '[]', '[{"spec":{}}]']) {
    assert(asDeployment(body) === null, `${body} decoded as an object`)
  }

  const n = asNode('{"spec":{"unschedulable":true}}')
  assert(n !== null && unschedulable(n) === true, 'a Node did not decode')
  assert(asConfigMap('{"data":{"k":"v"}}')?.data?.k === 'v', 'a ConfigMap did not decode')

  // The defaults must hold through a DECODE, not only on a literal - that is the
  // path a program actually takes.
  const bare = asDeployment('{"metadata":{"name":"x"}}')
  assert(bare !== null, 'a bare object did not decode')
  assert(wantedReplicas(bare) === 1 && readyReplicas(bare) === 0,
    'the defaults did not survive the decode')
}

test('k8s.test.ts: runtime guards pass', () => {
  runtimeGuards()
})
