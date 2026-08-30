// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Resume conditions - why a quiesced step should be woken.
//!
//! A resume is DATA: the host evaluates it WITHOUT running the step, which is
//! what lets radiant index parked programs by what they wait on and show an
//! operator why one is asleep.
//!
//! # The type is the safety property
//!
//! [`Resume`] is `Expr<Bool>`, so an effect - `ensure(..)`, an ordinary
//! expression in the same language - is a compile error in a wake condition.
//! That is the host's `CheckPure` rule, moved to the build.

use crate::expr::{self as e, Bool, Expr};
use crate::path::ApiPath;

/// A wake condition.
pub type Resume = Expr<Bool>;

/// Wake when an object EXISTS - or, if it does, when it stops existing.
///
/// Any kind: the path says which. `Get`'s field is `metadata.name`, which every
/// object has and which is therefore ABSENT exactly when the object is.
#[must_use]
pub fn object_exists(path: &ApiPath) -> Resume {
    e::exists(&e::get(path, "metadata.name"))
}

/// Wake when an object is GONE.
#[must_use]
pub fn object_gone(path: &ApiPath) -> Resume {
    e::not(&e::exists(&e::get(path, "metadata.name")))
}

/// Wake when the number of pods matching a selector stops being `n`.
///
/// Prefer [`field_ne`] on the field a scaler maintains: a pod census is a
/// lagging, flapping proxy for it. It passes through values nobody set during a
/// rollout, a crashlooping pod moves it without any spec change, and a spec
/// change to the SAME count is invisible to it.
#[must_use]
pub fn count_ne(selector: &str, n: i64) -> Resume {
    e::ne(e::length(&e::list_pods(selector)), n)
}

/// Wake when the pod census stops matching a workload's desired replica count.
///
/// Both sides are observations rather than one being a literal the guest already
/// knew - a shape that only became expressible once aperture grew types and
/// arithmetic, because the right-hand side is not a constant.
#[must_use]
pub fn count_ne_field(selector: &str, workload: &ApiPath) -> Resume {
    e::ne(
        e::length(&e::list_pods(selector)),
        e::get(workload, "spec.replicas"),
    )
}

/// Wake when a field of an object stops being `n`.
///
/// **PARK ON THE FIELD YOU MAINTAIN.** `spec.replicas` is the field a scaler
/// writes, and parking on it is what makes a level-triggered program
/// level-triggered - it wakes on a spec change nobody's pods have reflected yet.
#[must_use]
pub fn field_ne(path: &ApiPath, field: &str, n: i64) -> Resume {
    e::ne(e::get(path, field), n)
}

/// Wake at an ABSOLUTE deadline, in epoch milliseconds.
///
/// Takes the INSTANT, not a delay. A delay would have to be added to a clock
/// this crate cannot read - `Now()` is a host capability, not a syscall - and
/// resolving it guest-side would bake in the moment the expression was BUILT
/// rather than the moment the step decided to park.
#[must_use]
pub fn deadline(at_epoch_millis: i64) -> Resume {
    e::ge(e::now(), at_epoch_millis)
}

/// Wake if ANY condition holds.
#[must_use]
pub fn any_of(of: &[Resume]) -> Resume {
    e::or(of)
}

/// Wake only if ALL conditions hold.
///
/// A conjunction of pure time bounds has nothing to watch and degrades to
/// polling; for a guaranteed wake put the deadline in an [`any_of`].
#[must_use]
pub fn all_of(of: &[Resume]) -> Resume {
    e::and(of)
}

// ---------------------------------------------------------------------------
// DERIVING A RESUME FROM WHAT THE STEP ACTUALLY OBSERVED.
//
// ***A HAND-WRITTEN RESUME NAMES THE OBJECT A SECOND TIME, AND THE TWO SPELLINGS
// ARE NOT CHECKED AGAINST EACH OTHER.***
//
//     let deployment = path::ns("default").deployments("api");   // OBSERVED
//     let workload   = "api";                                    // PARKED ON
//     quiesce(replicas_ne(workload, want))
//
// `ApiPath` has no string constructor precisely so a path cannot be written by
// hand - and then the resume takes a bare NAME, which can. Change the path to
// `deployments("api-v2")` and the program observes the new deployment and parks
// on the old one: awake for changes it no longer reads, asleep through every
// change it does.
//
// ***THAT FAILURE IS INVISIBLE FROM BOTH SIDES.*** The step is correctly asleep
// on a well-formed condition, quiescing returns nothing to the guest, and the
// host cannot know the two were meant to agree. It is ADR-0075's "asleep on a
// condition nobody will satisfy", reached by an ordinary edit.
//
// So derive it: the path the step read IS the input, and there is no second
// spelling left to drift.

