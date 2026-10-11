# ADR-0075 step contract in plain TypeScript — the size/latency baseline

Same step, same five arms as `../perseid-ocaml` and `../perseid-effect`, so the
three are directly comparable on **shape** — the outcome of each arm, and whether
an arm acts at all. Transcribed from `trail --component perseid-ts.wasm --p3
--host-caps none` on 2026-09-01:

    below      -> Yield     acts=[ensure(/apis/apps/v1/namespaces/default/deployments/api, spec.replicas, {"num":3})]
    equal      -> Quiesce   acts=[set(Ready=True AtDesiredScale)]
    above      -> Yield     acts=[ensure(/apis/apps/v1/namespaces/default/deployments/api, spec.replicas, {"num":3})]
    absent     -> Terminate acts=[]
    unknown    -> Yield     acts=[]

⚠ ***THIS BLOCK SAID `acts=[scale +2]` / `acts=[scale -2]` UNTIL 2026-09-01, AND IT
WAS ACCURATE WHEN WRITTEN.*** `5feb940c6` added the sample and the code that
produced it in one commit — the step really did `emit(\`scale +${want - have.v}\`)`,
a DELTA. `37cae9c1d` collapsed the two arms into one absolute write, and the sample
did not move with it. So `below` and `above` have emitted the *same* obligation
since that commit, and the block went on showing a signed delta for a program that
had stopped computing one.

**The `ensure` migration is the SECOND thing that dated it, not the first.** Worth
separating, because "docs drifted during today's rename" and "docs drifted a week
ago and nobody re-ran the probe" call for different fixes, and only the second one
is about this README.

Two smaller corrections in the same block:

- **`status readyReplicas=3` is not what the equal arm emits**; it reports a
  CONDITION, `set(Ready=True AtDesiredScale)`.
- **"All three produce identical output" was too strong.** The three
  implementations record acts in three different formats — `../perseid-effect`
  builds its strings by hand. What is genuinely comparable is the five-arm
  **shape**: which outcome each arm reaches, and whether it acts at all. The
  wording above now claims only that.

A transcribed sample beats a remembered one: this one is copied from the probe's
own stdout, and the probe is one command in the Build section below.

Built with `dwarf --minify --opt-size`; best-of-5, warm cache.

| | artifact | wake |
|---|---|---|
| **this** | **1.43 MB** | **39 ms** |
| `../perseid-ocaml` | 2.66 MB | 58 ms |
| `../perseid-effect` | 8.57 MB | 190 ms |

## It uses the SDK, it does not reimplement the contract

`src/main.ts` is written against **`sdk/ts/periapsis/step.ts`**, which owns the
ADR-0075 contract: `Obs`, `Resume`, `Outcome`, `defineEffect`, `runStep`,
`Handler`. The example supplies only the logic.

That matters because two of the invariants stop being conventions:

- **`defineEffect` cannot produce a wrapper with a wide yield type.** Hand-writing
  one as `Generator<AllEffects, …>` compiles and silently destroys capability
  tracking; the helper's shape makes that unwriteable.
- **`Handler<E>` is a mapped type over E's ops, so it must be total.** Drop one
  and you get `TS2741: Property 'emit' is missing … but required in type
  'Handler<Effs>'`.

Building the SDK found a real bug in it, worth recording: `defineEffect<R>()`
originally left the *argument* type to inference, and since there is no call-site
value to infer from, TypeScript silently resolved it to `unknown` — making every
handler argument `unknown` and defeating the point. Both type arguments are now
explicit.

## Why generators

A reconciliation step needs **single-shot resume** — perform an effect, receive a
value, continue — and that is precisely what a generator is. `yield` is
`perform`; `runStep`'s loop is the handler. No library, no CPS transform, no
second language.

Two idioms carry the weight, both in `src/main.ts`:

- **`yield*` delegation through a one-line wrapper per effect** recovers the
  per-effect *result* typing that a bare `yield` loses (and that OCaml's GADT
  gives natively). `const have = yield* get('replicas')` is correctly
  `Obs<number>`; the unchecked cast is confined to the wrapper.
- **`default: const _exhaustive: never = have`** makes a missing case a compile
  error — ADR-0075's first invariant. Opt-in per switch rather than automatic as
  in OCaml, but real: delete an arm and the build fails.

## Capabilities ARE tracked in the type — no library needed

