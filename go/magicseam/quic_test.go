// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ---- real loopback QUIC integration test ----
//
// Generates a throwaway self-signed CA + two leaf certs (one "provider",
// one "consumer" - genuinely mutual TLS, each side verifies the other),
// both sharing TrailQUICSNI as their DNS SAN per this package's fixed-SAN
// design (mirrors tools/trail/src/remote_quic.rs's own test module doc
// comment). Real UDP sockets on 127.0.0.1, real crypto/tls + quic-go
// handshakes, real streams - only the handler is a trivial mock.

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func generateTestCA(t *testing.T) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test-trail-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCA{cert: cert, key: key}
}

// writeTestLeaf mints a leaf signed by ca (CommonName/DNSName ==
// TrailQUICSNI, same fixed-SAN design as trailtls.go) and writes
// cert.pem/key.pem/ca.pem into dir, returning their paths.
func writeTestLeaf(t *testing.T, ca *testCA, dir string) (certPath, keyPath, caPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: TrailQUICSNI},
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

func writePEM(t *testing.T, path, blockType string, der []byte) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := pem.Encode(f, &pem.Block{Type: blockType, Bytes: der}); err != nil {
		t.Fatal(err)
	}
}

func TestQUICRoundTripOverRealLoopbackMTLS(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	ctx := t.Context()

	echo := func(_ Caller, request []byte) ([]byte, error) { return request, nil }
	go func() {
		_ = ServeQUIC(ctx, "tcp:127.0.0.1:19700", providerCert, providerKey, providerCA, "0.1.0", echo)
	}()
	time.Sleep(150 * time.Millisecond) // let the listener bind before dialing

	client, err := DialQUIC(ctx, "tcp:127.0.0.1:19700", consumerCert, consumerKey, consumerCA, "0.1.0")
	if err != nil {
		t.Fatalf("DialQUIC: %v", err)
	}
	defer client.Close()
	if client.Served != "0.1.0" {
		t.Errorf("Served = %q, want %q", client.Served, "0.1.0")
	}

	resp, err := client.Call(ctx, []byte("hello quic"))
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if string(resp) != "hello quic" {
		t.Errorf("Call response = %q, want %q", resp, "hello quic")
	}
}

func TestQUICConcurrentCallsDoNotSerialize(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	ctx := t.Context()

	slow := func(_ Caller, request []byte) ([]byte, error) {
		time.Sleep(200 * time.Millisecond)
		return request, nil
	}
	go func() {
		_ = ServeQUIC(ctx, "tcp:127.0.0.1:19701", providerCert, providerKey, providerCA, "", slow)
	}()
	time.Sleep(150 * time.Millisecond)

	client, err := DialQUIC(ctx, "tcp:127.0.0.1:19701", consumerCert, consumerKey, consumerCA, "")
	if err != nil {
		t.Fatalf("DialQUIC: %v", err)
	}
	defer client.Close()

	start := time.Now()
	done := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := client.Call(ctx, []byte("x"))
			done <- err
		}()
	}
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	// Two 200ms calls that ran concurrently finish in ~200ms; serialized,
	// they'd take ~400ms. Generous bound to absorb CI/loopback jitter.
	if elapsed := time.Since(start); elapsed > 350*time.Millisecond {
		t.Errorf("two concurrent 200ms calls took %v, expected ~200ms (not serialized)", elapsed)
	}
}

