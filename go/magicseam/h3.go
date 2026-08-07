// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

// THE SEAM OVER HTTP/3 (the intended replacement for the raw-QUIC transport).
//
// # Why this is a translation and not a redesign
//
// The raw protocol turned out to be a small, hand-rolled HTTP. Nearly every
// bespoke element has an exact h3 equivalent, and writing them side by side is
// the whole argument for the change:
//
//	one call per bidi stream      -> one request per stream (h3's own model)
//	tag byte 0/1/2/3              -> status 200 / 503 / 403 / 413
//	caller frame ns\tpod\tuid\tc  -> request headers
//	caps frame on a first stream  -> headers, no bespoke handshake at all
//	OP_MARKER / OP_RESUME         -> POST /marker, /resume
//	barrier-id echo               -> response header
//	refuse-while-armed            -> 503 per request
//	u32-LE length framing         -> h3 body framing
//
// The tag byte IS a status code and the caller frame IS headers. So this keeps
// the semantics of docs/magic-seam-quic-protocol.md exactly and drops the
// hand-rolled parts - including the handshake, which is where the C SDK is
// stuck: it has no capability frame at all, and h3 gives it headers for free.
//
// # Not a dual path
//
// This is the REPLACEMENT being built, not an alternative kept alongside
// (CLAUDE.md: forward-only, no migration shims). It is unwired until every
// implementation can cut over; at that point the raw-QUIC transport is DELETED,
// not deprecated. The ALPN changes with it - a peer that has not cut over then
// fails at the handshake, loudly, instead of negotiating and misparsing frames.

