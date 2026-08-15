// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The BULK seam (periapsis:magic/stream-handler) on the provider side.
//
// A provider built on this SDK is NATIVE - it speaks the wire protocol directly
// rather than running as a WASM component - so it implements the negotiation
// itself. This mirrors cmd/trail/src/streamwire.rs, which is the
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

/** Wire opcodes. Present once EITHER opcode-using capability is agreed - the
 *  bulk seam (CAP_STREAM) or the markers (CAP_BARRIER). */
export const OP_CALL = 0
export const OP_STREAM = 1
export const OP_MARKER = 2
export const OP_MARKER_ACK = 3
export const OP_RESUME = 4

/** The capability token for the bulk seam. */
export const CAP_STREAM = "stream"

/** The capability token for the coordinated-checkpoint markers (§8). */
export const CAP_BARRIER = "barrier"

/**
 * What this SDK advertises.
 *
 * CAP_BARRIER ONLY WHEN THERE IS A BARRIER TO HONOUR IT. Advertising it
 * unconditionally is the false-quiesce bug the Go SDK shipped and had to fix:
 * a provider with no barrier acks a marker without draining and without
 * refusing, so the coordinator reads that ack as "my channel is empty",
 * snapshots, and takes a torn cut from a provider that never stopped serving.
 *
 * It also defeats the guard meant to catch it - trail fails a barrier when a
 * peer does NOT advertise the capability, which is exactly the case that would
 * be misreported. Advertising something you do not implement is worse than not
 * implementing it: the second fails closed, the first fails silently.
 */
export function capsOffered(hasBarrier: boolean = false): string {
  const caps = [CAP_STREAM]
  if (hasBarrier) caps.push(CAP_BARRIER)

  return caps.join(",")
}

/**
 * Whether the marker ops are live on this connection. TWO-SIDED like streams:
 * the peer must advertise the token AND this provider must actually have a
 * barrier.
 */
export function barrierAgreed(peerCaps: string[], hasBarrier: boolean): boolean {
  return hasBarrier && peerCaps.includes(CAP_BARRIER)
}

/**
 * Whether the peer will prefix a stream with an opcode byte.
 *
 * EITHER opcode-using capability puts it there. The spec (§5) defines `barrier`
 * as two-sided like `stream` but never says one requires the other, so a
 * conforming consumer may advertise barrier ALONE - it wants markers, not bulk
 * calls. Gating on streams only means its OP_MARKER is consumed as the first
 * byte of the caller-frame length and the marker becomes a garbled call, which
 * is the failure §5 makes barrier two-sided to prevent. (Fixed in the Go SDK
 * after this was found there; the same trap is live here.)
 */
export function opcodeOnWire(peerCaps: string[], hasBarrier: boolean): boolean {
  return streamsAgreed(peerCaps) || barrierAgreed(peerCaps, hasBarrier)
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