func TestQUICRejectedAndTooLargeTagsRoundtrip(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	ctx := t.Context()

	handler := func(_ Caller, request []byte) ([]byte, error) {
		switch string(request) {
		case "reject":
			return nil, ErrRejected
		case "toolarge":
			return nil, ErrTooLarge
		default:
			return nil, errors.New("boom")
		}
	}
	go func() {
		_ = ServeQUIC(ctx, "tcp:127.0.0.1:19702", providerCert, providerKey, providerCA, "", handler)
	}()
	time.Sleep(150 * time.Millisecond)

	client, err := DialQUIC(ctx, "tcp:127.0.0.1:19702", consumerCert, consumerKey, consumerCA, "")
	if err != nil {
		t.Fatalf("DialQUIC: %v", err)
	}
	defer client.Close()

	if _, err := client.Call(ctx, []byte("reject")); !errors.Is(err, ErrRejected) {
		t.Errorf("Call(reject) err = %v, want ErrRejected", err)
	}
	if _, err := client.Call(ctx, []byte("toolarge")); !errors.Is(err, ErrTooLarge) {
		t.Errorf("Call(toolarge) err = %v, want ErrTooLarge", err)
	}
	if _, err := client.Call(ctx, []byte("other")); err == nil {
		t.Error("Call(other) expected an Unavailable-shaped error, got nil")
	}
}

// TestQUICCarriesTheCaller: the identity must survive the hop. Asserted by
// echoing the CALLER back rather than the request - a test that only checked
// the call succeeded would pass just as happily with an empty caller.
func TestQUICCarriesTheCaller(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())
	ctx := t.Context()

	addr := "tcp:127.0.0.1:19706"
	go func() {
		_ = ServeQUIC(ctx, addr, providerCert, providerKey, providerCA, "0.1.0",
			func(c Caller, _ []byte) ([]byte, error) { return encodeCaller(c), nil })
	}()
	time.Sleep(150 * time.Millisecond)

	client, err := DialQUIC(ctx, addr, consumerCert, consumerKey, consumerCA, "0.1.0")
	if err != nil {
		t.Fatalf("DialQUIC: %v", err)
	}
	defer client.Close()
	client.Caller = Caller{Namespace: "team-a", PodName: "w8s-a", PodUID: "uid-123", Component: "cri"}

	got, err := client.Call(ctx, []byte("ignored"))
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if echoed := decodeCaller(got); echoed != client.Caller {
		t.Fatalf("caller = %+v, want %+v", echoed, client.Caller)
	}
}

func TestDecodeCallerHandlesShortFrames(t *testing.T) {
	// An unattributed or garbled call must yield empty fields rather than an
	// error: refusing is the PROVIDER's decision, not the transport's.
	if got := decodeCaller([]byte("only-ns")); got.Namespace != "only-ns" || got.PodUID != "" {
		t.Fatalf("short frame = %+v", got)
	}
	if got := decodeCaller(nil); got != (Caller{}) {
		t.Fatalf("empty frame = %+v, want zero Caller", got)
	}
}

// TestListenUDPForHostHonoursTheRequestedFamily: "0.0.0.0" means IPv4. Go's
// net package answers an unspecified host on network "udp" with an AF_INET6
// dual-stack socket, so a v4 wildcard silently becomes [::] - visible only in
// /proc/net/udp6, with nothing in /proc/net/udp. That surprised us once
// already (done/2026-07-31_quic-provider-wedge.md); assert the family rather
// than merely that a socket was created.
func TestListenUDPForHostHonoursTheRequestedFamily(t *testing.T) {
	cases := []struct {
		hostPort string
		wantV4   bool
	}{
		{"0.0.0.0:0", true},
		{"127.0.0.1:0", true},
		{"[::]:0", false},
		{"[::1]:0", false},
	}
	for _, tc := range cases {
		pc, err := listenUDPForHost(tc.hostPort)
		if err != nil {
			t.Fatalf("listenUDPForHost(%q): %v", tc.hostPort, err)
		}
		local := pc.LocalAddr().(*net.UDPAddr)
		gotV4 := local.IP.To4() != nil
		pc.Close()
		if gotV4 != tc.wantV4 {
			fam := "IPv6"
			if tc.wantV4 {
				fam = "IPv4"
			}
			t.Errorf("listenUDPForHost(%q) bound %v, want an %s socket", tc.hostPort, local.IP, fam)
		}
	}
}
