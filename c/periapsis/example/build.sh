#!/usr/bin/env sh
# Build the example guest into a wasm32-wasip3 component.
# Point WASI_SDK at a wasi-sdk with wasm32-wasip3 support if it isn't in the
# default location.
set -eu
cd "$(dirname "$0")/.."

: "${WASI_SDK:=$HOME/.local/share/wasi-sdk-p3}"
CC="$WASI_SDK/bin/wasm32-wasip3-clang"
CFLAGS="-O2 -Wall -Wextra -std=c11"

# The component-type object isn't checked in (it's a wit-bindgen artifact);
# regenerate it (+ the .c/.h) if absent.
[ -f generated/trail_host_component_type.o ] || ./bindgen.sh

$CC $CFLAGS -c generated/trail_host.c -o generated/trail_host.o
$CC $CFLAGS -c periapsis.c -o periapsis.o
$CC $CFLAGS example/main.c periapsis.o generated/trail_host.o \
    generated/trail_host_component_type.o -o example/c-sdk-example.wasm

echo "built example/c-sdk-example.wasm"
echo "--- component world ---"
wasm-tools component wit example/c-sdk-example.wasm | sed -n '1,24p'
