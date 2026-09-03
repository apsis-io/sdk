// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"errors"
	"testing"

	"github.com/apsis-io/sdk/go/gazer"
)

func TestGazerPrincipal_AcceptsAWellFormedSubject(t *testing.T) {
	ns, name, err := GazerPrincipal(Caller{VerifiedPrincipal: "apsis:gazer:team-a:phone-7"})
	if err != nil {
		t.Fatalf("GazerPrincipal: %v", err)
	}
	if ns != "team-a" || name != "phone-7" {
		t.Fatalf("got %q/%q, want team-a/phone-7", ns, name)
	}
}

// THE ONE THAT MATTERS: the asserted fields must never be a fallback.
//
// Caller.Namespace is right there, spelled the same, and it is what trail fills
// in from the pod it is running - which any holder of a trail cert can set to
// anything. A "helpful" fallback when the verified field is empty converts this
// from an authentication check into a self-report, and it would look like a
// robustness improvement in review.
func TestGazerPrincipal_NeverFallsBackToTheAssertedFields(t *testing.T) {
	who := Caller{
		Namespace: "team-a",
		PodName:   "phone-7",
		PodUID:    "uid-1",
		PeerAddr:  "192.0.2.1:5000",
		// VerifiedPrincipal deliberately empty.
	}
	ns, name, err := GazerPrincipal(who)
	if err == nil {
		t.Fatalf("derived %q/%q from ASSERTED fields alone - any holder of a trail cert "+
			"can set those, so this is a self-report wearing an authentication check", ns, name)
	}
	if !errors.Is(err, gazer.ErrUnattested) {
		t.Fatalf("err = %v, want gazer.ErrUnattested", err)
	}
}

// "We could not establish who this is" and "this is someone, and not a device"
// are different findings. A pod peer on a fleet-shared leaf hits the first every
// time, so collapsing them would bury a real authorization refusal under the
// noise of the normal case.
func TestGazerPrincipal_UnattestedAndNotAGazerAreDistinct(t *testing.T) {
	_, _, unattested := GazerPrincipal(Caller{VerifiedPrincipal: ""})
	_, _, notGazer := GazerPrincipal(Caller{VerifiedPrincipal: "some-other-service"})

	if !errors.Is(unattested, gazer.ErrUnattested) || errors.Is(unattested, gazer.ErrNotAGazer) {
		t.Fatalf("empty principal gave %v, want gazer.ErrUnattested only", unattested)
	}
	if !errors.Is(notGazer, gazer.ErrNotAGazer) || errors.Is(notGazer, gazer.ErrUnattested) {
		t.Fatalf("non-gazer principal gave %v, want gazer.ErrNotAGazer only", notGazer)
	}
}

// The output selects an object to authorize a write against, so anything that
// parses but names a DIFFERENT object is the whole risk.
//
// ***THIS COMMENT SPENT A DAY WITH NO TEST UNDER IT.*** The hostile-subject
// table it introduces moved to go/gazer when the Gazer vocabulary was split out
// for the licence boundary, and the comment stayed here at the end of the file,
// documenting an assertion that had gone. A trailing comment with nothing after
// it reads, to anyone skimming, exactly like a described test.
//
// ***AND THE TABLE'S NEW HOME DOES NOT COVER THIS BOUNDARY.*** go/gazer calls
// ParseGazerPrincipal directly. Every caller in this repo goes through
// GazerPrincipal(Caller), which is a DIFFERENT function: it decides what counts
// as attested and then delegates. A version of it that trimmed, lowercased or
// otherwise tidied VerifiedPrincipal before handing it over would leave
// go/gazer's table entirely green, because the parser it tests would never see
// the hostile string - it would see the cleaned one.
//
// So this asserts the composition, not the parser: the subject reaches the
// parser unmodified, and the refusal arrives with NO namespace or name beside
// it. The cases are the ones where a tidy-up would change the verdict rather
// than the whole table, which go/gazer owns.
func TestGazerPrincipal_RefusesAHostileSubjectAtThisBoundary(t *testing.T) {
	for _, tc := range []struct{ name, subject string }{
		{"path traversal in namespace", "apsis:gazer:../kube-system:phone-7"},
		{"uppercase namespace", "apsis:gazer:Team-A:phone-7"},
		{"whitespace", "apsis:gazer:team a:phone-7"},
		{"trailing dot in name", "apsis:gazer:team-a:phone-7."},
		{"nul byte", "apsis:gazer:team-a:phone\x007"},
		{"kubelet masquerade", "system:node:node-1"},
		// The fleet-shared trail subject. Spelled out rather than referenced -
		// see go/gazer's table for why this package's constant is not used there
		// and why the direction matters.
		{"the fleet-shared subject", "trail-quic-peer"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ns, name, err := GazerPrincipal(Caller{VerifiedPrincipal: tc.subject})
			if err == nil {
				t.Fatalf("accepted %q as %q/%q", tc.subject, ns, name)
			}
			// ErrNotAGazer, never ErrUnattested: the caller IS attested here.
			// Collapsing the two would let a hostile subject be reported as the
			// ordinary pod-peer case, which is the one nobody investigates.
			if !errors.Is(err, gazer.ErrNotAGazer) {
				t.Fatalf("err = %v, want gazer.ErrNotAGazer", err)
			}
			if ns != "" || name != "" {
				t.Fatalf("returned %q/%q alongside an error - a caller that checks the "+
					"error second would authorize a write against that object", ns, name)
			}
		})
	}
}
