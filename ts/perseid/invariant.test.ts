// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test'
import { Type, type Static } from '@sinclair/typebox'
import { check, invariant, InvariantError } from './invariant'

const Deployment = Type.Object({
	name: Type.String(),
	replicas: Type.Integer({ minimum: 0 }),
	labels: Type.Optional(Type.Record(Type.String(), Type.String())),
})

type Deployment = Static<typeof Deployment>

describe('invariant', () => {
	test('passes for a conforming value and narrows its type', () => {
		const input: unknown = { name: 'api', replicas: 3, labels: { tier: 'web' } }

		invariant(Deployment, input)

		// Compile-time proof of the narrowing: input is Static<typeof Deployment> here.
		const typed: Deployment = input
		expect(typed.replicas).toBe(3)
	})

	test('throws InvariantError carrying every TypeBox error', () => {
		const input: unknown = { name: 42, replicas: 'many' }

		expect(() => invariant(Deployment, input)).toThrow(InvariantError)

		try {
			invariant(Deployment, input)
			expect.unreachable()
		} catch (error) {
			const invariantError = error as InvariantError
			expect(invariantError.errors).toHaveLength(2)
			expect(invariantError.errors[0]).toContain('/name')
			expect(invariantError.errors[1]).toContain('/replicas')
			expect(invariantError.value).toEqual(input)
			expect(invariantError.schema).toEqual(Deployment)
			expect(invariantError.message).toContain('invariant failed')
		}
	})

	test('rejects unknown and missing members like TypeBox does', () => {
		// TypeBox default: additionalProperties is unrestricted, so extra keys pass.
		expect(() =>
			invariant(Deployment, { name: 'api', replicas: 0, extra: true }),
		).not.toThrow()

		// But a missing required member fails with its path in the errors.
		try {
			invariant(Deployment, { name: 'api' })
			expect.unreachable()
		} catch (error) {
			expect((error as InvariantError).errors[0]).toContain('/replicas')
		}
	})

	test('integer schema rejects floats at the exact boundary', () => {
		expect(() => invariant(Deployment, { name: 'api', replicas: 0 })).not.toThrow()
		expect(() => invariant(Deployment, { name: 'api', replicas: -1 })).toThrow(InvariantError)
		expect(() => invariant(Deployment, { name: 'api', replicas: 1.5 })).toThrow(InvariantError)
	})
})

describe('check', () => {
	test('returns no errors for a conforming value', () => {
		expect(check(Deployment, { name: 'api', replicas: 2 })).toEqual([])
	})

	test('returns the errors instead of throwing', () => {
		const errors = check(Deployment, { replicas: 4 })

		expect(errors.length).toBeGreaterThan(0)
		expect(errors[0]).toContain('/name')
		expect(() => check(Deployment, { replicas: 4 })).not.toThrow()
	})
})

describe('invariant guards a boundary the type system cannot see', () => {
	// The house case: data crossing the WASI boundary arrives as `unknown`.
	// The schema is the contract; invariant is the checkpoint.
	test('a host payload that satisfies the schema flows through as typed', () => {
		const decodeHostPayload = (payload: unknown): Deployment => {
			invariant(Deployment, payload)
			return payload
		}

		const deployment = decodeHostPayload('{\"name\":\"web\",\"replicas\":2}'.length > 0
			? JSON.parse('{\"name\":\"web\",\"replicas\":2}')
			: undefined)

		expect(deployment.name).toBe('web')
	})

	test('a malformed payload is rejected with reasons, not a stack of maybes', () => {
		const decodeHostPayload = (payload: unknown): Deployment => {
			invariant(Deployment, payload)
			return payload
		}

		expect(() => decodeHostPayload(JSON.parse('{\"name\":\"web\"}'))).toThrow(InvariantError)
		expect(() => decodeHostPayload('not an object')).toThrow(InvariantError)
	})
})
