// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// THE WIT BOUNDARY'S CONVERTERS, ONE COPY.
//
// Every `*-main.ts` here speaks two value languages: the SDK's `EnsureValue`
// on the step side and the WIT `value` variant on the host side, and the two
// are NOT structurally compatible - forwarding one as the other compiles
// against `any` and produces a malformed variant at runtime. These were inline
// in each main; one copy is the point, because two copies are two things that
// must agree about a shape whose wrongness is silent.
import type { EnsureValue } from '@apsis-io/perseid/perseid.js'
import type { StructValue } from '@apsis-io/perseid/expr.js'
import type { Value } from 'perseid:reconcile/ensure@0.1.0'
import type { Field } from 'perseid:reconcile/apply@0.1.0'

/** SDK `EnsureValue` -> WIT `value` variant.
 *
 * Dispatches on `typeof`; the WIT variant's tag is built HERE, which is where
 * the two representations are meant to meet. The widened members - `null`,
 * arrays, records - have NO WIT representation, so they REFUSE with the rule
 * named rather than fall through to a `{ tag: 'text' }` of something that is
 * not text: a fallthrough would stringify an array or object into the
 * ConfigMap silently, and these programs declare scalars only. */
export const lower = (value: EnsureValue): Value => {
  if (typeof value === 'number') return { tag: 'num', val: BigInt(Math.trunc(value)) }
  if (typeof value === 'boolean') return { tag: 'flag', val: value }
  if (typeof value === 'string') return { tag: 'text', val: value }

  throw new Error(
    'host-convert: the WIT value variant carries text, number, or flag only - null, arrays, and records have no representation, and this program declares scalars only.',
  )
}

/** SDK `StructValue` (the apply body) -> WIT `field` rows.
 *
 * A dotted-path walk: object keys join with `.`, array elements with `[i]` -
 * the same spelling the row dialect always used (`spec.ports[0].port`). Keys
 * walk SORTED so the rows are canonical regardless of the body literal's
 * written order; `undefined` stays absent, because apply owns the whole body
 * and an absent field is a value the caller never stated. */
export const flatten = (body: StructValue): Field[] => {
  const rows: Field[] = []

  const walk = (prefix: string, node: unknown): void => {
    if (node === undefined) return
    // Arrays before the leaf test: `typeof [] === 'object'`, so the object
    // branch would swallow them and lower() would refuse what is legitimate
    // body content.
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(`${prefix}[${i}]`, item))

      return
    }
    if (node === null || typeof node !== 'object') {
      rows.push({ path: prefix, value: lower(node as EnsureValue) })

      return
    }
    const rec = node as Record<string, unknown>
    for (const k of Object.keys(rec).sort()) walk(prefix ? `${prefix}.${k}` : k, rec[k])
  }

  walk('', body)

  return rows
}
