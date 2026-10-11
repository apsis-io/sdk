// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! A Perseid whose VERDICT is a component the operator wired at launch.
//!
//! The loop is the ordinary one - `read -> decide -> report -> park -> the
//! instance dies`. What is different is where the decision comes from: instead of
//! compiling the policy into the program, the step hands the subject to a child
//! component named `check` and reports what that child says. The operator swaps
//! the policy with `--exec-with check=<other>.wasm` and never rebuilds this.
//!
//! The allowlist is `spec.execWith` on the Perseid:
//!
//!     spec:
//!       execWith:
//!         check: /var/lib/apsis/wasm-exec/perseid-exec-checker.wasm
//!
//! ⛔ ***THAT FIELD DID NOT EXIST UNTIL 2026-09-08, AND THIS PROGRAM WAS WRITTEN
//! AGAINST ITS ABSENCE.*** `--exec-with` comes from the `trail.apsis/exec-with`
//! pod annotation and radiant builds a Perseid's pod itself, so there was no
//! route for an allowlist to reach a Perseid at all: `periapsis:host/exec` was
//! admissible in `spec.capabilities` and every `spawn` still returned
//! `not-allowed` - a capability you could be granted and could never use.
//!
//! ⚠ Paths are confined to `/var/lib/apsis/wasm-exec` and radiant refuses the
//! launch otherwise, because a Perseid author may not hold pod-create - see
//! `ExecWithRoot` in `internal/trailop/perseidpod.go` for the whole argument.
//!
//! ⛔ ***DECLARING NOTHING DOES NOT REACH THE `NoChecker` ARM ON THIS PATH - IT
//! FAILS AT INSTANTIATION*** (engi, 2026-09-08). trail's `step_linker` withholds
//! `periapsis:host/exec` from a Perseid's linker unless the allowlist is
//! non-empty, so an ungranted program importing exec is refused with *"a matching
//! implementation was not found in the linker"* before a pass runs. Loud on
//! purpose: a silent `not-allowed` is indistinguishable from "nobody wired a
//! checker".
//!
//! ⚠ ***THE ARM IS STILL LIVE, VIA THE CASE THAT MATTERS***: a non-empty
//! allowlist that does not contain THIS name - `spec.execWith` declares `audit`
//! and this program spawns `check` - links exec and returns `not-allowed`. A
//! misconfiguration to survive and report, not to crash on.
//!
//! (`cmd/trail/src/main.rs:1076` still describes the UNGATED behaviour, which is
//! what the two `main.rs` call sites do for ordinary components: there
//! `exec::link` is unconditional and the allowlist alone gates.)
//!
//! ⚠ ***`exec` SPAWNS A COMPONENT, NOT A SHELL.*** The name is resolved against
//! an allowlist of wasm component paths fixed at launch. There is no way to name
//! an arbitrary host path or program from inside the guest, which is what keeps
//! this a capability rather than a hole.

wit_bindgen::generate!({
    path: "wit",
    world: "perseid-exec",
    generate_all,
    // ⛔ ***NO `async` OPTION, DELIBERATELY - `async: true` BREAKS THIS BUILD.***
    // A blanket forces every function, including the plain non-async `spawn` and
    // `stdout`, into the async canonical ABI, and `wasm-tools validate` rejects
    // that for a plain function type ("the `async` canonical option requires an
    // async function type"). Omitting it falls back to each function's own WIT
    // async-ness: `step.run` and `wait` are `async func`, `spawn`/`stdout` are
    // not - which mirrors exactly how the HOST side is flagged in `exec.rs`.
    // `exec-parent` next door carries the same comment for the same reason.
});

use exports::radiant::reconcile::signal::{Guest as SignalGuest, State};
use exports::radiant::reconcile::step::Guest as StepGuest;
use std::cell::RefCell;
use periapsis::host::exec::{ChildProcess, ExecError};
use radiant::reconcile::observe;
use radiant::reconcile::status::{self, Condition, ConditionStatus};
use radiant::reconcile::types::Obs;
use wit_bindgen::StreamResult;

