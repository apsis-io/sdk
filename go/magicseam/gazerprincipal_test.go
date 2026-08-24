// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"errors"
	"strings"
	"testing"
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
		PeerAddr:  "10.0.0.1:5000",
		// VerifiedPrincipal deliberately empty.
	}
	ns, name, err := GazerPrincipal(who)
	if err == nil {
		t.Fatalf("derived %q/%q from ASSERTED fields alone - any holder of a trail cert "+
			"can set those, so this is a self-report wearing an authentication check", ns, name)
	}
	if !errors.Is(err, ErrUnattested) {
		t.Fatalf("err = %v, want ErrUnattested", err)
	}
}

// "We could not establish who this is" and "this is someone, and not a device"
// are different findings. A pod peer on a fleet-shared leaf hits the first every
// time, so collapsing them would bury a real authorization refusal under the
// noise of the normal case.
func TestGazerPrincipal_UnattestedAndNotAGazerAreDistinct(t *testing.T) {
	_, _, unattested := GazerPrincipal(Caller{VerifiedPrincipal: ""})
	_, _, notGazer := GazerPrincipal(Caller{VerifiedPrincipal: "some-other-service"})

	if !errors.Is(unattested, ErrUnattested) || errors.Is(unattested, ErrNotAGazer) {
		t.Fatalf("empty principal gave %v, want ErrUnattested only", unattested)
	}
	if !errors.Is(notGazer, ErrNotAGazer) || errors.Is(notGazer, ErrUnattested) {
		t.Fatalf("non-gazer principal gave %v, want ErrNotAGazer only", notGazer)
	}
}

// The output selects an object to authorize a write against, so anything that
// parses but names a DIFFERENT object is the whole risk.
func TestGazerPrincipal_RefusesMalformedAndHostileSubjects(t *testing.T) {
	for _, tc := range []struct{ name, principal string }{
		{"extra segment folds into the name", "apsis:gazer:team-a:phone-7:extra"},
		{"missing name", "apsis:gazer:team-a"},
		{"empty namespace", "apsis:gazer::phone-7"},
		{"empty name", "apsis:gazer:team-a:"},
		{"both empty", "apsis:gazer::"},
		{"path traversal in namespace", "apsis:gazer:../kube-system:phone-7"},
		{"slash in name", "apsis:gazer:team-a:phone/7"},
		{"uppercase namespace", "apsis:gazer:Team-A:phone-7"},
		{"leading dash", "apsis:gazer:-team-a:phone-7"},
		{"trailing dot in name", "apsis:gazer:team-a:phone-7."},
		{"dot in namespace", "apsis:gazer:team.a:phone-7"},
		{"whitespace", "apsis:gazer:team a:phone-7"},
		{"wrong prefix", "apsis:node:team-a:phone-7"},
		{"prefix only", "apsis:gazer:"},
		{"kubelet masquerade", "system:node:engix99"},
		{"the fleet-shared subject", TrailQUICSNI},
		{"nul byte", "apsis:gazer:team-a:phone\x007"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ns, name, err := GazerPrincipal(Caller{VerifiedPrincipal: tc.principal})
			if err == nil {
				t.Fatalf("accepted %q as %q/%q", tc.principal, ns, name)
			}
			if !errors.Is(err, ErrNotAGazer) {
				t.Fatalf("err = %v, want ErrNotAGazer", err)
			}
			if ns != "" || name != "" {
				t.Fatalf("returned %q/%q alongside an error - a caller that checks the "+
					"error second would act on it", ns, name)
			}
		})
	}
}

// A length bound that is not tested is a length bound that is not there.
func TestGazerPrincipal_RefusesOverlongSegments(t *testing.T) {
	long := strings.Repeat("a", 64)
	if _, _, err := GazerPrincipal(Caller{VerifiedPrincipal: "apsis:gazer:" + long + ":x"}); err == nil {
		t.Fatal("accepted a 64-character namespace; DNS-1123 labels stop at 63")
	}
	ok := strings.Repeat("a", 63)
	if _, _, err := GazerPrincipal(Caller{VerifiedPrincipal: "apsis:gazer:" + ok + ":x"}); err != nil {
		t.Fatalf("refused a legal 63-character namespace: %v", err)
	}
}
