# perseid-exec — a Perseid whose verdict is a component wired at launch

A Perseid that reads a Deployment, hands a projection of it to a child component
called `check`, and publishes what that child says as its `Ready` condition. The
operator swaps the policy with `--exec-with check=<other>.wasm` and never rebuilds
the operator.

Two artifacts, deliberately:

| | |
|---|---|
| `perseid-exec/` | the LOOP — reads, spawns, reports, parks |
| `perseid-exec-checker/` | the POLICY — reads stdin, prints a line, exits 0 or non-zero |

`perseid-exec` never names the checker. It spawns the allowlist **name** `check`;
which artifact that is, is a launch-time decision.

## Wiring the checker: `spec.execWith`

```yaml
spec:
  execWith:
    check: /var/lib/apsis/wasm-exec/perseid-exec-checker.wasm
```

**This did not exist until 2026-09-08 and its absence was the whole gap.**
`--exec-with` comes from the `trail.apsis/exec-with` pod annotation, and radiant
builds a Perseid's pod itself — the only trail annotation it used to set was
`trail.apsis/serve-quic`. So `periapsis:host/exec` was admissible in
`spec.capabilities` and every `spawn` still returned `not-allowed`: a capability
you could be granted and could never use.

⛔ **EVERY PATH MUST SIT UNDER `/var/lib/apsis/wasm-exec`, and radiant refuses to
launch the program otherwise** — an `ExecWithInvalid` Event naming the path,
rather than a dropped entry, because a dropped name reaches the guest as
`not-allowed`, which is exactly what "nobody wired a checker" looks like. A typo
would have presented as the seam being broken.

**A Perseid is not a pod, and that is why the confinement exists.** Writing the
equivalent pod annotation already requires pod-create — far larger authority than
anything this seam reaches. A Perseid CR has its own, narrower RBAC, so passing
paths straight through would let Perseid-create name any file on the node: a
widening of authority nobody granted, arriving as a convenience feature. Confined,
what it confers is *"whoever can put a file in that directory"*, which is the
authority that directory already had.

⛔ **Leaving `spec.execWith` out does not produce `NoChecker` — the program fails
at instantiation.** trail's `step_linker` withholds `periapsis:host/exec` from a
Perseid's linker unless the allowlist is non-empty, so an ungranted program
importing exec is refused with *"component imports instance
`periapsis:host/exec@0.1.0`, but a matching implementation was not found in the
linker"*. Loud, before a pass runs — on purpose, because a silent `not-allowed` is
indistinguishable from "nobody wired a checker".

⚠ **The `NoChecker` arm is still live, via the case that matters**: a non-empty
allowlist that does not contain the name the program spawns (`spec.execWith`
declares `audit`, the program spawns `check`). Then exec *is* linked and `spawn`
returns `not-allowed` — a misconfiguration to survive and report, not to crash on.

This is stricter than how exec is treated for ordinary components, where
`exec::link` is unconditional at both `main.rs` call sites and the allowlist alone
gates. A Perseid gets the extra gate because ADR-0075 makes a step a pure function
of its observations: the refusal stays the default and the grant stays an explicit
operator act, exactly as `wasi:http` is gated on `--network`.

⚠ **`exec` spawns a COMPONENT, not a shell.** The name resolves against an
allowlist of wasm component paths fixed at launch. There is no way to name an
arbitrary host path or program from inside the guest.

## Two arms, and why

| | |
|---|---|
| `perseid-exec/` (here) | **Rust** — rustc + wit-bindgen, no JS engine, ~180 KB, no WASI in the world |
| `../perseid-ts/src/execcheck.ts` | **TypeScript** — dwarf, ~1.5 MB, and the arm with unit tests |

⛔ **THIS SECTION SAID RUST WAS FORCED. IT WAS NOT, AND THE CORRECTION IS THE
USEFUL PART.** It claimed the TS SDK had no binding for the exec seam because
`child-process` is a resource carrying `stream<u8>`. **`sdk/ts/periapsis/exec.ts`
has wrapped exactly that the whole time** — extracted from `../js-dwarf-shell`,
which has run it live on a real pod.

**The error was the POPULATION, not the reading.** `perseid.ts` was grepped for
`WIT_` constants and returned none — true, and about a different question: the
seam lives in its own SDK module and never had a `WIT_` constant. *An absence
found by looking in one file is a fact about that file*, and it went out as a
fact about the SDK.

So the arms differ in **toolchain, not capability**, which is the same reason
`perseid-wake-rs` exists next door: one toolchain agreeing with itself proves
less. The TS arm is also the one whose step is unit-tested — see below.

## Build

```bash
./build.sh                        # -> perseid-exec.wasm
../perseid-exec-checker/build.sh  # -> the checker (runs its unit tests first)
```

`build.sh` **stages** the WIT deps from `wit/reconcile` and `wit/host` rather than
vendoring them, so the crate always compiles against HEAD's contract and there is
no third copy to drift. Same shape as the `signal-rust` recipe in
`cmd/trail/tests/fixtures/justfile`.

## What is verified

- Both components build and pass `wasm-tools validate --features all`.
- `trail --inspect` reports the intended surface — `seam_candidates` **empty**
  (this is not a seam consumer), `periapsis:host/exec@0.1.0` in `non_seam`, which
  is the partition admission diffs against `spec.capabilities`:

  ```
  backstop: 60000
  non_seam: perseid:reconcile/{types,observe,status}@0.1.0, periapsis:host/exec@0.1.0
  exports:  perseid:reconcile/step@0.1.0
  ```

