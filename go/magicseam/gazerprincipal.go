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
// cannot fix, so periapsis's trail operator/gazeradmission_test.go reads the VAP and fails
// when the two spellings drift.
//
// NOT `system:node:` and not any `system:` prefix: periapsis never masquerades
// its identity as kubelet (CLAUDE.md), and an identity in that namespace would
// be one the Node authorizer has opinions about.
const GazerPrincipalPrefix = "apsis:gazer:"

// GazerOrganisation is the GROUP a device's client certificate carries, i.e.
// the `O=` in its subject.
//
// ***THIS HAD THREE COPIES AND NO GO CONSTANT UNTIL 2026-08-25*** -
// deploy/gazer-rbac.yaml's ClusterRoleBinding subject, deploy/gazer-vap.yaml's
// matchCondition, and the comet agent's CSR generator - with nothing making any
// of them agree.
//
// IT IS THE FAIL-OPEN DIRECTION, which is why the missing constant mattered
// more than the usual duplication. gazer-vap.yaml says so itself: "an identity
// NOT in this group is not checked here at all, so this policy is only as good
// as the rule that `apsis:gazers` is granted to devices and nothing else." A
// device whose certificate carries a different spelling is not DENIED by the
// policy - it is not SUBJECT to it, and it keeps whatever the RBAC gave it.
//
// So a typo here does not produce a refusal anybody sees. It produces a device
// outside the admission rule, looking healthy.
//
// periapsis's cross-language seam tests, gazercsr_test.go pins this against the two manifests and
// against the Rust constant, which is the only form the agreement can take
// across three languages.
const GazerOrganisation = "apsis:gazers"

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
	return ParseGazerPrincipal(who.VerifiedPrincipal)
}

// ParseGazerPrincipal is GazerPrincipal's parser, exported so the side that
// MINTS a device leaf validates with the identical code that later reads it.
//
// THE PRODUCER AND THE CONSUMER OF THIS SUBJECT MUST AGREE FOREVER, and the way
// they stop agreeing is a second copy of the rules. periapsis's PKI
// SignGazerTrailCSR calls this before it will sign anything, so a subject that
// cannot be parsed cannot be issued in the first place - the failure moves from
// a device that authenticates as nobody to a signer that refuses.
//
// Callers holding a Caller should use GazerPrincipal instead: it distinguishes
// "no verified identity at all" (ErrUnattested) from "an identity that is not a
// Gazer" (ErrNotAGazer), and that distinction is lost once the string is on its
// own.
func ParseGazerPrincipal(principal string) (namespace, name string, err error) {
	rest, ok := strings.CutPrefix(principal, GazerPrincipalPrefix)
	if !ok {
		return "", "", fmt.Errorf("%w: %q has no %q prefix",
			ErrNotAGazer, principal, GazerPrincipalPrefix)
	}
	// EXACTLY two parts. SplitN with a limit would fold a third colon into the
	// name and hand back something that parses but names a different object, so
	// the count is checked rather than bounded.
	parts := strings.Split(rest, ":")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("%w: %q must be %s<namespace>:<name>",
			ErrNotAGazer, principal, GazerPrincipalPrefix)
	}
	namespace, name = parts[0], parts[1]
	if err := validDNSName(namespace, 63, false); err != nil {
		return "", "", fmt.Errorf("%w: namespace in %q: %v", ErrNotAGazer, principal, err)
	}
	if err := validDNSName(name, 253, true); err != nil {
		return "", "", fmt.Errorf("%w: name in %q: %v", ErrNotAGazer, principal, err)
	}
	return namespace, name, nil
}

// GazerPrincipalFor builds the principal for a Gazer from its namespace and
// name, so a signer never has to be HANDED one.
//
// ***THE POINT IS THAT THE PRINCIPAL IS DERIVED, NEVER SUPPLIED.***
// SignGazerTrailCSR signs the principal it is given and says so: it cannot tell
// whether the requester is entitled to it, and getting that wrong mints a
// credential that authenticates as another device - one layer earlier than any
// ValidatingAdmissionPolicy can see.
//
// The way that gap closes is not a second policy check, it is arithmetic. A
// device's CSR arrives in its OWN Gazer, and deploy/gazer-vap.yaml already
// guarantees only that device could have written that object. So the issuer
// derives the principal from the OBJECT it found the request on, and a device
// asking for someone else's identity has nowhere to put the request. The
// entitlement question stops being answered and starts being unaskable - the
// same move aperture makes with namespaces, where a cross-namespace write is
// unspellable rather than refused.
//
// So: an issuer that calls this is safe by construction, and one that reads a
// principal out of the request payload has reintroduced the whole problem while
// looking like it is doing the same thing.
func GazerPrincipalFor(namespace, name string) (string, error) {
	principal := GazerPrincipalPrefix + namespace + ":" + name
	// Validated by PARSING WHAT WAS BUILT rather than by checking the parts
	// separately: the two must agree forever, and the only way to be sure the
	// thing constructed here is the thing readable there is to read it.
	// Catches a namespace containing a colon, which splitting the checks would
	// wave through and which would silently rename the object being authorized.
	gotNS, gotName, err := ParseGazerPrincipal(principal)
	if err != nil {
		return "", err
	}
	// ***UNREACHABLE TODAY, AND KEPT DELIBERATELY - SAYING SO BECAUSE AN
	// UNTESTED CHECK THAT READS AS LOAD-BEARING IS WORSE THAN NO CHECK.***
	//
	// Measured by mutation: deleting this comparison breaks NO test, and the
	// mutant was confirmed to apply and to compile before that was believed.
	// It cannot fire while ParseGazerPrincipal demands exactly two colon
	// segments and returns them verbatim - a colon in either input makes the
	// split three parts, which the error above already catches.
	//
	// It is kept for ONE named, plausible future change: if the parser is ever
	// relaxed to SplitN(rest, ":", 2), extra colons fold into the NAME instead
	// of erroring, and this becomes the only thing standing between a namespace
	// of "team-a:evil" and a principal that authorizes a different object. That
	// change would look like tidying. This is the thing that would refuse it.
	if gotNS != namespace || gotName != name {
		return "", fmt.Errorf("%w: %q round-trips to %q/%q, not %q/%q",
			ErrNotAGazer, principal, gotNS, gotName, namespace, name)
	}
	return principal, nil
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