// # What the 2.3x IS, measured - and it is not the headers
//
// I predicted header overhead and was wrong; the profile said so and an
// experiment confirmed it. Same CA, loopback, payload, loop:
//
//	raw QUIC                          107,598 ns/op
//	h3, first cut                     248,587
//	  + req.ContentLength set         231,268   (-7%, kept)
//	  + stripped to 2 short headers   224,868   (-3% more, NOT kept)
//
// A CPU profile shows no header hotspot: httpguts.ValidHeaderFieldName and
// huffmanDecode are ~3% each, syscalls dominate, and the benchmark is
// latency-bound rather than CPU-bound. Going from six self-describing headers to
// two one-letter ones bought 3% - so the cost is structural in the h3 stack
// (framing layers, per-request synchronisation), not in this mapping, and it is
// not tunable from here.
//
// The six names are therefore KEPT. Three percent does not pay for making the
// wire unreadable, and self-describing headers are most of what makes this
// transport cheaper for the C SDK than the handshake it cannot currently build.
//
// # And the comparison itself was framed wrongly - it is not "h3 vs QUIC"
//
// Both transports run on the SAME quic-go. Measured against a bare QUIC stream
// carrying no protocol at all, which is the floor neither can beat:
//
//	bare QUIC stream, no protocol      99,038 ns/op     (the floor)
//	this SDK's custom protocol        103,671           +4.6us   (+4.7%)
//	HTTP/3                            229,188          +130us   (+131%)
//
// QUIC itself dominates. The bespoke protocol is a ~5% veneer on it; h3 costs 28x
// more than that veneer does. So the trade is not "fast transport vs slow
// transport" - it is a 5% protocol tax against a 131% one, bought with
// generality.
//
// # Where the h3 cost lives, since "optimise it" is the obvious next thought
//
// A payload sweep separates a fixed extra round trip from per-byte work, and it
// is BOTH - so neither single explanation was right:
//
//	           raw QUIC     h3          delta     ratio
//	  64 B     111,828     252,310     +140us     2.26x
//	  64 KiB   693,557   1,153,723     +460us     1.66x
//
// A constant delta would mean an extra round trip; a constant ratio would mean
// per-byte processing. The delta grows 3x while the ratio falls, so there is a
// fixed ~140us AND roughly 7ns/byte on top.
//
// What is tunable FROM HERE is the 7% above and nothing else: a CPU profile
// shows the benchmark latency-bound with no header hotspot, so the fixed cost is
// structural in the h3 stack and the per-byte cost is copies inside its body
// path. Both live in quic-go's http3, not in this file.
//
// Note the ratio is WORST at small payloads - which is exactly the seam's stated
// target (wit/magic/magic.wit: "the seam's stated target is small east-west
// traffic"). The transport is least suited where it is most used.
//
// # 0-RTT: it does not buy what you would reach for it for
//
// Measured cost is 2.3x per SMALL CALL on an established connection
// (BenchmarkH3Call vs BenchmarkQUICCall), and 0-RTT does not touch that. Early
// data saves a round trip on connection SETUP; the benchmark reuses one
// connection across every iteration, so the handshake is already amortised to
// nothing and the delta is per-request framing and QPACK.
//
// Where it WOULD help is reconnection - provider restart, migration, a healing
// client redialling - which this seam does more often than it looks.
//
// EXCEPT THAT EARLY DATA IS REPLAYABLE, and this seam's calls are not
// idempotent: /call carries whatever the application put in the body, and for
// w8s that includes `launch`, where a replay creates a pod. A replayed `resume`
// would release a barrier taken later, which is worse.
//
// quic-go enforces the safe thing for us: its h3 client permits early data only
// on GET/HEAD (MethodGet0RTT, MethodHead0RTT), and every seam op here is POST.
// So 0-RTT is off, correctly, and by construction rather than by our vigilance -
// which is itself an argument for the transport: rolling 0-RTT on raw QUIC would
// have put that replay analysis on us, with no vocabulary to express the answer.
//
// # The API change that would unlock it, scoped - and the answer is DON'T
//
// Only the GUEST knows a call is idempotent. The transport sees `handle:
// async func(request: list<u8>) -> result<list<u8>, error>` (wit/magic/magic.wit)
// - an opaque byte pipe, with the ops (launch/stop/logs/status) inside the body.
// So the declaration has to come from the WIT contract down, and that is the
// whole cost:
//
//  1. WIT. It cannot be a parameter added to `handle`: magic.wit's own note on
//     `handle-stream` settles the precedent - "a world's export is satisfied
//     only by exporting the WHOLE interface", so extending `handler` breaks every
//     provider exporting it, which today is the Go, C, TS and Rust echo
//     providers plus the live w8s-node-provider. It would be a SEPARATE
//     interface, opt-in, like the bulk seam.
//  2. Four SDKs (Go, TS, C, Zig) grow a second call shape.
//  3. trail: plug.rs routes the idempotent shape differently and quicheal.rs
//     must preserve the distinction across a heal - a retry that silently
//     downgrades is the replay hazard arriving by the back door.
//
// AND THEN IT STILL DOES NOT FIT. quic-go permits early data on GET/HEAD only,
// and a GET cannot carry a `list<u8>` body - the payload would have to move into
// the URL or headers, capping its size and forcing this layer to understand the
// application's ops. That trades the byte-pipe abstraction, which is the seam's
// central property, for one round trip.
//
// What it would buy: a single RTT on RECONNECT, for idempotent calls only, on a
// path that already got 16% cheaper from session resumption (BenchmarkH3Dial*)
// at no API cost at all. `status` is the only realistic candidate and it is not
// worth a WIT change propagating through four SDKs and the healing client.
//
// Recorded as a considered NO rather than left as an open idea, so the next
// person reaches for resumption first and does not re-derive this.

// H3ALPN is the ALPN for the seam over HTTP/3.
//
// Deliberately h3's own token rather than a bespoke one: the point of the change
// is that this IS HTTP/3, so ordinary tooling (curl --http3, proxies, meshes)
// can speak to it. It also means a peer still offering "trail-quic" fails ALPN
// negotiation outright - the clean, fail-closed way to notice a missed cutover.
const H3ALPN = "h3"

// Seam paths. Versioned in the path so a future wire change is a new path
// rather than a silent reinterpretation of this one.
const (
	H3PathCall   = "/seam/v1/call"
	H3PathMarker = "/seam/v1/marker"
	H3PathResume = "/seam/v1/resume"
)

// Seam headers.
//
// Caller identity is FOUR headers rather than one tab-joined blob. The raw wire
// packs them into a single frame that decodeCaller splits field-by-field
// precisely so no amount of padding can inject a field; separate headers make
// that structural instead of careful.
const (
	H3HeaderVersion       = "Seam-Version"        // what the consumer requires
	H3HeaderServedVersion = "Seam-Served-Version" // what the provider serves
	H3HeaderCaps          = "Seam-Caps"           // both directions
	H3HeaderBarrier       = "Seam-Barrier"        // marker id, echoed back
	H3HeaderCallerNS      = "Seam-Caller-Namespace"
	H3HeaderCallerPod     = "Seam-Caller-Pod"
	H3HeaderCallerUID     = "Seam-Caller-Uid"
	H3HeaderCallerComp    = "Seam-Caller-Component"
)

