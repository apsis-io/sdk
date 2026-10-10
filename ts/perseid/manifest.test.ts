// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test'
import { perseid, toYaml, type PerseidManifest, type PerseidManifestInput } from './manifest.js'

// ***THE GOLDENS ARE THE CONTRACT WITH kubectl.*** This module is the only
// producer of kernel-Perseid manifests - the CRD is the only other voice - so
// the rendered text is pinned exactly, and every refusal quotes the words the
// host itself uses (ParseStepSource, the CRD's CEL, admission.go).
//
// ⭐ ***EVERY GOLDEN IS ALSO PARSE-BACK VERIFIED.*** The text pins the layout;
// Bun.YAML.parse proves the same bytes read back as the object that went in -
// a golden that renders pretty but parses wrong would die here, not in
// someone's `kubectl apply`.
const roundTrips = (m: PerseidManifest): void => {
  expect(Bun.YAML.parse(toYaml(m))).toEqual(JSON.parse(JSON.stringify(m)))
}

const minimal = (): PerseidManifestInput => ({
  metadata: { name: 'canary', namespace: 'prod' },
  spec: { step: 'export function* run() {}\n' },
})

test('the minimal inline manifest renders in CRD presentation order', () => {
  const m = perseid(minimal())
  roundTrips(m)
  expect(toYaml(m)).toBe(
    `apiVersion: perseid.apsis/v1
kind: Perseid
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
  const m = perseid({
    metadata: { name: 'canary', namespace: 'prod' },
    spec: { stepRef: { image: 'registry.example/ops/canary@sha256:abcd' } },
  })
  roundTrips(m)
  expect(toYaml(m)).toBe(
    `apiVersion: perseid.apsis/v1
kind: Perseid
metadata:
  name: canary
  namespace: prod
spec:
  stepRef:
    image: registry.example/ops/canary@sha256:abcd
`,
  )
})

test('the full field set renders engine, labels sorted and optionals in place', () => {
  const m = perseid({
    metadata: {
      name: 'scaler',
      namespace: 'prod',
      labels: { tier: 'web', 'app.kubernetes.io/name': 'scaler' },
      annotations: { 'perseid.apsis.io/capabilities': 'observe,ensure' },
    },
    spec: { step: 'export function* run() {}\n', engine: 'kinetics', backstopMs: 90000, suspend: false },
  })
  roundTrips(m)
  expect(toYaml(m)).toBe(
    `apiVersion: perseid.apsis/v1
kind: Perseid
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
  engine: kinetics
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
  const m = perseid({ metadata: { name: 'warden', namespace: 'prod' }, spec: { step: source } })
  roundTrips(m)
  const yaml = toYaml(m)
  expect(yaml).toBe(
    `apiVersion: perseid.apsis/v1
kind: Perseid
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
  const yaml = toYaml(perseid({ metadata: { name: 'a', namespace: 'b' }, spec: { step: 'x\n\n' } }))
  expect(yaml).toContain('step: |+')
  expect(yaml).toContain('    x\n\n')
})

// The refusals quote the host where the host has words (ParseStepSource minus
// its `stepref:` log prefix - the same sentences the CRD's CEL carries - and
// admission.go's engine sentence) and name the rule where it does not.
test('the refusals', () => {
  const meta = { name: 'canary', namespace: 'prod' }
  expect(() =>
    perseid({ metadata: meta, spec: { step: 'x', stepRef: { image: 'y' } } as unknown as PerseidManifestInput['spec'] }),
  ).toThrow('spec.step and spec.stepRef are mutually exclusive; set one')
  expect(() => perseid({ metadata: meta, spec: {} as PerseidManifestInput['spec'] })).toThrow(
    'neither spec.step nor spec.stepRef is set',
  )
  expect(() => perseid({ metadata: meta, spec: { step: '' } })).toThrow(
    'spec.step is missing or not a string - a Perseid object without a step (or component) is not a kernel program',
  )
  expect(() => perseid({ metadata: meta, spec: { step: 42 } as unknown as PerseidManifestInput['spec'] })).toThrow(
    'spec.step is missing or not a string',
  )
  expect(() => perseid({ metadata: { name: 'Canary', namespace: 'prod' }, spec: { step: 'x' } })).toThrow(
    'DNS-1123 subdomain',
  )
  expect(() => perseid({ metadata: { name: 'canary', namespace: 'pro.d' }, spec: { step: 'x' } })).toThrow(
    'DNS-1123 label',
  )
  expect(() =>
    perseid({ metadata: meta, spec: { step: 'x', backstopMs: 0 } }),
  ).toThrow('0 is the operator default in the CRD; omit the field to say that.')
  expect(() =>
    perseid({ metadata: meta, spec: { step: 'x', backstopMs: 1.5 } }),
  ).toThrow('positive integer')
  expect(() =>
    perseid({ metadata: meta, spec: { step: 'x', suspend: 'yes' } as unknown as PerseidManifestInput['spec'] }),
  ).toThrow('spec.suspend must be a boolean.')
})

// ⛔ THE ENGINE REFUSALS, WORD FOR WORD FROM admission.go. trail executes
// spec.component artifacts; a TS step naming it is refusing the kernel, and
// the builder says so before admission does. The enum is kinetics|trail -
// engi corrected the first relay's quickjs/wasmtime.
test('the engine refusals', () => {
  const meta = { name: 'canary', namespace: 'prod' }
  expect(() =>
    perseid({
      metadata: meta,
      spec: { step: 'x', engine: 'trail' } as unknown as PerseidManifestInput['spec'],
    }),
  ).toThrow(
    'spec.engine=trail cannot run this program - trail executes spec.component artifacts, not a TS step; omit spec.engine or declare kinetics',
  )
  expect(() =>
    perseid({
      metadata: meta,
      spec: { step: 'x', engine: 'v8' } as unknown as PerseidManifestInput['spec'],
    }),
  ).toThrow('spec.engine must be "kinetics" or "trail".')
})

test('the built object is JSON-ready as-is', () => {
  const m = perseid(minimal())
  const parsed = JSON.parse(JSON.stringify(m))
  expect(parsed).toEqual({
    apiVersion: 'perseid.apsis/v1',
    kind: 'Perseid',
    metadata: { name: 'canary', namespace: 'prod' },
    spec: { step: 'export function* run() {}\n' },
  })
})

const _typeLevelOnly = () =>
  perseid({
    metadata: { name: 'canary', namespace: 'prod' },
    // @ts-expect-error - both forms at once is the admission refusal, enforced
    // by the type before any runtime sees it
    spec: { step: 'x', stepRef: { image: 'y' } },
  })
void _typeLevelOnly
