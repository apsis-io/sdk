// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Package magicseam lets a genuinely non-WASM Go program expose the magic
// seam (ADR-0028, periapsis:magic/handler) as a remote provider.
//
// *** TRAIL NO LONGER SPEAKS THIS PROTOCOL. *** MSK1 and its consumer flag
// --plug-remote-simple were REMOVED from trail by ADR-0044 (commit 5fe956bf1,
// "remove Simple/MSK1 transport, superseded by QUIC"). This doc comment cited
// trail's MSK1 transport for the authoritative wire description until
// 2026-08-27; that file has not existed since. Do not go looking for it, and
// do not pass --plug-remote-simple to trail - it is not a flag.
//
// So this package is now among the LAST SPEAKERS of MSK1 rather than one end
// of a live pair. What that means for you:
//
//   - For a Go provider a trail consumer can actually bind to today, use the
//     QUIC path in quic.go (--plug-remote-quic / --plug-serve-quic). That is
//     the live remote transport and where this SDK's own weight now sits.
//   - Trail DOES have a unix-socket rung again - the `ipc` rung, --ipc
//     unix:<path>[#tier] - but *** ITS WIRE IS NOT MSK1. *** Different
//     framing, different handshake, multiplexed. See docs/ipc-wire.md, which
//     opens by warning about exactly this confusion. Pointing an --ipc trail
//     at a Serve from this package will not handshake.
//
// The protocol below is kept and still described in full because the wire is
// the record now that the Rust end is gone - there is no other file to defer
// to. It is the ORIGINAL magic-sock wire protocol, before wRPC replaced it
// for the WASM-to-WASM case (which needs wRPC's generality: arbitrary WIT
// interfaces, resource handles, stream<T>).
// The magic seam's own interface is exactly the value-type-only case MSK1
// already handled (handle: func(request: list<u8>) -> result<list<u8>,
// error>), so this package implements just that - no WIT-RPC framework, no
// wasmtime, no dwarf, nothing WASM-shaped at all. A plain Go program calling
// Serve is a real provider.
//
// *** VERSION GATING IS ENFORCED HERE, AS OF 2026-08-27. *** Serve compares the
// consumer's required version against the one it serves and refuses an
// incompatible handshake with `accept = 0`. `versionCompatible` mirrors
// trail's plug negotiation's `version_compatible` exactly, including the 0.x rules
// that are not plain semver.
//
// WHY IT HAD TO MOVE HERE, because the original decision was not wrong:
// "version gating happens on the CONSUMER (trail) side, not here ... this
// package deliberately does not reimplement that semver logic" was CORRECT
// while trail's --plug-remote-simple gate sat on the other end. ADR-0044 deleted
// that gate along with the transport, and the comment went on delegating to a
// counterparty that no longer existed - so an MSK1 consumer requiring a version
// this provider does not implement was accepted and served.
//
// *** THE DELEGATION ROTTED, NOT THE CODE. *** A delegation names the thing it
// trusts, so deleting that thing leaves a sentence that still parses and a check
// nobody performs. On the QUIC path (quic.go) the gate is still trail-side and
// still correct - that package genuinely does not need to reimplement it,
// because there the server IS trail. Here the server is this package, and the
// gate has nowhere else to live.
package magicseam

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
)

// Handler processes one seam call: request in, response out. A returned
// error maps to the wire's Unavailable tag (the transport-neutral,
// fail-closed default) UNLESS it is (or wraps) ErrRejected or ErrTooLarge,
// which map to their own distinct wire tags - use errors.Is against those
// two sentinels from Handler, same as any other Go error-wrapping
// convention, don't compare error strings.
type Handler func(caller Caller, request []byte) ([]byte, error)

