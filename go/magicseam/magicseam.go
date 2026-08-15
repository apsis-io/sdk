// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Package magicseam lets a genuinely non-WASM Go program expose the magic
// seam (ADR-0028, periapsis:magic/handler) as a remote provider a trail-run
// WASM consumer can bind to via --plug-remote-simple <addr>[#tier].
//
// This is the provider (server) side of the magic sock's revived MSK1
// protocol (cmd/trail/src/remote_simple.rs) - the ORIGINAL magic-sock wire
// protocol, before wRPC replaced it for the WASM-to-WASM case (which needs
// wRPC's generality: arbitrary WIT interfaces, resource handles, stream<T>).
// The magic seam's own interface is exactly the value-type-only case MSK1
// already handled (handle: func(request: list<u8>) -> result<list<u8>,
// error>), so this package implements just that - no WIT-RPC framework, no
// wasmtime, no dwarf, nothing WASM-shaped at all. A plain Go program calling
// Serve is a real provider.
//
// Version gating happens on the CONSUMER (trail) side, not here: Serve
// always accepts a connecting consumer's handshake regardless of the
// version it requires - trail's own --plug-remote-simple gate (the same
// version_compatible/--plug-min-version logic every other plug tier already
// goes through) is the enforcement point. This package deliberately does
// not reimplement that semver logic.
package magicseam

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
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
	// (internal/pki/trailrelay.go), so mTLS proves "signed by the trail CA"
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
}

// encodeCaller renders a Caller into the wire frame trail expects. Kept beside
// decodeCaller so the two cannot drift.
func encodeCaller(c Caller) []byte {
	return []byte(strings.Join([]string{c.Namespace, c.PodName, c.PodUID, c.Component}, "\t"))
}

// decodeCaller parses the tab-separated caller frame trail writes
// (cmd/trail/src/remote_quic.rs encode_caller). A short or garbled frame
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
// (internal/trailop's Prober): "the provider is reachable but serves the wrong
// version" and "nothing is listening" are the same string to a reader and
// opposite facts to a health check. Marking a provider unhealthy for a version
// mismatch would take a working provider out of service for consumers that
// wanted the version it actually serves.
var ErrVersionRejected = errors.New("magicseam: provider rejected the required version")

// Wire constants - see cmd/trail/src/remote_simple.rs's module doc
// comment for the authoritative protocol description this mirrors exactly.
const (
	preamble = "MSK1"
	// maxFrame bounds a single frame so a hostile/garbled peer can't make
	// this process allocate unbounded - matches remote_simple.rs's own
	// MAX_FRAME (64 MiB, the seam's own too-large rejection ballpark).
	maxFrame = 64 << 20

	tagOK          byte = 0
	tagUnavailable byte = 1
	tagRejected    byte = 2
	tagTooLarge    byte = 3
)

// Serve listens on addr ("unix:<path>" or "tcp:<host:port>", the exact same
// syntax trail's own --plug-remote/--plug-remote-simple already use) and
// serves the magic seam via handler, forever - one goroutine per accepted
// connection (Go's cheap-goroutine model is a direct fit for what was
// originally a thread-per-connection design in cmd/trail's pre-wRPC
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

	// A stale socket file from a prior run would make Listen fail; clear it
	// (mirrors the pre-wRPC Rust serve_provider this protocol was ported
	// from - cmd/trail/src/remote_simple.rs's own module doc comment -
	// and sdk/ts/magicseam's equivalent). A no-op, harmlessly, for "tcp".
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

// parseAddr mirrors cmd/trail/src/remote_simple.rs's parse_addr exactly:
// "unix:<path>" or "tcp:<host:port>", nothing else accepted.
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
	// latency to over a genuine network - see remote_simple.rs's matching
	// set_nodelay call and its comment for the live-confirmed symptom
	// (a benchmark that ran instantly over a unix socket took minutes over
	// a real Service ClusterIP before both sides set this).
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
	}
	r := bufio.NewReader(conn)

	pre := make([]byte, 4)
	if _, err := io.ReadFull(r, pre); err != nil {
		return
	}
	if string(pre) != preamble {
		return // not a magic-sock client - silently drop, matching remote_simple.rs's server-side (now Go-side) intent
	}

	// The client's required version - read and discarded; this package
	// always accepts (see doc comment). Reading it is still necessary to
	// stay in sync with the wire protocol's framing.
	if _, err := readFrame(r); err != nil {
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