/// A path this crate has no resume derivation for.
///
/// Carries the path so the message can name it. Returned rather than panicking:
/// an expression built from a guess parses, evaluates, and watches the WRONG
/// OBJECT, which is the failure autoderivation exists to remove.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotDerivable {
    /// The path that could not be read.
    pub path: String,
}

impl core::fmt::Display for NotDerivable {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "{} is not a deployment path, so there is no replica count to watch. \
             Autoderivation covers deployments (the object `scale` writes); for anything \
             else name the condition explicitly - pod_exists, count_ne, deadline - so the \
             resume says what it means rather than being inferred wrongly.",
            self.path
        )
    }
}

impl core::error::Error for NotDerivable {}

/// The workload NAME an apiserver path addresses.
///
/// Exported because a resume often needs the name in more than one clause, and
/// deriving it twice from one path is still ONE source of truth - whereas a
/// `let workload = "api"` beside the path is a second one.
///
/// # Errors
///
/// [`NotDerivable`] if the path does not address a deployment.
pub fn workload_of(observed: &ApiPath) -> Result<&str, NotDerivable> {
    let s = observed.as_str();
    // Matched structurally rather than with a regex: this crate has no
    // dependencies, and the shape is fixed by the builder that produced it.
    let rest = s
        .strip_prefix("/apis/apps/v1/namespaces/")
        .ok_or_else(|| NotDerivable {
            path: s.to_string(),
        })?;
    let (_ns, tail) = rest.split_once('/').ok_or_else(|| NotDerivable {
        path: s.to_string(),
    })?;
    let name = tail
        .strip_prefix("deployments/")
        .ok_or_else(|| NotDerivable {
            path: s.to_string(),
        })?;
    // A further slash means a SUBRESOURCE (`.../scale`), which is a different
    // object than the one `Replicas` reads. Accepting it would build a resume
    // that watches the parent while claiming to watch the subresource.
    if name.is_empty() || name.contains('/') {
        return Err(NotDerivable {
            path: s.to_string(),
        });
    }

    Ok(name)
}