// Caller is WHO is calling, as established by the calling trail rather than
// claimed by the guest: a consumer's imported handle() has no caller parameter,
// so a component cannot name itself. mTLS (the QUIC transport requires and
// verifies a client cert against the trail CA) establishes that the peer
// asserting it is a trail at all.
//
// Empty on the MSK1 path (Serve): that wire has no caller frame. Treat an empty
// Caller as "unattributed" and decide whether to refuse - an unattributed call
// is the PROVIDER's decision, which is why the transport delivers it rather
// than dropping it.
type Caller struct {
	// The ASSERTED identity: what the peer said about itself, read from the
	// wire frame. trail fills it in from the pod it is running and a guest
	// cannot reach it - but nothing in the TRANSPORT verifies it. The QUIC
	// leaf carries a fixed CommonName/DNS-SAN shared by every trail peer
	// fleet-wide and the signing side discards the subject entirely
	// (periapsis's PKI relay), so mTLS proves "signed by the trail CA"
	// and nothing about WHICH peer is speaking. Any holder of a trail cert can
	// therefore claim to be any pod, given that pod's UID.
	Namespace string
	PodName   string
	PodUID    string
	Component string

	// PeerAddr is OBSERVED, not asserted: the transport's view of where the
	// call actually came from ("ip:port"), set by the server side after
	// decoding the frame. Empty on transports that cannot observe it (the
	// local link tier has no peer address at all).
	//
	// WHY IT IS SAFE TO TRUST MORE THAN THE FIELDS ABOVE: it never crosses the
	// wire. encodeCaller does not write it and decodeCaller does not read it -
	// decodeCaller constructs its result field-by-field, so a peer cannot
	// inject a PeerAddr however it pads the frame. A provider can compare it
	// against the claimed pod's real podIP and turn an assertion into
	// something the datapath attests, because the CNI binds a source address
	// to an endpoint and a pod cannot forge another pod's.
	//
	// It is NOT a complete identity: it says where the packets came from, not
	// who signed them, and it is only as good as the CNI's source-address
	// enforcement.
	PeerAddr string

	// VerifiedPrincipal is the peer certificate's CommonName, read from the
	// COMPLETED TLS handshake and never from the wire.
	//
	// # WHY THIS EXISTS WHEN PeerAddr ALREADY DOES
	//
	// PeerAddr is trustworthy *because the CNI binds a source address to an
	// endpoint*. That is a property of the cluster datapath, and it does not
	// survive leaving it: a device is behind NAT, its address is bound to
	// nothing and changes between apparitions. The one field a provider can
	// attest against in-cluster is exactly the one that dies at the edge
	// (ADR-0078's Gazer is off-cluster by construction). This carries an
	// identity the SIGNER vouched for instead, so it travels.
	//
	// # EMPTY IS THE NORMAL CASE TODAY, AND EMPTY IS NOT "TRUSTED"
	//
	// Every trail leaf in the fleet is minted with the fixed subject
	// pki.TrailQuicSNI - the signer imposes it and discards the CSR's own
	// (periapsis's PKI relay). So for every pod peer this is EMPTY, and it
	// will stay empty until something issues an individually-subjected leaf.
	// A provider that reads empty as "no claim made" is correct; one that reads
	// it as "nobody is impersonating anyone" is making the absent-vs-unknown
	// mistake this codebase exists to prevent. The fields above remain merely
	// ASSERTED regardless of what this one says.
	//
	// It is deliberately NOT populated from TrailQuicSNI: a value every peer
	// shares identifies nobody, and putting it here would turn "no identity"
	// into a string that LOOKS like one - the same collapse that makes a
	// mechanism returning one constant for every case survive review.
	VerifiedPrincipal string
}

// observed is what the TRANSPORT established about a connection at accept time.
//
// A STRUCT RATHER THAN TWO STRING PARAMETERS, because the observed/asserted line
// is the whole security property of Caller and threading it as loose strings is
// how a future field gets added to one call path and forgotten on another. These
// values cross no frame: they are read from the connection and the completed
// handshake, so no peer can influence them however it pads its caller frame.
type observed struct {
	PeerAddr  string
	Principal string
}

// encodeCaller renders a Caller into the wire frame trail expects. Kept beside
// decodeCaller so the two cannot drift.
func encodeCaller(c Caller) []byte {
	return []byte(strings.Join([]string{c.Namespace, c.PodName, c.PodUID, c.Component}, "\t"))
}

// decodeCaller parses the tab-separated caller frame trail writes
// (trail's QUIC transport encode_caller). A short or garbled frame
// yields empty fields rather than an error, matching the Rust side.
func decodeCaller(b []byte) Caller {
	f := strings.SplitN(string(b), "\t", 4)
	for len(f) < 4 {
		f = append(f, "")
	}
	return Caller{Namespace: f[0], PodName: f[1], PodUID: f[2], Component: f[3]}
}

// ErrRejected and ErrTooLarge are the two OTHER seam error tags a Handler
// can return (via errors.Is) beyond the Unavailable default - matching
// periapsis:magic/handler's error variant exactly (unavailable/rejected/
// too-large).
var (
	ErrRejected = errors.New("magicseam: rejected")
	ErrTooLarge = errors.New("magicseam: too large")
)

