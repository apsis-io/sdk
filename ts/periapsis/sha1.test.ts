// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test'
import { sha1 } from './sha1.js'

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

// THE RFC 3174 / NIST VECTORS, VERBATIM. This sha1 exists for the WebSocket
// handshake's Sec-WebSocket-Accept, where a wrong digest is a handshake the
// peer refuses - these are the digests the whole world agrees on.
test('the standard vectors', () => {
  expect(hex(sha1(new TextEncoder().encode('')))).toBe(
    'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  )
  expect(hex(sha1(new TextEncoder().encode('abc')))).toBe(
    'a9993e364706816aba3e25717850c26c9cd0d89d',
  )
  expect(
    hex(sha1(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
  ).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1')
  expect(hex(sha1(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')))).toBe(
    '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
  )
})

// The 56-byte vector above lands exactly on the padding boundary's awkward
// side (one byte of 0x80 + 55 zero bytes DO fit the second chunk); a million
// 'a' exercises many-chunk accumulation, where a rolling-state bug shows.
test('multi-chunk inputs accumulate correctly', () => {
  expect(hex(sha1(new Uint8Array(1_000_000).fill(0x61)))).toBe(
    '34aa973cd4c4daa4f61eeb2bdbad27316534016f',
  )
})