// h3Status maps a handler error to the status that carries it.
//
// The same four outcomes the tag byte carried, in the vocabulary HTTP already
// has. 403/413/503 are not approximations - they are what those tags meant.
func h3Status(err error) int {
	switch {
	case err == nil:
		return http.StatusOK
	case errors.Is(err, ErrRejected):
		return http.StatusForbidden
	case errors.Is(err, ErrTooLarge):
		return http.StatusRequestEntityTooLarge
	default:
		return http.StatusServiceUnavailable
	}
}

// errForH3Status is the inverse, for the client.
func errForH3Status(code int) error {
	switch code {
	case http.StatusOK:
		return nil
	case http.StatusForbidden:
		return ErrRejected
	case http.StatusRequestEntityTooLarge:
		return ErrTooLarge
	case http.StatusUpgradeRequired:
		return ErrVersionRejected
	default:
		return fmt.Errorf("magicseam: provider unavailable (status %d)", code)
	}
}

// ServeH3 serves the seam over HTTP/3 on addr ("tcp:host:port").
//
// barrier may be nil, exactly as for the raw transport, and the same rule holds:
// a nil barrier does NOT advertise the capability and REFUSES markers rather
// than acking them. "No barrier" is not "nothing to drain".
func ServeH3(
	ctx context.Context,
	addr, certPath, keyPath, caPath, version string,
	handler Handler,
	barrier *Barrier,
) error {
	hostPort, err := parseQUICAddr(addr)
	if err != nil {
		return err
	}
	tlsCfg, err := loadQUICTLSConfig(certPath, keyPath, caPath, true)
	if err != nil {
		return err
	}
	tlsCfg.NextProtos = []string{H3ALPN}

	srv := &http3.Server{
		Addr:      hostPort,
		TLSConfig: tlsCfg,
		Handler:   H3Handler(version, handler, barrier),
	}
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	fmt.Fprintf(os.Stderr, "[magicseam][h3] serving handler@%s on %s\n", version, addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}

	return nil
}

// H3Handler is the seam's HTTP surface, separated from the server so it can be
// driven by an ordinary httptest-style request in tests - the mapping is the
// thing worth testing, and it should not require a QUIC socket to reach.
func H3Handler(version string, handler Handler, barrier *Barrier) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(H3PathCall, func(w http.ResponseWriter, r *http.Request) {
		h3ServeCall(w, r, version, handler, barrier)
	})
	mux.HandleFunc(H3PathMarker, func(w http.ResponseWriter, r *http.Request) {
		h3ServeMarker(w, r, version, barrier, false)
	})
	mux.HandleFunc(H3PathResume, func(w http.ResponseWriter, r *http.Request) {
		h3ServeMarker(w, r, version, barrier, true)
	})

	return mux
}

// h3Advertise stamps the provider's identity onto every response.
//
// No handshake: the version and capabilities ride each answer, so a consumer
// learns them from the first call rather than from a bespoke first stream. That
// is the part the C SDK cannot do today - it has no capability frame at all -
// and here it costs nothing.
func h3Advertise(w http.ResponseWriter, version string, barrier *Barrier) {
	w.Header().Set(H3HeaderServedVersion, version)
	w.Header().Set(H3HeaderCaps, capsOffered(barrier != nil))
}

func h3ServeCall(w http.ResponseWriter, r *http.Request, version string, handler Handler, barrier *Barrier) {
	h3Advertise(w, version, barrier)
	// REFUSED WHILE ARMED, and the connection stays usable: a resume has to be
	// able to arrive, and 503 refuses the CALL rather than the transport.
	if barrier != nil && barrier.Armed() {
		w.WriteHeader(http.StatusServiceUnavailable)

		return
	}
	done := func() {}
	if barrier != nil {
		done = barrier.Enter()
	}
	defer done()

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFrame))
	if err != nil {
		w.WriteHeader(http.StatusRequestEntityTooLarge)

		return
	}
	resp, err := handler(h3Caller(r), body)
	if err != nil {
		w.WriteHeader(h3Status(err))

		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(resp)
}