// ErrUnavailable is the third tag: the provider was REACHED and answered that it
// cannot serve this call right now - an armed barrier (ADR-0032), a handler
// returning the fail-closed default, a provider shedding load.
//
// It exists to be told apart from a TRANSPORT failure, which arrives from Call
// as a plain wrapped I/O error. Both are "the call did not succeed" and they
// demand opposite responses:
//
//	transport failure -> the connection is dead; redial (quicheal.go)
//	ErrUnavailable    -> the provider is UP and said no; redialling it is a
//	                     retry storm against something working correctly
//
// Before this existed the two were the same opaque fmt.Errorf, so no caller
// could have chosen correctly - which is why the healing client could not have
// been written without it.
var ErrUnavailable = errors.New("magicseam: provider unavailable")

// ErrVersionRejected reports that a provider COMPLETED the handshake and then
// refused the required version. It is deliberately distinguishable from every
// other DialQUIC failure, because those are transport failures and this one is
// an answer.
//
// The distinction is the whole basis of reachability probing
// (periapsis's trail operator's Prober): "the provider is reachable but serves the wrong
// version" and "nothing is listening" are the same string to a reader and
// opposite facts to a health check. Marking a provider unhealthy for a version
// mismatch would take a working provider out of service for consumers that
// wanted the version it actually serves.
var ErrVersionRejected = errors.New("magicseam: provider rejected the required version")

// Wire constants. *** THIS IS THE AUTHORITATIVE DESCRIPTION NOW *** - it said
// "see trail's MSK1 transport's module doc comment for the
// authoritative protocol description this mirrors exactly" until 2026-08-27,
// and that file was removed by ADR-0044. Nothing this mirrors exists; the
// constants below are the definition, not a copy of one.
const (
	preamble = "MSK1"
	// maxFrame bounds a single frame so a hostile/garbled peer can't make
	// this process allocate unbounded - matches trail's QUIC transport's
	// own MAX_FRAME (64 MiB, the seam's own too-large rejection ballpark).
	// *** THAT EQUALITY IS ENFORCED, not merely asserted here: ***
	// TestEverySeamSpeakerSharesOneFrameBound (periapsis's cross-language seam tests, 
	// seamframebound_test.go) reds if any of the five speakers - trail, comet,
	// this SDK, sdk/ts, sdk/c - drifts. It is the one cross-speaker fact that
	// survived MSK1's removal, which is why this citation can be repointed
	// when the parseAddr one below cannot.
	maxFrame = 64 << 20

	// THE REPLY TAGS: the FIRST BYTE of a reply frame, where 0 is success and
	// NONZERO is a failure code.
	//
	// ***THE CONVERSE SEAM USES THE SAME POSITION WITH THE OPPOSITE POLARITY***
	// (converse.go: convAsk=0, convDone=1). There 1 means the conversation
	// FINISHED NORMALLY; here 1 means UNAVAILABLE. They cannot mis-route - the
	// converse frames are read only by the handler opcode 5 dispatches to - but a
	// reader holding both files has two meanings for one byte, and the converse
	// path has no error branch, so a misreading HANGS rather than fails.
	//
	// Named apart deliberately (conv* versus tag*) so autocomplete does not offer
	// five candidates for one position. Pointer kept in BOTH directions because
	// whoever finds the hazard may arrive from either file.
	tagOK          byte = 0
	tagUnavailable byte = 1
	tagRejected    byte = 2
	tagTooLarge    byte = 3
)

// Serve listens on addr ("unix:<path>" or "tcp:<host:port>"). This said "the
// exact same syntax trail's own --plug-remote/--plug-remote-simple already
// use" until 2026-08-27; ADR-0079 renamed the tiers and BOTH those names are
// dead. Trail's live spellings are --remote (tcp only) and --ipc (unix only),
// so the syntax is not "the same" either - see parseAddr's note. Serve
// serves the magic seam via handler, forever - one goroutine per accepted
// connection (Go's cheap-goroutine model is a direct fit for what was
// originally a thread-per-connection design in trail's pre-wRPC
// implementation). version is this provider's own self-declared seam
// version (e.g. "0.1.0", matching periapsis:magic/handler@0.1.0) reported
// at every handshake - purely informational from this package's own point
// of view; the connecting trail consumer's gate is what actually enforces
// compatibility against it.
//
// Blocks forever (like net.Listener.Accept's own typical use), returning
// only on a listener-level error (bind failure, or the listener being
// closed by other means - this package exposes no explicit Close/shutdown,
// matching v1's scope of a long-running provider process).
func Serve(addr string, version string, handler Handler) error {
	network, address, err := parseAddr(addr)
	if err != nil {
		return err
	}

	// A stale socket file from a prior run would make Listen fail; clear it.
	// Ported from the pre-wRPC Rust serve_provider, which ADR-0044 removed;
	// ts/magicseam's equivalent is now the only other implementation to
	// compare against. A no-op, harmlessly, for "tcp".
	if network == "unix" {
		_ = os.Remove(address)
	}

	listener, err := net.Listen(network, address)
	if err != nil {
		return fmt.Errorf("magicseam: listen %s: %w", addr, err)
	}
	defer listener.Close()

	fmt.Fprintf(os.Stderr, "[magicseam] serving handler@%s on %s\n", version, addr)

	for {
		conn, err := listener.Accept()
		if err != nil {
			return fmt.Errorf("magicseam: accept on %s: %w", addr, err)
		}
		go serveConn(conn, version, handler)
	}
}