/// The object this program is about.
const SUBJECT: &str = "/apis/apps/v1/namespaces/default/deployments/exec-demo";

/// The allowlist NAME, not a path. `--exec-with check=<path>` binds it; anything
/// else is `not-allowed` and the guest cannot influence which.
const CHECKER: &str = "check";

const CONDITION: &str = "Ready";

/// ***BOUNDED BECAUSE THE PIPE IS.*** trail's duplex pipe is `BUF_CAP = 8192`
/// bytes (`exec.rs`), and this program writes the child's whole stdin BEFORE it
/// starts reading stdout. That is safe only while the payload fits: a larger one
/// blocks mid-write, the child fills its own stdout with nobody draining it, and
/// both ends stop - a deadlock, not an error. Feeding a real object's raw JSON
/// would hit it routinely (`managedFields` alone usually clears 8 KB), which is
/// why `checker_input` sends a PROJECTION rather than the object.
///
/// A program that genuinely needs to stream more must interleave the write with
/// the read instead of raising this number.
const MAX_STDIN: usize = 4096;

thread_local! {
    /// The write end of this pass's wake future, between `run` and `signal`.
    ///
    /// A `thread_local` because the two exports must share one object and the
    /// host calls each independently - there is no way to pass it between them.
    /// Taken (not cloned) on signal, so a second signal in one pass has nothing
    /// to write and honestly reports `running`.
    static WAKER: RefCell<Option<wit_bindgen::FutureWriter<u32>>> = const { RefCell::new(None) };
}

struct Guest;

impl StepGuest for Guest {
    async fn run() -> String {
        // ***THE WHOLE PASS IS RACED AGAINST A WAKE, AND TRAIL REFUSES TO SERVE
        // THIS PROGRAM OTHERWISE.*** Every read is a round trip to radiant; one
        // that is never answered would leave the step suspended with no way out.
        // The TS arm spells this `Promise.race([runStepAsync(...),
        // wake.signalled()])`; this is the same shape in Rust.
        //
        // ***CREATED HERE, INSIDE THE TASK THAT WILL SUSPEND.*** The reads
        // register in this task's own waitable set; a future made anywhere else
        // is not in the set the runtime will resume on.
        let (tx, rx) = wit_future::new::<u32>(|| 0);
        WAKER.with(|w| *w.borrow_mut() = Some(tx));

        let work = Box::pin(pass());
        let wake = Box::pin(rx.into_future());

        match futures::future::select(work, wake).await {
            futures::future::Either::Left((outcome, _)) => outcome,
            // Woken mid-pass: this pass established nothing, so it declares
            // nothing and asks to run again rather than reporting a verdict it
            // did not reach.
            futures::future::Either::Right(_) => r#"{"o":"yield"}"#.to_string(),
        }
    }
}

impl SignalGuest for Guest {
    /// SYNC, and it must stay that way: the handler runs on a stack with NO TASK
    /// STATE while `run` is suspended. Completing a future whose reader is
    /// already waiting finishes on the spot and never asks for task state, which
    /// is exactly why a handler that has none can do it.
    fn signal(_code: u32) -> State {
        match WAKER.with(|w| w.borrow_mut().take()) {
            // The step never armed a future, so there is nothing to wake. A true
            // answer: this program cannot wind up.
            None => State::Running,
            Some(tx) => {
                let _ = tx.write(0);

                State::Terminating
            }
        }
    }

    /// NEVER CALLED. It exists so `future<u32>` appears in a function and the
    /// world exports it, so omitting it fails at instantiation rather than at a
    /// call - see `wake-carrier` in wit/reconcile/reconcile.wit.
    fn wake_carrier() -> wit_bindgen::FutureReader<u32> {
        let (tx, rx) = wit_future::new::<u32>(|| 0);
        let _ = tx.write(0);

        rx
    }
}

