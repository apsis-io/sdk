// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

// RE-DIAL A SEAM PROVIDER WHOSE CONNECTION HAS DIED.
//
// The Go port of trail's quicheal.rs, deliberately matching its semantics
// decision for decision - the two are consumers of the same protocol and a
// consumer that heals differently depending on its language is a debugging trap.
//
// # Why QUICClient does not do this itself
//
// A QUIC connection failure is terminal for the WHOLE multiplexed connection:
// every in-flight stream fails together. So a client that silently replaced its
// own connection would be swapping it out from under calls that are still
// running on it. The repair has to happen a layer up, above a client that stays
// immutable and single-connection - which is why this wraps rather than extends.
//
// # The gap this closes
//
// Nothing on the Go side re-dialled. A provider restart stranded a Go consumer
// permanently, until the consumer itself restarted - and a provider restart is
// not exotic, it is what a rollout is. trail (Rust) has had this since
// quicheal.rs; the Go SDK never did.
//
// Today's Go consumers are short-lived probes (tools/seamstatus,
// internal/trailop's probers) that dial, ask, and exit, so they mostly do not
// live long enough to notice. That is a property of the current callers, not of
// the SDK, and it stops being true the first time anything long-lived dials from
// Go.
//
// # What it deliberately does NOT do
//
//   - Retry an application answer. ErrRejected, ErrTooLarge and ErrUnavailable
//     all mean the provider was REACHED and answered. Redialling turns a refusal
//     into a retry storm against a provider that is working correctly - and an
//     armed barrier answers exactly this way, so healing on it would fight a
//     coordinated checkpoint.
//   - Skip the version gate. A redial goes through the same dial function, which
//     re-applies the handshake's version check. A provider that came back
//     serving something incompatible must not be adopted silently through a
//     healing path - that is a downgrade nobody asked for.
//   - Redial concurrently. One at a time; callers arriving mid-heal wait and
//     then use whatever it produced. Otherwise one provider blip has every
//     in-flight call open its own connection.
//   - Retry more than once. If the fresh connection also fails, the answer is
//     the error. Looping here hides a genuinely down provider behind a call that
//     never returns.

// HealingClient wraps a QUICClient and replaces its connection when it dies.
//
// Safe for concurrent use. Call is the only operation that heals; the accessors
// report the CURRENT connection's negotiated state, which changes across a heal.
type HealingClient struct {
	// mu guards inner. Readers take a snapshot so a call in flight keeps the
	// connection it started on rather than having one swapped underneath it.
	mu    sync.RWMutex
	inner *QUICClient

	// redial serialises heals, held across the whole dial so that concurrent
	// failures produce ONE new connection rather than one each.
	redial sync.Mutex

	// dial produces a fresh client. A closure rather than stored cert paths so
	// the healing logic never re-implements dialling - it re-runs whatever the
	// caller used originally, including its version gate.
	dial func(context.Context) (*QUICClient, error)

	// closed latches on Close so a later Call cannot RESURRECT this client.
	//
	// Without it, healing defeats Close: the call after a Close fails with a
	// transport error, which is exactly the shape heal exists to repair, so it
	// would dial a fresh connection to a provider the caller had finished with.
	// A "closed" client that silently reopens a connection leaks one and gives
	// shutdown no way to be final.
	closed atomic.Bool
}

// NewHealingClient wraps an already-dialled client. dial must produce an
// equivalent connection to the same provider, applying the same version
// requirement - it is what a heal re-runs.
func NewHealingClient(initial *QUICClient, dial func(context.Context) (*QUICClient, error)) *HealingClient {
	return &HealingClient{inner: initial, dial: dial}
}

// DialQUICHealing dials a provider and wraps it so later transport failures
// re-dial the same address with the same version requirement.
//
// Uses DialQUICEarly for both the initial dial and every heal: a heal is a fresh
// connection on a hot path with a caller blocked on it, which is precisely where
// 0-RTT pays (quic0rtt.go).
func DialQUICHealing(ctx context.Context, addr, certPath, keyPath, caPath, requiredVersion string) (*HealingClient, error) {
	dial := func(dctx context.Context) (*QUICClient, error) {
		return DialQUICEarly(dctx, addr, certPath, keyPath, caPath, requiredVersion)
	}
	initial, err := dial(ctx)
	if err != nil {
		return nil, err
	}

	return NewHealingClient(initial, dial), nil
}

