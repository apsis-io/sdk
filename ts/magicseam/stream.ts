// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The BULK seam (periapsis:magic/stream-handler) on the provider side.
//
// A provider built on this SDK is NATIVE - it speaks the wire protocol directly
// rather than running as a WASM component - so it implements the negotiation
// itself. This mirrors rust/seamwire/src/lib.rs, which is the
// specification; the two are implementations of one protocol and must be read
// together. go/magicseam/stream.go is the third.
//
// That path was trail's wire vocabulary until 2026-08-26, when it became a
// shared crate so the Comet agent could speak the seam without a second Rust
// implementation of it. trail consumes it under the same name.
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

/**
 * A CONVERSATION: one stream carrying a call whose CALLEE may ask the CALLER
 * questions before answering (ADR-0082). Every other op is one-shot in one
 * direction - OP_CALL and OP_STREAM are both request-then-reply - so what this
 * adds is not bidirectionality (QUIC streams were always bidirectional) but
 * INTERLEAVING.
 *
 *     opcode 5
 *     caller frame, then request frame     caller -> callee
 *     [CONV_ASK ..question..]              callee -> caller
 *     ..answer..                           caller -> callee, NO tag byte
 *     [CONV_DONE ..final reply..]          ends the conversation
 */
export const OP_CONVERSE = 5

/**
 * First byte of a callee frame that is a QUESTION. The caller replies with ONE
 * plain frame carrying no tag.
 *
 * THE ANSWER FRAME CARRIES NO TAG AND THAT ASYMMETRY IS DELIBERATE - only the
 * callee can end the conversation, so only the callee's frames need to say
 * which kind they are.
 */
export const CONV_ASK = 0

/**
 * First byte of the FINAL callee frame: the rest is the reply and the
 * conversation ends.
 *
 * A CALLEE THAT RAN AND REFUSED SENDS CONV_DONE CARRYING ITS ERROR TEXT rather
 * than closing the stream, and EOF is a FAILURE rather than a clean end. That
 * asymmetry is load-bearing on the far side: a vanished callee producing an
 * empty reply reads as "the work finished", and for this seam's first caller
 * finished is TERMINAL - it retires the program and tears down its live
 * obligations rather than parking it.
 */
export const CONV_DONE = 1

/** The capability token for the bulk seam. */
export const CAP_STREAM = "stream"

/** The capability token for the coordinated-checkpoint markers (§8). */
export const CAP_BARRIER = "barrier"

/**
 * The capability token for a conversation. ADVERTISED ONLY BY A CALLEE THAT HAS
 * A HANDLER FOR IT - see capsOffered's `hasConverse`.
 *
 * ADVERTISING IS A PROMISE ABOUT EVERY SUBSEQUENT CALL, NOT ABOUT THIS ONE. A
 * caller decides from this advertisement alone whether to send OP_CONVERSE, so
 * a provider that advertises and then has nothing to dispatch to leaves the
 * caller waiting on a question that never comes - and the failure is silence,
 * not an error, because both ends are still reading.
 */
export const CAP_CONVERSE = "converse"

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
export function capsOffered(hasBarrier: boolean = false, hasConverse: boolean = false): string {
  const caps = [CAP_STREAM]
  if (hasBarrier) caps.push(CAP_BARRIER)
  // ADVERTISED IFF SERVED, and the parameter exists to make the other spelling
  // unavailable. A provider that advertised `converse` with nothing to dispatch
  // to would convert a readable up-front refusal on the caller's side - "peer
  // does not support the converse seam" - into a call that hangs mid-stream.
  // Mirrors go/magicseam's capsOffered(hasBarrier, hasConverse).
  if (hasConverse) caps.push(CAP_CONVERSE)

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
