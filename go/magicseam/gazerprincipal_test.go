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
