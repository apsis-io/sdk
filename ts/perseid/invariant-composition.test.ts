// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test'
import { Type } from '@sinclair/typebox'
import { decodeInto, observeInto, tolerateUnknown } from './invariant-composition.js'
import { UnknownFeedsWriteError } from './invariant-composition.js'

const ReplicaView = Type.Object({
	replicas: Type.Integer({ minimum: 0 }),
	ready: Type.Integer({ minimum: 0 }),
})

describe('decodeInto', () => {
	const obs = observeInto(ReplicaView, 'deployment-status')

	test('a conforming payload decodes as known with the typed value', () => {
		const out = decodeInto(obs, { replicas: 3, ready: 3 })

		expect(out.kind).toBe('known')
		if (out.kind === 'known') {
			expect(out.value.replicas).toBe(3)
			expect(out.value.ready).toBe(3)
		}
	})

	test('a malformed payload lands in unknown with reasons, never absent', () => {
		const out = decodeInto(obs, { replicas: 'many', ready: 'none' })

		expect(out.kind).toBe('unknown')
		if (out.kind === 'unknown') {
			expect(out.reasons.length).toBeGreaterThan(0)
		}
	})

	test('an empty payload is absent - the peer said "not in my world"', () => {
		const out = decodeInto(obs, undefined)

		expect(out.kind).toBe('absent')
	})
})

describe('tolerateUnknown', () => {
	const obs = observeInto(ReplicaView, 'deployment-status')

	test('the wrapper marks the read without changing the schema', () => {
		const marked = tolerateUnknown(obs)

		expect(marked.tolerateUnknown).toBe(true)
		expect(marked.obs).toBe(obs)
	})
});

describe('UnknownFeedsWriteError', () => {
	test('carries the source name so the operator knows which read failed', () => {
		const err = new UnknownFeedsWriteError('deployment-status')

		expect(err.name).toBe('UnknownFeedsWriteError')
		expect(err.source).toBe('deployment-status')
		expect(err.message).toContain('tolerateUnknown')
	})
});