An earlier draft of this file claimed generators cannot do this. **Measured, they
can.** The generator's *Yield* parameter is the capability set, inferred
automatically through `yield*`:

    function* readOnly()  { const h = yield* get('replicas'); return h.t }
    function* readWrite() { const h = yield* get('replicas'); yield* emit('x'); return h.t }

    declare function runRead<A>(g: Generator<GetEff, A, any>): A

    runRead(readOnly())    // fine
    runRead(readWrite())   // TS2345: 'GetEff | EmitEff' is not assignable to 'GetEff'

A runner that supplies only `Get` structurally **rejects** a step that also
emits — which is exactly Effect-TS's R channel, for free, with no library.

`../perseid-effect` still buys things this does not: typed errors (the E channel),
`Layer` composition and memoisation, `TestClock`, `Schedule`. But under
ADR-0075's contract those are mostly host concerns by design — back-off lives in
the runtime, the fake clock is one line in the runner — so it is paying **6x the
artifact and ~5x the wake** for a headline feature the language already has.

## The WIT world is DERIVED from the types

`tools/derive-wit.ts` reads `step`'s inferred `Generator<Y, …>` yield type — the
capability union — and projects it onto the component's imports. Each effect
type carries a **type-only** `readonly wit?: '<interface>'` marker (optional,
never assigned, zero runtime cost), so the world is a projection of the code
rather than a manifest maintained beside it:

    $ nub tools/derive-wit.ts src/main.ts step
    world step-derived {
      import perseid:reconcile/observe@0.1.0;
      import perseid:reconcile/status@0.1.0;
      import perseid:reconcile/workloads@0.1.0;
    }

This sample is the *current* `derived/step.wit` verbatim. It is prose, so
nothing regenerates it — if you change the capability set, change it here too,
or the next reader follows a world the build would reject.

`build.sh` runs it with `--check` against the committed `derived/step.wit`, so
the build fails if the code's capabilities and the declared world diverge.
This is the inverse of `trail --inspect`, which reads a *built* component; this
reads the source before one exists. (`--inspect-imports` was folded into
`--inspect` — one parse now answers imports, capabilities and exports together.)

### Four guards, each mutation-verified rather than asserted

| guard | mutation | red |
|---|---|---|
| capability typing still works | make the bad call legal | `TS2578: Unused '@ts-expect-error' directive` |
| derived world matches code | delete an import from `derived/step.wit` | `derived/step.wit is stale — the code's capabilities changed` |
| no silently-incomplete world | remove an effect's `wit?` marker | `1 effect type(s) carry no 'wit' marker` |
| runner handles every capability | remove an op from the handler | `TS2741: Property 'emit' is missing … required in type 'Handler<Effs>'` |

The last one is the SDK's `Handler<E>` mapped type doing the work: you cannot add
a capability without handling it, and you cannot forget to handle one.

## Readiness-gated canary

`src/canary.ts` demonstrates a cross-object promotion edge a Deployment cannot
express: the candidate starts at one replica only after the stable Deployment is
ready, grows to its full population only after that probe is ready, and only
then drains stable. It is deliberately **readiness-gated**, not latency- or
error-rate-gated. A metrics-backed value gate is now expressible when another
controller publishes the value into one of the seven readable object kinds, but
this component intentionally does not implement one. Its safety-first policy also
requires stable to remain healthy before draining it; a permanently degraded
stable therefore retains both workloads and reports `StableNotReady`.

The pure decision table is in `src/canary.ts`, host imports are isolated in
`src/canary-main.ts`, and `src/canary.test.ts` drives the promotion gates without
a component runtime. `canary.yaml` is the deployable Perseid manifest; create
its two subject Deployments before applying it.

## A Perseid that creates a Pod

`src/podmaker.ts` is the only program here that exercises `create`, and it exists
to prove a composition rather than to be useful. A Perseid could not usefully
create a Pod until 2026-09-01: `aperture.unwritableKinds` banned the KIND to
compensate for the CREDENTIAL, because every obligation was applied with radiant's
identity and `seam-binding-vap.yaml` exempts exactly that identity on pods. With a
per-program ServiceAccount the premise is false, so it became an ordinary question
about RBAC and `spec.writes`.

Three things it deliberately does **not** demonstrate, each of which a reader
tends to assume it does:

- **`create` is KIND-level.** RBAC cannot scope a create by name — the name is in
  the request *body*, so authorization sees an empty one and a `resourceNames`
  rule matches nothing. Declaring one pod grants create on **all** pods in the
  namespace. `Ensure` and `Delete` on that pod stay object-scoped.
