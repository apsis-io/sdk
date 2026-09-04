// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! ***THE PROGRAM'S OWN BOUND ON A PARK, DECLARED ONCE AND COMPILED IN.***
//!
//! A Perseid that parks is asleep until its condition fires. If that condition
//! is too narrow, or a watch is dropped, the only thing that ever wakes it again
//! is the backstop - so every park has one, and this is how a program states its
//! own instead of taking the host's.
//!
//! # Where it lives, and why it is not a field on the object
//!
//! It was `spec.maxSleepMs` until 2026-09-04 and is now a wasm custom section on
//! the artifact. The bound is not an operator dial: it does not pace apiserver
//! load (the poll interval does, separately), it only decides how long a program
//! that missed a wake stays missed - the same standing Kubernetes' resync
//! interval has, which is a compile-time decision by whoever wrote the
//! controller.
//!
//! **And it could not go in the park expression**, which was tried first. A
//! resume is assembled at RUNTIME, so admission never sees one: a bound written
//! there is invisible until the first park, and the point is to refuse a bad one
//! before a pod exists. A custom section is the only carrier that is both
//! compiled into the program and readable at inspection.
//!
//! # How it reaches the host
//!
//! ```text
//! radiant:backstop  ->  trail --inspect  ->  ComponentManifest status.backstop
//!                   ->  admission, and the park's actual bound
//! ```
//!
//! The section is attached to the built COMPONENT, after componentization.
//!
//! ⚠ **`#[link_section]` IS NOT OFFERED HERE, AND THE OMISSION IS DELIBERATE.**
//! It would be the nicer authoring experience - the declaration sits in the
//! source rather than in a build step - but a `#[link_section]` static lands in
//! the CORE MODULE, and a component embeds that module one level down. trail
//! reads custom sections at **depth 0 only**, on purpose: it must not pick up a
//! section from a nested module some dependency dragged in. Whether the
//! toolchain hoists it is untested here, so this crate ships the mechanism that
//! is MEASURED - appending to the finished component, verified 2026-09-04 by
//! reading a real component back through `trail --inspect` - rather than a macro
//! that may compile, emit nothing readable, and report a program as having
//! declared no bound.

/// The wasm custom section carrying the bound. **A NAME, so a `const`.**
pub const BACKSTOP_SECTION: &str = "radiant:backstop";

/// The host's bound when a program declares none.
///
/// **Exported so a program can say "this is fine" explicitly.** Declaring
/// [`DEFAULT_BACKSTOP_MS`] is not the same as declaring nothing: the first is a
/// decision and the second is a program nobody has thought about, and only a
/// build that can tell them apart can warn about the second.
pub const DEFAULT_BACKSTOP_MS: u64 = 300_000;

/// A declared park bound, and the section payload that carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backstop {
    ms: u64,
}

/// The bound was not usable. Every arm here is refused by `trail` at decode too;
/// catching it in the build is the same refusal, moved to where the author is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackstopError {
    /// A park bounded by zero expires at the instant it begins, so the program
    /// never actually waits. It is also exactly what an unset integer field
    /// serialises as, which is why it refuses rather than defaulting.
    Zero,
}

impl core::fmt::Display for BackstopError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Zero => write!(
                f,
                "`{BACKSTOP_SECTION}` is 0; a park bounded by zero expires the moment it \
                 begins, so the program would never wait. Omit the declaration to take the \
                 host's default of {DEFAULT_BACKSTOP_MS}ms"
            ),
        }
    }
}

impl Backstop {
    /// Declare a bound in milliseconds.
    ///
    /// **A DURATION, never a deadline** - the only form a constant can take,
    /// since an absolute instant is a fact about a moment and a program compiled
    /// on Tuesday cannot carry Wednesday's. The host turns it into an instant at
    /// park time.
    pub fn millis(ms: u64) -> Result<Self, BackstopError> {
        if ms == 0 {
            return Err(BackstopError::Zero);
        }

        Ok(Self { ms })
    }

    /// Declare a bound in seconds.
    pub fn seconds(s: u64) -> Result<Self, BackstopError> {
        Self::millis(s.saturating_mul(1000))
    }

    /// The declared bound in milliseconds.
    pub fn as_millis(&self) -> u64 {
        self.ms
    }

    /// The section payload: `{"ms": <n>}`.
    ///
    /// The OBJECT form rather than a bare number, though `trail` accepts both -
    /// it is the shape with room for per-declaration metadata later, which is
    /// the same argument the roles section records for choosing JSON at all.
    pub fn payload(&self) -> Vec<u8> {
        format!(r#"{{"ms":{}}}"#, self.ms).into_bytes()
    }

    /// Append this declaration to a built component as a TOP-LEVEL custom
    /// section.
    ///
    /// A wasm custom section is `0x00 <leb size> <leb name-len> <name> <data>`,
    /// and a component is a wasm container - so a section appended at the end is
    /// a top-level section, which is what trail reads.
    pub fn attach(&self, component: &[u8]) -> Vec<u8> {
        let name = BACKSTOP_SECTION.as_bytes();
        let payload = self.payload();

        let mut body = Vec::with_capacity(name.len() + payload.len() + 4);
        leb128(name.len() as u64, &mut body);
        body.extend_from_slice(name);
        body.extend_from_slice(&payload);

        let mut out = Vec::with_capacity(component.len() + body.len() + 8);
        out.extend_from_slice(component);
        out.push(0x00);
        leb128(body.len() as u64, &mut out);
        out.extend_from_slice(&body);

        out
    }
}

/// Unsigned LEB128, the length encoding every wasm section header uses.
fn leb128(mut n: u64, out: &mut Vec<u8>) {
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);

