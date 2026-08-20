// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"slices"
	"strings"

	quic "github.com/quic-go/quic-go"
)

// The BULK seam (periapsis:magic/stream-handler) on the provider side.
//
// A provider written with this SDK is NATIVE - it speaks the wire protocol
// directly rather than running as a WASM component - so it has to implement
// the negotiation and framing itself. Everything here mirrors
// cmd/trail/src/streamwire.rs; that file is the specification and this is a
// second implementation of it, so the two must be read together.
//
// WHY A PROVIDER GAINS ANYTHING FROM THIS. Without it a provider is simply an
// older peer: trail negotiates no streaming, a consumer importing the bulk seam
// is refused at bind with an explanation, and classic calls keep working
// untouched. That degradation is deliberate and safe. Implementing this turns
// the refusal into a working bulk call.
//
// WHAT IT DOES NOT CHANGE: the Handler signature. A streaming call is
// reassembled here and handed to the same func(Caller, []byte) ([]byte, error).
// That keeps every existing provider's code working as-is, and it is honest
// about what the trail side does today too - it also collects. Incremental
// dispatch is a later change on both sides; the WIRE is already incremental,
// so it will not need a protocol change.

// Wire opcodes, present only once both ends have advertised CapStream.
const (
	opCall   byte = 0
	opStream byte = 1
	// Coordinated-checkpoint markers (ADR-0032). Sent only when both ends
	// advertised CapBarrier, so a peer that does not implement them never sees
	// one - a marker read as a caller frame would garble a call rather than be
	// cleanly refused.
	opMarker    byte = 2
	opMarkerAck byte = 3
	opResume    byte = 4
)

// CapStream is the capability token for the bulk seam.
const CapStream = "stream"

// CapStatus is the capability token for the `status` op (ADR-0059 addendum).
//
// Advertised so a consumer can know BEFORE calling whether the peer serves it.
// Without this a consumer can only try and be refused: an old provider answers
// `status` with ErrRejected "unknown op", which does name the missing thing but
// gives no way to degrade gracefully - and old-provider-plus-new-consumer is not
// hypothetical here, the deployed binary drifted from source for days this week.
const CapStatus = "status"

// CapBarrier is the capability token for the coordinated-checkpoint marker
// protocol (ADR-0032): opMarker / opMarkerAck / opResume.
//
// Advertising it is what makes a provider built on this SDK QUIESCIBLE - a
// first-class member of a barrier rather than the reason one cannot be taken.
// A coordinator checks for it BEFORE starting, so a provider that lacks it fails
// the graph closed with an explanation instead of timing out mid-barrier.
const CapBarrier = "barrier"

// capsOffered is what this SDK advertises. A provider that serves bulk calls
// says so; the negotiation is symmetric, so a consumer that does not advertise
// gets classic-only regardless.
//
// Comma-separated because parseCaps splits on it. Order is not significant and
// callers must not depend on it.
func capsOffered(hasBarrier bool) string {
	caps := []string{CapStream, CapStatus}
	// ADVERTISED ONLY WHEN THERE IS A BARRIER TO HONOUR IT, and the first version
	// of this got it wrong in the most dangerous available direction.
	//
	// CapBarrier was unconditional while ServeQUIC passes a nil barrier - and a
	// nil barrier ACKS a marker immediately, without draining and without
	// refusing calls. So every provider built on plain ServeQUIC claimed to be
	// quiescible and was not: the coordinator reads that ack as "my channel is
	// empty", snapshots, and takes a torn cut from a provider that never stopped
	// serving.
	//
	// That also defeated the one protection meant to catch it. markerprop fails a
	// barrier when a peer does NOT advertise the capability - which is exactly the
	// case that was being misreported, so the guard could never fire.
	//
	// Advertising a capability you do not implement is worse than not implementing
	// it: the second fails closed, the first fails silently.
	if hasBarrier {
		caps = append(caps, CapBarrier)
	}

	return strings.Join(caps, ",")
}

