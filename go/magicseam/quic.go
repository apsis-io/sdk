// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// QUIC transport (ADR-0043) for a genuinely non-WASM Go magic-seam
// provider/consumer - mirrors tools/trail/src/remote_quic.rs's wire
// protocol EXACTLY (see that file's own module doc comment, the
// authoritative spec this was ported from): mutual TLS against the
// cluster's self-managed trail CA, one persistent connection, a version
// handshake on the first bidirectional stream, then every subsequent call
// opens its OWN stream (so unrelated calls never queue behind each other -
// unlike Serve/DialMSK1's single-connection serialization above).
//
// TLS material: peri.apsis/tls-quic (internal/podlaunch/builder.go)
// bind-mounts a fresh cert/key/CA-bundle triple, signed by the trail CA,
// into the pod at internal/podlaunch.TLSQuicMountDir - callers running as
// a pod should point DialQUIC/ServeQUIC at those three files directly.
package magicseam

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"

	quic "github.com/quic-go/quic-go"
)

// TrailQUICSNI is the fixed CommonName/DNS-SAN every trail-CA-signed QUIC
// leaf carries - must match internal/podlaunch/trailtls.go's TrailQuicSNI
// and tools/trail/src/remote_quic.rs's SERVER_NAME exactly. Every peer
// shares this one SAN (a pod's own address is neither known at cert-mint
// time nor stable across a migration), so hostname verification is
// trivially satisfied; the real trust boundary is "signed by the trail
// CA," not which specific peer presents it.
const TrailQUICSNI = "trail-quic-peer"

// quicALPNProtocol is the ALPN protocol negotiated on every trail QUIC
// endpoint (client and server) - must match tools/trail/src/remote_quic.rs's
// own ALPN_PROTOCOL and sdk/ts/magicseam/quic.ts's own ALPN constant
// exactly. quic-go's own docs (client.go/server.go) say tls.Config "must
// define an application protocol (using NextProtos)"; leaving it unset
// worked by coincidence as long as BOTH peers left it unset (quic-go
// apparently skips ALPN negotiation entirely in that degenerate case), but
// broke live the moment trail's Rust client started offering
// "trail-quic" (this same fix, on the Rust side) against this SDK's
// still-empty NextProtos: quic-go's server had no configured protocol to
// match the client's offered one against, and closed the connection
// ("peer doesn't support any known protocol"). Setting the SAME string
// here resolves it cleanly instead of leaving Go as the one implementation
// relying on an undocumented, coincidental no-ALPN/no-ALPN pairing.
const quicALPNProtocol = "trail-quic"

// loadQUICTLSConfig builds a *tls.Config for either a QUIC dial or listen
// from the three PEM files peri.apsis/tls-quic provisions - mutual TLS,
// trusting ONLY the given CA bundle (never the system root store).
func loadQUICTLSConfig(certPath, keyPath, caPath string, isServer bool) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("magicseam: load QUIC cert/key: %w", err)
	}
	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		return nil, fmt.Errorf("magicseam: read QUIC CA bundle: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("magicseam: no certificates found in QUIC CA bundle %s", caPath)
	}
	cfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		ServerName:   TrailQUICSNI,
		NextProtos:   []string{quicALPNProtocol},
	}
	if isServer {
		cfg.ClientCAs = pool
		cfg.ClientAuth = tls.RequireAndVerifyClientCert
	} else {
		cfg.RootCAs = pool
	}
	return cfg, nil
}

// parseQUICAddr mirrors remote_quic.rs's resolve_addr / podlaunch's
// validateRemotePlugQuicAddr: ONLY tcp:<host:port> is meaningful for a
// UDP-based transport - unlike parseAddr above (MSK1), unix: is rejected.
func parseQUICAddr(addr string) (string, error) {
	hp, ok := strings.CutPrefix(addr, "tcp:")
	if !ok || hp == "" {
		return "", fmt.Errorf("magicseam: QUIC address must be tcp:<host:port>, got %q", addr)
	}
	return hp, nil
}

