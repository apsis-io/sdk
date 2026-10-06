// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

use crate::expr::{self as e, Bool, Expr, ScalarValue};
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

/// Wake when AT LEAST ONE pod matches `selector`.
///
/// ***THE SELECTOR IS A LITERAL BY CONSTRUCTION***: the host's static walk
/// extracts subjects from literals, and a selector hidden behind an object is
/// the `PodsOf` shape the language declined - such a park would poll while
/// looking subscribed. Count forms only: a string-field quantifier does not
/// exist yet, and adding one is a language change coordinated with the host's
/// fingerprint, not a local edit. Pair with a root guard on the workload that
/// supplied the selector ([`field_no_longer`] on `metadata.generation` - the
/// selector is a map and a scalar comparison over it reads UNKNOWN).
#[must_use]
pub fn any_pods(selector: &str) -> Resume {
    e::gt(e::length(&e::list_pods(selector)), 0)
}

/// Wake when NO pod matches `selector` - the drained half of [`any_pods`],
/// under the same literal-selector contract and root-guard pairing.
#[must_use]
pub fn no_pods(selector: &str) -> Resume {
    e::eq(e::length(&e::list_pods(selector)), 0)
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

/// Wake when a STRING or BOOLEAN field becomes `value` - the scalar sibling of
/// [`field_ne`], for a phase, an annotation, `spec.unschedulable`.
///
/// ***FALSE RATHER THAN TRUE WHILE THE FIELD IS ABSENT***: an absent operand
/// propagates as unknown and a park holds unless its condition is true, which
/// is the direction an "until the drain flag appears" park wants.
#[must_use]
pub fn field_is(path: &ApiPath, field: &str, value: impl ScalarValue) -> Resume {
    e::eq_scalar(&e::get(path, field), value)
}

/// The value an edge field held when the step read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldValue<'a> {
    /// A string edge - a name, a phase, an annotation.
    Str(&'a str),
    /// A boolean edge - a flag, `spec.unschedulable`.
    Bool(bool),
    /// A numeric edge - the shape Kubernetes omits at zero, which is why the
    /// guard is `field_no_longer` rather than a bare comparison.
    Int(i64),
}

/// Wake when a field STOPS being `value` - including by being DELETED.
///
/// ***THE `!exists` HALF IS THE WHOLE POINT AND A BARE `!=` IS A BUG HERE.***
/// Removing the field makes it ABSENT; `absent != "x"` evaluates to UNKNOWN,
/// not true, so a plain inequality never fires on the withdrawal it was
/// written to catch, and the program waits out its backstop - correct, late,
/// and looking subscribed the whole time. The host narrows to the field before
/// evaluating, so a missing one is absent rather than unknown, which is what
/// makes the `.exists` arm expressible at all.
#[must_use]
pub fn field_no_longer(path: &ApiPath, field: &str, value: FieldValue<'_>) -> Resume {
    e::or(&[
        e::not(&e::exists(&e::get(path, field))),
        match value {
            FieldValue::Str(s) => e::ne_scalar(&e::get(path, field), s),
            FieldValue::Bool(b) => e::ne_scalar(&e::get(path, field), b),
            FieldValue::Int(n) => e::ne(e::get(path, field), n),
        },
    ])
}

/// One edge of a multi-hop chain, as the step observed it while awake: the
/// object whose edge field was read, the field that named the next object, and
/// the value that field held.
pub struct Hop<'a> {
    /// The hop's SOURCE - e.g. the Pod, not the PVC it points at.
    pub path: &'a ApiPath,
    /// The edge field that named the next object.
    pub field: &'a str,
    /// What that field held - the name of the next hop in the chain.
    pub value: FieldValue<'a>,
}