/// Wake when the object this step OBSERVED stops holding the value it SAW.
///
/// The two arguments are the observation itself: the path that was read and the
/// value that came back. Both are in hand at the moment a step decides to park,
/// so there is nothing to restate and nothing to keep in step.
///
/// ***IT PARKS ON WHAT IT SAW, NOT ON WHAT IT WANTED.*** At the moment of
/// quiescing those are equal - that is why the step quiesced - so the emitted
/// text is identical either way. What differs is that a target is the program's
/// own constant and cannot drift, while the observed value is a fact about the
/// cluster.
///
/// # Errors
///
/// [`NotDerivable`] if the observed path does not address a deployment.
pub fn until_drift(observed: &ApiPath, seen: i64) -> Result<Resume, NotDerivable> {
    // ***THE NAME IS DISCARDED AND THAT IS THE POINT.*** `workload_of` exists to
    // pull a NAME out of a path, because `Replicas` took a bare name and a park
    // therefore had to be re-addressed in a second vocabulary. `Get` takes the
    // path, so the round trip is gone - what is left of that function here is
    // its VALIDATION, which still matters: it refuses a path that does not
    // address a deployment, and refuses a subresource (`.../scale`), which is a
    // different object than the one this parks on.
    workload_of(observed)?;

    Ok(field_ne(observed, "spec.replicas", seen))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path;

    const DEP: &str = "/apis/apps/v1/namespaces/default/deployments/api";

    #[test]
    fn builders_emit_what_aperture_parses() {
        let d = path::ns("default").deployments("api");
        let pod = path::ns("default").pods("web");
        assert_eq!(
            object_exists(&pod).as_str(),
            r#"Get("/api/v1/namespaces/default/pods/web", "metadata.name").exists"#
        );
        assert_eq!(
            object_gone(&pod).as_str(),
            r#"!Get("/api/v1/namespaces/default/pods/web", "metadata.name").exists"#
        );
        assert_eq!(
            count_ne("app=api", 3).as_str(),
            r#"ListPods("app=api").length != 3"#
        );
        assert_eq!(
            field_ne(&d, "spec.replicas", 3).as_str(),
            format!(r#"Get("{DEP}", "spec.replicas") != 3"#)
        );
        assert_eq!(
            deadline(1_788_011_630_089).as_str(),
            "Now() >= 1788011630089"
        );
        assert_eq!(
            count_ne_field("app=api", &d).as_str(),
            format!(r#"ListPods("app=api").length != Get("{DEP}", "spec.replicas")"#)
        );
    }

    #[test]
    fn workload_of_reads_the_name_back_out_of_the_observed_path() {
        assert_eq!(
            workload_of(&path::ns("default").deployments("api")).unwrap(),
            "api"
        );
        assert_eq!(
            workload_of(&path::ns("kube-system").deployments("coredns")).unwrap(),
            "coredns"
        );
    }

    // A path this cannot read must not produce a plausible guess.
    #[test]
    fn workload_of_refuses_what_it_cannot_derive() {
        let pods = path::ns("default").pods("api-7d9f");
        let err = workload_of(&pods).unwrap_err();
        assert!(err.to_string().contains("not a deployment path"), "{err}");

        // A SUBRESOURCE addresses a different object than the parent.
        let scale = path::ns("default").resource("apps", "v1", "deployments", "api/scale");
        assert!(
            workload_of(&scale).is_err(),
            "a subresource path was accepted as its parent"
        );
    }

    // ***THE VALIDATION SURVIVED THE COLLAPSE, WHICH IS WORTH ITS OWN ARM.***
    // `until_drift` no longer USES the name `workload_of` returns - it parks on
    // the path directly - so the refusal is now reachable only through the call
    // whose result is discarded. A reader deleting that call as dead would
    // silently start accepting a pods path and emit a resume on `spec.replicas`
    // of a pod, which is absent forever: a program that never wakes.
    #[test]
    fn until_drift_still_refuses_a_path_that_is_not_a_deployment() {
        assert!(until_drift(&path::ns("default").pods("api-7d9f"), 2).is_err());
        assert!(
            until_drift(
                &path::ns("default").resource("apps", "v1", "deployments", "api/scale"),
                2
            )
            .is_err()
        );
    }

    // ***THE EQUIVALENCE ARM.*** Autoderivation is adoptable only if it emits
    // what a correct hand-written resume emitted; otherwise every parked
    // program's wake behaviour changes silently.
    #[test]
    fn until_drift_emits_exactly_what_the_hand_written_resume_emitted() {
        let d = path::ns("default").deployments("api");
        assert_eq!(until_drift(&d, 2).unwrap(), field_ne(&d, "spec.replicas", 2));
        assert_eq!(
            until_drift(&d, 2).unwrap().as_str(),
            format!(r#"Get("{DEP}", "spec.replicas") != 2"#)
        );
    }

    // ***THE ARM THAT IS THE WHOLE POINT.*** Under the old shape the path moved
    // and the resume did not; here they cannot move apart because there is only
    // one of them.
    #[test]
    fn until_drift_follows_the_path_when_the_path_changes() {
        let d = path::ns("default").deployments("api");
        let before = until_drift(&d, 2).unwrap();
        let after = until_drift(&path::ns("default").deployments("api-v2"), 2).unwrap();

        assert_ne!(before, after);
        assert!(after.as_str().contains("api-v2"));

        // The control showing the OLD shape really was broken: a resume written
        // against a stale name is UNCHANGED by the path moving, which is what
        // made the defect invisible.
        let hand_written = field_ne(&d, "spec.replicas", 2);
        assert_eq!(hand_written, before);
        assert_ne!(hand_written, after);
    }

    #[test]
    fn a_derived_resume_composes_with_explicit_clauses() {
        let d = path::ns("default").deployments("api");
        let composed = any_of(&[until_drift(&d, 2).unwrap(), count_ne_field("app=api", &d)]);
        assert_eq!(
            composed.as_str(),
            format!(
                r#"(Get("{DEP}", "spec.replicas") != 2) || (ListPods("app=api").length != Get("{DEP}", "spec.replicas"))"#
            )
        );
    }
}
