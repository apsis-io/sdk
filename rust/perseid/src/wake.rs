// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! ***THE ONLY THING THAT FREES A STEP BLOCKED IN A HOST READ.***
//!
//! A step awaiting a read nobody answers cannot be stopped from outside. Both
//! obvious levers are measured closed (2026-09-04, in trail, both arms):
//!
//! - the HOST cannot cancel a future it has handed over;
//! - the GUEST cannot free itself with an ordinary in-language promise. In a JS
//!   guest, `AbortController` and `Promise::race` live in the job queue, which a
//!   componentized guest drains only while resuming a task - and a task resumes
//!   only for a **waitable in its own set**. The handler runs, the promise
//!   resolves, and the continuation is scheduled and never drained.
//!
//! A WIT `future` is a waitable. Completing one re-enters the guest, the task
//! resumes, the race settles and `run` returns through the normal path - with
//! its outcome and its declared writes, which a step killed while wedged loses
//! entirely.
//!
//! # What this module does and does not own
//!
//! ⚠ **IT DOES NOT CREATE THE FUTURE, AND THAT IS NOT AN OVERSIGHT.** A Rust
//! guest's `future<u32>` is a type `wit_bindgen` generates *into the guest's own
//! crate*, from the world that guest was built against. There is no runtime
//! global to reach for - the TS SDK has `wit.Future` and this has nothing
//! equivalent - so a helper here cannot construct one without being generic over
//! types it can never name. The caller creates the pair with its own bindings
//! and hands the write end over.
//!
//! What this owns is the part that is easy to get wrong and identical in every
//! program: keeping the write end out of a module-level `static mut`, and
//! answering `Running` rather than `Terminating` when a program was never armed.
//!
//! ⛔ **ARM IT INSIDE `run`, NOT AT MODULE INITIALISATION.** The read must
//! register in the waitable set of the task that will be suspended, and in a
//! componentized guest there is no task context at module scope at all.
//!
//! ```ignore
//! fn run() -> String {
//!     let (tx, rx) = wit_future::new();     // the guest's OWN bindgen types
//!     WAKE.with(|w| w.arm(tx));
//!     // race rx against the pass's reads
//! }
//! ```
//!
//! A step must ALSO declare a `radiant:backstop` ([`crate::backstop`]), or
//! nothing will ever signal it: the host signals a step only when it outlives
//! its own declared bound.

/// The guest's answer to being signalled. Mirrors `enum state` in the WIT.
///
/// ***THE HOST REPORTS THIS AND DOES NOT OBEY IT.*** `Running` from a program
/// that intends to keep working is a true answer, not defiance - the host's only
/// remaining lever is to stop waiting, which it was going to do anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Still working, and does not intend to stop.
    Running,
    /// Winding up; expect the step to return shortly.
    Terminating,
    /// Finished. Whatever outcome it was going to produce, it has produced.
    Terminated,
}

/// The write end of a wake future, as the guest's own bindings expose it.
///
/// One method, taking `self`, because a WIT future carries exactly one value and
/// its writer is consumed by writing it.
pub trait WakeWriter {
    /// Complete the future the suspended step is reading.
    fn wake(self, code: u32);
}

/// Holds the write end of one program's wake future between `run` and `signal`.
///
/// ***THE POINT IS THAT THE WRITE END IS NOT A GLOBAL.*** The mechanism needs
/// two exports to share one object, and the obvious way to arrange that is a
/// `static mut` - which is exactly the hidden mutable program state a step is
/// not allowed to have (see `internal/reconcilehost/carry.go`), arriving by the
/// back door because the mechanism seems to require it. Keeping it in a value
/// the program threads deliberately makes the sharing visible.
#[derive(Debug, Default)]
pub struct Wake<W> {
    writer: Option<W>,
}

impl<W: WakeWriter> Wake<W> {
    /// A wake channel that has not been armed. Answers `Running` until it is.
    #[must_use]
    pub const fn new() -> Self {
        Self { writer: None }
    }

    /// Hand over the write end of the future this pass will race.
    ///
    /// Call it in `run`, after creating the pair and before awaiting the read.
    /// Arming twice replaces the previous writer: a new pass means a new future,
    /// and the old one belongs to a task that is gone.
    pub fn arm(&mut self, writer: W) {
        self.writer = Some(writer);
    }

    /// Answer a signal, completing the future if this pass armed one.
    ///
    /// ***`Running` WHEN UNARMED IS THE LOAD-BEARING CASE.*** Exporting `signal`
    /// is not the same as being wakeable: a program can export it and await
    /// nothing else. Reporting `Terminating` there would tell the host a wind-up
    /// is underway that will never happen.
    ///
    /// `state` is the program's own verdict, consulted only when there was
    /// something to wake.
    pub fn signal(&mut self, code: u32, state: impl FnOnce(u32) -> State) -> State {
        match self.writer.take() {
            None => State::Running,
            Some(w) => {
                w.wake(code);

                state(code)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{State, Wake, WakeWriter};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    /// A stand-in for the guest's generated writer.
    ///
    /// ⚠ It cannot reproduce what makes a WIT future special - re-entering a
    /// suspended guest task - and no test outside a wasm host can. That half is
    /// measured in `cmd/trail`
    /// (`a_wedged_step_is_freed_only_by_a_waitable`), against a real guest wedged
    /// on a real host read, with an AbortController arm that must NOT be freed.
    /// Asserted here: the wiring.
    struct Spy(Arc<AtomicU32>);

    impl WakeWriter for Spy {
        fn wake(self, code: u32) {
            self.0.store(code, Ordering::SeqCst);
        }
    }

    #[test]
    fn an_armed_wake_completes_the_future_and_reports_the_programs_verdict() {
        let seen = Arc::new(AtomicU32::new(0));
        let mut wake = Wake::new();
        wake.arm(Spy(Arc::clone(&seen)));

        assert_eq!(wake.signal(7, |_| State::Terminating), State::Terminating);
        assert_eq!(seen.load(Ordering::SeqCst), 7, "the code is passed through, not invented");
    }

    /// A program that never raced cannot wind up, and must say so rather than
    /// promising a termination that will never arrive.
    #[test]
    fn an_unarmed_wake_reports_running_and_never_consults_the_program() {
        let mut wake: Wake<Spy> = Wake::new();

        assert_eq!(
            wake.signal(1, |_| panic!("the verdict must not be consulted when nothing is armed")),
            State::Running
        );
    }

    /// The future carries one value, so a second signal in the same pass has
    /// nothing left to write - and must not claim it wound up twice.
    #[test]
    fn a_second_signal_in_one_pass_reports_running() {
        let seen = Arc::new(AtomicU32::new(0));
        let mut wake = Wake::new();
        wake.arm(Spy(Arc::clone(&seen)));

        assert_eq!(wake.signal(1, |_| State::Terminating), State::Terminating);
        assert_eq!(wake.signal(2, |_| State::Terminating), State::Running);
        assert_eq!(seen.load(Ordering::SeqCst), 1, "the second signal must not overwrite the first");
    }
}
