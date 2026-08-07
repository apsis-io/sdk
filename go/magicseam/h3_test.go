// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The mapping is driven through an ordinary HTTP request rather than a QUIC
// socket: what is worth testing is the TRANSLATION - status codes, headers,
// refusal - and requiring a real h3 connection to reach it would put the
// interesting part behind the least interesting part.

func h3Do(h http.Handler, method, path string, body string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	return rec
}

// THE TAG BYTE IS A STATUS CODE. This is the core of the claim that the raw
// protocol was a hand-rolled HTTP: each of the four outcomes has an exact
// equivalent, not an approximation.
func TestH3StatusCarriesTheSameFourOutcomes(t *testing.T) {
	cases := []struct {
		err  error
		want int
	}{
		{nil, http.StatusOK},
		{ErrRejected, http.StatusForbidden},
		{ErrTooLarge, http.StatusRequestEntityTooLarge},
		{errors.New("anything else"), http.StatusServiceUnavailable},
	}
	for _, c := range cases {
		if got := h3Status(c.err); got != c.want {
			t.Errorf("h3Status(%v) = %d, want %d", c.err, got, c.want)
		}
		// ...and the client must read it back as the same error, or a refusal
		// arrives at the caller as a generic failure.
		if c.err == nil {
			continue
		}
		back := errForH3Status(c.want)
		if c.want != http.StatusServiceUnavailable && !errors.Is(back, c.err) {
			t.Errorf("errForH3Status(%d) = %v, want %v", c.want, back, c.err)
		}
	}
}

// A CLIENT CANNOT SET ITS OWN PEER ADDRESS. On the raw wire that is enforced by
// decoding a fixed number of fields so padding cannot inject one; here it is
// enforced by never reading a header for it. The property must survive the
// translation, because it is what makes caller identity worth anything.
func TestH3PeerAddressComesFromTheConnection(t *testing.T) {
	var seen Caller
	h := H3Handler("0.1.0", func(c Caller, _ []byte) ([]byte, error) {
		seen = c

		return nil, nil
	}, nil)

	h3Do(h, http.MethodPost, H3PathCall, "x", map[string]string{
		H3HeaderCallerNS:  "ns",
		H3HeaderCallerPod: "pod",
		// A hostile peer trying to dictate where it came from.
		"Seam-Caller-Peer": "10.9.9.9",
		"X-Forwarded-For":  "10.9.9.9",
	})

	if seen.PeerAddr == "10.9.9.9" {
		t.Error("a client set its own PeerAddr - caller identity is then whatever the caller " +
			"claims, and every ownership check downstream is decorative")
	}
	if seen.Namespace != "ns" || seen.PodName != "pod" {
		t.Errorf("caller identity did not survive the headers: %+v", seen)
	}
}

// Every answer advertises version and capabilities, so there is NO handshake to
// get wrong - which is the part the C SDK cannot do today.
func TestH3AdvertisesOnEveryAnswerInsteadOfAHandshake(t *testing.T) {
	h := H3Handler("0.1.0", func(Caller, []byte) ([]byte, error) { return nil, nil }, nil)

	rec := h3Do(h, http.MethodPost, H3PathCall, "x", nil)

	if got := rec.Header().Get(H3HeaderServedVersion); got != "0.1.0" {
		t.Errorf("served version header = %q, want 0.1.0", got)
	}
	if got := rec.Header().Get(H3HeaderCaps); got == "" {
		t.Error("no capabilities advertised - a consumer would have to guess, which is the " +
			"bespoke handshake this transport exists to delete")
	}
}

// The advertising rule survives the move: no barrier, no "barrier" capability.
func TestH3DoesNotClaimABarrierItDoesNotHave(t *testing.T) {
	h := H3Handler("0.1.0", func(Caller, []byte) ([]byte, error) { return nil, nil }, nil)
	rec := h3Do(h, http.MethodPost, H3PathCall, "x", nil)
	if strings.Contains(rec.Header().Get(H3HeaderCaps), CapBarrier) {
		t.Error("advertised barrier with no barrier to honour it - the false-quiesce bug, " +
			"carried into the new transport")
	}

	var b Barrier
	h2 := H3Handler("0.1.0", func(Caller, []byte) ([]byte, error) { return nil, nil }, &b)
	rec2 := h3Do(h2, http.MethodPost, H3PathCall, "x", nil)
	if !strings.Contains(rec2.Header().Get(H3HeaderCaps), CapBarrier) {
		t.Error("a configured barrier was not advertised")
	}
}

// ARMED -> 503 on calls, and the marker path still answers. Refuse the CALL, not
// the transport: a resume has to be able to arrive.
func TestH3RefusesCallsWhileArmedButStaysReachable(t *testing.T) {
	var b Barrier
	h := H3Handler("0.1.0", func(Caller, []byte) ([]byte, error) { return []byte("served"), nil }, &b)

	rec := h3Do(h, http.MethodPost, H3PathMarker, "", map[string]string{H3HeaderBarrier: "b1"})
	if rec.Code != http.StatusOK {
		t.Fatalf("marker = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get(H3HeaderBarrier); got != "b1" {
		t.Errorf("barrier echo = %q, want b1 - a consumer must be able to discard an ack for a "+
			"barrier it has moved on from", got)
	}
	if !b.Armed() {
		t.Fatal("acked without arming")
	}

	if got := h3Do(h, http.MethodPost, H3PathCall, "x", nil).Code; got != http.StatusServiceUnavailable {
		t.Errorf("armed provider answered a call with %d - the ack it already sent is a lie", got)
	}

	rec = h3Do(h, http.MethodPost, H3PathResume, "", map[string]string{H3HeaderBarrier: "b1"})
	if rec.Code != http.StatusOK || b.Armed() {
		t.Errorf("resume = %d armed=%v, want 200 and released", rec.Code, b.Armed())
	}
	if got := h3Do(h, http.MethodPost, H3PathCall, "x", nil).Code; got != http.StatusOK {
		t.Errorf("resumed provider still refuses calls (%d)", got)
	}
}

// A FAILED DRAIN MUST NOT ACK, and must leave the barrier ARMED.
func TestH3AFailedDrainRefusesAndStaysArmed(t *testing.T) {
	b := Barrier{}
	defer b.Enter()() // pinned in flight for the whole test
	h := H3Handler("0.1.0", func(Caller, []byte) ([]byte, error) { return nil, nil }, &b)

	start := time.Now()
	rec := h3Do(h, http.MethodPost, H3PathMarker, "", map[string]string{H3HeaderBarrier: "b1"})
	if rec.Code == http.StatusOK {
		t.Error("acked a marker while a call was in flight - the coordinator snapshots a channel " +
			"that still has work in it")
	}
	if !b.Armed() {
		t.Error("a failed drain un-armed the barrier - it resumes while the coordinator still " +
			"believes it is negotiating")
	}
	if elapsed := time.Since(start); elapsed < DefaultDrainTimeout {
		t.Logf("drain refused after %s (bounded by DefaultDrainTimeout=%s)", elapsed, DefaultDrainTimeout)
	}
}

// A provider with NO barrier refuses markers rather than acking them.
func TestH3ABarrierlessProviderRefusesMarkers(t *testing.T) {
	h := H3Handler("0.1.0", func(Caller, []byte) ([]byte, error) { return nil, nil }, nil)

	if got := h3Do(h, http.MethodPost, H3PathMarker, "", map[string]string{H3HeaderBarrier: "b1"}).Code; got == http.StatusOK {
		t.Error("a barrierless provider acked a marker - the ack means 'my channel is empty', " +
			"and this one never stopped serving")
	}
}
