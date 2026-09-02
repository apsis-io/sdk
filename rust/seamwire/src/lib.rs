// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! The bulk seam over QUIC: capability negotiation and chunk framing.
//!
//! # Why negotiation rather than just changing the wire
//!
//! Four providers are LIVE against the current protocol - the Go, C and TS echo
//! providers and `w8s-node-provider`, the last of which is load-bearing for the
//! whole w8s demo. "Forward-only, no backward compatibility" (CLAUDE.md) permits
//! changing a format outright, and would here mean rebuilding and redeploying
//! four SDKs' worth of providers to add a byte none of them needs. That is not
//! forward motion, it is a flag day for a feature only one consumer wants.
//!
//! So the classic `handle` path's bytes are **unchanged**, and streaming is
//! negotiated once per connection:
//!
//! ```text
//! client -> server   frame(required version)  [frame(client caps)]   finish
//! server -> client   byte(accept)  frame(served version)  [frame(server caps)]
//! ```
//!
//! Both capability frames are OPTIONAL, and that is what makes this compatible
//! in both directions:
//!
//! - new client, old server - the server never writes a caps frame, the client
//!   reads a clean EOF, concludes "no streaming", and refuses a stream call with
//!   an explanation instead of hanging or corrupting a classic call.
//! - old client, new server - the client never writes caps and never reads the
//!   server's; an unread frame on a finished stream harms nothing.
//! - new/new - both see `stream`, and only then does the per-call opcode below
//!   appear on the wire.
//!
//! # Per-call framing, once both sides agreed
//!
//! An opcode leads every call stream, so classic and streaming calls are
//! distinguished by construction rather than by guessing from frame contents:
//!
//! ```text
//! classic    [OP_CALL]  frame(caller)  frame(request)
//!            <- byte(tag)  frame(response)                     tag 0 = ok
//!
//! streaming  [OP_STREAM] frame(caller)  frame(chunk)* frame(EOF)
//!            <- byte(tag)  frame(chunk)* frame(EOF)
//! ```
//!
//! `EOF` is a zero-length frame. A zero-length chunk is therefore not
//! representable mid-stream - which costs nothing, since an empty write carries
//! no data, and buys an end marker that needs no separate length prefix or
//! sentinel byte.
//!
//! The opcode is written on EVERY call once negotiated, including classic ones,
//! so there is exactly one code path per peer generation rather than a
//! per-call guess.

/// A classic `handle(list<u8>) -> list<u8>` call.
pub const OP_CALL: u8 = 0;
/// A bulk `handle-stream(stream<u8>) -> stream<u8>` call.
pub const OP_STREAM: u8 = 1;

/// A coordinated-checkpoint MARKER (ADR-0032).
///
/// Carries a barrier ID frame. On receipt a provider stops admitting NEW calls
/// on that connection, lets in-flight ones drain, and replies with OP_MARKER_ACK
/// once the channel is empty - so the consumer learns that this specific channel
/// is quiesced, rather than inferring it from a local in-flight count that says
/// nothing about the peer.
///
/// THE BARRIER ID IS LOAD-BEARING, not decoration: a provider that has already
/// resumed, or that sees a stale marker from a timed-out barrier, must be able to
/// tell which snapshot instance a marker belongs to. Without it a late marker
/// from an abandoned barrier silently re-quiesces a running provider.
pub const OP_MARKER: u8 = 2;

/// The reply to OP_MARKER: this channel is drained and admitting nothing new.
/// Carries the same barrier ID back, so a consumer cannot mistake an ack for one
/// barrier as an ack for another.
pub const OP_MARKER_ACK: u8 = 3;

/// Release a barrier: resume admitting calls on this connection.
///
/// Sent on BOTH the commit and abort paths - a provider must not be able to tell
/// them apart, because a provider left quiesced by a coordinator that died is
/// wedged, and "the coordinator will always send the right one" is exactly the
/// assumption that makes it wedge.
pub const OP_RESUME: u8 = 4;

/// A CONVERSATION: one stream carrying a call whose callee may ask questions
/// back before answering (board #6, ADR-0082 "RADIANT ALSO DRIVES").
///
/// radiant invokes ONE STEP in a pod. The step's `observe`/`emit` have to reach
/// radiant mid-pass, and this is how: the same stream carries them back, so the
/// invoking goroutine holds the Host and THE STREAM IS THE IDENTITY OF THE PASS.
/// The alternative was a listener on radiant plus a registry mapping a callback
/// to the right in-flight Host - a routing problem this shape does not have.
///
/// After the opcode: a caller frame, then a request frame, then the callee
/// writes CONV_ASK/CONV_DONE frames (below) until it is done.
pub const OP_CONVERSE: u8 = 5;

