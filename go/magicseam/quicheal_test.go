// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

// serveQUICHandler starts a provider running handler on a fresh port.
//
// serveQUICEcho's sibling for the tests that need a provider which REFUSES:
// healing's whole contract is about telling a refusal from a dead connection,
// and an echo provider can only ever demonstrate one of those.
func serveQUICHandler(tb testing.TB, cert, key, ca string, handler Handler) string {
	tb.Helper()
	addr := fmt.Sprintf("tcp:127.0.0.1:%d", freeLoopbackUDPPort(tb))
	go func() {
		_ = ServeQUIC(tb.Context(), addr, cert, key, ca, "0.1.0", handler)
	}()

	return addr
}

// healingFixture wires a HealingClient whose redials are COUNTED, which is what
// most of these assertions are really about: "did it redial" is the behaviour,
// and a test that only checks the call's return value cannot see it.
type healingFixture struct {
	client *HealingClient
	dials  *atomic.Int64
	addr   string
}

func newHealingFixture(t *testing.T, handler Handler) *healingFixture {
	t.Helper()
	ca := generateTestCA(t)
	pc, pk, pca := writeTestLeaf(t, ca, t.TempDir())
	cc, ck, cca := writeTestLeaf(t, ca, t.TempDir())

	addr := serveQUICHandler(t, pc, pk, pca, handler)
	initial := dialQUICWhenUp(t, addr, cc, ck, cca)

	var dials atomic.Int64
	dial := func(ctx context.Context) (*QUICClient, error) {
		dials.Add(1)

		return DialQUICEarly(ctx, addr, cc, ck, cca, "0.1.0")
	}

	return &healingFixture{client: NewHealingClient(initial, dial), dials: &dials, addr: addr}
}

func echoHandler(_ Caller, req []byte) ([]byte, error) { return req, nil }

// THE GAP THIS EXISTS TO CLOSE. A provider restart used to strand a Go consumer
// permanently - every later call failed with nothing reaching the provider,
// until the consumer itself was restarted. A provider restart is what a rollout
// is, so "permanently" meant every rollout.
func TestHealingRedialsWhenTheConnectionIsDead(t *testing.T) {
	f := newHealingFixture(t, echoHandler)
	defer f.client.Close()

	// Kill the connection underneath the healing client, which is what a provider
	// restart looks like from here.
	if err := f.client.inner.Close(); err != nil {
		t.Fatalf("closing the underlying connection: %v", err)
	}

	reply, err := f.client.Call(t.Context(), []byte("after-restart"))
	if err != nil {
		t.Fatalf("a call over a DEAD connection did not heal: %v - this is the whole point of "+
			"the type; without it the consumer is stranded until it restarts", err)
	}
	if !bytes.Equal(reply, []byte("after-restart")) {
		t.Errorf("healed call returned %q, want the echo back - it reconnected but the call did "+
			"not actually round-trip", reply)
	}
	if got := f.dials.Load(); got != 1 {
		t.Errorf("redials = %d, want exactly 1", got)
	}
}

// A REFUSAL IS NOT A DEAD CONNECTION. The provider answered, so it is reachable
// and working; redialling it turns one refusal into a reconnect storm against
// something healthy. An ARMED BARRIER answers exactly this way (ADR-0032), so
// getting this wrong means healing fights a coordinated checkpoint.
func TestHealingDoesNotRedialOnAProviderRefusal(t *testing.T) {
	refuse := func(_ Caller, _ []byte) ([]byte, error) {
		return nil, errors.New("not right now") // -> tagUnavailable on the wire
	}
	f := newHealingFixture(t, refuse)
	defer f.client.Close()

	_, err := f.client.Call(t.Context(), []byte("x"))
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("call error = %v, want ErrUnavailable - the provider ANSWERED, and healing can "+
			"only make the right choice if that is distinguishable from a dead connection", err)
	}
	if got := f.dials.Load(); got != 0 {
		t.Errorf("redials = %d, want 0 - a working provider that said no was reconnected to", got)
	}
}

// ...and the same for the other two application answers, which are refusals with
// different reasons rather than different KINDS of outcome.
func TestHealingDoesNotRedialOnRejectedOrTooLarge(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"rejected", ErrRejected},
		{"too-large", ErrTooLarge},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHealingFixture(t, func(_ Caller, _ []byte) ([]byte, error) { return nil, tc.err })
			defer f.client.Close()

			_, err := f.client.Call(t.Context(), []byte("x"))
			if !errors.Is(err, tc.err) {
				t.Fatalf("call error = %v, want %v", err, tc.err)
			}
			if got := f.dials.Load(); got != 0 {
				t.Errorf("redials = %d, want 0 - %v is an ANSWER, not a transport failure",
					got, tc.err)
			}
		})
	}
}

