// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"context"
	"errors"
	"fmt"
	"io"
)

// THE CONVERSE SEAM: ONE STREAM, A CALL THAT CALLS BACK.
//
// Every other op here is request-then-reply — `opCall` sends bytes and reads
// bytes, `opStream` does the same in chunks. A Perseid step cannot be served
// that way, and the reason is a property of the programming model rather than of
// the transport:
//
//	`observe.get(path)` is a CALL, NOT A MANIFEST. The step computes the paths
//	it reads from its config and from what EARLIER OBSERVATIONS said. Pre-sending
//	observations means guessing what it is about to ask for, which is not a
//	cheaper version of the model — it is a weaker one.
//
// So the callee must be able to ask the caller questions mid-call. This op keeps
// that on ONE stream: the caller opens it, states the request, then answers
// callbacks until the callee sends a terminal frame.
//
// # WHY THIS AND NOT A LISTENER
//
// The obvious alternative is for radiant to run a server the pod dials back
// into. That needs a port, an inbound authorization surface, a routing table
// from an arriving call to the right program's in-flight state, and a lifetime
// discipline for state that is replaced every pass.
//
// ***THE STREAM IS THE ROUTING.*** The goroutine that opened it holds the state
// the callbacks are served from, so there is nothing to publish and nothing to
// look up, and no window where state is published and replaced underneath a
// caller. One opcode against four mechanisms.
//
// # WHAT THIS DELIBERATELY CANNOT EXPRESS
//
// A callback cannot make the caller PERFORM anything. It asks and it declares;
// what the answers and declarations mean is entirely the caller's business. That
// is not a limitation to work around — a callback that performed a write would
// walk past whatever boundary the caller checks AFTER the call returns, and in
// this codebase that boundary is the whole point.
const (
	// CapConverse is the capability token for this op. Advertised so a caller
	// knows BEFORE opening a stream whether the peer speaks it, rather than
	// writing an opcode an older peer would read as a caller frame and garble.
	CapConverse = "converse"

	// opConverse is the wire opcode. NEXT AFTER opResume(4) and never reusing a
	// retired number: an opcode collision between versions is the one framing
	// error that produces plausible garbage rather than a clean refusal.
	opConverse byte = 5
)

// Frame tags for the callee->caller direction. The FIRST BYTE of every frame the
// callee sends, so a caller always knows whether it is being asked something or
// told the conversation is over.
//
// A TAG RATHER THAN A LENGTH CONVENTION OR A SENTINEL PAYLOAD: an empty final
// frame and a callback asking about the empty string are otherwise the same
// bytes, and "the conversation ended" must never be inferrable from a payload
// the callee controls.
const (
	tagAsk  byte = 0 // the rest of this frame is a question; answer it
	tagDone byte = 1 // the rest of this frame is the final reply; stop
)

// ErrConverseUnsupported is returned when the peer never advertised CapConverse.
//
// REFUSED UP FRONT rather than attempted: writing opConverse at a peer that does
// not know it means that peer reads the opcode as the first byte of a caller
// frame. It does not fail cleanly, it MISPARSES — and a corrupted classic call is
// a far worse outcome than a refused conversation. Same reasoning call_stream
// gives for its own guard.
var ErrConverseUnsupported = errors.New("magicseam: peer does not support the converse seam")

// ConverseServed reports whether the peer advertised this op.
//
// ASYMMETRIC, LIKE StatusServed AND UNLIKE STREAMING: only the CALLEE has to
// serve it. The caller's own capabilities are irrelevant - it opens the stream
// and answers questions, which needs no advertisement.
func ConverseServed(peerCaps []string) bool { return hasCap(peerCaps, CapConverse) }

// Answerer serves one callback. Returning an error ABANDONS the conversation:
// the stream is closed and Converse returns that error, because a caller that
// cannot answer a question has no way to let the callee finish correctly.
type Answerer func(ctx context.Context, ask []byte) ([]byte, error)