/// FIRST BYTE OF A CALLEE FRAME IN A CONVERSATION. The rest of the frame is the
/// question; the caller answers with ONE PLAIN frame carrying no tag.
///
/// THESE TWO ARE NAMED CONV_* AND NOT TAG_* ON PURPOSE, AND THE REASON IS A
/// NEAR-MISS RATHER THAN TASTE. Two unrelated first-byte conventions already
/// live on this wire and they have OPPOSITE polarity:
///
/// ```text
/// the streaming REPLY path   0 = ok, NONZERO = error
///                            (remote_quic.rs:976 "write ok tag", :983
///                            "write error tag")
/// a CONVERSATION frame       0 = ASK, 1 = DONE, and DONE is SUCCESS
/// ```
///
/// So a leading `1` is "error code 0" on one path and "here is your answer" on
/// the other. Nothing mis-routes - a conversation frame is only ever read by the
/// handler OP_CONVERSE dispatches to - so this is a READING hazard, not a wire
/// collision. It matters because a misparse HERE has no error branch: both ends
/// keep reading and the exchange HANGS rather than failing, which is exactly the
/// hour this protocol's Go half already lost to a handshake mismatch.
///
/// radiant-main found the sharper half on their side: magicseam.go already had
/// `tagOK=0, tagUnavailable=1, tagRejected=2`, so a `tagDone=1` would have sat
/// beside `tagUnavailable=1` meaning the opposite thing, in one package, all
/// spelled `tag*`. They renamed to conv* rather than commenting, because a
/// comment does not reach somebody autocompleting `tag` and picking one of five.
pub const CONV_ASK: u8 = 0;

/// FIRST BYTE OF THE FINAL CALLEE FRAME: the rest is the reply and the
/// conversation ends. See CONV_ASK for why these are not called TAG_*.
///
/// A CALLEE THAT RAN AND REFUSED SENDS CONV_DONE CARRYING ITS ERROR TEXT rather
/// than closing the stream, and EOF is a FAILURE rather than a clean end. That
/// asymmetry is load-bearing on the Go side: a vanished callee producing an
/// empty reply would read as "the step finished", and a finished step is
/// TERMINAL - the Driver retires the program and tears down its live
/// obligations, rather than parking it.
pub const CONV_DONE: u8 = 1;

/// The capability token for a conversation. Advertised ONLY by a callee that has
/// a handler for it.
///
/// ADVERTISING IS A PROMISE ABOUT EVERY SUBSEQUENT CALL, NOT ABOUT THIS ONE.
/// A server decides from the client's caps ALONE whether an opcode precedes each
/// call, so a peer that advertises and then omits opcodes corrupts the next
/// ordinary call - see remote_quic.rs:444, which says exactly this and was read
/// the same night the Go half walked into it.
pub const CAP_CONVERSE: &str = "converse";

/// The capability token for the bulk seam. A bare token rather than a bitmask
/// or a version number: capabilities are sparse and independent, and a reader
/// that does not know a token must ignore it rather than mis-order it.
pub const CAP_STREAM: &str = "stream";

/// The capability token for the `status` op (ADR-0059 addendum).
///
/// Advertised by a provider that serves it, so a consumer can know BEFORE
/// calling rather than discovering it by refusal. An older provider answers
/// `status` with a Rejected "unknown op", which does name the missing thing but
/// leaves no room to degrade gracefully.
pub const CAP_STATUS: &str = "status";

/// The capability token for the coordinated-checkpoint marker protocol
/// (ADR-0032): OP_MARKER / OP_MARKER_ACK / OP_RESUME.
///
/// NEGOTIATED, and that is the whole reason a non-native provider can join a
/// barrier at all. A provider written in any language advertises `barrier` once
/// it implements the three ops; one that does not is never sent a marker, and
/// the coordinator can see - before starting - that the graph contains a member
/// it cannot quiesce. That is the difference between a checkpoint that fails
/// closed and one that produces a torn cut nobody detects.
pub const CAP_BARRIER: &str = "barrier";

