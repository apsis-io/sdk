// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"errors"
	"fmt"
	"strings"
)

// Turning a VERIFIED caller identity into the Gazer it names.
//
// The sibling of AttestPeer, and it closes the gap that function's own doc
// names: "it says where the packets came from, NOT who signed them - it is not a
// substitute for per-pod credentials, it is what can be had without them."
// Caller.VerifiedPrincipal is who signed them, so this is the check AttestPeer
// could not be.
//
// IT LIVES HERE FOR AttestPeer'S REASON, restated: whatever authorizes a
// device's calls is a security control, and a second copy of it somewhere else
// would have to agree with this one forever.
//
// # WHY A DEVICE NEEDS A DIFFERENT CONTROL FROM A POD
//
// AttestPeer works by comparing the claimed pod against the address the packets
// arrived from, which is attested because the CNI binds a source address to an
// endpoint. A Gazer (ADR-0078) is off-cluster by construction: it is behind NAT,
// its address is bound to nothing, and it changes between apparitions. There is
// no datapath fact to compare against, so the identity has to be one the SIGNER
// vouched for.

// GazerPrincipalPrefix is the subject convention for a device's trail leaf:
// apsis:gazer:<namespace>:<name>.
//
// ***THIS STRING IS DUPLICATED IN deploy/gazer-vap.yaml'S CEL EXPRESSION***, and
// it must be, because a ValidatingAdmissionPolicy cannot import a Go constant.
// Two things that must agree with nothing enforcing it is exactly what a comment
// cannot fix, so internal/trailop/gazeradmission_test.go reads the VAP and fails
// when the two spellings drift.
//
// NOT `system:node:` and not any `system:` prefix: periapsis never masquerades
// its identity as kubelet (CLAUDE.md), and an identity in that namespace would
// be one the Node authorizer has opinions about.
const GazerPrincipalPrefix = "apsis:gazer:"

// ErrUnattested is returned when the caller presented NO verified identity.
//
// SEPARATE FROM ErrNotAGazer ON PURPOSE. "We could not establish who this is"
// and "we established who this is, and it is not a device" are different
// findings with different fixes - the first is a peer on a fleet-shared trail
// leaf (every pod today) or a misconfigured signer, the second is a real
// identity calling something not meant for it. Collapsing them into one refusal
// would make a deployment fault and an authorization fault look identical in the
// logs, and the first is the one that will actually happen.
var ErrUnattested = errors.New("magicseam: caller presented no verified identity")

// ErrNotAGazer is returned when a verified identity exists but does not name a
// Gazer.
var ErrNotAGazer = errors.New("magicseam: verified identity is not a Gazer principal")

// GazerPrincipal returns the namespace and name of the Gazer the caller's
// VERIFIED identity names.
//
// ***IT READS Caller.VerifiedPrincipal AND NOTHING ELSE.*** Caller.Namespace is
// right there, spelled the same, and it is ASSERTED - trail fills it in and any
// holder of a trail cert can put anything in it. Falling back to it when the
// verified field is empty would be the natural-looking change that silently
// converts this from an authentication check into a self-report, which is the
// entire defect this exists to prevent. There is a test pinning that.
func GazerPrincipal(who Caller) (namespace, name string, err error) {
	if who.VerifiedPrincipal == "" {
		return "", "", fmt.Errorf("%w: refusing to derive a Gazer from an unattested caller "+
			"(every trail leaf in the fleet shares one subject, so this is the normal case "+
			"for a pod peer - it is not evidence that nobody is impersonating anyone)",
			ErrUnattested)
	}
	rest, ok := strings.CutPrefix(who.VerifiedPrincipal, GazerPrincipalPrefix)
	if !ok {
		return "", "", fmt.Errorf("%w: %q has no %q prefix",
			ErrNotAGazer, who.VerifiedPrincipal, GazerPrincipalPrefix)
	}
	// EXACTLY two parts. SplitN with a limit would fold a third colon into the
	// name and hand back something that parses but names a different object, so
	// the count is checked rather than bounded.
	parts := strings.Split(rest, ":")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("%w: %q must be %s<namespace>:<name>",
			ErrNotAGazer, who.VerifiedPrincipal, GazerPrincipalPrefix)
	}
	namespace, name = parts[0], parts[1]
	if err := validDNSName(namespace, 63, false); err != nil {
		return "", "", fmt.Errorf("%w: namespace in %q: %v", ErrNotAGazer, who.VerifiedPrincipal, err)
	}
	if err := validDNSName(name, 253, true); err != nil {
		return "", "", fmt.Errorf("%w: name in %q: %v", ErrNotAGazer, who.VerifiedPrincipal, err)
	}
	return namespace, name, nil
}

// validDNSName checks the subset of DNS-1123 Kubernetes actually accepts, by
// hand rather than via apimachinery: this SDK is deliberately client-go free
// (the same tax facade.go and attest.go describe and choose to pay), and a
// device's Comet linking the Kubernetes API machinery to parse its own name
// would be absurd on a 320 KB target.
//
// STRICTER THAN IT LOOKS NECESSARY, because the output of this function selects
// an object to authorize a write against. An accepted "" or ".." or a name with
// a slash would be a path into somewhere the caller does not own.
func validDNSName(s string, maxLen int, allowDots bool) error {
	if s == "" {
		return errors.New("empty")
	}
	if len(s) > maxLen {
		return fmt.Errorf("longer than %d characters", maxLen)
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '-':
		case c == '.' && allowDots:
		default:
			return fmt.Errorf("invalid character %q (lowercase alphanumeric, '-'%s only)",
				string(c), map[bool]string{true: " and '.'", false: ""}[allowDots])
		}
	}
	if s[0] == '-' || s[len(s)-1] == '-' || s[0] == '.' || s[len(s)-1] == '.' {
		return errors.New("must start and end with an alphanumeric character")
	}
	return nil
}