// QUICClient is a bound connection to one QUIC magic-seam provider -
// dial once via DialQUIC, then Call as many times as needed; independent
// calls each open their own stream and never queue behind each other.
type QUICClient struct {
	// Caller is announced on every call. Zero means unattributed, which is the
	// normal case for a plain Go consumer that is not a trail-managed pod.
	Caller Caller

	conn   *quic.Conn
	Served string // the provider's self-reported version (may be "")
	// PeerCaps is what the provider advertised, or empty for a provider that
	// predates negotiation. Consult it with StatusServed(c.PeerCaps) BEFORE
	// calling an optional op, rather than calling and reading a refusal.
	PeerCaps []string
	// PeerStatus is the component's self-reported status, valid only when
	// HasStatus is true. Two fields rather than a pointer so a caller that
	// ignores HasStatus reads the zero state - which is not Healthy() - instead
	// of dereferencing nil or, worse, seeing a plausible-looking "ready".
	PeerStatus ComponentStatus
	HasStatus  bool
}

// DialQUIC connects to a QUIC magic-seam provider at addr ("tcp:<host:port>")
// and performs the version handshake: requiredVersion is this consumer's
// own required version ("" = none), sent to the provider; the provider's
// own served version is returned via QUICClient.Served for the caller to
// gate on (this package does not itself enforce semver compatibility -
// same "gating is the caller's job" convention DialMSK1/Serve already use).
func DialQUIC(ctx context.Context, addr, certPath, keyPath, caPath, requiredVersion string) (*QUICClient, error) {
	hostPort, err := parseQUICAddr(addr)
	if err != nil {
		return nil, err
	}
	tlsCfg, err := loadQUICTLSConfig(certPath, keyPath, caPath, false)
	if err != nil {
		return nil, err
	}
	conn, err := quic.DialAddr(ctx, hostPort, tlsCfg, nil)
	if err != nil {
		return nil, fmt.Errorf("magicseam: QUIC dial %s: %w", addr, err)
	}

	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		conn.CloseWithError(0, "handshake failed")
		return nil, fmt.Errorf("magicseam: open handshake stream: %w", err)
	}
	if err := writeFrame(stream, []byte(requiredVersion)); err != nil {
		conn.CloseWithError(0, "handshake failed")
		return nil, fmt.Errorf("magicseam: write required version: %w", err)
	}
	if err := stream.Close(); err != nil { // finish our send side
		conn.CloseWithError(0, "handshake failed")
		return nil, fmt.Errorf("magicseam: finish handshake stream: %w", err)
	}
	acceptByte := make([]byte, 1)
	if _, err := io.ReadFull(stream, acceptByte); err != nil {
		conn.CloseWithError(0, "handshake failed")
		return nil, fmt.Errorf("magicseam: read handshake accept byte: %w", err)
	}
	servedFrame, err := readFrame(stream)
	if err != nil {
		conn.CloseWithError(0, "handshake failed")
		return nil, fmt.Errorf("magicseam: read served version: %w", err)
	}
	// OPTIONAL third frame: the provider's capabilities, written after the
	// served version. Mirror-image of the server's own optional read - a
	// provider from before negotiation sends none, so a read failure means
	// "advertised nothing", never an error. Without this the consumer half of
	// negotiation does not exist: StatusServed had no peer list to consult, so
	// a consumer could only try an op and be refused.
	var peerCaps []string
	if capsFrame, cerr := readFrame(stream); cerr == nil {
		peerCaps = parseCaps(capsFrame)
	}
	// OPTIONAL frame three: the component's self-reported status (ADR-0060).
	// Same treatment as caps for the same reason - absent, empty or unknown all
	// mean "no opinion", never unhealthy.
	var peerStatus ComponentStatus
	var haveStatus bool
	if statusFrame, serr := readFrame(stream); serr == nil {
		peerStatus, haveStatus = DecodeComponentStatus(statusFrame)
	}
	if acceptByte[0] == 0 {
		conn.CloseWithError(0, "incompatible version")
		return nil, fmt.Errorf("%w: required %q, serves %q", ErrVersionRejected, requiredVersion, servedFrame)
	}

	return &QUICClient{
		conn:       conn,
		Served:     string(servedFrame),
		PeerCaps:   peerCaps,
		PeerStatus: peerStatus,
		HasStatus:  haveStatus,
	}, nil
}

