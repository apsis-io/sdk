#!/usr/bin/env bash
# ADR-0075 feasibility probe: OCaml 5 effect handlers -> wasm component.
#
#   ocaml/step.ml --ocamlc--> .byte --js_of_ocaml--> src/step.js
#                 --vite--> dist/main.js --dwarf--> perseid-ocaml.wasm --> trail
#
# Every step below has a failure mode that is not obvious; each is commented
# where it bites rather than in the README, because that is where you will be
# standing when it happens.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-perseid-ocaml.wasm}"

# --- OCaml toolchain -------------------------------------------------------
# The system ocamlfind (Arch's ocaml-findlib) cannot see an opam switch's
# packages: OCAMLPATH is empty and findlib looks only at /usr/lib/ocaml. Point
# it at the switch. NOTE this probe deliberately uses no OCaml libraries, so
# plain ocamlc suffices; the moment you add one that ships C stubs (the
# js_of_ocaml library itself, for Js.export) bytecode linking fails with
#   I/O error: dlljsoo_runtime_stubs.so: No such file or directory
# and you will also need CAML_LD_LIBRARY_PATH or an opam-installed ocamlfind.
OPAM_SWITCH_NAME="${OPAM_SWITCH_NAME:-jsoo}"
if command -v opam >/dev/null 2>&1; then
  eval "$(opam env --switch="$OPAM_SWITCH_NAME" 2>/dev/null || true)"
  export OCAMLPATH="${OCAMLPATH:-$HOME/.opam/$OPAM_SWITCH_NAME/lib}"
fi
for bin in ocamlc js_of_ocaml; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "error: $bin not found." >&2
    echo "       paru -S ocaml dune opam" >&2
    echo "       opam init -y --bare --disable-sandboxing" >&2
    echo "       opam switch create $OPAM_SWITCH_NAME ocaml-system" >&2
    echo "       opam install -y js_of_ocaml js_of_ocaml-compiler" >&2
    exit 1
  }
done

# --- dwarf -----------------------------------------------------------------
DWARF_BIN="${DWARF_BIN:-dwarf}"
if ! command -v "$DWARF_BIN" >/dev/null 2>&1; then
  if [ -x "$HOME/git/dwarf/target/release/dwarf" ]; then
    DWARF_BIN="$HOME/git/dwarf/target/release/dwarf"
  else
    echo "error: dwarf not on PATH; build it: cd ~/git/dwarf && cargo build --release" >&2
    exit 1
  fi
fi

echo "1/4 ocamlc: ocaml/step.ml -> step.byte"
ocamlc ocaml/step.ml -o step.byte

# --effects=cps is REQUIRED and is not the default. Without it the build
# succeeds (with a warning) and then dies at RUNTIME with
#   Fatal error: exception Failure("Effect handlers are not supported")
# --effects=double-translation also works and is ~15% larger: it emits both
# direct-style and CPS versions so the non-effect path runs at full speed.
echo "2/4 js_of_ocaml --effects=cps -> src/step.js"
js_of_ocaml --effects=cps step.byte -o src/step.js

echo "3/4 vite build (esnext, no code-splitting) -> dist/main.js"
nub exec vite build

# --no-vendor: dwarf's auto-vendoring shells out to `wkg wit fetch`, whose CLI
# has diverged (`unexpected argument '--wit-dir'`). WASI deps are committed
# under wit/deps/ instead, copied from ../js-dwarf-p3.
echo "4/4 dwarf componentize -> $OUT"
"$DWARF_BIN" --wit wit --js dist/main.js --world perseid-ocaml --minify --opt-size --no-vendor -o "$OUT"

echo
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
echo "run it:  trail --component $OUT --p3 --host-caps none"
echo "expected (byte-identical to 'ocamlopt ocaml/step.ml && ./a.out'):"
echo "  below      -> Yield     acts=[scale +2]"
echo "  equal      -> Quiesce   acts=[status readyReplicas=3]"
echo "  above      -> Yield     acts=[scale -2]"
echo "  absent     -> Terminate acts=[]"
echo "  unknown    -> Yield     acts=[]"