/// Wake when `target` holds AND every edge of the traced chain still points
/// where the step observed it - the PINNED TRACE for a multi-hop chain
/// (Pod -> PVC -> PV), authored entirely from what the step resolved while it
/// was awake.
///
/// ***LAYER 1, DELIBERATELY.*** Every hop is an ordinary [`field_no_longer`]
/// guard over a LITERAL path, so the host's static walk subscribes the step to
/// every object in the chain and the host grows no symbol. And the guards are
/// [`field_no_longer`], NOT [`field_is`], on purpose - that difference is
/// liveness, not style: a bare `==` goes UNKNOWN when a hop's object is
/// deleted and the conjunction never fires, so the park sleeps through the
/// very edit that invalidates the trace. The `!exists` arm makes deletion WAKE
/// the program, which re-traces on its next pass.
pub fn pinned(hops: &[Hop<'_>], target: Resume) -> Resume {
    let mut parts: Vec<Resume> = hops
        .iter()
        .map(|h| field_no_longer(h.path, h.field, h.value))
        .collect();
    parts.push(target);
    e::and(&parts)
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
        assert_eq!(
            field_is(&path::ns("default").pods("web"), "status.phase", "Running").as_str(),
            r#"Get("/api/v1/namespaces/default/pods/web", "status.phase") == "Running""#
        );
        assert_eq!(
            any_pods("app=frontend").as_str(),
            r#"ListPods("app=frontend").length > 0"#
        );
        assert_eq!(
            no_pods("app=frontend").as_str(),
            r#"ListPods("app=frontend").length == 0"#
        );
    }

    #[test]
    fn field_no_longer_fires_on_the_withdrawal_a_bare_ne_misses() {
        let pvc = path::ns("default").core("v1", "persistentvolumeclaims", "data-vol");
        assert_eq!(
            field_no_longer(&pvc, "spec.volumeName", FieldValue::Str("pv-1")).as_str(),
            format!(
                r#"(!Get("{pvc}", "spec.volumeName").exists) || (Get("{pvc}", "spec.volumeName") != "pv-1")"#
            )
        );
    }

    // ***THE GOLDEN IS THE TS SDK'S GOLDEN, BYTE FOR BYTE.*** The host parses
    // one grammar and `rustsdk_test.go` runs this text through the real
    // parser, so the two producers must not merely agree in shape but in text.
    #[test]
    fn pinned_emits_the_same_text_as_the_ts_sdk() {
        let pod = path::ns("default").pods("app-1");
        let pvc = path::ns("default").core("v1", "persistentvolumeclaims", "data-vol");
        let pv = path::cluster_core("v1", "persistentvolumes", "pvc-84df12");
        let claim = "spec.volumes[?name=data].persistentVolumeClaim.claimName";

        let trace = pinned(
            &[
                Hop {
                    path: &pod,
                    field: claim,
                    value: FieldValue::Str("data-vol"),
                },
                Hop {
                    path: &pvc,
                    field: "spec.volumeName",
                    value: FieldValue::Str("pvc-84df12"),
                },
            ],
            field_is(&pv, "status.phase", "Bound"),
        );

        assert_eq!(
            trace.as_str(),
            format!(
                r#"((!Get("{pod}", "{claim}").exists) || (Get("{pod}", "{claim}") != "data-vol")) && ((!Get("{pvc}", "spec.volumeName").exists) || (Get("{pvc}", "spec.volumeName") != "pvc-84df12")) && (Get("{pv}", "status.phase") == "Bound")"#
            )
        );

        // The liveness proof: every hop arm carries the `!exists` half, so a
        // deleted hop wakes a re-trace instead of silencing the park.
        let guards: Vec<&str> = trace.as_str().split(" && ").collect();
        assert_eq!(guards.len(), 3);
        for g in &guards[..2] {
            assert!(g.contains(".exists"), "hop guard without the exists arm: {g}");
            assert!(g.contains("||"), "hop guard without the deletion arm: {g}");
        }
    }

    #[test]
    fn the_set_park_root_guards_the_workload_that_supplied_the_selector() {
        let dep = path::ns("default").deployments("frontend");
        let composed = all_of(&[
            field_no_longer(&dep, "metadata.generation", FieldValue::Int(5)),
            any_pods("app=frontend"),
        ]);
        assert_eq!(
            composed.as_str(),
            format!(
                r#"((!Get("{dep}", "metadata.generation").exists) || (Get("{dep}", "metadata.generation") != 5)) && (ListPods("app=frontend").length > 0)"#
            )
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
        assert_eq!(
            until_drift(&d, 2).unwrap(),
            field_ne(&d, "spec.replicas", 2)
        );
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