// Call opens a NEW bidirectional stream for this one request - concurrent
// Call invocations on the same *QUICClient never serialize behind each
// other, unlike DialMSK1's Client.
func (c *QUICClient) Call(ctx context.Context, request []byte) ([]byte, error) {
	stream, err := c.conn.OpenStreamSync(ctx)
	if err != nil {
		return nil, fmt.Errorf("magicseam: open call stream: %w", err)
	}
	defer stream.CancelRead(0)

	// Caller frame first, then the request - the shape trail's own client uses
	// (remote_quic.rs Client::call). A Go consumer usually has no pod identity
	// to declare, so Caller is zero unless set; the frame is written either way
	// because the FRAMING is not optional even when the identity is.
	if err := writeFrame(stream, encodeCaller(c.Caller)); err != nil {
		return nil, fmt.Errorf("magicseam: write caller: %w", err)
	}
	if err := writeFrame(stream, request); err != nil {
		return nil, fmt.Errorf("magicseam: write request: %w", err)
	}
	if err := stream.Close(); err != nil {
		return nil, fmt.Errorf("magicseam: finish call stream: %w", err)
	}

	tag := make([]byte, 1)
	if _, err := io.ReadFull(stream, tag); err != nil {
		return nil, fmt.Errorf("magicseam: read result tag: %w", err)
	}
	switch tag[0] {
	case tagOK:
		return readFrame(stream)
	case tagRejected:
		return nil, ErrRejected
	case tagTooLarge:
		return nil, ErrTooLarge
	default:
		return nil, fmt.Errorf("magicseam: provider unavailable (tag %d)", tag[0])
	}
}

// Close ends the underlying QUIC connection. Any in-flight Call is left to
// fail with its own read/write error - callers that need a graceful drain
// should stop issuing new Calls before calling Close, same as any other
// connection-oriented client.
func (c *QUICClient) Close() error {
	return c.conn.CloseWithError(0, "")
}

// listenUDPForHost binds a UDP socket in the address family the host half of
// hostPort names: an IPv4 literal (including the 0.0.0.0 wildcard) gets "udp4",
// an IPv6 literal or the :: wildcard gets "udp6", and anything else (a DNS name,
// or an empty host) keeps the previous "udp" behaviour since no family was
// stated and widening is then a reasonable default rather than a surprise.
func listenUDPForHost(hostPort string) (net.PacketConn, error) {
	network := "udp"
	if host, _, err := net.SplitHostPort(hostPort); err == nil && host != "" {
		if ip := net.ParseIP(host); ip != nil {
			if ip.To4() != nil {
				network = "udp4"
			} else {
				network = "udp6"
			}
		}
	}
	udpAddr, err := net.ResolveUDPAddr(network, hostPort)
	if err != nil {
		return nil, err
	}

	return net.ListenUDP(network, udpAddr)
}

// ServeQUIC listens for QUIC magic-seam consumers at addr ("tcp:<host:port>",
// the listen address - e.g. "tcp:0.0.0.0:9400") and serves handler forever,
// mirroring remote_quic.rs's serve_provider/serve_connection/
// serve_one_call: one accepted CONNECTION runs its own handshake once, then
// every subsequent STREAM on it is one call, dispatched to its own
// goroutine so independent calls run concurrently (never serialized,
// unlike Serve/MSK1 above).
func ServeQUIC(ctx context.Context, addr, certPath, keyPath, caPath, version string, handler Handler) error {
	return ServeQUICWithBarrier(ctx, addr, certPath, keyPath, caPath, version, handler, nil)
}