/// One pass, as it was before the wake race was added around it.
async fn pass() -> String {
    {
        let subject = match observe::get(SUBJECT.to_string()).await {
            Obs::Known(json) => json,
            Obs::Absent => {
                report(
                    ConditionStatus::False,
                    "SubjectAbsent",
                    &format!("{SUBJECT} does not exist"),
                );
                // Nothing to check and nothing to wait on but its arrival.
                return quiesce(&subject_exists());
            }
            // ⛔ ***`Unknown` IS NOT `Absent`, AND REPORTING `False` HERE WOULD BE
            // THE MOST REPEATED DEFECT IN THIS CODEBASE.*** The read failed; the
            // subject may be in perfect health. `unsure` is what this pass
            // actually established.
            Obs::Unknown => {
                report(
                    ConditionStatus::Unknown,
                    "ReadFailed",
                    &format!("could not read {SUBJECT}"),
                );
                return quiesce(&subject_exists());
            }
        };

        // What to wake on. `metadata.resourceVersion` moves on any write to the
        // object, which is the widest "something about my subject changed" this
        // program can express without knowing what the checker cares about.
        //
        // ⚠ Written in the ABSENT-OR-DIFFERENT shape rather than a plain `!=`,
        // because an absent operand propagates as *unknown*, not true - so a bare
        // `!=` would never fire on the object being deleted. The host renders
        // `(<this>) || Backstop()` around it (`aperture/eval.go`'s
        // `WithBackstop`), so the park is bounded without this program saying so.
        let park = match resource_version(&subject) {
            Some(rv) => subject_moved(&rv),
            // No resourceVersion in what came back: fall back to mere existence
            // rather than emitting an expression built from a value we do not
            // have.
            None => subject_exists(),
        };

        let payload = match checker_input(&subject) {
            Ok(p) => p,
            Err(why) => {
                report(ConditionStatus::Unknown, "SubjectUnreadable", &why);
                return quiesce(&park);
            }
        };

        match run_checker(&payload).await {
            // ***THE STATE THE FLEET IS IN TODAY*** - see the module doc. The
            // check did not fail; it did not RUN, so nothing about the subject
            // was established.
            Err(ExecError::NotAllowed) => {
                report(
                    ConditionStatus::Unknown,
                    "NoChecker",
                    &format!(
                        "`{CHECKER}` is not in this pod's exec allowlist, so no verdict was \
                         reached. Wire it with the trail.apsis/exec-with annotation \
                         (`{CHECKER}=<path-to-component.wasm>`)."
                    ),
                );
                quiesce(&park)
            }
            // Equally: an instrument that did not run is a THIRD outcome, not a
            // failing check.
            Err(e) => {
                report(
                    ConditionStatus::Unknown,
                    "CheckerUnavailable",
                    &format!("`{CHECKER}` could not be run: {e:?}"),
                );
                quiesce(&park)
            }
            Ok((0, out)) => {
                report(ConditionStatus::True, "CheckPassed", say(&out));
                quiesce(&park)
            }
            Ok((code, out)) => {
                report(
                    ConditionStatus::False,
                    "CheckFailed",
                    &format!("`{CHECKER}` exited {code}: {}", say(&out)),
                );
                quiesce(&park)
            }
        }
    }
}

