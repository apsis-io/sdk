# OCaml 5 effect handlers as a reconciliation step, all the way to a component

**This is a feasibility probe for [ADR-0075](../../../adr/0075-an-operator-is-a-program-you-write.md),
not a production pattern.** It exists to answer one question — *do OCaml 5
effect handlers survive the toolchain* — and it answers it yes. Read the
limitations at the bottom before copying anything here.

## What it proves

    ocaml/step.ml  --ocamlc-->  .byte  --js_of_ocaml --effects=cps-->  src/step.js
                   --vite-->  dist/main.js  --dwarf-->  perseid-ocaml.wasm  --> trail

Output under `trail` is **byte-identical to native** across five arms:

    [wrapper] run() entered — importing jsoo bundle now
    below      -> Yield     acts=[scale +2]
    equal      -> Quiesce   acts=[status readyReplicas=3]
    above      -> Yield     acts=[scale -2]
    absent     -> Terminate acts=[]
    unknown    -> Yield     acts=[]
    [wrapper] jsoo import returned

The five arms are chosen, not decorative: `below`/`above`/`equal` are the
positive cases, and **`absent` vs `unknown` is the discrimination that matters** —
"it is gone" must not behave like "cannot tell". ADR-0075's first invariant is
that the three-valued observation makes that distinction unforgettable, and the
compiler enforces it: drop a case from the match and the build fails.

## Why OCaml at all

`Effect.Deep.try_with` *is* the step contract. The program performs `Get` and
`Emit` and reads as ordinary sequential code; the handler supplies the world and
collects obligations, so the step never touches anything and stays replayable.
That pattern is hand-rolled in every other language. Here it is the runtime.

## What it cost

| stage | size |
|---|---|
| `src/step.js` (jsoo, `--effects=cps`) | ~83 KB |
| same logic compiled *without* effects | ~73 KB (so the CPS delta is small **on a program this size**, where the jsoo runtime dominates — do not read it as the general tax) |
| `perseid-ocaml.wasm` (`--minify --opt-size`) | **2.66 MB**, wake **58 ms** |

2.66 MB for forty lines of logic is QuickJS plus the jsoo runtime. Measured
against the same step in plain TS (`../perseid-ts`, 1.43 MB / 39 ms) the jsoo
runtime costs ~1.2 MB and ~19 ms per wake — see ADR-0075's language comparison.

## Four things that will bite you, in the order you hit them

1. **`--effects=cps` is required and is not the default.** A plain
   `js_of_ocaml` build *succeeds* (with a warning) and then dies at runtime with
   `Effect handlers are not supported`. The warning names the flag, so the
   failure is loud — but it is at a different stage than the error.
2. **The dynamic import in `src/main.ts` is load-bearing.** dwarf's Wizer
   pre-init evaluates top-level module code at BUILD time, so a static import
   runs the OCaml program during componentization and never at runtime. Same
   wrinkle `../js-dwarf-checkpoint-also-run` documents for `checkpointLoad()`.
3. **vite code-splits that dynamic import**, and dwarf takes exactly one `--js`.
   Hence `rollupOptions.output.codeSplitting: false`. vite 8.2.1 deprecates
   `inlineDynamicImports` in favour of it but does not say WHERE it goes —
   `build.codeSplitting` is silently ignored and `rollupOptions.codeSplitting`
   warns "Invalid input options"; both still split, and the resulting component
   contains only the 0.23 kB stub and traps. Only the `output.` position works.
4. **dwarf's WIT auto-vendoring is broken** against the installed `wkg`
   (`unexpected argument '--wit-dir'`). WASI deps are committed under `wit/deps/`
   and the build passes `--no-vendor`.

Plus one environment trap: **Arch's `ocamlfind` cannot see an opam switch.**
`build.sh` sets `OCAMLPATH`. This probe uses no OCaml libraries at all, which is
also why it dodges the next problem — see below.

## Limitations — read before building on this

- **No JS-callable exports.** The component runs the program once from `run()`.
  A real operator needs the host to *call into* OCaml, which means
  `Js.export` from the `js_of_ocaml` library — and linking that library fails
  with `dlljsoo_runtime_stubs.so: No such file or directory` under the Arch
  `ocamlc` + opam libs combination. **This is the next gate and it is untested.**
- **No file I/O.** js_of_ocaml routes it through `node:fs`; dwarf's polyfill set
  has no `fs` (it has `unstorage`, and `../js-dwarf-filesystem` reaches storage
  via `wasi:filesystem` in the world instead). Untested on this path.
- **Resident memory per instance is unmeasured.** (Wake latency now is: 58 ms,
  against 39 ms for the same step in plain TS — see ADR-0075.)
- **The whole chain is a bridge, not the design.** It exists because OCaml's wasm
  story is roughly a year behind this runtime: `wasm_of_ocaml` supports OCaml 5
  effects but WASI 0.1 is still an open PR and there is no component-model
  support. When that lands, five stages collapse to one and nothing proven here
  changes.

## Build

    ./build.sh
    trail --component perseid-ocaml.wasm --p3 --host-caps none

Prerequisites (Arch):

    paru -S ocaml dune opam
    opam init -y --bare --disable-sandboxing
    opam switch create jsoo ocaml-system
    opam install -y js_of_ocaml js_of_ocaml-compiler
