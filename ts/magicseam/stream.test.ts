// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test"
import { CAP_STREAM, OP_CALL, OP_STREAM, capsOffered, parseCaps, streamsAgreed } from "./stream"

// These live in their own file, separate from quic.test.ts, deliberately:
// quic.ts pulls in @matrixai/quic, which is not installed in every environment
// (it is not here), so a negotiation test placed there would silently not run.
// The negotiation logic has no transport dependency and should not inherit one.
describe("bulk-seam capability negotiation", () => {
  // The compatibility property the whole mechanism exists for. Guessing "yes"
  // would make this provider expect an opcode the consumer never writes,
  // misframing every call on the connection.
  test("an absent or empty caps frame means classic-only", () => {
    expect(streamsAgreed(parseCaps(undefined))).toBe(false)
    expect(streamsAgreed(parseCaps(new Uint8Array(0)))).toBe(false)
    expect(streamsAgreed([])).toBe(false)
  })

  test("a peer advertising the token negotiates it", () => {
    expect(streamsAgreed(parseCaps(Buffer.from(CAP_STREAM)))).toBe(true)
  })

  // Adding a capability later must not be a breaking change - which it would be
  // if an unrecognised token made a peer fail or mask a known one.
  test("unknown tokens do not mask a known one", () => {
    expect(streamsAgreed(parseCaps(Buffer.from("stream,quantum-teleport,zip")))).toBe(true)
    expect(streamsAgreed(parseCaps(Buffer.from("quantum-teleport")))).toBe(false)
  })

  test("stray separators and whitespace are tolerated", () => {
    expect(parseCaps(Buffer.from(" stream , , "))).toEqual([CAP_STREAM])
  })

  // This SDK must advertise exactly what it can serve: advertising nothing
  // leaves every TS provider classic-only; advertising more misframes calls.
  test("this SDK advertises the bulk seam", () => {
    expect(streamsAgreed(parseCaps(Buffer.from(capsOffered())))).toBe(true)
  })

  test("the opcodes are distinct", () => {
    expect(OP_CALL).not.toBe(OP_STREAM)
  })
})
