// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Package magicseam is the TinyGo (WASM guest) SDK for the magic seam
// (ADR-0028, periapsis:magic/handler) - the Go counterpart to the Rust examples'
// `impl Guest for ... { async fn handle }`, for a program compiled by TinyGo into
// a WASM component that acts as a magic-seam PROVIDER or CONSUMER inside trail.
//
// This is the WASM-GUEST side, distinct from sdk/go/magicseam (a non-WASM Go
// program serving the seam over a real socket / QUIC).
//
// # ASYNC GAP (read this)
//
// The seam's handle() is `async func` in the WIT (component-model-async, P3) as
// of 2026-07-16. TinyGo / wit-bindgen-go have NO async-component-model support
// today - that is Rust wit-bindgen + experimental wasmtime only (see
// done/2026-07-16_tinygo-sdk-blocked.md). So the actual WIT binding glue -
// generating the periapsis:magic/handler bindings and wiring a Handler to the
// component's async export (provider) or calling the async import (consumer) - is
// deliberately NOT in this package yet: TinyGo cannot compile it.
//
// What IS here is the language-neutral, non-async surface a guest needs
// regardless of the ABI: the Handler contract, the seam's `error` variant as Go
// sentinels, and the Go-error <-> seam-error mapping in BOTH directions. Guest
// code written against these is correct and unchanged when the binding lands -
// the future generated export glue calls SeamError to translate a Handler's
// error into the component-model result, and a consumer wrapper calls
// FromSeamError to turn a seam error back into a Go error. This package compiles
// with plain `go build` today (no TinyGo/wit-bindgen needed) precisely because it
// omits the async glue.
//
// Unblock: TinyGo/wit-bindgen-go gaining async support, or a deliberate sync
// guest-facing seam WIT variant. Until then, this is a ready scaffold, not a
// runnable component's binding.
package magicseam

import "errors"

// Handler processes one magic-seam call for a PROVIDER guest: request bytes in,
// response bytes out. A returned error maps to the seam's `error` variant -
// Unavailable by default (transport-neutral, fail-closed), or Rejected/TooLarge
// when the error is (or wraps) ErrRejected/ErrTooLarge (matched via errors.Is, so
// a wrapped sentinel still selects its tag). Mirrors sdk/go/magicseam.Handler and
// the Rust `async fn handle(Vec<u8>) -> Result<Vec<u8>, Error>` guests.
type Handler func(request []byte) (response []byte, err error)

// The seam's error variant (periapsis:magic/handler's `error`: unavailable /
// rejected / too-large) as Go sentinels. A Handler returns ErrRejected/ErrTooLarge
// (or a wrap) to select those tags; anything else is Unavailable, the fail-closed
// default. A consumer sees these back from FromSeamError.
var (
	ErrUnavailable = errors.New("magicseam: unavailable")
	ErrRejected    = errors.New("magicseam: rejected")
	ErrTooLarge    = errors.New("magicseam: too large")
)

// SeamError maps a Handler-returned error to the seam `error` variant string the
// component-model result carries, so the (future) async export glue translates a
// Go error without duplicating this logic. Mirrors sdk/go/magicseam's tagFor
// exactly. A nil error is not a seam error (the call succeeded): SeamError(nil)
// returns ("", false).
func SeamError(err error) (variant string, isErr bool) {
	switch {
	case err == nil:
		return "", false
	case errors.Is(err, ErrRejected):
		return "rejected", true
	case errors.Is(err, ErrTooLarge):
		return "too-large", true
	default:
		return "unavailable", true
	}
}

// FromSeamError is SeamError's inverse for a CONSUMER guest: it turns the seam
// `error` variant string returned by a handle() call into the matching Go
// sentinel (usable with errors.Is), so consumer code branches on the same
// ErrUnavailable/ErrRejected/ErrTooLarge everything else uses. An unknown variant
// falls back to ErrUnavailable (fail-closed).
func FromSeamError(variant string) error {
	switch variant {
	case "rejected":
		return ErrRejected
	case "too-large":
		return ErrTooLarge
	default:
		return ErrUnavailable
	}
}
