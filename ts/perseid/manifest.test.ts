// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test'
import { perseidTS, toYaml, type PerseidTSManifest, type PerseidTSManifestInput } from './manifest.js'

// ⭐ ***EVERY GOLDEN IS ALSO PARSE-BACK VERIFIED.*** The text pins the layout;
// Bun.YAML.parse proves the same bytes read back as the object that went in -
// a golden that renders pretty but parses wrong would die here, not in
// someone's `kubectl apply`.
const roundTrips = (m: PerseidTSManifest): void => {
  expect(Bun.YAML.parse(toYaml(m))).toEqual(JSON.parse(JSON.stringify(m)))
}

// ***THE GOLDENS ARE THE CONTRACT WITH kubectl.*** This module is the first
// producer of PerseidTS manifests anywhere - the CRD is the only other voice -
// so the rendered text is pinned exactly, and every refusal quotes the words
// admission itself uses.

const minimal = (): PerseidTSManifestInput => ({
  metadata: { name: 'canary', namespace: 'prod' },
  spec: { step: 'export function* run() {}\n' },
})

test('the minimal inline manifest renders in CRD presentation order', () => {
  const m = perseidTS(minimal())
  roundTrips(m)
  expect(toYaml(m)).toBe(
    `apiVersion: perseid.apsis/v1
kind: PerseidTS
metadata:
  name: canary
  namespace: prod
spec:
  step: |
    export function* run() {}
`,
  )
})

test('the stepRef form renders the image coordinate bare - Bun.YAML knows sha256:abcd is colon-safe', () => {
  const m = perseidTS({
    metadata: { name: 'canary', namespace: 'prod' },
    spec: { stepRef: { image: 'registry.example/ops/canary@sha256:abcd' } },
  })
  roundTrips(m)
  expect(toYaml(m)).toBe(
    `apiVersion: perseid.apsis/v1
kind: PerseidTS
metadata:
  name: canary
  namespace: prod
spec:
  stepRef:
    image: registry.example/ops/canary@sha256:abcd
`,
  )
})

test('the full field set renders labels sorted and optionals in place', () => {
  const m = perseidTS({
    metadata: {
      name: 'scaler',
      namespace: 'prod',
      labels: { tier: 'web', 'app.kubernetes.io/name': 'scaler' },
      annotations: { 'perseid.apsis.io/capabilities': 'observe,ensure' },
    },
    spec: { step: 'export function* run() {}\n', backstopMs: 90000, suspend: false },
  })
  roundTrips(m)
  expect(toYaml(m)).toBe(
    `apiVersion: perseid.apsis/v1
kind: PerseidTS
metadata:
  name: scaler
  namespace: prod
  labels:
    app.kubernetes.io/name: scaler
    tier: web
  annotations:
    perseid.apsis.io/capabilities: "observe,ensure"
spec:
  step: |
    export function* run() {}
  backstopMs: 90000
  suspend: false
`,
  )
})

// ⛔ ***THE HOSTILE SOURCE IS THE ROUND-TRIP PROOF.*** The manifest is the
// code: quotes, comment lines, a document separator, a `key: value` line, an
// empty line and a missing trailing newline must all come back as the bytes
// that went in - which is why the chomping indicator is DECIDED BY THE SOURCE
// (`|-` here, `|` for clip, `|+` for keep) and never chosen for tidiness.
test('a hostile step source survives the literal block byte for byte', () => {
  const source = [
    'export function* run() {',
    '  // has "quotes" and a # comment',
    '  ---',
    '',
    '  key: value',
    '  done}',
  ].join('\n')
  const m = perseidTS({ metadata: { name: 'warden', namespace: 'prod' }, spec: { step: source } })
  roundTrips(m)
  const yaml = toYaml(m)
  expect(yaml).toBe(
    `apiVersion: perseid.apsis/v1
kind: PerseidTS
metadata:
  name: warden
  namespace: prod
spec:
  step: |-
    export function* run() {
      // has "quotes" and a # comment
      ---

      key: value
      done}
`,
  )
})

test('multiple trailing newlines keep-chomp so the source is not silently clipped', () => {
  const yaml = toYaml(perseidTS({ metadata: { name: 'a', namespace: 'b' }, spec: { step: 'x\n\n' } }))
  expect(yaml).toContain('step: |+')
  expect(yaml).toContain('    x\n\n')
})

// The refusals quote admission's own words where the host has words
// (ParseStepSource) and name the rule where it does not (field.ts's select).
test('the refusals', () => {
  const meta = { name: 'canary', namespace: 'prod' }
  expect(() =>
    perseidTS({ metadata: meta, spec: { step: 'x', stepRef: { image: 'y' } } as unknown as PerseidTSManifestInput['spec'] }),
  ).toThrow('spec.step and spec.stepRef are mutually exclusive; set one.')
  expect(() => perseidTS({ metadata: meta, spec: {} as PerseidTSManifestInput['spec'] })).toThrow(
    'neither spec.step nor spec.stepRef is set - a manifest with no program is not a program.',
  )
  expect(() => perseidTS({ metadata: meta, spec: { step: '' } })).toThrow(
    'neither spec.step nor spec.stepRef is set',
  )
  expect(() => perseidTS({ metadata: { name: 'Canary', namespace: 'prod' }, spec: { step: 'x' } })).toThrow(
    'DNS-1123 subdomain',
  )
  expect(() => perseidTS({ metadata: { name: 'canary', namespace: 'pro.d' }, spec: { step: 'x' } })).toThrow(
    'DNS-1123 label',
  )
  expect(() =>
    perseidTS({ metadata: meta, spec: { step: 'x', backstopMs: 0 } }),
  ).toThrow('0 is the operator default in the CRD; omit the field to say that.')
  expect(() =>
    perseidTS({ metadata: meta, spec: { step: 'x', backstopMs: 1.5 } }),
  ).toThrow('positive integer')
  expect(() =>
    perseidTS({ metadata: meta, spec: { step: 'x', suspend: 'yes' } as unknown as PerseidTSManifestInput['spec'] }),
  ).toThrow('spec.suspend must be a boolean.')
})

test('the built object is JSON-ready as-is', () => {
  const m = perseidTS(minimal())
  const parsed = JSON.parse(JSON.stringify(m))
  expect(parsed).toEqual({
    apiVersion: 'perseid.apsis/v1',
    kind: 'PerseidTS',
    metadata: { name: 'canary', namespace: 'prod' },
    spec: { step: 'export function* run() {}\n' },
  })
})

const _typeLevelOnly = () =>
  perseidTS({
    metadata: { name: 'canary', namespace: 'prod' },
    // @ts-expect-error - both forms at once is the admission refusal, enforced
    // by the type before any runtime sees it
    spec: { step: 'x', stepRef: { image: 'y' } },
  })
void _typeLevelOnly