// snapshot returns the current client without holding the lock across the call.
func (h *HealingClient) snapshot() *QUICClient {
	h.mu.RLock()
	defer h.mu.RUnlock()

	return h.inner
}

// isProviderAnswer reports whether err is the provider REFUSING rather than the
// connection failing. These must never trigger a redial.
func isProviderAnswer(err error) bool {
	return errors.Is(err, ErrRejected) ||
		errors.Is(err, ErrTooLarge) ||
		errors.Is(err, ErrUnavailable) ||
		errors.Is(err, ErrVersionRejected)
}

// Call makes one seam call, healing once if the connection has died.
func (h *HealingClient) Call(ctx context.Context, request []byte) ([]byte, error) {
	if h.closed.Load() {
		return nil, ErrClosed
	}
	stale := h.snapshot()
	reply, err := stale.Call(ctx, request)
	if err == nil || isProviderAnswer(err) {
		return reply, err
	}
	// A cancelled or expired CALLER context is not a dead connection. Redialling
	// on it would spend a fresh handshake to answer a caller that has already
	// given up, and the dial would immediately fail on the same context anyway.
	if ctx.Err() != nil {
		return nil, err
	}

	fresh, healErr := h.heal(ctx, stale)
	if healErr != nil {
		return nil, healErr
	}

	return fresh.Call(ctx, request)
}

// heal replaces stale with a fresh connection, or returns the dial's error.
//
// Returns the CURRENT client when another goroutine already healed past stale,
// so a blip that fails N concurrent calls costs one redial rather than N.
func (h *HealingClient) heal(ctx context.Context, stale *QUICClient) (*QUICClient, error) {
	h.redial.Lock()
	defer h.redial.Unlock()

	// Identity, not equality: someone else may have swapped the connection while
	// this goroutine waited for the lock, in which case their fresh one is the
	// answer and dialling again would discard it.
	if current := h.snapshot(); current != stale {
		return current, nil
	}
	// Re-check under the redial lock: Close can land between Call's check and
	// here, and dialling then would reopen a connection for a closed client -
	// the exact resurrection the latch exists to prevent.
	if h.closed.Load() {
		return nil, ErrClosed
	}

	fresh, err := h.dial(ctx)
	if err != nil {
		return nil, err
	}

	h.mu.Lock()
	h.inner = fresh
	h.mu.Unlock()

	// The dead connection still holds a UDP socket and quic-go's per-connection
	// goroutines. Closing after the swap, so no arriving caller can pick it up.
	_ = stale.Close()

	return fresh, nil
}

// Served reports the CURRENT connection's provider version. It can change across
// a heal - a provider that restarted may serve a different (still compatible)
// version, and reporting the version this client dialled with originally would
// be a stale answer that looks authoritative.
func (h *HealingClient) Served() string { return h.snapshot().Served }

// PeerCaps reports the CURRENT connection's advertised capabilities. Consult it
// again after a heal rather than caching: a restarted provider can legitimately
// come back advertising less (a rollback), and acting on the pre-heal list would
// call an op the peer no longer serves.
func (h *HealingClient) PeerCaps() []string { return h.snapshot().PeerCaps }

// Used0RTT reports whether the CURRENT connection resumed with early data.
func (h *HealingClient) Used0RTT() bool { return h.snapshot().Used0RTT() }

// Close ends the current connection and permanently disables healing.
//
// A Call after Close returns ErrClosed rather than dialling: see the closed
// field for why a healing client MUST latch this, and TestAClosedClientDoesNotHeal
// for the guard.
func (h *HealingClient) Close() error {
	h.closed.Store(true)

	return h.snapshot().Close()
}

// ErrClosed reports a Call on a HealingClient whose Close has already run.
var ErrClosed = errors.New("magicseam: client is closed")