// h3Caller builds the caller identity from headers, and takes PeerAddr from the
// CONNECTION.
//
// The peer address is never read from a header. On the raw wire that is enforced
// by decoding a fixed number of fields; here it is enforced by not looking - a
// client may send whatever it likes and cannot reach this field.
func h3Caller(r *http.Request) Caller {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = h
	}

	return Caller{
		Namespace: r.Header.Get(H3HeaderCallerNS),
		PodName:   r.Header.Get(H3HeaderCallerPod),
		PodUID:    r.Header.Get(H3HeaderCallerUID),
		Component: r.Header.Get(H3HeaderCallerComp),
		PeerAddr:  host,
	}
}

// h3ServeMarker answers a marker or a resume.
//
// The contract is unchanged from §8 and the reasons are the same: the ack means
// "my channel is EMPTY", so it is sent only once in-flight reaches zero; a
// failed drain must NOT ack and leaves the barrier ARMED; the barrier id is
// ECHOED so a consumer can discard an ack for a barrier it has moved on from.
func h3ServeMarker(w http.ResponseWriter, r *http.Request, version string, barrier *Barrier, resume bool) {
	h3Advertise(w, version, barrier)
	id := r.Header.Get(H3HeaderBarrier)
	// A provider with NO barrier REFUSES rather than acking - "no barrier" is not
	// "nothing to drain", it is serving calls with nothing counting them.
	// Unreachable from a peer that honours capsOffered; the fail-closed floor.
	if barrier == nil {
		w.WriteHeader(http.StatusServiceUnavailable)

		return
	}
	w.Header().Set(H3HeaderBarrier, id)
	if resume {
		barrier.Resume()
		fmt.Fprintf(os.Stderr, "[magicseam][h3][barrier] resumed (barrier %q)\n", id)
		w.WriteHeader(http.StatusOK)

		return
	}
	if err := barrier.Arm(DefaultDrainTimeout); err != nil {
		// NO ACK. 503 is the refusal; the barrier stays armed and the
		// coordinator's abort path sends the resume.
		fmt.Fprintf(os.Stderr, "[magicseam][h3][barrier] REFUSED barrier %q: %v\n", id, err)
		w.WriteHeader(http.StatusServiceUnavailable)

		return
	}
	fmt.Fprintf(os.Stderr, "[magicseam][h3][barrier] armed for barrier %q\n", id)
	w.WriteHeader(http.StatusOK)
}

// H3Client is a consumer's handle on an h3 provider.
type H3Client struct {
	tr      *http3.Transport
	base    string
	caller  Caller
	version string
	// served and caps are learned from the first answer rather than a handshake.
	served string
	caps   []string
}

// sharedSessionCache lets a redial RESUME rather than handshake from cold.
//
// This is the reconnection win that 0-RTT cannot give us: early data is GET/HEAD
// only and every seam op is POST, but a resumed handshake still skips the
// certificate exchange. It matters because this seam redials more than it looks -
// provider restart, pod migration, a healing client after a transport error.
//
// Process-wide and bounded: tickets are per server name, the seam talks to a
// handful of providers, and an unbounded cache would be a slow leak keyed by
// something a peer influences.
var sharedSessionCache = tls.NewLRUClientSessionCache(64)

// DialH3 opens an h3 connection to a provider.
func DialH3(ctx context.Context, addr, certPath, keyPath, caPath, requiredVersion string, caller Caller) (*H3Client, error) {
	hostPort, err := parseQUICAddr(addr)
	if err != nil {
		return nil, err
	}
	tlsCfg, err := loadQUICTLSConfig(certPath, keyPath, caPath, false)
	if err != nil {
		return nil, err
	}
	tlsCfg.NextProtos = []string{H3ALPN}
	tlsCfg.ServerName = TrailQUICSNI
	tlsCfg.ClientSessionCache = sharedSessionCache

	tr := &http3.Transport{TLSClientConfig: tlsCfg, QUICConfig: &quic.Config{}}

	return &H3Client{
		tr:      tr,
		base:    "https://" + hostPort,
		caller:  caller,
		version: requiredVersion,
	}, nil
}

