// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test'
import { objects } from './perseid.js'
import type { CreateArgs } from './perseid.js'

const NS = objects.ns('default')

// ⭐ THE GAP THE ACME-DNS SHOWCASE EXPOSED (kinetics-main, 2026-10-18): no
// branded route reached a core-kind object - `resource('')` rendered
// `/apis//v1/...`, a path no apiserver serves, so a program could not create
// the Service it supervised and shipped it as a static companion manifest.
// `service` is the well-known entry; `core` is the escape hatch's twin; the
// empty group is refused with the fix named.
test('service rides the core prefix, not /apis', () => {
  expect(String(NS.service('acme-dns').path)).toBe('/api/v1/namespaces/default/services/acme-dns')
})

test('service.spec renders ports, the FLAT selector, and every optional given', () => {
  const { body } = NS.service('acme-dns').spec(
    {
      selector: { app: 'acme-dns' },
      ports: [
        { name: 'dns', port: 53, targetPort: 5353, protocol: 'UDP' },
        { port: 8080 },
      ],
      type: 'NodePort',
      clusterIP: 'None',
    },
    { labels: { tier: 'dns' } },
  )

  expect(JSON.parse(JSON.stringify(body))).toEqual({
    spec: {
      ports: [
        { name: 'dns', port: 53, targetPort: 5353, protocol: 'UDP' },
        { port: 8080 },
      ],
      selector: { app: 'acme-dns' },
      type: 'NodePort',
      clusterIP: 'None',
    },
    metadata: { labels: { tier: 'dns' } },
  })
})

// Absents STAY ABSENT: the apiserver defaults a Service (ClusterIP, the
// targetPort that equals port); a field this builder invents is a value the
// apiserver never defaulted to.
test('absent optionals stay absent - no invented defaults', () => {
  const { body } = NS.service('x').spec({ ports: [{ port: 53 }] })
  expect(JSON.parse(JSON.stringify(body))).toEqual({ spec: { ports: [{ port: 53 }] } })
})

test('core reaches any core-kind object through the /api prefix', () => {
  expect(String(NS.core('v1', 'services', 'x').path)).toBe('/api/v1/namespaces/default/services/x')
  expect(String(NS.core('v1', 'mycrs', 'y').path)).toBe('/api/v1/namespaces/default/mycrs/y')
})

test("resource('') is refused, not rendered as /apis//v1", () => {
  expect(() => NS.resource('', 'v1', 'services', 'x')).toThrow(/core group rides the \/api\/ prefix/)
  // A real group still builds, unchanged.
  expect(String(NS.resource('apps', 'v1', 'deployments', 'x').path)).toBe(
    '/apis/apps/v1/namespaces/default/deployments/x',
  )
})

// THE WIRE SHAPE: a kinded object is exactly the pair `CreateArgs` takes -
// path and body, brand and all, no cast in either direction. The verb is
// `apply` since create retired (engi, 2026-10-19); the args type kept its
// name and the pair is the same wire shape either way.
test('a service object is an apply() body with no casts', () => {
  const svc = NS.service('acme-dns').spec({
    selector: { app: 'a' },
    ports: [{ port: 53, targetPort: 'dns' }],
  })

  const args: CreateArgs = { path: svc.path, body: svc.body }
  expect(String(args.path)).toBe('/api/v1/namespaces/default/services/acme-dns')
})

// The TYPE-level refusals, in a function nothing calls - a negative probe
// cannot run under bun (the runtime has no types; the call would throw where
// the compile error is the assertion). The runtime twin lives in the test
// below.
export const _specIsTyped = () => {
  // @ts-expect-error - ports is required; a Service with no ports is not a Service
  NS.service('x').spec({})
  // @ts-expect-error - the port is a number, not the string that looks like one
  NS.service('x').spec({ ports: [{ port: '53' }] })
}

test('daemonset and statefulset build through the same kinded pairing', () => {
  expect(String(NS.daemonset('cilium').path)).toBe('/apis/apps/v1/namespaces/default/daemonsets/cilium')
  expect(String(NS.statefulset('phus').path)).toBe('/apis/apps/v1/namespaces/default/statefulsets/phus')
  expect(String(NS.serviceaccount('radiant').path)).toBe(
    '/api/v1/namespaces/default/serviceaccounts/radiant',
  )

  // DaemonSet: no replica count to spell - selector and template only.
  const ds = NS.daemonset('cilium').spec({
    selector: { app: 'cilium' },
    containers: [{ name: 'agent', image: 'cilium:1' }],
  })
  expect(JSON.parse(JSON.stringify(ds.body)).spec.selector).toEqual({ matchLabels: { app: 'cilium' } })

  // StatefulSet: the headless serviceName rides the spec; a bare replicas
  // number passes through and an expression is wrapped, like the Deployment's.
  const sts = NS.statefulset('phus').spec({
    serviceName: 'phus-headless',
    replicas: 3,
    selector: { app: 'phus' },
    containers: [{ name: 'phus', image: 'phus:1' }],
  })
  const stsSpec = JSON.parse(JSON.stringify(sts.body)).spec
  expect(stsSpec.serviceName).toBe('phus-headless')
  expect(stsSpec.replicas).toBe(3)
})

test('a portless Service is refused at runtime too - JS callers do not get the types', () => {
  expect(() => NS.service('x').spec({ ports: [] })).toThrow(/no ports is not a Service/)
  expect(() => (NS.service('x').spec as (s: unknown) => unknown)({})).toThrow(/no ports is not a Service/)
})
