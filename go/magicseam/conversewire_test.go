// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// A RUNNABLE CALLER FOR A CALLEE THAT IS NOT WRITTEN IN GO.
//
// trail-main asked whether they could build the Rust pod half against the Go
// side "so the first integration is a test rather than a cluster". Yes - but
// against the CALLER, not the test server: radiant OPENS the stream and the pod
// ANSWERS, so a Rust callee is exercised by `Converse`, which is the production
// code path. Testing it against the Go callee would have both halves playing the
// same role and prove nothing about the pairing.
//
// SKIPPED UNLESS POINTED AT SOMETHING, so it costs the suite nothing and is one
// env var away from being an integration test:
//
//	CONVERSE_ADDR=tcp:127.0.0.1:9500 \
//	CONVERSE_CERT=/path/cert.pem CONVERSE_KEY=/path/key.pem CONVERSE_CA=/path/ca.pem \
//	go test ./sdk/go/magicseam/ -run WireAgainstALiveCallee -v
//
// WHAT IT PROVES AND WHAT IT DOES NOT: it proves the two implementations agree
// on the FRAMING - opcode, caller frame, request frame, tagged callee frames,
// plain answer frames. It says nothing about what the callee does with the
// request, which is the pod half's own business.
func TestConverse_WireAgainstALiveCallee(t *testing.T) {
	addr := os.Getenv("CONVERSE_ADDR")
	if addr == "" {
		t.Skip("set CONVERSE_ADDR (and CONVERSE_CERT/KEY/CA) to run against a live callee")
	}
	cert, key, ca := os.Getenv("CONVERSE_CERT"), os.Getenv("CONVERSE_KEY"), os.Getenv("CONVERSE_CA")

	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()

	client, err := DialQUICForConverse(ctx, addr, cert, key, ca, "")
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer client.Close()

	// THE NEGOTIATION IS THE FIRST THING THAT CAN DISAGREE, and it fails in the
	// readable direction: an unadvertised capability is a refusal, where a
	// framing mismatch is a HANG.
	if !ConverseServed(client.PeerCaps) {
		t.Fatalf("the callee does not advertise %q - it advertised %v. Nothing else in this "+
			"test can run, and this is the failure you WANT: the alternative is writing an "+
			"opcode a peer reads as a caller frame, which hangs both ends silently",
			CapConverse, client.PeerCaps)
	}

	var asked []string
	reply, err := client.Converse(ctx, []byte(`{"op":"step"}`), func(_ context.Context, ask []byte) ([]byte, error) {
		asked = append(asked, string(ask))
		// Answer everything with a well-formed unknown observation: this test is
		// about FRAMING, so the answer's content only has to be something the
		// callee can parse.
		return []byte(`{"kind":"unknown"}`), nil
	})
	if err != nil {
		t.Fatalf("converse against %s failed after %d callback(s) %v: %v", addr, len(asked), asked, err)
	}

	t.Logf("callee asked %d question(s): %v", len(asked), asked)
	t.Logf("final reply: %s", reply)

	// A REPLY THAT ARRIVED AT ALL IS THE FRAMING PROOF. An empty one is not a
	// failure here - a callee may legitimately finish with nothing to say - but
	// it IS worth naming, because an empty reply is exactly what a swallowed
	// error looks like one layer up, where the Driver reads it as "the step
	// finished" and retires the program.
	if len(reply) == 0 {
		t.Logf("NOTE: the callee replied with an EMPTY final frame. Framing is proven, but " +
			"check that this is deliberate: at the Driver an empty outcome means FINISHED, " +
			"which is terminal.")
	}
	if strings.Contains(string(reply), "err") {
		t.Logf("NOTE: the reply mentions an error - that is the callee ANSWERING, not the " +
			"transport failing, and the two are deliberately distinguishable")
	}
}
