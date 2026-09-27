// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// ═══════════════════════════════════════════════════════════════════════════
// The composition layer over invariant(): a named, inspectable read
// declaration bound to a TypeBox schema, and the invariant that refuses to
// let an unknown observation feed a write.
//
// ADDITIVE: nothing here changes the existing invariant()/check() exports.
// This file only names the two things a caller must not confuse:
//
//   - known: the peer answered and the value decoded - usable everywhere.
//   - unknown: the peer answered but the value failed the schema - usable in
//     reads, refused in writes unless tolerateUnknown() was called.
//   - absent: the peer said "not in my world" - never retried, never
//     conflated with the other two.
// ═══════════════════════════════════════════════════════════════════════════

import { type TSchema, type TObject, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { check, invariant } from './invariant.js'

/** A read declaration: a schema bound to a named observation source. */
export interface ObservationInto<T extends TSchema> {
	/** The TypeBox schema the decoded value must satisfy. */
	readonly schema: T
	/** The named source this observation came from (log/diff surface). */
	readonly source: string
}

/** Declares a typed read that decodes at the handler boundary. */
export function observeInto<T extends TObject>(
	schema: T,
	source: string,
): ObservationInto<T> {
	return { schema, source }
}

/** The decoded result of one observation, three-valued by contract. */
export type Decoded<T extends TSchema> =
	| { readonly kind: 'known'; readonly value: Static<T> }
	| { readonly kind: 'absent' }
	| { readonly kind: 'unknown'; readonly reasons: string[] }

/** Decode a raw observation payload through the schema into the three arms. */
export function decodeInto<T extends TSchema>(
	obs: ObservationInto<T>,
	raw: unknown,
): Decoded<T> {
	// The host's answer is authoritative about existence: if the peer said
	// "not in my world", that is a FACT about the world and must not be
	// flattened into a decode failure.
	if (raw === undefined || raw === null) {
		return { kind: 'absent' }
	}

	const errors = check(obs.schema, raw)
	if (errors.length !== 0) {
		// Malformed JSON lands in UNKNOWN, never ABSENT - absent would erase
		// the retry decision, and a value that failed its schema is not "not
		// in the world", it is "in the world but unreadable".
		return { kind: 'unknown', reasons: errors }
	}

	return { kind: 'known', value: raw as Static<T> }
}

/** Refuses an unknown observation at compile time unless explicitly allowed. */
export function tolerateUnknown<T extends TSchema>(
	obs: ObservationInto<T>,
): { readonly tolerateUnknown: true; readonly obs: ObservationInto<T> } {
	return { tolerateUnknown: true, obs }
}

/** Compile-time refusal: unknown feeding write/status is a named error. */
export class UnknownFeedsWriteError extends Error {
	constructor(readonly source: string) {
		super(
			`invariant: unknown observation from "${source}" cannot feed a write - ${`wrap the read in tolerateUnknown() if this is intentional`}`,
		)
		this.name = 'UnknownFeedsWriteError'
	}
}
