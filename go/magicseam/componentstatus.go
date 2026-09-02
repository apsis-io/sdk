// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import "strings"

// The component-status handshake frame (ADR-0060 decision 5), Go side.
//
// Mirrors trail's status frame. Reimplemented rather than shared
// because the encoding is deliberately trivial - one split on a tab - and a
// shared codec across a Rust/Go boundary would cost more than it saves for two
// fields. The pairing that matters is the TESTS: both sides assert the same
// round trips and the same no-opinion cases.
//
// # Why status is here and not on the call wire
//
// It rides the handshake as an optional trailing frame, after the capability
// frame. An opcode would have been the obvious choice and is a trap: the
// opcode's presence on the wire is gated on the streaming capability
// specifically, so a peer pair that negotiated status but not streaming would
// disagree about whether that byte exists and misframe every subsequent call.
// The handshake route inherits the compatible-extension pattern this protocol
// already used twice - served version, then caps, now status.

// ComponentState is a component's self-reported state, mirroring
// periapsis:component/status's `state` enum.
type ComponentState string

const (
	StateStarting ComponentState = "starting"
	StateReady    ComponentState = "ready"
	StateDegraded ComponentState = "degraded"
	StateFailed   ComponentState = "failed"
	StateStopping ComponentState = "stopping"
)

// Healthy reports whether this state should count as healthy to a puller.
//
// Only `ready`. `starting` is deliberately NOT healthy: a component still coming
// up has not claimed it can serve, and treating "not yet" as "yes" is how a
// rollout routes traffic at something that is not listening. `stopping` likewise
// - it has announced it is leaving.
func (s ComponentState) Healthy() bool {
	return s == StateReady
}

func knownState(t string) (ComponentState, bool) {
	switch ComponentState(t) {
	case StateStarting, StateReady, StateDegraded, StateFailed, StateStopping:
		return ComponentState(t), true
	default:
		return "", false
	}
}

// ComponentStatus is a decoded status frame.
type ComponentStatus struct {
	State  ComponentState
	Reason string
}

// Encode renders the frame: the state token, optionally followed by a TAB and a
// free-text reason. Tab-separated rather than comma because the reason is human
// text that will contain commas, and the capability frame one position earlier
// already owns the comma.
func (c ComponentStatus) Encode() []byte {
	if c.Reason == "" {
		return []byte(c.State)
	}

	return []byte(string(c.State) + "\t" + c.Reason)
}

// DecodeComponentStatus parses a status frame.
//
// Returns ok=false for an empty frame and for an unrecognised state token. Both
// mean "NO OPINION", never "unhealthy":
//
//   - empty: the provider predates this frame, or its guest exports no status.
//     Marking those unhealthy would take out every provider built before it.
//   - unknown token: matches how capabilities treat unknown tokens. Failing over
//     a state this build has not heard of would make adding one a breaking
//     change, which is the thing the frame format exists to avoid.
func DecodeComponentStatus(frame []byte) (ComponentStatus, bool) {
	s := strings.TrimSpace(string(frame))
	if s == "" {
		return ComponentStatus{}, false
	}
	token, reason, _ := strings.Cut(s, "\t")
	state, ok := knownState(strings.TrimSpace(token))
	if !ok {
		return ComponentStatus{}, false
	}

	return ComponentStatus{State: state, Reason: strings.TrimSpace(reason)}, true
}
