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
// tools/trail/src/streamwire.rs; that file is the specification and this is a
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
)

// CapStream is the capability token for the bulk seam.
const CapStream = "stream"

// capsOffered is what this SDK advertises. A provider that serves bulk calls
// says so; the negotiation is symmetric, so a consumer that does not advertise
// gets classic-only regardless.
func capsOffered() string {
	return CapStream
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
func streamsAgreed(peerCaps []string) bool {
	return hasCap(peerCaps, CapStream)
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
