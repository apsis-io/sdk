// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! The RUST arm of the wake A/B: a step that races a WIT future and is freed by
//! a signal while blocked on a host read.
//!
//! The TS fixtures next door prove the same thing through dwarf. This shares no
//! code path with them - rustc, wit-bindgen, no JS engine - so the two together
//! say the mechanism is a property of the COMPONENT MODEL rather than of one
//! componentizer's job queue.

wit_bindgen::generate!({
    path: "wit",
    world: "perseid-wake-rs",
    generate_all,
    // ⛔ ***WIT-BINDGEN TAKES ASYNC-NESS FROM HERE, NOT FROM THE WIT.*** With no
    // option at all it generates `fn run() -> String` - SYNC - for a `run: async
    // func()` in the contract, and a sync `run` cannot await, so it cannot race
    // anything and the whole mechanism is unreachable. With `async: true` it
    // goes the other way and makes `signal` async too, which breaks it from the
    // other side: the handler runs on a stack with NO TASK STATE while `run` is
    // suspended, and must stay sync.
    //
    // ***THE SPECIFIC FILTERS MUST PRECEDE `all`.*** The set is scanned in order
    // and `all` returns immediately, so a trailing override is never consulted -
    // it fails the build as an "unused async option", which is at least loud.
    // Names are interface ids WITH their version.
    async: [
        "-export:perseid:reconcile/signal@0.1.0#signal",
        "-export:perseid:reconcile/signal@0.1.0#wake-carrier",
        "all",
    ],
});

use exports::perseid::reconcile::signal::{Guest as SignalGuest, State};
use exports::perseid::reconcile::step::Guest as StepGuest;
use perseid::reconcile::observe;
use std::cell::RefCell;

/// A path nothing will ever answer: the test's host holds the reply channel open
/// and never replies, so this read is the wedge.
const WEDGE: &str = "/api/v1/namespaces/default/pods/never";

thread_local! {
    /// The write end of this pass's wake future, between `run` and `signal`.
    ///
    /// A `thread_local` rather than a `static mut` because the two exports have
    /// to share one object and there is no way to pass it between them - the
    /// host calls each independently. Taken (not cloned) on signal, so a second
    /// signal in one pass has nothing to write and reports `running`.
    static WAKER: RefCell<Option<wit_bindgen::FutureWriter<u32>>> = const { RefCell::new(None) };
}

struct Guest;

impl StepGuest for Guest {
    async fn run() -> String {
        // ***CREATED HERE, INSIDE THE TASK THAT WILL SUSPEND.*** The read has to
        // register in that task's own waitable set; a future made anywhere else
        // is not in the set the runtime will resume on.
        //
        // ⚠ ***THE `|| 0` IS A DEFAULT FOR THE DROP CASE, AND IT MEANS DROPPING
        // THE WRITER ALSO WAKES THE STEP.*** Measured 2026-09-04 by mutation: a
        // handler that took the writer and merely let it fall out of scope still
        // freed the step, because the runtime completes the future with this
        // default when the write end goes away. So in Rust a wake has TWO causes
        // - an explicit `write`, and the writer being dropped anywhere, including
        // on an early return or an unwind - and a step cannot tell them apart
        // from the value alone.
        //
        // The TS path has no equivalent: there the writer is a handle the guest
        // holds and nothing completes it implicitly. Worth knowing before a
        // program treats "woken" as "the host asked me to stop".
        let (tx, rx) = wit_future::new::<u32>(|| 0);
        WAKER.with(|w| *w.borrow_mut() = Some(tx));

        let read = Box::pin(observe::get(WEDGE.to_string()));
        let wake = Box::pin(rx.into_future());

        match futures::future::select(read, wake).await {
            // The wedge answered after all - the host stopped wedging, and this
            // arm is no longer measuring anything. Named so a test can say so.
            futures::future::Either::Left(_) => "read-returned".into(),
            futures::future::Either::Right(_) => "WOKEN-BY-FUTURE".into(),
        }
    }
}

impl SignalGuest for Guest {
    /// SYNC, and it must stay that way - see the `async` filters above.
    fn signal(code: u32) -> State {
        match WAKER.with(|w| w.borrow_mut().take()) {
            // The step never armed a future, so there is nothing to wake. A true
            // answer: this program cannot wind up.
            None => State::Running,
            Some(tx) => {
                // Completing a future whose reader is already waiting finishes on
                // the spot and never asks for task state, which is exactly why a
                // handler that has none can do it.
                let _ = tx.write(code);

                State::Terminating
            }
        }
    }

    /// NEVER CALLED - see `wake-carrier` in wit/reconcile/reconcile.wit. It
    /// exists so `future<u32>` appears in a function, and the world exports it,
    /// so omitting it fails at instantiation rather than at a call.
    fn wake_carrier() -> wit_bindgen::FutureReader<u32> {
        let (tx, rx) = wit_future::new::<u32>(|| 0);
        let _ = tx.write(0);

        rx
    }
}

export!(Guest);
