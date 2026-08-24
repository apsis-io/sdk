// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"path/filepath"
	"testing"
	"time"
)

// THE ONE FIELD ON Caller THAT A PEER CANNOT LIE ABOUT.
//
// Every other identity field is ASSERTED - "any holder of a trail cert can
// claim to be any pod, given that pod's UID" (Caller's own doc). PeerAddr is
// the exception, and it is trustworthy only because the CNI binds a pod's
// source address to its endpoint. THAT PROPERTY IS A FACT ABOUT THE CLUSTER
// DATAPATH AND DOES NOT LEAVE IT: a device (ADR-0078) is behind NAT, its
// address is bound to nothing and changes between apparitions, so the single
// attestable field is exactly the one that dies at the edge.
//
// VerifiedPrincipal carries an identity the SIGNER vouched for instead, read
// from the completed handshake. These tests pin the two properties that make it
// worth anything: the wire cannot set it, and a certificate that identifies
// NOBODY must produce EMPTY rather than a string that looks like an identity.

// writeTestLeafCN is writeTestLeaf with a caller-chosen subject.
//
// THE DNS-SAN STAYS TrailQUICSNI while only the CommonName varies, and that
// split is the whole mechanism: hostname verification reads the SAN (so
// rustls's stock webpki verifier on the Rust side stays trivially satisfied and
// untouched), while the subject is free to name the peer. They were only ever
// the same string because nothing needed them to differ.
func writeTestLeafCN(t testing.TB, ca *testCA, dir, commonName string) (certPath, keyPath, caPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(7),
		Subject:      pkix.Name{CommonName: commonName},
		DNSNames:     []string{TrailQUICSNI},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")
	caPath = filepath.Join(dir, "ca.pem")
	writePEM(t, certPath, "CERTIFICATE", der)
	writePEM(t, keyPath, "EC PRIVATE KEY", keyDER)
	writePEM(t, caPath, "CERTIFICATE", ca.cert.Raw)
	return
}

// echoCaller serves one provider that hands the whole Caller back, so a test
// asserts on the IDENTITY rather than on the call having succeeded.
func echoCaller(t *testing.T, ca *testCA, consumerCN string) Caller {
	t.Helper()
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	var consumerCert, consumerKey, consumerCA string
	if consumerCN == "" {
		consumerCert, consumerKey, consumerCA = writeTestLeaf(t, ca, t.TempDir())
	} else {
		consumerCert, consumerKey, consumerCA = writeTestLeafCN(t, ca, t.TempDir(), consumerCN)
	}
	ctx := t.Context()

	addr := freeAddr(t)
	go func() {
		_ = ServeQUIC(ctx, "tcp:"+addr, providerCert, providerKey, providerCA, "0.1.0",
			func(c Caller, _ []byte) ([]byte, error) {
				return []byte(c.VerifiedPrincipal), nil
			})
	}()
	client, err := dialQUICWhenReady(t, ctx, addr, consumerCert, consumerKey, consumerCA, "0.1.0")
	if err != nil {
		t.Fatalf("DialQUIC: %v", err)
	}
	defer client.Close()

	got, err := client.Call(ctx, []byte("ignored"))
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	return Caller{VerifiedPrincipal: string(got)}
}

// THE FALSE-POSITIVE DIRECTION, AND IT IS THE ONE THAT MATTERS.
//
// Every trail leaf in the fleet is minted with the fixed subject TrailQUICSNI.
// If that were surfaced, EVERY POD WOULD SUDDENLY LOOK IDENTIFIED - and
// identified as the same principal, which is worse than unidentified, because a
// provider comparing VerifiedPrincipal against an expected value would start
// matching peers it has no business matching. "No identity" must read as no
// identity, not as a string.
func TestVerifiedPrincipal_FleetSharedLeafIdentifiesNobody(t *testing.T) {
	ca := generateTestCA(t)
	got := echoCaller(t, ca, "")
	if got.VerifiedPrincipal != "" {
		t.Fatalf("a leaf carrying the fleet-wide subject produced VerifiedPrincipal=%q - "+
			"a value every peer shares identifies NOBODY, and reporting it turns "+
			"'no identity' into something that looks like one", got.VerifiedPrincipal)
	}
}

