// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Runtime invariants for the TypeScript SDK.
//
// ═══════════════════════════════════════════════════════════════════════════
// Two entry points, one contract:
//
//   invariant(cond, schema, value)  — asserts `value` satisfies the TypeBox
//     schema `schema`; throws InvariantError otherwise. Use where a broken
//     assumption is a BUG in this code, not bad input: crossing a trust
//     boundary the type system cannot see, or pinning a shape the compiler
//     was asked to take on faith.
//
//   check(schema, value)            — same validation, result instead of
//     throw. Use at edges where bad data is the CALLER's bug and must be
//     reported, not crashed on.
//
// The condition is checked by TypeBox (compile(): the same checker
// `bun:test` and Fastify users share), not by hand-written guards, so a
// schema and its invariant can never drift apart.
//
// ADR-0075 invariant 5 ("a park must say what would change its mind") is the
// house style this module follows: an assertion that cannot say what broke
// is not worth throwing. InvariantError therefore carries the type errors,
// not just a boolean.
// ═══════════════════════════════════════════════════════════════════════════

import { type Static, type TSchema, type TObject } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

/** Error thrown by {@link invariant} when `value` fails `schema`. */
export class InvariantError extends Error {
	/** The TypeBox errors describing exactly what failed. */
	readonly errors: string[]
	/** The JSON-Schema form of the schema that was violated. */
	readonly schema: unknown
	/** The rejected value. */
	readonly value: unknown

	constructor(schema: TSchema, value: unknown, errors: string[]) {
		super(`invariant failed: ${errors.join('; ')}`)
		this.name = 'InvariantError'
		this.errors = errors
		this.schema = schema
		this.value = value
	}
}

/**
 * Validate `value` against `schema` without throwing.
 *
 * @returns the TypeBox errors, empty when the value satisfies the schema.
 */
export function check<T extends TSchema>(schema: T, value: unknown): string[] {
	const iterator = Value.Errors(schema, value)

	return [...iterator].map(error => `${error.path}: ${error.message}`)
}

/**
 * Assert `value` satisfies the TypeBox `schema`, or throw {@link InvariantError}.
 *
 * This is the typed assertion: after it, TypeScript narrows `value` to
 * `Static<T>`, so the runtime check and the compile-time type come from the
 * single source of truth.
 *
 * @param schema - TypeBox schema describing the value's required shape.
 * @param value - The value to check; treated as `Static<T>` afterwards.
 * @throws {InvariantError} with the TypeBox errors when the check fails.
 */
export function invariant<T extends TObject>(
	schema: T,
	value: unknown,
): asserts value is Static<T> {
	const errors = check(schema, value)
	if (errors.length !== 0) {
		throw new InvariantError(schema, value, errors)
	}
}
