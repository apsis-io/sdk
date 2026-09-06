// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// FIELD PATHS, BUILT RATHER THAN TYPED.
//
// `Get(path, field)` takes a field path, and that path has its own small
// grammar: `a.b`, `a["k"]` for a key with punctuation, `a[?k=v]` to select a
// list element. Written by hand it is a string, which means every rule is one an
// author has to remember and no mistake is caught before the cluster.
//
// ***THE THREE MISTAKES THIS REMOVES ARE ALL MEASURED, NOT IMAGINED.***
//
//	metadata.annotations.drain\.apsis/requested   a BACKSLASH escape, which the
//	                                              host does not have. It splits
//	                                              at the dot and reads ABSENT -
//	                                              shipped in the drainer,
//	                                              declared and unused for a day
//	spec.taints[?key!=x]                          parsed as a field called `key!`
//	                                              until 2026-09-06, answering
//	                                              Absent about a field nothing has
//	status.conditions[0].status                   a list INDEX, which does not
//	                                              exist - order is not API
//
// Each is silent: a wrong field path reads `absent`, and absent is a real answer
// a program acts on. So the failure is a program that quietly concludes the
// wrong thing, which is the worst shape available.
//
// ⚠ ***THIS IS THE ANSWER TO "SHOULD THE FIELD PATH BE AN OBJECT ON THE WIRE"
// AND IT IS DELIBERATELY THE SMALLER ONE*** (engi, 2026-09-06: "can we split
// string into an object"). Making it structural in the LANGUAGE means a grammar
// change, a version bump, both SDKs, and dual-form support forever - deployed
// programs emit strings and cannot be broken - so the string grammar would stay
// and the second form would be the extra vocabulary this repo keeps deleting.
// Building the string here gets the authoring safety at no contract cost. What
// it does NOT get: structural safety at the host boundary, and the ~436ns parse
// per read. Both were weighed; see internal/aperture/LANGUAGE.md §8.
// ═══════════════════════════════════════════════════════════════════════════

/** One step of a field path: a key, or a selector over a list. */
export type Seg = string | { readonly selKey: string; readonly selVal: string }

/**
 * Select the element of a LIST whose `key` equals `value`.
 *
 *     field('status', 'conditions', sel('type', 'Ready'), 'status')
 *
 * ***NAMED `sel` AND NOT `where`***, because `where` is the step combinator that
 * binds concurrent sub-step results. Two unrelated things called `where` in one
 * SDK is the collision a reader pays for later.
 */
export const sel = (key: string, value: string): Seg => {
  // ⛔ THE HOST REFUSES A SELECTOR FIELD THAT IS NOT A PLAIN NAME, because
  // `[?k!=v]` used to parse as a field called `k!`. Refusing here too turns that
  // into a build error instead of a program that reads Absent forever.
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) {
    throw new Error(
      `sel(${JSON.stringify(key)}): a selector compares ONE field for equality, and the ` +
        `field must be a plain name. Punctuation here means an operator the aperture does ` +
        `not have - there is no !=, no &&, no wildcard.`,
    )
  }
  if (value.includes(']')) {
    throw new Error(
      `sel(${key}, ${JSON.stringify(value)}): a selector value runs to the first ']', so a ` +
        `value containing one cannot be expressed.`,
    )
  }

  return { selKey: key, selVal: value }
}

// A key needs no subscript when it is a bare name. Anything else - a dot, a
// slash, a bracket - has to be quoted or the walker splits it.
const bare = /^[A-Za-z0-9_-]+$/

/**
 * Build a field path from its segments.
 *
 *     field('spec', 'replicas')                        spec.replicas
 *     field('metadata', 'annotations', 'a.b/c')        metadata.annotations["a.b/c"]
 *     field('status', 'conditions', sel('type','Ready'), 'status')
 *                                   status.conditions[?type=Ready].status
 *
 * ***QUOTING IS DECIDED HERE, NOT BY THE AUTHOR.*** A key containing a dot or a
 * slash is subscripted automatically - which is the rule the drainer got wrong
 * by hand, using a backslash escape the host does not have. An author who never
 * makes the decision cannot make it wrongly.
 */
export const field = (...segs: readonly Seg[]): string => {
  if (segs.length === 0) {
    throw new Error('field(): a field path names at least one segment')
  }

  let out = ''
  for (const s of segs) {
    if (typeof s !== 'string') {
      out += `[?${s.selKey}=${s.selVal}]`
      continue
    }
    if (s === '') {
      throw new Error('field(): an empty segment names nothing')
    }
    if (bare.test(s)) {
      out += out === '' ? s : `.${s}`
      continue
    }
    // ⛔ A SUBSCRIPT CANNOT OPEN A PATH - the host refuses `["k"].b`, because a
    // bracketed key must follow the map it indexes.
    if (out === '') {
      throw new Error(
        `field(${JSON.stringify(s)}): a key needing a subscript cannot be the FIRST ` +
          `segment - a bracketed key must follow the map it indexes.`,
      )
    }
    out += `[${JSON.stringify(s)}]`
  }

  return out
}
