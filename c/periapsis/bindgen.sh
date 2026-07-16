#!/usr/bin/env sh
# Regenerate the wit-bindgen C bindings from ./wit into ./generated.
# Run this after any change to wit/. Requires wit-bindgen (>= 0.59) on PATH.
#
# The generated files (trail_host.{c,h} + trail_host_component_type.o) are
# checked in so consumers don't need wit-bindgen just to build the SDK; this
# script is how you refresh them.
set -eu
cd "$(dirname "$0")"
wit-bindgen c wit --world trail-host --out-dir generated
echo "regenerated generated/trail_host.{c,h} + trail_host_component_type.o from wit/"