// parseAddr accepts "unix:<path>" or "tcp:<host:port>", nothing else.
//
// *** DO NOT "FIX" THIS CITATION BY REPOINTING IT AT A FILE THAT EXISTS. ***
// It read "mirrors trail's MSK1 transport's parse_addr exactly" until
// 2026-08-27. `fn parse_addr` now appears NOWHERE in trail's sources (verified
// against a positive control: `fn read_frame` finds 2, `fn parse_addr` finds
// 0). Trail did not move that grammar, it SPLIT it, and each half rejects what
// this function accepts:
//
//	--ipc     unix:<path>[#tier]        unix only  - tcp: is not accepted
//	--remote  tcp:<host:port>[#tier]    tcp only   - unix: is refused outright,
//	                                    with "QUIC is UDP-based and unix: has
//	                                    no meaning here. Use --ipc"
//
// Both carry a #tier suffix this function knows nothing about. So there is no
// live trail function this mirrors, and repointing at either one would produce
// a citation that is still wrong while LOOKING right - the path would resolve,
// so the next reader stops there instead of checking the grammar. A dead path
// at least announces itself.
//
// This combined unix-or-tcp grammar is now this SDK's own (sdk/ts and sdk/c
// match it). It is not trail's any more.
func parseAddr(addr string) (network, address string, err error) {
	switch {
	case strings.HasPrefix(addr, "unix:"):
		p := strings.TrimPrefix(addr, "unix:")
		if p == "" {
			return "", "", fmt.Errorf("magicseam: unix address needs a path: %q", addr)
		}
		return "unix", p, nil
	case strings.HasPrefix(addr, "tcp:"):
		hp := strings.TrimPrefix(addr, "tcp:")
		if hp == "" {
			return "", "", fmt.Errorf("magicseam: tcp address needs host:port: %q", addr)
		}
		return "tcp", hp, nil
	default:
		return "", "", fmt.Errorf("magicseam: address must be unix:<path> or tcp:<host:port>, got %q", addr)
	}
}

