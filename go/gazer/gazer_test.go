// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package gazer

import (
	"errors"
	"strings"
	"testing"
)

// The output selects an object to authorize a write against, so anything that
// parses but names a DIFFERENT object is the whole risk.
func TestParseGazerPrincipal_RefusesMalformedAndHostileSubjects(t *testing.T) {
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
		{"kubelet masquerade", "system:node:node-1"},
		// SPELLED OUT, NOT magicseam.TrailQUICSNI. Referencing the constant would
		// make this Apache package import the BUSL one - the exact direction the
		// split exists to forbid - to assert something about a STRING. If the SNI
		// ever changes this case stops being the fleet-shared subject and becomes
		// just another non-Gazer principal, which it must be refused as either way.
		{"the fleet-shared subject", "trail-quic-peer"},
		{"nul byte", "apsis:gazer:team-a:phone\x007"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ns, name, err := ParseGazerPrincipal(tc.principal)
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

// A length bound that is not tested is a length bound that is not there.
func TestParseGazerPrincipal_RefusesOverlongSegments(t *testing.T) {
	long := strings.Repeat("a", 64)
	if _, _, err := ParseGazerPrincipal("apsis:gazer:" + long + ":x"); err == nil {
		t.Fatal("accepted a 64-character namespace; DNS-1123 labels stop at 63")
	}
	ok := strings.Repeat("a", 63)
	if _, _, err := ParseGazerPrincipal("apsis:gazer:" + ok + ":x"); err != nil {
		t.Fatalf("refused a legal 63-character namespace: %v", err)
	}
}

// THE CONSTRUCTOR AND THE PARSER MUST AGREE FOREVER, and the round trip is the
// only way to know it. Checking the parts separately would wave through a
// namespace containing a colon, which silently renames the object a signer is
// about to authorize.

// THE CONSTRUCTOR AND THE PARSER MUST AGREE FOREVER, and the round trip is the
// only way to know it. Checking the parts separately would wave through a
// namespace containing a colon, which silently renames the object a signer is
// about to authorize.
func TestGazerPrincipalFor_RoundTripsThroughTheParser(t *testing.T) {
	for _, tc := range []struct{ ns, name string }{
		{"team-a", "phone-7"},
		{"default", "a"},
		{"team-a", "phone.7.local"},
		{strings.Repeat("n", 63), strings.Repeat("m", 253)},
	} {
		principal, err := GazerPrincipalFor(tc.ns, tc.name)
		if err != nil {
			t.Fatalf("GazerPrincipalFor(%q,%q): %v", tc.ns, tc.name, err)
		}
		gotNS, gotName, err := ParseGazerPrincipal(principal)
		if err != nil {
			t.Fatalf("built %q and could not parse it back: %v", principal, err)
		}
		if gotNS != tc.ns || gotName != tc.name {
			t.Fatalf("%q parsed to %q/%q, want %q/%q", principal, gotNS, gotName, tc.ns, tc.name)
		}
	}
}

// A DERIVED PRINCIPAL IS ONLY SAFE IF IT CANNOT BE STEERED. These are the inputs
// an issuer might read off an object whose name it did not fully validate.

// A DERIVED PRINCIPAL IS ONLY SAFE IF IT CANNOT BE STEERED. These are the inputs
// an issuer might read off an object whose name it did not fully validate.
func TestGazerPrincipalFor_RefusesInputsThatWouldRenameTheSubject(t *testing.T) {
	for _, tc := range []struct{ name, ns, obj string }{
		// A colon in the namespace shifts the split and names a DIFFERENT
		// object - the exact reason this validates by round-tripping.
		{"colon in namespace", "team-a:evil", "phone-7"},
		{"colon in name", "team-a", "phone:7"},
		{"empty namespace", "", "phone-7"},
		{"empty name", "team-a", ""},
		{"traversal", "../kube-system", "phone-7"},
		{"uppercase", "Team-A", "phone-7"},
		{"dot in namespace", "team.a", "phone-7"},
		{"overlong namespace", strings.Repeat("n", 64), "phone-7"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := GazerPrincipalFor(tc.ns, tc.obj)
			if err == nil {
				t.Fatalf("built %q from %q/%q - a principal that names something other than "+
					"the object it was derived from authorizes the wrong device", got, tc.ns, tc.obj)
			}
			if got != "" {
				t.Errorf("returned %q alongside an error", got)
			}
		})
	}
}
