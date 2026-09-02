// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The Perseid vocabulary for Rust guests.
//!
//! A Perseid program is a TOTAL step: it observes, concludes, and either yields,
//! terminates, or parks on a condition that would change its mind (ADR-0075).
//! This crate is the half of that which is pure vocabulary - canonical apiserver
//! paths, the aperture expression language, and resume conditions.
//!
//! ```
//! use perseid::{path, resume};
//!
//! let deployment = path::ns("default").deployments("api");
//! // Parked on what the step actually READ, derived from the path it read.
//! let wake = resume::until_drift(&deployment, 2).unwrap();
//! assert_eq!(
//!     wake.as_str(),
//!     r#"Get("/apis/apps/v1/namespaces/default/deployments/api", "spec.replicas") != 2"#
//! );
//! ```
//!
//! # What this crate deliberately does not contain
//!
//! ***NO WIT BINDINGS AND NO RUNTIME, WHICH IS THE SAME CALL `seamwire` MAKES
//! AND FOR THE SAME REASON.*** A Rust Perseid may be a `wit-bindgen` reactor, a
//! test harness with a fake world, or a program built against a future binding;
//! a `wit-bindgen` version pinned here would be inherited by every one of them
//! and would make this crate's compatibility a function of a dependency it has
//! no opinion about. What it knows is the LANGUAGE, and the language has no
//! runtime.
//!
//! The step machinery - the effect union, the exhaustive matcher, `run_step` -
//! is a separate question, because Rust reaches those properties by different
//! means than the TypeScript SDK does (enums and `match` rather than a generator
//! and an arms object). It is deliberately not guessed at here.
//!
//! # The agreement with the host is tested, not asserted
//!
//! The guest builds these expressions and the host parses them; the two are
//! written in different languages and cannot import each other. So
//! `periapsis's aperture`'s test suite reads THIS SOURCE and checks that every
//! symbol aperture types is constructed here, with a matching arity, and that
//! effectful symbols are the ones typed `Expr<Effect>`. A drift is a Go test
//! failure rather than a silently dropped write.

#![forbid(unsafe_code)]

pub mod expr;
pub mod path;
pub mod resume;

pub use path::ApiPath;
pub use resume::Resume;