// serveConn is the per-connection loop: validate the preamble, handshake
// (always accepting - see the package doc comment on why version gating is
// the consumer's job, not this package's), then loop request/response
// frames until the peer disconnects. Errors here just end this one
// connection - never fatal to Serve's own accept loop.
func serveConn(conn net.Conn, version string, handler Handler) {
	defer conn.Close()
	// Explicit, not relying on Go's own TCP default: the request/response
	// pattern below (small write, then wait for a small reply) is exactly
	// what Nagle's algorithm + delayed ACKs combine to add real per-call
	// latency to over a genuine network.
	//
	// *** THE LIVE-CONFIRMED SYMPTOM, recorded HERE because the file that
	// held it is gone: a benchmark that ran instantly over a unix socket took
	// MINUTES over a real Service ClusterIP until both sides set this. ***
	// This deferred to remote_simple.rs's matching set_nodelay comment until
	// 2026-08-27; ADR-0044 deleted that file, and a measured symptom whose
	// only record is a comment in a deleted file is a measurement lost. The
	// unix-socket case is exactly where this looks unnecessary, which is why
	// it is worth the words.
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
	}
	r := bufio.NewReader(conn)

	pre := make([]byte, 4)
	if _, err := io.ReadFull(r, pre); err != nil {
		return
	}
	if string(pre) != preamble {
		// Not a magic-sock client - silently drop. Deliberate, and inherited
		// from the Rust server side ADR-0044 removed: a wrong preamble is a
		// stray connection, not an error worth a reply.
		return
	}

	// The client's REQUIRED version, and this package now enforces it.
	//
	// *** IT USED TO BE "read and discarded; this package always accepts". ***
	// That was safe while trail's --plug-remote-simple gate sat on the other
	// end; ADR-0044 deleted the gate along with the transport, and the comment
	// went on delegating to a counterparty that no longer existed. A delegation
	// names the thing it trusts, so removing that thing leaves a sentence that
	// still parses and a check nobody performs.
	required, err := readFrame(r)
	if err != nil {
		return
	}
	if !versionCompatible(string(required), version) {
		// accept = 0. The wire already carried this byte; nothing here was
		// unable to refuse, only unwilling.
		_, _ = conn.Write([]byte{0})
		// The served version still follows, so the consumer's error can name
		// what it asked for AND what it was offered rather than just failing.
		_ = writeFrame(conn, []byte(version))
		return
	}
	if _, err := conn.Write([]byte{1}); err != nil { // accept = 1
		return
	}
	if err := writeFrame(conn, []byte(version)); err != nil {
		return
	}

	for {
		request, err := readFrame(r)
		if err != nil {
			return // clean EOF or any read error ends the connection
		}
		// MSK1 has no caller frame, so this path is always unattributed.
		response, err := handler(Caller{}, request)
		if err != nil {
			if _, werr := conn.Write([]byte{tagFor(err)}); werr != nil {
				return
			}
			continue
		}
		if _, err := conn.Write([]byte{tagOK}); err != nil {
			return
		}
		if err := writeFrame(conn, response); err != nil {
			return
		}
	}
}

// versionCompatible reports whether a provider serving `served` satisfies a
// consumer requiring `required`.
//
// *** MIRRORS trail's plug negotiation's version_compatible EXACTLY, including the
// parts that are not plain semver. *** Copied deliberately rather than
// approximated with a >= comparison, because the 0.x rules are where the two
// would silently diverge and a divergence here means one end binds a plug the
// other would have refused:
//
//	major differs        -> never compatible
//	0.y.z                -> minor must be EQUAL (0.x minors are breaking)
//	0.0.z                -> patch must be EQUAL (every 0.0.z is its own API)
//	otherwise            -> (minor, patch) >= (required minor, patch)
//
// An UNPARSEABLE version on either side is accepted, matching trail's "serving
// unversioned" behaviour: a provider that declares no version cannot gate, and
// failing closed there would refuse every consumer of an unversioned provider
// rather than the incompatible ones. That is a real hole and it is the same hole
// trail has; it is not widened here.
func versionCompatible(required, served string) bool {
	rq, ok1 := parseVersion(required)
	sv, ok2 := parseVersion(served)
	if !ok1 || !ok2 {
		return true
	}
	if rq[0] != sv[0] {
		return false
	}
	if rq[0] == 0 {
		if rq[1] != sv[1] {
			return false
		}
		if rq[1] == 0 {
			return sv[2] == rq[2]
		}
		return sv[2] >= rq[2]
	}
	return sv[1] > rq[1] || (sv[1] == rq[1] && sv[2] >= rq[2])
}

// parseVersion pulls major/minor/patch out of "X.Y.Z", ignoring any pre-release
// or build-metadata suffix.
//
// (That sentence used to name the suffixes with their punctuation, and `go vet`
// read the second one as a BUILD CONSTRAINT - "invalid non-alphanumeric build
// constraint". A doc comment is not an inert place to write that token.)
//
// Hand-rolled on purpose: this package is vendored by third parties and
// deliberately has no dependencies beyond the standard library.
func parseVersion(v string) ([3]uint64, bool) {
	var out [3]uint64
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// tagFor maps a Handler-returned error to its wire tag: ErrRejected/
// ErrTooLarge (via errors.Is, so a wrapped sentinel still matches) to their
// own distinct tags, anything else to Unavailable - the transport-neutral,
// fail-closed default.
func tagFor(err error) byte {
	switch {
	case errors.Is(err, ErrRejected):
		return tagRejected
	case errors.Is(err, ErrTooLarge):
		return tagTooLarge
	default:
		return tagUnavailable
	}
}

func writeFrame(w io.Writer, b []byte) error {
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(b)))
	if _, err := w.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err := w.Write(b)
	return err
}

func readFrame(r io.Reader) ([]byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(lenBuf[:])
	if n > maxFrame {
		return nil, fmt.Errorf("magicseam: frame length %d exceeds max %d", n, maxFrame)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}