- The checker's logic is unit-tested **and mutation-verified**: changing
  `unwrap_or(0)` to `unwrap_or(want)` turns two tests red naming the mechanism
  (*"absent readyReplicas must not read as satisfied"*). A guard nobody has seen
  fail is not yet a guard.
- **The TS arm** (`../perseid-ts/src/execcheck.ts`) componentizes to a real
  Perseid — `trail --inspect` shows it exporting `perseid:reconcile/step@0.1.0`
  *and* importing all three `periapsis:host/exec` functions, `backstop: 60000`.
  Its step is unit-tested with **no host at all**, because the spawn is an
  *effect the step yields* rather than a call it makes; two mutations red it and
  name the mechanism (*"an unwired checker did not report unsure: False"*,
  *"absent readyReplicas was not preserved as null: 0"*). 11 files, 11 pass.

  ⭐ That testability is the argument for the effect indirection. `exec.ts`'s
  `await exec(...)` is perfectly good and calling it inside the step would make
  the program a function of its host — including the `not-allowed` arm, which is
  what any program with no `spec.execWith` gets on every pass and therefore the
  one most worth being able to exercise offline.

- **The wiring** (`internal/trailop`, 2026-09-08): `spec.execWith` renders onto the
  pod, sorted; the paths are confined to `ExecWithRoot`; `podStale` compares the
  allowlist so editing it recycles the pod. Eight tests, and the three
  load-bearing ones are mutation-verified — swapping `filepath.Rel` for a prefix
  test admits `…/wasm-exec-evil/` and reds *only* the sibling arm; deleting the
  `podStale` arm reds *"spec.execWith is inert"*; leaking author names as
  annotation keys reds the containment test naming the forged
  `radiant.apsis/bound-by`.

## Verified LIVE on kas-sqlite, 2026-09-08

Both arms, both languages, one checker, on the real cluster:

```
exec-demo      Ready=False CheckFailed  `check` exited 1: checker: exec-demo 2/3 ready
exec-demo-rs   Ready=False CheckFailed  `check` exited 1: checker: exec-demo 2/3 ready
                                        (subject: spec=3 ready=2 — the checker read real data)
```

Scaling the subject flips them to `Ready=True CheckPassed … 1/1 ready`, so the
park fires, the step re-runs, the child re-computes and the verdict republishes.
The message text is produced BY THE CHILD — a value the Perseid could not invent,
which is what makes it evidence rather than a self-report.

Also measured live, each as its own arm:

| | |
|---|---|
| `podStale` | renaming the entry logs `execWith [check=…] -> [audit=…]` and recycles the pod (UID changes), so the field is not inert |
| allowlist is by NAME | with only `audit` granted, `spawn("check")` → `Ready=Unknown/NoChecker: not-allowed` — **`Unknown`, not `False`** |
| path escape | `/etc/shadow` → `ExecWithInvalid … is outside /var/lib/apsis/wasm-exec`, **no launch, pod untouched** |
| comma injection | `…/a.wasm,evil=/etc/shadow` → refused, naming the comma |
| `=` in a name | `check=/etc/shadow` → refused, naming the delimiter |
| no grant at all | refused at INSTANTIATION: *"not found in the linker"* |

⛔ **THE RUST ARM WAS NOT SERVABLE UNTIL THIS RUN, AND ONLY SERVING IT COULD SHOW
THAT.** It built, passed `wasm-tools validate` and reported the intended surface
under `trail --inspect` — and trail refused it: *"this program imports 2 and
exports no `perseid:reconcile/signal@0.1.0`. A program that reads can WEDGE."* A
Perseid that performs I/O must export `signal` and race a `future<u32>` against
its reads; the TS arm got this free from the SDK's `wakeable()`, and the Rust arm
now hand-writes it (`../perseid-wake-rs` is the reference). **Three green checks
agreed the artifact was fine; the fourth ran it.**

## The manifest

```yaml
apiVersion: radiant.apsis/v1alpha1
kind: Perseid
metadata:
  name: exec-demo
  namespace: default
spec:
  component: perseid-exec:v1
  language: 1          # Get / .exists / != / || only — no field selector, no quantifier
  capabilities:
  - perseid:reconcile/observe@0.1.0
  - perseid:reconcile/status@0.1.0
  - perseid:reconcile/types@0.1.0
  - periapsis:host/exec@0.1.0
  execWith:
    check: /var/lib/apsis/wasm-exec/perseid-exec-checker.wasm
```

Stage the checker on each node that may run it — the path is a **host** path, read
only, bound into the pod's chroot at the same place:

```bash
sudo mkdir -p /var/lib/apsis/wasm-exec
sudo cp perseid_exec_checker.wasm /var/lib/apsis/wasm-exec/
```

## The two constraints worth reading the source for

**The pipe is bounded.** trail's duplex pipe is `BUF_CAP = 8192` bytes, and this
program writes the child's whole stdin *before* it reads stdout. That is safe only
while the payload fits — a larger one blocks mid-write while the child fills its
own stdout with nobody draining it, and both ends stop. Feeding a real object's
raw JSON would hit this routinely (`managedFields` alone usually clears 8 KB),
which is why the program sends a **projection** and refuses over `MAX_STDIN`
rather than raising the number.

**Absent is not zero, and the default flips one field away.** `spec.replicas`
absent means **1** (Kubernetes' default); `status.readyReplicas` absent means
**0** — Kubernetes omits it entirely rather than writing zero, so the failure the
checker exists to catch arrives as a *missing field*. The park expression is
written in the absent-or-different shape for the same reason: an absent operand
propagates as *unknown*, not true, so a bare `!=` would never fire on deletion.