// ServeQUICWithBarrier is ServeQUIC with a caller-owned Barrier, making this
// provider QUIESCIBLE by a coordinated checkpoint (ADR-0032).
//
// A nil barrier keeps the pre-marker behaviour exactly: markers are still
// answered so a coordinator is never left waiting, but nothing is ever refused
// and nothing drains. Passing one is what makes this provider a first-class
// member of a barrier rather than the reason one cannot be taken - the caller
// owns it so it can also observe Armed()/InFlight() for its own logging.
func ServeQUICWithBarrier(ctx context.Context, addr, certPath, keyPath, caPath, version string, handler Handler, barrier *Barrier) error {
	hostPort, err := parseQUICAddr(addr)
	if err != nil {
		return err
	}
	tlsCfg, err := loadQUICTLSConfig(certPath, keyPath, caPath, true)
	if err != nil {
		return err
	}
	// Bind the address FAMILY that was actually asked for, rather than letting
	// Go widen it. quic.ListenAddr resolves with network "udp", and Go's net
	// package answers an UNSPECIFIED host with an AF_INET6 dual-stack socket
	// (IPV6_V6ONLY=0) - so "0.0.0.0:9500" silently becomes [::]:9500, visible
	// only in /proc/net/udp6 with nothing at all in /proc/net/udp.
	//
	// That is surprising on its own terms: an operator who writes 0.0.0.0 has
	// said IPv4. It is also the one structural difference between this provider
	// and trail's quinn-based one, which parses a SocketAddr and binds AF_INET -
	// and those two split exactly along survivor/casualty in the wedge
	// investigation (done/2026-07-31_quic-provider-wedge.md). Whether the
	// dual-stack bind is the MECHANISM there is untested at the time of writing;
	// honouring the requested family is correct regardless.
	pconn, err := listenUDPForHost(hostPort)
	if err != nil {
		return fmt.Errorf("magicseam: QUIC listen %s: %w", addr, err)
	}
	defer pconn.Close()
	listener, err := quic.Listen(pconn, tlsCfg, nil)
	if err != nil {
		return fmt.Errorf("magicseam: QUIC listen %s: %w", addr, err)
	}
	defer listener.Close()

	fmt.Fprintf(os.Stderr, "[magicseam][quic] serving handler@%s on %s\n", version, addr)

	for {
		conn, err := listener.Accept(ctx)
		if err != nil {
			return fmt.Errorf("magicseam: QUIC accept on %s: %w", addr, err)
		}
		go serveQUICConn(ctx, conn, version, handler, barrier)
	}
}

// serveQUICConn runs one connection's handshake (the FIRST stream), then
// loops AcceptStream for every subsequent call - each dispatched to its own
// goroutine so concurrent calls on this connection never queue behind each
// other.
func serveQUICConn(ctx context.Context, conn *quic.Conn, version string, handler Handler, barrier *Barrier) {
	// Observed once per connection: the transport's view of who is calling,
	// which no wire frame can influence. See Caller.PeerAddr.
	peer := ""
	if a := conn.RemoteAddr(); a != nil {
		peer = a.String()
	}
	handshake, err := conn.AcceptStream(ctx)
	if err != nil {
		return
	}
	requiredFrame, err := readFrame(handshake)
	if err != nil {
		handshake.Close()
		return
	}
	// This package always accepts, same "gating is the consumer/caller's
	// job" convention Serve (MSK1) already documents - requiredFrame is
	// read (to stay in sync with the framing) but not enforced here.
	_ = requiredFrame
	// OPTIONAL second frame: the peer's capabilities. A consumer from before
	// negotiation existed sends none, and must keep working unchanged - so a
	// read failure here means "classic only", never an error. See stream.go.
	var peerCaps []string
	if capsFrame, err := readFrame(handshake); err == nil {
		peerCaps = parseCaps(capsFrame)
	}
	streams := streamsAgreed(peerCaps)
	if _, err := handshake.Write([]byte{1}); err != nil {
		handshake.Close()
		return
	}
	if err := writeFrame(handshake, []byte(version)); err != nil {
		handshake.Close()
		return
	}
	// Our capabilities, AFTER the served version so an older consumer - which
	// reads exactly the accept byte and one frame - is unaffected: it simply
	// never reads this one.
	if err := writeFrame(handshake, []byte(capsOffered(barrier != nil))); err != nil {
		handshake.Close()
		return
	}
	handshake.Close()

	var wg sync.WaitGroup
	for {
		stream, err := conn.AcceptStream(ctx)
		if err != nil {
			break // connection closed or ctx done
		}
		wg.Go(func() {
			serveQUICCall(stream, peer, handler, streams, barrier)
		})
	}
	wg.Wait()
}

