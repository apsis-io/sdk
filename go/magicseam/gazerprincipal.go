// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"fmt"

	"github.com/apsis-io/sdk/go/gazer"
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

// ***THE VOCABULARY ITSELF MOVED TO github.com/apsis-io/sdk/go/gazer ON
// 2026-09-02, UNDER APACHE-2.0.*** periapsis-CE is GPLv3 and depended on exactly
// four symbols from this file - GazerOrganisation, GazerPrincipalPrefix,
// ParseGazerPrincipal, GazerPrincipalFor - none of which touch the seam. BUSL's
// production-use conditions and GPLv3 section 10 cannot both hold downstream, so
// the half that is string handling over a naming convention went permissive and
// the half that needs a Caller stayed here.
//
// WHAT IS LEFT IS THE PART THAT CANNOT MOVE. GazerPrincipal takes a Caller,
// which is the seam's own type; everything it does beyond reading that field is
// delegated. The dependency runs BUSL -> Apache, which is fine, and never the
// other way.
//
// Consumers wanting the vocabulary WITHOUT the seam should import gazer
// directly. It is deliberately not re-exported here: an alias would let a
// GPLv3 build reach the vocabulary through a BUSL import and still compile,
// which is precisely the silent edge this split exists to remove.

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
			gazer.ErrUnattested)
	}
	return gazer.ParseGazerPrincipal(who.VerifiedPrincipal)
}
