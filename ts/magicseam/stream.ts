// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The BULK seam (periapsis:magic/stream-handler) on the provider side.
//
// A provider built on this SDK is NATIVE - it speaks the wire protocol directly
// rather than running as a WASM component - so it implements the negotiation
// itself. This mirrors tools/trail/src/streamwire.rs, which is the
// specification; the two are implementations of one protocol and must be read
// together. sdk/go/magicseam/stream.go is the third.
//
// Without this a provider is simply an older peer: trail negotiates no
// streaming, a consumer importing the bulk seam is refused at bind with an
// explanation, and classic calls keep working untouched.
//
// The Handler signature is UNCHANGED - a streaming call is reassembled here and
// handed to the same handler, so existing providers gain bulk support without
// touching their code. That matches what trail does today; it collects too.

/** Wire opcodes, present only once both ends advertised CAP_STREAM. */
export const OP_CALL = 0
export const OP_STREAM = 1

/** The capability token for the bulk seam. */
export const CAP_STREAM = "stream"

/** What this SDK advertises. */
export function capsOffered(): string {
  return CAP_STREAM
}

/**
 * Parse a capability frame. Unknown and empty tokens are dropped rather than
 * rejected: a capability list is an advertisement, not a contract, and failing
 * a connection over an unrecognised token would make ADDING one a breaking
 * change - exactly what negotiation exists to avoid.
 */
export function parseCaps(frame: Uint8Array | undefined): string[] {
  if (frame === undefined) return []

  return Buffer.from(frame)
    .toString("utf8")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * Whether the peer advertised the bulk seam. One-sided agreement is the
 * dangerous case: the peer would not write the opcode this side then expects,
 * misframing every call on the connection - so absence must mean no.
 */
export function streamsAgreed(peerCaps: string[]): boolean {
  return peerCaps.includes(CAP_STREAM)
}
