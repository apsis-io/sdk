// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from 'bun:test'
import {
  attachBackstop,
  BACKSTOP_SECTION,
  DEFAULT_BACKSTOP_MS,
  declareBackstop,
} from './backstop'

// ***THE PAYLOAD IS THE ONE trail PARSES, SO IT IS ASSERTED AS BYTES.***
// `decode_backstop` accepts a bare number or `{"ms": n}`; this SDK emits the
// object form, because that is the shape with room for per-declaration metadata
// later - the same argument decode_roles records for choosing JSON at all.
test('the payload is the object form trail decodes', () => {
  expect(new TextDecoder().decode(declareBackstop(60_000).bytes)).toBe('{"ms":60000}')
  expect(declareBackstop.seconds(60).ms).toBe(60_000)
  expect(declareBackstop.minutes(5).ms).toBe(300_000)
})

// ***THE SECTION HEADER, BYTE FOR BYTE.***
//
// A wasm custom section is `0x00 <leb size> <leb name-len> <name> <data>`. If
// any of that is wrong the component still LOADS - a malformed trailing section
// is the one kind of corruption a runtime may ignore - and trail reports the
// bound as absent, which reads as "this program declared none". So the failure
// is silent in the reassuring direction and has to be pinned here.
test('the appended section has the shape trail reads at depth 0', () => {
  // A minimal component preamble: magic + version. Enough to assert framing.
  const stub = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00])
  const out = attachBackstop(stub, declareBackstop(60_000))

  // The original bytes are untouched and the section is APPENDED, not spliced.
  expect(out.slice(0, stub.length)).toEqual(stub)

  const tail = out.slice(stub.length)
  expect(tail[0]).toBe(0x00) // custom-section id

  const name = BACKSTOP_SECTION
  const body = tail.slice(2) // one-byte LEB for this size
  expect(body[0]).toBe(name.length) // one-byte LEB name length
  expect(new TextDecoder().decode(body.slice(1, 1 + name.length))).toBe(name)
  expect(new TextDecoder().decode(body.slice(1 + name.length))).toBe('{"ms":60000}')

  // The declared size must cover exactly the body, or every later section is
  // misframed - the failure that makes a runtime skip the tail silently.
  expect(tail[1]).toBe(body.length)
})

// ***A BOUND OVER 127 BYTES OF SECTION EXERCISES MULTI-BYTE LEB.***
// One-byte LEB is the happy path and the only one a small fixture reaches; a
// long section name or payload crosses 0x80 and a wrong encoding there frames
// the section short, which again reads as "declared none".
test('leb128 is multi-byte when the section exceeds 127 bytes', () => {
  const stub = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00])
  const big = { ms: 1, bytes: new TextEncoder().encode('x'.repeat(200)) }
  const tail = attachBackstop(stub, big).slice(stub.length)

  expect(tail[0]).toBe(0x00)
  // 200 payload + 1 name-length byte + 16 name bytes = 217 -> two LEB bytes.
  expect(tail[1] & 0x80).not.toBe(0)
  expect(tail[2]).toBe(1)
})

// The default is EXPORTED so a program can declare it deliberately. Declaring
// the default and declaring nothing are different states, and only the first
// says somebody thought about it.
test('the default is the host bound, and is declarable', () => {
  expect(DEFAULT_BACKSTOP_MS).toBe(300_000)
  expect(declareBackstop(300_000).ms).toBe(DEFAULT_BACKSTOP_MS)
})

// ***THESE EXACT BYTES WERE READ BACK BY A REAL `trail --inspect`.***
//
// Every other test here checks the framing against my own reading of the wasm
// spec - the same source the implementation came from - so they would all agree
// with each other about a wrong encoding. This one does not: it is a transcript.
//
// Provenance, 2026-09-04: this SDK's `attachBackstop` appended a bound to
// `magic-0.1.0.wasm`, a real component; `trail --inspect` reported
// `backstop = 90000`; `wasm-tools validate` still passed. The Rust SDK's
// `Backstop::attach` reproduces the identical bytes, which is what makes two
// producers for one consumer safe.
//
// A failure here means a section trail will read as ABSENT - silently, in the
// reassuring direction, since a component with a malformed trailing section
// still loads and simply reports no bound.
test('the bytes are the ones trail actually read', () => {
  const want = new Uint8Array([
    0x00, 0x1d, 0x10, // custom-section id, size 29, name length 16
    ...new TextEncoder().encode('radiant:backstop'),
    ...new TextEncoder().encode('{"ms":90000}'),
  ])
  expect(attachBackstop(new Uint8Array(), declareBackstop.seconds(90))).toEqual(want)
})