/// Feed the child, drain its stdout, collect its exit code.
///
/// The write completes before the read begins, which is sound only under
/// `MAX_STDIN` - see that constant for the deadlock this ordering has when the
/// payload outgrows the pipe.
async fn run_checker(payload: &str) -> Result<(i32, String), ExecError> {
    // The PARENT makes the stream pair and keeps the writable half; the readable
    // half is what `spawn` takes. (Mirrors `wasi:http/types@0.3.0`'s
    // `Response.new` taking `contents` as a parameter - exec.wit says so itself.)
    let (mut tx, rx) = wit_stream::new();

    let child = ChildProcess::spawn(CHECKER, &[], rx)?;

    let (_result, _remaining) = tx.write(payload.as_bytes().to_vec()).await;
    // Closing stdin is what lets a child that reads to EOF finish at all. Without
    // this the child blocks forever and so does `wait`.
    drop(tx);

    let mut out_stream = child.stdout();
    let mut collected = Vec::new();
    loop {
        let (result, buf) = out_stream.read(Vec::<u8>::with_capacity(1024)).await;
        collected.extend_from_slice(&buf);
        if matches!(result, StreamResult::Dropped) {
            break;
        }
    }

    let code = child.wait().await;
    Ok((
        code,
        String::from_utf8_lossy(&collected).trim().to_string(),
    ))
}

/// What the checker is given: a PROJECTION of the subject, not the subject.
///
/// Two reasons, and the second is the interesting one. It keeps the payload under
/// `MAX_STDIN`; and it makes the contract between this program and a swappable
/// checker EXPLICIT, so replacing the checker cannot silently start depending on
/// a field nobody meant to expose.
fn checker_input(subject: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(subject).map_err(|e| format!("subject is not JSON: {e}"))?;

    let projection = serde_json::json!({
        "name": v["metadata"]["name"],
        "namespace": v["metadata"]["namespace"],
        "generation": v["metadata"]["generation"],
        "spec": { "replicas": v["spec"]["replicas"] },
        "status": {
            "replicas": v["status"]["replicas"],
            // ⚠ Kubernetes OMITS this at zero, and zero is the failure a checker
            // exists for. It arrives as JSON `null` rather than as a number, and
            // the checker has to tell those apart - the same absent-is-not-zero
            // trap the park expression above is written around.
            "readyReplicas": v["status"]["readyReplicas"],
            "availableReplicas": v["status"]["availableReplicas"],
            "conditions": v["status"]["conditions"],
        },
    });

    let out = projection.to_string();
    if out.len() > MAX_STDIN {
        return Err(format!(
            "projection is {} bytes, over the {MAX_STDIN}-byte stdin bound",
            out.len()
        ));
    }
    Ok(out)
}

fn resource_version(subject: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(subject)
        .ok()?["metadata"]["resourceVersion"]
        .as_str()
        .map(str::to_owned)
}

// --- the outcome and the park expression -----------------------------------
//
// `step.run` returns a STRING, and reconcile.wit fixes its shape:
//
//     {"o":"yield"} | {"o":"quiesce","resume":"<aperture source>"} | {"o":"terminate"}
//
// `resume` is aperture SOURCE TEXT carried in a JSON string - not an expression
// tree - which is why this file needs no builder for it, and why `held()` can
// hand a program back its own operands as text.

fn quiesce(resume: &str) -> String {
    serde_json::json!({ "o": "quiesce", "resume": resume }).to_string()
}

/// An aperture string literal, escaped by the JSON encoder rather than by hand.
fn lit(s: &str) -> String {
    serde_json::Value::String(s.to_owned()).to_string()
}

fn subject_exists() -> String {
    format!("Get({}, \"metadata.uid\").exists", lit(SUBJECT))
}

fn subject_moved(rv: &str) -> String {
    let p = lit(SUBJECT);
    format!(
        "(!Get({p}, \"metadata.resourceVersion\").exists || Get({p}, \"metadata.resourceVersion\") != {})",
        lit(rv)
    )
}

fn report(status: ConditionStatus, reason: &str, message: &str) {
    status::status(&Condition {
        type_: CONDITION.to_string(),
        status,
        reason: reason.to_string(),
        message: message.to_string(),
    });
}

/// A checker that said nothing still has to produce a message somebody can read.
fn say(out: &str) -> &str {
    if out.is_empty() {
        "(no output)"
    } else {
        out
    }
}

export!(Guest);
