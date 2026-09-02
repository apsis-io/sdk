// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Guards for the AUTODERIVED resume.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***THE DEFECT THIS EXISTS FOR IS A PROGRAM THAT IS CORRECTLY ASLEEP ON THE
// WRONG OBJECT.*** A hand-written resume names the object a second time:
//
//	const deployment = path.ns('default').deployments('api')   // OBSERVED
//	const workload   = 'api'                                   // PARKED ON
//
// Nothing relates them. Edit the path and the program reads the new deployment
// and parks on the old one - awake for changes it no longer reads, asleep
// through every change it does. `quiesce` returns nothing to the guest and the
// host cannot know the two were meant to agree, so the failure is invisible from
// both sides.
//
// The equivalence test below is the one that says autoderivation CHANGED
// NOTHING; the divergence test is the one that says it changed the thing it was
// supposed to.
// ═══════════════════════════════════════════════════════════════════════════

import { expect, test, describe } from 'bun:test'
import { path, untilDrift, workloadOf, fieldNe, countNeField, anyOf } from './perseid'

const D = '/apis/apps/v1/namespaces/default/deployments/api'

describe('workloadOf', () => {
  test('reads the name back out of the path that was observed', () => {
    expect(workloadOf(path.ns('default').deployments('api'))).toBe('api')
    expect(workloadOf(path.ns('kube-system').deployments('coredns'))).toBe('coredns')
  })

  // A path this cannot read must not produce a plausible guess: an expression
  // built from one parses, evaluates, and watches the wrong object - which is
  // precisely the failure autoderivation removes, reintroduced by the mechanism
  // meant to remove it.
  test('refuses a path it has no derivation for, and names the alternative', () => {
    const pods = path.ns('default').pods('api-7d9f')
    expect(() => workloadOf(pods)).toThrow(/not a deployment path/)
    expect(() => workloadOf(pods)).toThrow(/podExists/)
  })
})

describe('untilDrift', () => {
  // ***THE EQUIVALENCE ARM.*** Autoderivation is only adoptable if it emits what
  // a correct hand-written resume emitted; otherwise every existing program's
  // wake behaviour changes silently on upgrade.
  test('emits exactly what the hand-written resume emitted', () => {
    const deployment = path.ns('default').deployments('api')
    expect(untilDrift(deployment, 2)).toBe(fieldNe(deployment, 'spec.replicas', 2))
    expect(String(untilDrift(deployment, 2))).toBe(`Get("${D}", "spec.replicas") != 2`)
  })

  // ***THE ARM THAT IS THE WHOLE POINT.*** Under the old shape the path moved
  // and the resume did not. Here they cannot move apart, because there is only
  // one of them.
  test('follows the path when the path changes', () => {
    const before = untilDrift(path.ns('default').deployments('api'), 2)
    const after = untilDrift(path.ns('default').deployments('api-v2'), 2)

    expect(before).not.toBe(after)
    expect(String(after)).toContain('api-v2')

    // And the control that shows the OLD shape really was broken: a resume
    // written against a stale name is unchanged by the path moving, which is
    // what made the defect invisible.
    const handWritten = fieldNe(path.ns('default').deployments('api'), 'spec.replicas', 2)
    expect(handWritten).toBe(before)
    expect(handWritten).not.toBe(after)
  })

  test('parks on the value observed, not on a restated constant', () => {
    const deployment = path.ns('default').deployments('api')
    expect(String(untilDrift(deployment, 5))).toBe(`Get("${D}", "spec.replicas") != 5`)
    expect(String(untilDrift(deployment, 0))).toBe(`Get("${D}", "spec.replicas") != 0`)
  })
})

describe('a derived resume composes with explicit clauses', () => {
  // Autoderivation answers "wake when what I read changes" and nothing else. A
  // second claim - that the pod census should track the desired count - is not
  // implied by the observation, so it stays explicit. This asserts the composed
  // form is what the worked example prints, which is what makes the example's
  // output a regression test rather than a demo.
  test('matches the expression sugar.ts publishes', () => {
    const deployment = path.ns('default').deployments('api')
    const composed = anyOf(untilDrift(deployment, 2), countNeField('app=api', deployment))

    expect(String(composed)).toBe(
      `(Get("${D}", "spec.replicas") != 2) || (ListPods("app=api").length != Get("${D}", "spec.replicas"))`,
    )
  })
})