// ServedVersion and Caps report what the provider advertised on its last answer.
// Empty until the first call - there is no handshake to learn them from, by
// design.
func (c *H3Client) ServedVersion() string { return c.served }
func (c *H3Client) Caps() []string        { return append([]string(nil), c.caps...) }

// Call performs one seam call.
func (c *H3Client) Call(ctx context.Context, request []byte) ([]byte, error) {
	resp, body, err := c.do(ctx, H3PathCall, request, "")
	if err != nil {
		return nil, err
	}
	if statusErr := errForH3Status(resp.StatusCode); statusErr != nil {
		return nil, statusErr
	}

	return body, nil
}

// Marker arms the provider and waits for its ack; Resume releases it.
func (c *H3Client) Marker(ctx context.Context, barrierID string) error {
	return c.marker(ctx, H3PathMarker, barrierID)
}

func (c *H3Client) Resume(ctx context.Context, barrierID string) error {
	return c.marker(ctx, H3PathResume, barrierID)
}

func (c *H3Client) marker(ctx context.Context, path, barrierID string) error {
	resp, _, err := c.do(ctx, path, nil, barrierID)
	if err != nil {
		return err
	}
	if statusErr := errForH3Status(resp.StatusCode); statusErr != nil {
		return statusErr
	}
	// THE ECHO IS CHECKED, not assumed. An ack for a barrier we are not taking
	// would otherwise record a channel as empty on the strength of an unrelated
	// reply.
	if got := resp.Header.Get(H3HeaderBarrier); got != barrierID {
		return fmt.Errorf("magicseam: barrier id echo %q does not match %q", got, barrierID)
	}

	return nil
}

func (c *H3Client) do(ctx context.Context, path string, body []byte, barrierID string) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, h3Body(body))
	if err != nil {
		return nil, nil, err
	}
	// A KNOWN LENGTH IS WORTH 7%, MEASURED. Without it the body is sent with an
	// unknown length and the stack cannot pack HEADERS+DATA+FIN as tightly.
	// 248,587 -> 231,268 ns/op, which is the only tuning of the three tried that
	// paid for itself.
	req.ContentLength = int64(len(body))
	req.Header.Set(H3HeaderVersion, c.version)
	req.Header.Set(H3HeaderCaps, capsOffered(true))
	req.Header.Set(H3HeaderCallerNS, c.caller.Namespace)
	req.Header.Set(H3HeaderCallerPod, c.caller.PodName)
	req.Header.Set(H3HeaderCallerUID, c.caller.PodUID)
	req.Header.Set(H3HeaderCallerComp, c.caller.Component)
	if barrierID != "" {
		req.Header.Set(H3HeaderBarrier, barrierID)
	}
	resp, err := c.tr.RoundTrip(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	c.served = resp.Header.Get(H3HeaderServedVersion)
	if caps := resp.Header.Get(H3HeaderCaps); caps != "" {
		c.caps = strings.Split(caps, ",")
	}
	out, err := io.ReadAll(io.LimitReader(resp.Body, maxFrame))
	if err != nil {
		return nil, nil, err
	}

	return resp, out, nil
}

// Close releases the underlying connection.
func (c *H3Client) Close() error { return c.tr.Close() }

// h3Body avoids sending a zero-length body as a non-nil reader: a marker carries
// no payload, and an empty body is the honest encoding of that.
func h3Body(b []byte) io.Reader {
	if len(b) == 0 {
		return nil
	}

	return bytes.NewReader(b)
}

// dialH3WithCache is DialH3 with the session cache made explicit, so a benchmark
// can measure a COLD handshake against a RESUMED one. Production always wants
// the cache; without a way to turn it off there is no baseline to compare
// against, and "resumption helps" would be an assertion rather than a number.
func dialH3WithCache(
	ctx context.Context,
	addr, certPath, keyPath, caPath, requiredVersion string,
	caller Caller,
	useCache bool,
) (*H3Client, error) {
	c, err := DialH3(ctx, addr, certPath, keyPath, caPath, requiredVersion, caller)
	if err != nil {
		return nil, err
	}
	if !useCache {
		// A FRESH cache per dial is a cold handshake: nothing to resume from.
		c.tr.TLSClientConfig.ClientSessionCache = tls.NewLRUClientSessionCache(1)
	}

	return c, nil
}