// The positive case: a leaf whose subject names one peer carries that name
// across the hop, verified rather than asserted.
func TestVerifiedPrincipal_IndividuallySubjectedLeafIsCarried(t *testing.T) {
	const principal = "apsis:gazer:team-a:phone-7"
	ca := generateTestCA(t)
	got := echoCaller(t, ca, principal)
	if got.VerifiedPrincipal != principal {
		t.Fatalf("VerifiedPrincipal = %q, want %q - the subject did not survive the hop, "+
			"so nothing off-cluster can be identified", got.VerifiedPrincipal, principal)
	}
}

// AND THE WIRE MUST NEVER BE ABLE TO SET IT.
//
// Same property PeerAddr has and for the same reason: decodeCaller builds its
// result field-by-field, so no amount of frame padding reaches this field. A
// test that only checked the happy path would pass just as happily on an
// implementation that read the principal out of the caller frame - which would
// make it exactly as forgeable as PodUID and worth nothing at all.
func TestVerifiedPrincipal_TheWireCannotSetIt(t *testing.T) {
	frames := []string{
		"ns\tpod\tuid\tcomp\tapsis:gazer:team-a:phone-7",
		"ns\tpod\tuid\tapsis:gazer:team-a:phone-7",
		"apsis:gazer:team-a:phone-7",
		"\t\t\t\t\t\tapsis:gazer:team-a:phone-7",
	}
	for _, f := range frames {
		if got := decodeCaller([]byte(f)); got.VerifiedPrincipal != "" {
			t.Errorf("decodeCaller(%q) set VerifiedPrincipal=%q - the wire must never populate it",
				f, got.VerifiedPrincipal)
		}
	}
	// encodeCaller must not carry it either, or a proxying provider would
	// launder an unverified value into a downstream peer's verified field.
	c := Caller{Namespace: "ns", PodName: "pod", PodUID: "uid", Component: "comp",
		VerifiedPrincipal: "apsis:gazer:team-a:phone-7"}
	if back := decodeCaller(encodeCaller(c)); back.VerifiedPrincipal != "" {
		t.Errorf("encodeCaller round-trip carried VerifiedPrincipal=%q - it must not cross a frame",
			back.VerifiedPrincipal)
	}
}

// WHAT THIS DOES NOT FIX, pinned so nobody reads the field above as more than
// it is: the asserted fields stay asserted. A peer holding ANY trail cert can
// still claim to be any pod. VerifiedPrincipal adds a channel that cannot be
// forged; it does not retroactively authenticate the ones that can.
func TestVerifiedPrincipal_DoesNotAuthenticateTheAssertedFields(t *testing.T) {
	const principal = "apsis:gazer:team-a:phone-7"
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeafCN(t, ca, t.TempDir(), principal)
	ctx := t.Context()

	addr := freeAddr(t)
	go func() {
		_ = ServeQUIC(ctx, "tcp:"+addr, providerCert, providerKey, providerCA, "0.1.0",
			func(c Caller, _ []byte) ([]byte, error) { return encodeCaller(c), nil })
	}()
	client, err := dialQUICWhenReady(t, ctx, addr, consumerCert, consumerKey, consumerCA, "0.1.0")
	if err != nil {
		t.Fatalf("DialQUIC: %v", err)
	}
	defer client.Close()

	// A cert that says "phone-7" claiming to be somebody else's pod entirely.
	client.Caller = Caller{Namespace: "kube-system", PodName: "radiant-0", PodUID: "not-mine"}
	got, err := client.Call(ctx, []byte("ignored"))
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	echoed := decodeCaller(got)
	if echoed.PodName != "radiant-0" {
		t.Fatalf("PodName = %q - the transport started FILTERING asserted fields. That may be "+
			"desirable, but it is a behaviour change this test exists to make deliberate",
			echoed.PodName)
	}
	// The point: the lie went through, and the verified channel is what a
	// provider must consult instead.
}