// Converse opens one stream, sends request, answers every callback with serve,
// and returns the callee's final reply.
//
// ***A TRANSPORT FAILURE RETURNS AN ERROR AND NEVER AN EMPTY REPLY.*** Every
// return path below is either a non-nil error or a reply the callee actually
// sent. That is a hard requirement rather than good manners: this seam's first
// caller feeds a driver where an empty result reads as THE WORK FINISHED, so a
// swallowed failure would not stall a program — it would RETIRE one, silently
// and permanently, with no error, no park and nothing outstanding to notice.
func (c *QUICClient) Converse(ctx context.Context, request []byte, serve Answerer) ([]byte, error) {
	if !ConverseServed(c.PeerCaps) {
		return nil, fmt.Errorf("%w (peer advertised %v)", ErrConverseUnsupported, c.PeerCaps)
	}
	if serve == nil {
		// A conversation with no answerer can only deadlock on the first
		// question, which presents as a timeout rather than as a missing
		// argument. Refuse where the mistake is.
		return nil, errors.New("magicseam: Converse requires an Answerer; a nil one cannot " +
			"answer the first callback and the call would hang instead of failing")
	}

	stream, err := c.conn.OpenStreamSync(ctx)
	if err != nil {
		return nil, fmt.Errorf("magicseam: converse open stream: %w", err)
	}
	defer stream.CancelRead(0)

	if _, err := stream.Write([]byte{opConverse}); err != nil {
		return nil, fmt.Errorf("magicseam: converse write opcode: %w", err)
	}
	// CALLER FRAME FIRST, THEN THE REQUEST - the same order Call writes and
	// serveQUICConverse reads. Omitting it was the whole reason the first version
	// of this HUNG: the callee read the request bytes as the caller frame and
	// then waited for a request that had already been sent. A frame-count
	// mismatch has no error path - both ends are still reading - so it presents
	// as silence rather than as a protocol error.
	if err := writeFrame(stream, encodeCaller(c.Caller)); err != nil {
		return nil, fmt.Errorf("magicseam: converse write caller: %w", err)
	}
	if err := writeFrame(stream, request); err != nil {
		return nil, fmt.Errorf("magicseam: converse write request: %w", err)
	}

	for {
		// EVERY ITERATION IS BOUNDED BY ctx, not by a per-frame timeout. A callee
		// that stops writing mid-conversation is indistinguishable from one
		// thinking hard, and only the caller knows how long the whole exchange
		// may take.
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("magicseam: converse: %w", err)
		}

		frame, err := readFrame(stream)
		if err != nil {
			// EOF HERE IS A FAILURE, NOT A CLEAN END. The conversation ends with
			// tagDone and nothing else; a stream that simply stopped means the
			// callee died or the connection broke, and returning a nil error
			// with an empty reply is precisely the swallowed failure this
			// function's doc refuses to produce.
			if errors.Is(err, io.EOF) {
				return nil, fmt.Errorf("magicseam: converse: peer closed the stream without a "+
					"final reply (%w)", io.ErrUnexpectedEOF)
			}

			return nil, fmt.Errorf("magicseam: converse read: %w", err)
		}
		if len(frame) == 0 {
			return nil, errors.New("magicseam: converse: callee sent an untagged empty frame")
		}

		switch frame[0] {
		case tagDone:
			return frame[1:], nil
		case tagAsk:
			answer, err := serve(ctx, frame[1:])
			if err != nil {
				return nil, fmt.Errorf("magicseam: converse: answering callback: %w", err)
			}
			if err := writeFrame(stream, answer); err != nil {
				return nil, fmt.Errorf("magicseam: converse write answer: %w", err)
			}
		default:
			// AN UNKNOWN TAG IS FATAL RATHER THAN SKIPPED. Skipping would leave
			// the stream misaligned - the next frame read would be whatever
			// followed a message this side did not understand - and the caller
			// would then answer questions it invented from garbage.
			return nil, fmt.Errorf("magicseam: converse: unknown frame tag %d", frame[0])
		}
	}
}

// Conversation is the callee side of one converse call: the request, plus the
// ability to ask the caller questions until Reply is returned.
type Conversation struct {
	// Caller is the attested identity of the peer that opened this stream, the
	// same value a Handler receives.
	Caller Caller
	// Request is what the caller sent to start the conversation.
	Request []byte

	stream io.ReadWriter
}

// Ask puts a question to the caller and returns its answer.
//
// AN ERROR HERE IS TERMINAL for the conversation: the stream is misaligned or
// the peer is gone, and a callee that continued would be talking to nothing.
func (c *Conversation) Ask(ask []byte) ([]byte, error) {
	if err := writeFrame(c.stream, append([]byte{tagAsk}, ask...)); err != nil {
		return nil, fmt.Errorf("magicseam: conversation ask: %w", err)
	}
	answer, err := readFrame(c.stream)
	if err != nil {
		return nil, fmt.Errorf("magicseam: conversation read answer: %w", err)
	}

	return answer, nil
}

// ConverseHandler serves one conversation, returning the final reply.
type ConverseHandler func(ctx context.Context, c *Conversation) ([]byte, error)

// serveQUICConverse handles one converse stream on the callee side: read the
// caller frame and the request, run the handler, write the final reply.
//
// THE HANDLER TALKS BACK THROUGH Conversation.Ask, WHICH WRITES ON THIS SAME
// STREAM. That is the whole mechanism: no second connection, no listener, and no
// way for two conversations to be confused with one another, because each one
// owns its stream for its whole life.
func serveQUICConverse(ctx context.Context, stream io.ReadWriter, peer string, handler ConverseHandler) {
	// A PEER THAT ADVERTISED NOTHING CANNOT GET HERE, but a nil handler behind an
	// advertised capability would leave the caller waiting on a stream nobody
	// reads. Refuse it as a call-level failure instead.
	if handler == nil {
		_ = writeFrame(stream, append([]byte{tagDone}, []byte(`{"err":"converse not served"}`)...))

		return
	}

	callerFrame, err := readFrame(stream)
	if err != nil {
		return
	}
	caller := decodeCaller(callerFrame)
	caller.PeerAddr = peer

	request, err := readFrame(stream)
	if err != nil {
		return
	}

	c := &Conversation{Caller: caller, Request: request, stream: stream}
	reply, err := handler(ctx, c)
	if err != nil {
		// THE ERROR GOES BACK AS A FINAL FRAME rather than by closing the stream.
		// A closed stream is what a CRASHED callee looks like, and the caller
		// treats that as a transport failure - which is correct for a crash and
		// wrong for a handler that ran and refused. The caller must be able to
		// tell "you are talking to nothing" from "I heard you and the answer is
		// no".
		_ = writeFrame(stream, append([]byte{tagDone}, []byte(err.Error())...))

		return
	}
	_ = writeFrame(stream, append([]byte{tagDone}, reply...))
}
