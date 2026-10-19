// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'bun:test'
import { bytesToString, concatBytes, stringToBytes } from './codec.js'

// The codec is dwarf's TextEncoder/TextDecoder under an alias, and its whole
// reason to exist is the history in its header: the charCodeAt version it
// replaced SILENTLY MANGLED non-ASCII. These pins are that history held shut.
test('multi-byte UTF-8 round-trips', () => {
  for (const s of ['héllo', '世界', '🐧!', 'a\0b']) {
    expect(bytesToString(stringToBytes(s))).toBe(s)
  }
})

test('stringToBytes emits real UTF-8 byte counts, not char counts', () => {
  expect([...stringToBytes('é')]).toEqual([0xc3, 0xa9])
  expect([...stringToBytes('世')]).toEqual([0xe4, 0xb8, 0x96])
})

test('concatBytes preserves chunk order across an empty chunk', () => {
  const out = concatBytes([stringToBytes('ab'), new Uint8Array(0), stringToBytes('cd')])
  expect([...out]).toEqual([0x61, 0x62, 0x63, 0x64])
  expect(concatBytes([]).length).toBe(0)
})
