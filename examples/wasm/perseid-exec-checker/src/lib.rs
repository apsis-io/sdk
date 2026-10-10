// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! The POLICY half of the `perseid-exec` pair.
//!
//! Reads the projection `perseid-exec` writes to its stdin, prints one line, and
//! exits 0 (ready) or non-zero (not ready). The Perseid publishes that verdict as
//! its `Ready` condition and never interprets it.

wit_bindgen::generate!({
    path: "wit",
    world: "checker",
    async: true,
    generate_all,
});

struct Comp;

impl exports::wasi::cli::run::Guest for Comp {
    async fn run() -> Result<(), ()> {
        // Transitional 0.2 stdio (std still emits wasi:cli/stdin@0.2) is enough:
        // trail wires a spawned child's stdin/stdout to the piped duplex halves
        // regardless of which stdio generation reads them - see exec.rs's
        // `build_child_store`, and ../exec-child, which says the same.
        use std::io::{Read, Write};

        let mut input = Vec::new();
        std::io::stdin().read_to_end(&mut input).map_err(|_| ())?;

        let verdict = decide(&input);
        let mut out = std::io::stdout();
        out.write_all(verdict.message.as_bytes()).map_err(|_| ())?;
        out.write_all(b"\n").map_err(|_| ())?;
        out.flush().map_err(|_| ())?;

        // ***THE EXIT CODE IS THE VERDICT, THE STDOUT IS THE EXPLANATION.*** The
        // parent reports the code as ready/unready and the text as the message,
        // so a checker that printed a reason but exited 0 would publish a
        // reassuring condition with an alarming message attached.
        if verdict.ready { Ok(()) } else { Err(()) }
    }
}

struct Verdict {
    ready: bool,
    message: String,
}

/// Pure, so the interesting half is testable without a component at all.
fn decide(input: &[u8]) -> Verdict {
    let v: serde_json::Value = match serde_json::from_slice(input) {
        Ok(v) => v,
        Err(e) => {
            return Verdict {
                ready: false,
                message: format!("checker: input is not JSON: {e}"),
            };
        }
    };

    // ⚠ ***ABSENT MEANS ONE, NOT ZERO.*** Kubernetes defaults `spec.replicas` to
    // 1 when it is omitted, so treating a missing field as 0 would call an
    // ordinary single-replica Deployment satisfied at zero ready pods.
    let want = v["spec"]["replicas"].as_i64().unwrap_or(1);

    // ⛔ ***AND HERE ABSENT MEANS ZERO, WHICH IS THE OPPOSITE DEFAULT ONE FIELD
    // AWAY.*** Kubernetes OMITS `status.readyReplicas` entirely when no pod is
    // ready - it does not write 0 - so the failure this checker exists to catch
    // arrives as an ABSENT field rather than as a small number. A reader that
    // treats absent as "unknown, skip" reports healthy on a fully-down workload.
    let ready = v["status"]["readyReplicas"].as_i64().unwrap_or(0);

    let name = v["name"].as_str().unwrap_or("(unnamed)");
    Verdict {
        ready: ready >= want,
        message: format!("checker: {name} {ready}/{want} ready"),
    }
}

export!(Comp);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_ready_replicas_is_zero_and_not_satisfied() {
        // The exact shape Kubernetes emits for a fully-down Deployment: no
        // `readyReplicas` key at all.
        let v = decide(br#"{"name":"x","spec":{"replicas":2},"status":{"replicas":2}}"#);
        assert!(!v.ready, "absent readyReplicas must not read as satisfied");
        assert!(v.message.contains("0/2"), "got {}", v.message);
    }

    #[test]
    fn absent_spec_replicas_defaults_to_one() {
        let v = decide(br#"{"name":"x","spec":{},"status":{"readyReplicas":1}}"#);
        assert!(v.ready, "1 ready against the default of 1 is satisfied");
    }

    #[test]
    fn absent_spec_replicas_is_not_zero() {
        // The negative arm of the above: if `want` defaulted to 0, a Deployment
        // with nothing ready would pass. It must not.
        let v = decide(br#"{"name":"x","spec":{},"status":{}}"#);
        assert!(!v.ready, "0 ready against the default of 1 is NOT satisfied");
    }

    #[test]
    fn satisfied_when_ready_meets_want() {
        let v = decide(br#"{"name":"api","spec":{"replicas":3},"status":{"readyReplicas":3}}"#);
        assert!(v.ready);
        assert!(v.message.contains("api 3/3 ready"), "got {}", v.message);
    }

    #[test]
    fn malformed_input_is_not_ready() {
        let v = decide(b"not json");
        assert!(!v.ready);
        assert!(v.message.contains("not JSON"), "got {}", v.message);
    }
}