// serveQUICCall handles exactly one call stream: read the request frame,
// invoke handler, write the result tag (+ payload frame on success).
func serveQUICCall(stream *quic.Stream, peer string, handler Handler, streamsNegotiated bool, barrier *Barrier) {
	defer stream.CancelRead(0)

	// The opcode is on the wire ONLY when both ends advertised the bulk seam.
	// Against a peer that did not, nothing is read here and the bytes are
	// exactly what this SDK has always spoken.
	op := opCall
	if streamsNegotiated {
		var b [1]byte
		if _, err := io.ReadFull(stream, b[:]); err != nil {
			return
		}
		op = b[0]
	}
	// MARKERS (ADR-0032), handled before the call path: a marker carries no
	// caller frame and no payload, and it has to be able to observe a channel
	// with zero calls in it.
	//
	// NO Enter() GUARD is taken for a marker. The marker arrives AS a stream, so
	// counting it would make the drain wait for itself and always time out - the
	// same coupling tools/trail/src/marker.rs documents on its own drain.
	if op == opMarker || op == opResume {
		serveQUICMarker(stream, op, barrier)

		return
	}

	// ARMED: refuse the CALL, not the connection. The consumer's own guard stops
	// IT calling while ITS barrier is armed, but this provider was armed
	// REMOTELY - the consumer is not armed, only this side is. Without a refusal
	// here an armed provider keeps serving and the "channel is empty" ack it
	// already sent becomes a lie. And the connection must stay open regardless,
	// or the Resume that releases this barrier has no way to arrive.
	if barrier != nil && barrier.Armed() {
		_, _ = stream.Write([]byte{tagUnavailable})
		stream.Close()

		return
	}

	done := func() {}
	if barrier != nil {
		done = barrier.Enter()
	}
	defer done()

	if op == opStream {
		serveQUICStreamCall(stream, peer, handler)

		return
	}

	// Caller frame FIRST, then the request - matching
	// tools/trail/src/remote_quic.rs's Client::call, which writes both before
	// finishing the send side.
	callerFrame, err := readFrame(stream)
	if err != nil {
		return
	}
	request, err := readFrame(stream)
	if err != nil {
		return
	}
	// The asserted identity comes off the wire; the observed one is stamped
	// here, where a peer cannot reach it. decodeCaller builds its result
	// field-by-field, so no amount of frame padding can set PeerAddr.
	caller := decodeCaller(callerFrame)
	caller.PeerAddr = peer
	response, err := handler(caller, request)
	if err != nil {
		_, _ = stream.Write([]byte{tagFor(err)})
		stream.Close()
		return
	}
	if _, err := stream.Write([]byte{tagOK}); err != nil {
		return
	}
	_ = writeFrame(stream, response)
	stream.Close()
}

// serveQUICMarker answers one marker: apply it, then ack with the SAME barrier
// ID.
//
// The ack is written only after Arm returns nil, which means in-flight actually
// reached zero. That is the contract the coordinator depends on - an ack means
// "this channel is empty", not "I heard you" - so a failed drain must NOT ack.
// The stream is closed without one, which the consumer reads as a failed marker
// and aborts the barrier, rather than snapshotting a channel that still has
// calls in it.
//
// The barrier ID is ECHOED rather than assumed: a consumer that has moved on to
// a later barrier must be able to discard an ack for an earlier one.
//
// A NIL BARRIER REFUSES, and the earlier reasoning for acking was wrong. It said
// a provider with no quiesce state "has nothing to drain", so silence would turn
// that into a needless barrier timeout. But a provider with no barrier is not a
// provider with no work: it is serving handler calls right now, with nothing
// counting them and nothing to stop admitting more. "Nothing to drain" describes
// a provider that serves nothing, which is not this.
//
// So this ends where a failed drain ends - closed, unacked - because it is the
// same fact: the channel is not empty and cannot be made empty. A barrier
// timeout is the correct outcome for a graph containing a provider that cannot
// be quiesced.
//
// Unreachable from a consumer that honours capabilities, since capsOffered omits
// "barrier" when there is none. Kept as the fail-closed floor anyway: the
// advertisement is a claim, and this is the behaviour that has to be true if
// something ignores the claim.
func serveQUICMarker(stream *quic.Stream, op byte, barrier *Barrier) {
	barrierID, err := readFrame(stream)
	if err != nil {
		return
	}
	if barrier == nil {
		stream.Close()

		return
	}
	switch op {
	case opResume:
		barrier.Resume()
	default:
		if err := barrier.Arm(DefaultDrainTimeout); err != nil {
			// Deliberately no ack: see this function's doc comment. The barrier
			// is left ARMED, and the coordinator's abort path sends the Resume -
			// un-arming here would silently resume a provider the coordinator
			// still believes it is negotiating with.
			stream.Close()

			return
		}
	}
	if _, err := stream.Write([]byte{opMarkerAck}); err != nil {
		return
	}
	if err := writeFrame(stream, barrierID); err != nil {
		return
	}
	stream.Close()
}