/// The capability token for a device KEYCHAIN seam - a Comet re-exporting the
/// platform keystore it holds (ADR-0078).
///
/// ***THE FIRST TOKEN HERE THAT A DEVICE ADVERTISES RATHER THAN A SERVER.*** The
/// four above are trail's wire features; this one is a capability a piece of
/// HARDWARE has and a cluster does not. It is the shape ADR-0078 is for: "a
/// capability the agent holds and re-exports is a seam, one a workload holds
/// directly is a hole".
///
/// A device advertises it because the handler is compiled in and answers - with
/// a structured `Err` naming the reason when the platform keystore is missing,
/// which is a REPLY and not a hang. That distinction is what makes advertising
/// honest here: `gazer-seamprobe` reports `SEAMPROBE-KEYCHAIN-UNAVAILABLE`
/// separately from a seam failure, because the seam worked and the keychain did
/// not - different findings, different remedies.
pub const CAP_KEYCHAIN: &str = "keychain";

/// What a peer said it can do. Unknown tokens are retained but unused, so a
/// newer peer advertising more does not confuse an older one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Caps {
    tokens: Vec<String>,
}

impl Caps {
    /// The capabilities THIS build offers.
    ///
    /// ***EVERY TOKEN HERE IS A PROMISE THIS BINARY CAN KEEP. DO NOT ADD ONE
    /// AHEAD OF ITS SERVE SIDE.***
    ///
    /// CAP_CONVERSE was DEFINED (line 146) and never listed here for three days,
    /// which had a consequence nobody predicted from reading the code: with no
    /// reference to it anywhere, the string was DEAD-CODE-ELIMINATED out of the
    /// binary entirely - `strings /usr/local/bin/trail | grep converse` returned
    /// 0 while `barrier` returned 18. A constant that agrees with its Go twin
    /// and is never used is not half-wired, it is absent.
    ///
    /// Radiant met the honest version of that on 2026-08-21: it dialled a
    /// Perseid pod, the QUIC handshake completed, and Converse was declined with
    /// "peer does not support the converse seam (peer advertised [stream status
    /// barrier])". ***THAT REFUSAL WAS CORRECT AND IS WHY THIS LINE WAITED.***
    /// Advertising a capability the handler cannot serve converts a clean,
    /// readable, up-front decline into a mid-stream hang - and magicseam's caller
    /// treats an empty reply as THE WORK FINISHED, so the failure would not
    /// stall a Perseid, it would silently RETIRE one.
    ///
    /// Listed now because `ProviderCall::converse` has a real implementation
    /// (plug.rs, running one Perseid step) rather than the refusing default.
    /// go/magicseam/wiredrift_test.go enforces the pair in BOTH directions -
    /// it went red on this exact line being absent while the serve side existed.
    pub fn ours() -> Caps {
        Caps {
            tokens: vec![
                CAP_STREAM.to_string(),
                CAP_STATUS.to_string(),
                CAP_BARRIER.to_string(),
                CAP_CONVERSE.to_string(),
            ],
        }
    }

    /// Absent capability frame, i.e. a peer from before negotiation existed.
    /// Distinct from an EMPTY frame only in intent; both mean "nothing".
    pub fn none() -> Caps {
        Caps::default()
    }