// ONE BLIP, ONE REDIAL. Without serialisation every in-flight call opens its own
// connection, so a single provider restart on a busy consumer becomes a
// thundering herd of handshakes against a provider that is only just back up.
func TestConcurrentFailuresProduceExactlyOneRedial(t *testing.T) {
	f := newHealingFixture(t, echoHandler)
	defer f.client.Close()

	if err := f.client.inner.Close(); err != nil {
		t.Fatalf("closing the underlying connection: %v", err)
	}

	const callers = 12
	var wg sync.WaitGroup
	errs := make([]error, callers)
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = f.client.Call(t.Context(), []byte("concurrent"))
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("caller %d failed: %v - every caller should ride the single heal", i, err)
		}
	}
	if got := f.dials.Load(); got != 1 {
		t.Errorf("redials = %d, want exactly 1 - %d concurrent failures each opened their own "+
			"connection, which is a handshake storm against a just-restarted provider",
			got, callers)
	}
}

// A CLOSED CLIENT MUST STAY CLOSED. This is the bug healing introduces if nobody
// looks for it: Close kills the connection, the next Call sees a transport
// failure, and a transport failure is EXACTLY the shape heal exists to repair -
// so a closed client silently dials a new connection and leaks it. Shutdown
// stops being final.
func TestAClosedClientDoesNotHeal(t *testing.T) {
	f := newHealingFixture(t, echoHandler)

	if err := f.client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	_, err := f.client.Call(t.Context(), []byte("after-close"))
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("call after Close returned %v, want ErrClosed", err)
	}
	if got := f.dials.Load(); got != 0 {
		t.Errorf("redials = %d, want 0 - a CLOSED client reconnected itself, so Close does not "+
			"actually close and the connection it opened is leaked", got)
	}
}

// A DIAL THAT ALSO FAILS IS AN ANSWER, not a reason to keep trying. Looping here
// would hide a genuinely down provider behind a call that never returns, which
// is strictly worse than an error: the caller cannot even time it out
// meaningfully.
func TestHealingSurfacesADialFailureRatherThanLooping(t *testing.T) {
	f := newHealingFixture(t, echoHandler)
	defer f.client.Close()

	wantErr := errors.New("provider is down")
	var attempts atomic.Int64
	f.client.dial = func(context.Context) (*QUICClient, error) {
		attempts.Add(1)

		return nil, wantErr
	}
	if err := f.client.inner.Close(); err != nil {
		t.Fatalf("closing the underlying connection: %v", err)
	}

	_, err := f.client.Call(t.Context(), []byte("x"))
	if !errors.Is(err, wantErr) {
		t.Fatalf("call error = %v, want the dial's own error surfaced", err)
	}
	if got := attempts.Load(); got != 1 {
		t.Errorf("dial attempts = %d, want exactly 1 - healing retried a failing dial, which "+
			"turns a down provider into a call that never returns", got)
	}
}

// THE VERSION GATE SURVIVES A HEAL. A provider that came back serving something
// incompatible must not be adopted silently: that is a downgrade nobody asked
// for, arriving through the repair path, where nobody is looking for it.
func TestHealingReappliesTheVersionGate(t *testing.T) {
	f := newHealingFixture(t, echoHandler)
	defer f.client.Close()

	// The redial lands on a provider that refuses this consumer's version.
	f.client.dial = func(context.Context) (*QUICClient, error) {
		return nil, fmt.Errorf("%w: required %q, serves %q", ErrVersionRejected, "0.1.0", "9.9.9")
	}
	if err := f.client.inner.Close(); err != nil {
		t.Fatalf("closing the underlying connection: %v", err)
	}

	_, err := f.client.Call(t.Context(), []byte("x"))
	if !errors.Is(err, ErrVersionRejected) {
		t.Fatalf("call error = %v, want ErrVersionRejected to reach the caller - a healed "+
			"connection to an INCOMPATIBLE provider is a silent downgrade", err)
	}
}

// A CANCELLED CALLER IS NOT A DEAD PROVIDER. Redialling on the caller's own
// cancellation spends a fresh handshake to serve someone who has already given
// up - and the dial would fail on that same context anyway.
func TestACancelledContextDoesNotTriggerARedial(t *testing.T) {
	f := newHealingFixture(t, echoHandler)
	defer f.client.Close()

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	if _, err := f.client.Call(ctx, []byte("x")); err == nil {
		t.Fatal("a call on a cancelled context succeeded")
	}
	if got := f.dials.Load(); got != 0 {
		t.Errorf("redials = %d, want 0 - the CALLER gave up; the connection was never the problem",
			got)
	}
}
