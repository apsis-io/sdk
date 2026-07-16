// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"errors"
	"fmt"
	"testing"
)

// TestSeamError_MapsVariantsAndDefaults: the provider-side Go-error -> seam
// variant mapping matches periapsis:magic/handler's error variant, defaults
// fail-closed to unavailable, and matches WRAPPED sentinels (errors.Is).
func TestSeamError_MapsVariantsAndDefaults(t *testing.T) {
	cases := []struct {
		err   error
		want  string
		isErr bool
	}{
		{nil, "", false},
		{ErrRejected, "rejected", true},
		{ErrTooLarge, "too-large", true},
		{ErrUnavailable, "unavailable", true},
		{errors.New("some random failure"), "unavailable", true}, // fail-closed default
		{fmt.Errorf("ctx: %w", ErrRejected), "rejected", true},   // wrapped sentinel
		{fmt.Errorf("ctx: %w", ErrTooLarge), "too-large", true},
	}
	for _, c := range cases {
		v, is := SeamError(c.err)
		if v != c.want || is != c.isErr {
			t.Errorf("SeamError(%v) = (%q, %v), want (%q, %v)", c.err, v, is, c.want, c.isErr)
		}
	}
}

// TestFromSeamError_InverseAndErrorsIs: the consumer-side variant -> Go-error
// inverse round-trips, is usable with errors.Is, and falls back to Unavailable
// for an unknown variant (fail-closed).
func TestFromSeamError_InverseAndErrorsIs(t *testing.T) {
	for _, v := range []string{"rejected", "too-large", "unavailable"} {
		got, is := SeamError(FromSeamError(v))
		if !is || got != v {
			t.Errorf("round-trip %q -> (%q, %v)", v, got, is)
		}
	}
	if !errors.Is(FromSeamError("rejected"), ErrRejected) {
		t.Error("FromSeamError(rejected) should errors.Is ErrRejected")
	}
	if !errors.Is(FromSeamError("too-large"), ErrTooLarge) {
		t.Error("FromSeamError(too-large) should errors.Is ErrTooLarge")
	}
	if !errors.Is(FromSeamError("bogus"), ErrUnavailable) {
		t.Error("unknown variant should fall back to ErrUnavailable (fail-closed)")
	}
}
