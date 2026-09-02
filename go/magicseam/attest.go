// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"fmt"
	"net"
)

// Turning the caller's ASSERTED identity into one the datapath attests.
//
// PROMOTED OUT OF the w8s node provider example 2026-08-20, UNCHANGED IN
// BEHAVIOUR, because radiant needs exactly this check to authorize a Perseid's
// observe/emit calls (ADR-0082's per-call enforcement point) and the alternative
// was a SECOND copy of a security control that must agree with the first
// forever. The reasoning below is that provider's, kept verbatim - it is the
// threat model, not decoration.
//
// THE GAP THIS CLOSES. Everything a provider refuses - an image allowlist, a
// fixed namespace, an ownerReference on launch, an ownership check on stop - is
// keyed on WHO IS CALLING, and without this that is a claim. trail fills the
// caller frame in from the pod it is running and a guest cannot reach it, but
// nothing in the transport verifies it: every trail QUIC leaf fleet-wide carries
// the same fixed CommonName/DNS-SAN and the signing side discards the subject
// entirely (periapsis's PKI relay, deliberately - ADR-0057 chose ONE
// IDENTITY PER HOST, not per pod). So mTLS proves "signed by the trail CA" and
// nothing about which peer is speaking. Any holder of a trail cert could claim
// to be any pod, given that pod's UID - and then act as it.
//
// WHAT ATTESTS IT INSTEAD. The CNI binds a source address to an endpoint, so the
// address a packet ARRIVES FROM is not something the sender chooses. The caller
// claims to be a pod; that pod has a podIP; if the two disagree, the claim is
// false. Verified live before this was written: conntrack on the node shows the
// consumer's own pod IP reaching the provider unmodified (UDP IN
// 192.0.2.33:50720 -> 192.0.2.53:9500), so pod-to-pod traffic there is not
// SNATed and the observed address is the caller's real one.
//
// AND THROUGH A ClusterIP SERVICE, ACROSS NODES - measured 2026-08-20, because
// the case above is pod-to-POD and every remote-tier seam dials a SERVICE
// (resolver.go binds the Service DNS name, not an endpoint IP). That is the hop
// where a SNAT would silently reduce this control to nothing:
//
//	client 198.51.100.196 (node-2) -> ClusterIP 203.0.113.254
//	server 198.51.100.13  (node-1) OBSERVED [::ffff:198.51.100.196]
//	three consecutive connections, all carrying the client's real podIP
//
// ***THE OBSERVED FORM WAS IPv4-MAPPED IPv6, WHICH IS WHY sameIP PARSES RATHER
// THAN COMPARES.*** That listener was dual-stack ([::]), so the mapping is the
// LISTENER's doing rather than the CNI's and a v4-only listener would see a
// plain v4 address - but it means the mapped form is a real wire condition here,
// not a defensive hypothetical. A string compare against Status.PodIP
// ("198.51.100.196") would have refused every legitimate call while reading in the
// logs exactly like an impersonation attempt.
//
// WHAT IT DOES NOT DO, stated because a partial control described as a complete
// one is worse than none:
//   - it is only as good as the CNI's source-address enforcement;
//   - it says where the packets came from, NOT who signed them - it is not a
//     substitute for per-pod credentials, it is what can be had without them.
//     The durable fix is a per-pod URI SAN, and its cutover is MINT -> CYCLE ->
//     ENFORCE in that order (periapsis's internal notes); enforcing first takes
//     out every wasm pod at once;
//   - it would be defeated by any hop that rewrites the source address. Route a
//     consumer through a SNATing path and the claim stops matching. That is why
//     a refusal here names BOTH addresses: the failure mode of this control is a
//     legitimate caller being refused, and that must be diagnosable in one look
//     rather than presenting as a mysterious rejection.

// PodIdentity is the part of a claimed caller's pod that attestation reads.
//
// A THREE-FIELD STRUCT RATHER THAN *corev1.Pod, AND THE REASON IS THE SDK'S
// DEPENDENCY SURFACE. This package has zero k8s.io imports and external seam
// providers consume it; taking a corev1.Pod would pull the whole Kubernetes API
// surface into every one of them. The check only ever reads these three fields,
// so nothing is lost - a caller holding a real Pod writes a two-line adapter.
type PodIdentity struct {
	Namespace string
	Name      string
	// PodIP is the address the CNI bound to this pod. Empty means "not assigned
	// yet", which is unattestable rather than mismatched - see AttestPeer.
	PodIP string
}

// AttestPeer reports whether the observed peer address is consistent with the
// pod the caller claims to be. A nil error means the claim is attested.
//
// FAILS CLOSED ON AN UNOBSERVED ADDRESS, AND THE CALLER MUST CHECK THAT THIS
// FITS ITS TRANSPORT. The originating provider is remote-only - declared with
// transport quic, where the address is always observable - so for it an empty
// PeerAddr can only mean the transport failed to observe one, and accepting on
// "we could not check" would leave the control bypassable by whatever produced
// the empty value.
//
// ***THAT PREMISE IS THE PROVIDER'S, NOT THIS PACKAGE'S.*** The LOCAL link tier
// has no peer address at all (see Caller.PeerAddr), so calling AttestPeer on a
// local-tier call refuses every one of them - correctly, by its own rule, and
// uselessly. Do not call it on a transport that cannot observe an address;
// decide unattributed calls yourself, as Caller's doc says.
func AttestPeer(claimed PodIdentity, who Caller) error {
	if who.PeerAddr == "" {
		return fmt.Errorf(
			"%w: no observed peer address - refusing to act on an unattested caller identity",
			ErrRejected)
	}
	host, _, err := net.SplitHostPort(who.PeerAddr)
	if err != nil {
		return fmt.Errorf("%w: unparseable peer address %q", ErrRejected, who.PeerAddr)
	}
	if claimed.PodIP == "" {
		return fmt.Errorf(
			"%w: caller %s/%s has no podIP yet, so its claim cannot be attested",
			ErrRejected, claimed.Namespace, claimed.Name)
	}
	if !sameIP(claimed.PodIP, host) {
		// Both addresses named on purpose - see the file comment.
		return fmt.Errorf(
			"%w: caller claims to be %s/%s (podIP %s) but the call arrived from %s",
			ErrRejected, claimed.Namespace, claimed.Name, claimed.PodIP, host)
	}

	return nil
}

// sameIP compares two addresses as IPs rather than strings, so equivalent
// spellings (an IPv4-mapped IPv6 form, a differently-written v6 address) do not
// read as an impersonation attempt.
func sameIP(a, b string) bool {
	ipA, ipB := net.ParseIP(a), net.ParseIP(b)
	if ipA == nil || ipB == nil {
		return false
	}

	return ipA.Equal(ipB)
}