    /// The capabilities a NON-TRAIL speaker offers.
    ///
    /// [`Caps::ours`] is trail's own set and is deliberately a fixed list - it is
    /// a statement about THIS binary. A Comet is a different binary with a
    /// different set, and before this existed the only public constructors were
    /// `ours`, `none` and `decode`, so a device could advertise its keychain only
    /// by round-tripping its own tokens through the wire decoder. That works and
    /// reads as a trick; this says what is meant.
    ///
    /// The same rule applies as to `ours`: ***every token passed here is a
    /// promise the caller can keep.***
    pub fn of(tokens: &[&str]) -> Caps {
        Caps {
            tokens: tokens.iter().map(|t| (*t).to_string()).collect(),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        self.tokens.join(",").into_bytes()
    }

    /// Parse a capability frame. Unknown and empty tokens are dropped rather
    /// than rejected: a capability list is not a contract to be validated, it
    /// is an advertisement, and failing a connection over an unrecognised
    /// token would make adding one a breaking change - the exact thing this
    /// mechanism exists to avoid.
    pub fn decode(bytes: &[u8]) -> Caps {
        let s = String::from_utf8_lossy(bytes);
        Caps {
            tokens: s
                .split(',')
                .map(|t| t.trim())
                .filter(|t| !t.is_empty())
                .map(|t| t.to_string())
                .collect(),
        }
    }

    pub fn has(&self, token: &str) -> bool {
        self.tokens.iter().any(|t| t == token)
    }

    /// Streaming is available only when BOTH ends advertise it. Deliberately
    /// not "the server supports it": the client must also know to write an
    /// opcode, and a one-sided assumption would corrupt every classic call.
    pub fn streams_agreed(ours: &Caps, theirs: &Caps) -> bool {
        ours.has(CAP_STREAM) && theirs.has(CAP_STREAM)
    }

    /// Whether the PEER serves `status`. Deliberately NOT two-sided, unlike
    /// streaming: `status` is a plain request/reply, so nothing about this side
    /// changes how the bytes are framed. Requiring both ends to advertise would
    /// refuse a working combination for no reason.
    pub fn status_served(theirs: &Caps) -> bool {
        theirs.has(CAP_STATUS)
    }

    /// Whether the marker protocol may be used on this connection.
    ///
    /// TWO-SIDED, like streaming and unlike status, and for the same reason: a
    /// marker changes what BOTH ends do with the stream. A consumer that sent
    /// OP_MARKER to a peer that does not understand it would have its opcode read
    /// as a caller frame and get a garbled call, not a clean refusal.
    pub fn barrier_agreed(ours: &Caps, theirs: &Caps) -> bool {
        ours.has(CAP_BARRIER) && theirs.has(CAP_BARRIER)
    }

    /// Why a graph member cannot be quiesced, for a coordinator to surface
    /// BEFORE it starts a barrier rather than after one times out.
    ///
    /// A provider that cannot be quiesced is not a slow member - it is a member
    /// whose in-flight calls will still be in flight at the snapshot instant, so
    /// the cut is torn. Saying so up front is the difference between failing
    /// closed and producing a checkpoint nobody knows is inconsistent.
    pub fn barrier_refusal(label: &str, theirs: &Caps) -> String {
        format!(
            "provider {label} does not advertise the {CAP_BARRIER:?} capability, so it cannot be              quiesced for a coordinated checkpoint - its in-flight calls would still be in flight              at the snapshot instant, tearing the cut. It advertised [{}]. Rebuild it against an              SDK that implements the marker ops, or exclude it from the barrier.",
            theirs.tokens.join(", ")
        )
    }

    /// The refusal for a consumer that REQUIRES `status` against a peer that
    /// does not serve it. Names the capability, because the alternative - a
    /// Rejected "unknown op" arriving mid-call - tells an operator what the
    /// provider did, not what it lacks.
    pub fn status_refusal(label: &str, theirs: &Caps) -> String {
        format!(
            "provider {label} does not advertise the {CAP_STATUS:?} capability, so it cannot \
             answer a status call. It advertised [{}]. This is a provider older than the status \
             op - rebuild and redeploy it; the consumer needs no change.",
            theirs.tokens.join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let c = Caps::decode(&Caps::ours().encode());
        assert!(c.has(CAP_STREAM));
    }

    /// The compatibility property this whole module exists for: a peer that
    /// never sends a capability frame must land on "no streaming", never on
    /// "assume yes".
    #[test]
    fn an_absent_or_empty_frame_means_no_streaming() {
        assert!(!Caps::none().has(CAP_STREAM));
        assert!(!Caps::decode(b"").has(CAP_STREAM));
        assert!(!Caps::streams_agreed(&Caps::ours(), &Caps::none()));
        assert!(!Caps::streams_agreed(&Caps::none(), &Caps::ours()));
        assert!(!Caps::streams_agreed(&Caps::none(), &Caps::none()));
    }

    #[test]
    fn agreement_needs_both_ends() {
        assert!(Caps::streams_agreed(&Caps::ours(), &Caps::ours()));
    }

    /// A newer peer advertising tokens we do not know must still negotiate the
    /// ones we do - otherwise adding a capability later becomes a breaking
    /// change, which is precisely what negotiation is here to prevent.
    #[test]
    fn unknown_tokens_do_not_break_a_known_one() {
        let theirs = Caps::decode(b"stream,quantum-teleport,zip");
        assert!(Caps::streams_agreed(&Caps::ours(), &theirs));
        let only_unknown = Caps::decode(b"quantum-teleport");
        assert!(!Caps::streams_agreed(&Caps::ours(), &only_unknown));
    }

    #[test]
    fn tolerates_whitespace_and_stray_separators() {
        let c = Caps::decode(b" stream , , ");
        assert!(c.has(CAP_STREAM));
        assert_eq!(c.tokens.len(), 1, "empty tokens must be dropped, got {:?}", c.tokens);
    }

    /// The two opcodes must differ - a shared value would route every streaming
    /// call into the classic handler and vice versa.
    /// Adding a second capability must not disturb the first. A peer sending
    /// both must still negotiate streaming.
    #[test]
    fn stream_and_status_coexist() {
        let both = Caps::decode(&Caps::ours().encode());
        assert!(Caps::streams_agreed(&Caps::ours(), &both), "status broke stream negotiation");
        assert!(Caps::status_served(&both), "status is not advertised by ours()");
    }

    /// The pre-status provider. Must read as NOT serving status, while still
    /// negotiating streaming - otherwise adding a token silently downgrades
    /// working peers.
    #[test]
    fn a_stream_only_peer_does_not_serve_status() {
        let old = Caps::decode(b"stream");
        assert!(!Caps::status_served(&old));
        assert!(Caps::streams_agreed(&Caps::ours(), &old));
    }

    /// Silence is never yes - the same rule the bulk seam already holds.
    #[test]
    fn absent_or_empty_caps_do_not_serve_status() {
        for frame in [b"".as_slice(), b"   ".as_slice(), b",,".as_slice()] {
            assert!(!Caps::status_served(&Caps::decode(frame)), "frame {frame:?} read as serving status");
        }
        assert!(!Caps::status_served(&Caps::none()));
    }

    /// The refusal must name the CAPABILITY and what the peer did offer - a
    /// message that says only "failed" sends the reader to the wrong layer.
    #[test]
    fn the_status_refusal_names_the_capability_and_what_was_offered() {
        let msg = Caps::status_refusal("tcp:p:9500", &Caps::decode(b"stream"));
        assert!(msg.contains("status"), "does not name the capability: {msg}");
        assert!(msg.contains("stream"), "does not report what the peer DID advertise: {msg}");
        assert!(msg.contains("rebuild"), "does not say what to do: {msg}");
    }

    /// EVERY opcode, not two of them.
    ///
    /// THIS TEST USED TO ASSERT `OP_CALL != OP_STREAM` AND NOTHING ELSE, which
    /// was two of five and read as complete. Adding OP_CONVERSE with a duplicate
    /// value would have passed it - and a duplicate opcode does not fail loudly:
    /// the peer dispatches to the wrong handler, reads a frame it cannot parse,
    /// and BOTH ENDS KEEP READING. A misparse on this wire hangs rather than
    /// errors, which is an hour of somebody's evening per occurrence.
    #[test]
    fn opcodes_are_distinct() {
        let ops = [
            ("OP_CALL", OP_CALL),
            ("OP_STREAM", OP_STREAM),
            ("OP_MARKER", OP_MARKER),
            ("OP_MARKER_ACK", OP_MARKER_ACK),
            ("OP_RESUME", OP_RESUME),
            ("OP_CONVERSE", OP_CONVERSE),
        ];
        for (i, (an, a)) in ops.iter().enumerate() {
            for (bn, b) in &ops[i + 1..] {
                assert_ne!(a, b, "{an} and {bn} are both {a} - the peer would dispatch one to \
                    the other's handler and the exchange would HANG, not fail");
            }
        }
    }

    /// The conversation tags are a SEPARATE namespace from the opcodes and must
    /// not be compared to them - they occupy the first byte of a FRAME, not the
    /// first byte of a STREAM. This pins only that they differ from each other,
    /// which is what a callee's writer and a caller's reader disagree about.
    ///
    /// Deliberately NOT asserting they differ from the OP_ values: they legally
    /// may not, and asserting it would encode a constraint the wire does not
    /// have - which is how a test starts refusing correct changes.
    #[test]
    fn conversation_tags_are_distinct() {
        assert_ne!(CONV_ASK, CONV_DONE,
            "ASK and DONE are the same byte - a caller would answer the final reply as if it \
             were a question, and wait for another frame that never comes");
    }
}