- **The VAP guards five annotation keys, not pod content.** It stops
  `radiant.apsis/link|remote|ipc|bound|bound-by`. What bounds the image is
  `spec.writes` plus the namespace's own PodSecurity admission.
- **A bare pod has no controller.** Nothing reschedules it. What brings it back is
  the program re-declaring it next pass, which is the reconcile model working —
  not Kubernetes doing it for you.

⚠ **Its world subtracts where the janitor's adds.** `perseid-ts-podmaker` is
create + status and no `observe`: the step never reads, because `objectGone(POD)`
is a resume expression the **host** evaluates while the program is parked.
`Handler<Effs>` is derived from the step's actual demand, so writing a `get`
handler is a type error rather than dead code.

**A DECLARED WRITE CONFERS THE READ OF WHAT IT WRITES, FOR A PARK ONLY** — so
podmaker needs no `observe` grant, and `spec.writes` is what makes its park
resolvable.

⚠ ***THAT IS THE SECOND ANSWER THIS SECTION HAS GIVEN IN ONE DAY, AND THE FIRST
ONE IS WORTH KEEPING VISIBLE.*** For a few hours the program genuinely did fail,
and the shape of the failure is the lesson even though the remedy changed:

    Applied         Create(".../pods/podmaker-proof", ...)   the write LANDED
    podmaker-proof  1/1 Running                              the pod came UP
    PerseidFailed   resume expression could not be evaluated:
                    aperture: unresolved identifier: "Get"

***THE STEP SUCCEEDS COMPLETELY AND THE PROGRAM DIES PARKING.*** Anyone watching
whether the write landed sees an unqualified success. The cause was that a resume
is evaluated with the program's own read capabilities, and podmaker declares none.

⛔ **The remedy was NOT to grant `observe`.** That was tried and reverted
(`eb9ac1a95` → `9dcbbcfe3`): it works, and it teaches every author to over-grant a
capability the aperture should have inferred — a workaround that *occupies* the
defect, and each program it fixes is one nobody looks at again. `DerivedRules`
already grants `get` on every object in `spec.writes`, so the aperture was refusing
a read the apiserver would have served to that program's own ServiceAccount.

⚠ **It is a real widening, and park-only is what bounds it.** Capabilities are
kind-granular, so declaring one pod write confers reading *pods* in that namespace
— the same power `observe` would have given. What contains it is that
`resumeExtraCaps` is a separate field from `programCaps` and never reaches
`mayReadKind`, so **the step's read surface is untouched**. Checked rather than
taken on trust: `mayReadKind` consults `h.programCaps` alone, and `resumeExtraCaps`
is read at exactly one site, the resume evaluation.

⚠ **`capabilities` is a GRANT, `imports` is a FACT** — still the distinction worth
carrying, and podmaker is still where they come apart: the artifact does not import
`observe` under either remedy.

**The build cannot catch a park's demand.** `derive-wit` reads the STEP's demand
out of the generator, and a park is not part of it — so the type system, the
derived world and `build.sh` are all correctly silent here. That is a fact about
the build, not an argument for documenting your way out: the host now infers the
grant, which is why this section no longer tells you to add one.

⚠ **`derive-wit` says two imports and `trail --inspect` says three, and both are
right.** `interface create` does `use ensure.{value}`, so the artifact's closure
carries `perseid:reconcile/ensure@0.1.0` transitively even though the program
never calls it. derive-wit reads the *program's* demand; trail reads the
*artifact*. `podmaker.yaml` must declare the artifact's answer, because that is
what admission compares against — which is also why its `capabilities` list grants
`ensure` for a program that has no `ensure` call in it.

## Build

    ./build.sh
    bun -e 'import("./src/canary.test.ts").then((m) => m.runtimeGuards())'
    apsis ingest -n canary:v1 perseid-canary.wasm
    kubectl apply -f canary.yaml

    apsis ingest -n podmaker:v1 perseid-podmaker.wasm
    kubectl apply -f podmaker.yaml

    trail --component perseid-ts.wasm --p3 --host-caps none

## Note

Everything runs inside `run()`, never at module scope — dwarf's Wizer pre-init
evaluates top-level code at BUILD time. See `../perseid-ocaml/src/main.ts`, where
that constraint is load-bearing rather than incidental.