// parseCaps splits a capability frame. Unknown and empty tokens are dropped
// rather than rejected: a capability list is an advertisement, not a contract,
// and failing a connection over a token this build has not heard of would make
// ADDING one a breaking change - the exact thing negotiation exists to avoid.
func parseCaps(frame []byte) []string {
	var out []string
	for t := range strings.SplitSeq(string(frame), ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}

	return out
}

// hasCap reports whether a parsed capability list contains token.
func hasCap(caps []string, token string) bool {
	return slices.Contains(caps, token)
}

// streamsAgreed reports whether BOTH ends advertised the bulk seam. One-sided
// agreement is the dangerous case: the peer would not be writing the opcode
// this side then expects, and every call on the connection would be misframed.

// barrierAgreed reports whether the marker ops are live on this connection:
// TWO-SIDED, like streams (§5). The peer must have advertised the token AND this
// provider must actually have a barrier - advertising without one is the
// false-quiesce bug capsOffered's own comment describes.
func barrierAgreed(peerCaps []string, hasBarrier bool) bool {
	if !hasBarrier {
		return false
	}
	return slices.Contains(peerCaps, CapBarrier)
}

// opcodeOnWire reports whether the peer will prefix a stream with an opcode
// byte.
//
// EITHER opcode-using capability puts it there, and reading only the stream one
// was a real gap: the spec defines `barrier` as two-sided but never says it
// requires `stream`, so a conforming consumer may advertise barrier ALONE - it
// wants markers, not bulk calls. Gated on streams only, that consumer's
// OP_MARKER was consumed as the first byte of the caller-frame length and the
// marker became a garbled call, which is exactly the failure §5 cites as the
// reason barrier is two-sided, arriving by the other door.
//
// Not reachable from this SDK's own client (capsOffered always includes stream),
// which is why it went unnoticed - but reachable from any conforming peer.
func opcodeOnWire(peerCaps []string, hasBarrier bool) bool {
	return streamsAgreed(peerCaps) || barrierAgreed(peerCaps, hasBarrier)
}

func streamsAgreed(peerCaps []string) bool {
	return hasCap(peerCaps, CapStream)
}

// StatusServed reports whether the peer advertised the `status` op. Unlike
// streaming, this is NOT symmetric: status is a plain request/reply, so only the
// PROVIDER needs to serve it - a consumer asking a provider that advertises it
// is safe regardless of what the consumer itself offers.
func StatusServed(peerCaps []string) bool {
	return hasCap(peerCaps, CapStatus)
}

// serveQUICStreamCall handles one BULK call: caller frame, then request chunk
// frames terminated by a zero-length frame, and the same shape in reply behind
// the usual tag byte.
//
// The request is reassembled and handed to the ordinary Handler. That is the
// same thing the trail side does today, and it is why an existing provider
// gains bulk support without touching its handler code.
func serveQUICStreamCall(stream *quic.Stream, peer string, handler Handler) {
	callerFrame, err := readFrame(stream)
	if err != nil {
		return
	}
	caller := decodeCaller(callerFrame)
	caller.PeerAddr = peer

	var request []byte
	for {
		chunk, err := readFrame(stream)
		if err != nil {
			return
		}
		if len(chunk) == 0 {
			break // zero-length frame ends the request
		}
		request = append(request, chunk...)
	}

	response, herr := handler(caller, request)
	if herr != nil {
		_, _ = stream.Write([]byte{tagFor(herr)})
		_ = stream.Close()

		return
	}
	if _, err := stream.Write([]byte{0}); err != nil {
		return
	}
	for chunk := range slices.Chunk(response, streamChunk) {
		if err := writeFrame(stream, chunk); err != nil {
			return
		}
	}
	// Zero-length frame ends the reply. Written even for an empty response,
	// where it is the whole reply - without it the consumer would block
	// waiting for a terminator that never comes.
	_ = writeFrame(stream, nil)
	_ = stream.Close()
}

// streamChunk is the reply framing size, matching trail's own STREAM_CHUNK so
// one wire chunk maps to about one guest read.
const streamChunk = 64 * 1024