            return;
        }
        out.push(b | 0x80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The payload is the one `trail`'s `decode_backstop` parses.
    #[test]
    fn the_payload_is_the_object_form() {
        let b = Backstop::seconds(60).unwrap();
        assert_eq!(b.as_millis(), 60_000);
        assert_eq!(b.payload(), br#"{"ms":60000}"#.to_vec());
    }

    /// ***ZERO REFUSES, AND IT IS THE ONE A GENERATOR PRODUCES.*** An unset
    /// integer field serialises as exactly this, so defaulting it would turn a
    /// forgotten value into a park that ends the instant it begins.
    #[test]
    fn zero_refuses_and_says_why() {
        let err = Backstop::millis(0).unwrap_err();
        assert_eq!(err, BackstopError::Zero);
        let msg = format!("{err}");
        assert!(
            msg.contains(BACKSTOP_SECTION),
            "the error must name the section: {msg}"
        );
        assert!(msg.contains("expires the moment it begins"), "{msg}");
    }

    /// ***THE SECTION FRAMING, BYTE FOR BYTE.*** Get any of it wrong and the
    /// component still LOADS - a malformed trailing section is the one kind of
    /// corruption a runtime may ignore - while trail reports the bound as
    /// ABSENT, which reads as "this program declared none". Silent, and in the
    /// reassuring direction.
    #[test]
    fn the_appended_section_has_the_shape_trail_reads() {
        let stub = [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];
        let out = Backstop::millis(60_000).unwrap().attach(&stub);

        assert_eq!(
            &out[..stub.len()],
            &stub,
            "the component's own bytes must be untouched"
        );
        let tail = &out[stub.len()..];
        assert_eq!(tail[0], 0x00, "custom-section id");

        let body = &tail[2..];
        assert_eq!(body[0] as usize, BACKSTOP_SECTION.len());
        assert_eq!(
            &body[1..1 + BACKSTOP_SECTION.len()],
            BACKSTOP_SECTION.as_bytes()
        );
        assert_eq!(&body[1 + BACKSTOP_SECTION.len()..], br#"{"ms":60000}"#);

        // The declared size must cover exactly the body, or every later section
        // is misframed - which is how a runtime comes to skip the tail silently.
        assert_eq!(tail[1] as usize, body.len());
    }

    /// A section over 127 bytes crosses into multi-byte LEB, which a small
    /// fixture never reaches - and a wrong encoding there frames the section
    /// short, so it again reads as "declared none".
    #[test]
    fn leb128_is_multi_byte_past_127() {
        let mut out = Vec::new();
        leb128(217, &mut out);
        assert_eq!(out, vec![0xd9, 0x01]);

        let mut one = Vec::new();
        leb128(127, &mut one);
        assert_eq!(
            one,
            vec![0x7f],
            "127 is still one byte - the boundary, not past it"
        );
    }

    /// ***THESE EXACT BYTES WERE READ BACK BY A REAL `trail --inspect`.***
    ///
    /// Every other test here asserts the framing against my own reading of the
    /// wasm spec, which is the same source the implementation came from - so
    /// they would all agree with each other about a wrong encoding. This one
    /// does not: it is a transcript.
    ///
    /// Provenance, 2026-09-04: the TS SDK's `attachBackstop` appended a bound to
    /// `magic-0.1.0.wasm`, a real component; `trail --inspect` reported
    /// `backstop = 90000`; `wasm-tools validate` still passed. These are the
    /// section bytes from that file, and the Rust SDK reproduces them EXACTLY -
    /// which is what makes two producers for one consumer safe.
    ///
    /// If this fails, the two SDKs have drifted and one of them is emitting a
    /// section trail will read as absent - silently, in the reassuring
    /// direction, since a component with a malformed trailing section still
    /// loads and simply reports no bound.
    #[test]
    fn the_bytes_are_the_ones_trail_actually_read() {
        let want: &[u8] = &[
            0x00, 0x1d, 0x10, // custom-section id, size 29, name length 16
            b'r', b'a', b'd', b'i', b'a', b'n', b't', b':', //
            b'b', b'a', b'c', b'k', b's', b't', b'o', b'p', //
            b'{', b'"', b'm', b's', b'"', b':', b'9', b'0', b'0', b'0', b'0', b'}',
        ];
        assert_eq!(Backstop::seconds(90).unwrap().attach(&[]), want);
    }
}
