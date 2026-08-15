#!/bin/bash
# Copyright (C) 2025-2026 Malformed C. All rights reserved.
# SPDX-License-Identifier: BUSL-1.1
#
# CROSS-IMPLEMENTATION TEST: does this SDK actually speak trail's wire?
#
# WHY THIS EXISTS. magicseam_quic_test drives this SDK's server with this SDK's
# own client. That is a useful self-consistency check and it is structurally
# incapable of catching the thing that actually broke: on 2026-07-31 the caller
# frame was added to the protocol (3532417c), neither half of this SDK was
# updated, and C-to-C stayed GREEN for two weeks while C-against-trail was dead
# - the server was handing handlers the caller's bytes as if they were the
# request. A suite that only ever talks to itself cannot notice the wire moving.
#
# So this talks to TRAIL, the reference implementation, and asserts a real
# round trip through a real mTLS QUIC hop.
#
# IT DOES NOT SILENTLY SKIP. A test that quietly does nothing when its
# prerequisites are missing is how a gap like this survives - the absence of a
# failure gets read as a pass. Missing prerequisites are a LOUD non-zero exit;
# pass --allow-skip only where you genuinely cannot build trail, and accept that
# you are then not testing this.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TRAIL="$ROOT/cmd/trail/target/release/trail"
CONSUMER="$ROOT/examples/wasm/magic-consumer/target/wasm32-wasip2/release/magic_consumer.wasm"
PORT="${INTEROP_PORT:-19590}"
ALLOW_SKIP=0
[ "${1:-}" = "--allow-skip" ] && ALLOW_SKIP=1

missing=""
[ -x "$TRAIL" ] || missing="$missing\n  trail binary:  $TRAIL  (cd cmd/trail && cargo build --release)"
[ -f "$CONSUMER" ] || missing="$missing\n  consumer wasm: $CONSUMER  (cd examples/wasm/magic-consumer && cargo build --release --target wasm32-wasip2)"
command -v openssl >/dev/null 2>&1 || missing="$missing\n  openssl"
if [ -n "$missing" ]; then
  printf '\n*** INTEROP TEST CANNOT RUN - this is NOT a pass ***\nmissing:%b\n\n' "$missing" >&2
  if [ "$ALLOW_SKIP" = "1" ]; then
    echo "--allow-skip given: skipping. sdk/c is UNVERIFIED against trail's wire." >&2
    exit 0
  fi
  echo "Re-run with --allow-skip only if you accept leaving sdk/c unverified." >&2
  exit 2
fi

D="$(mktemp -d)"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$D"
}
trap cleanup EXIT

# Throwaway CA + two leaves. SERVER_NAME is fixed at "trail-quic-peer" on both
# sides of the seam (remote_quic.rs), so the SAN is not arbitrary.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$D/ca.key" -out "$D/ca.pem" -days 1 \
  -subj "/CN=trail-interop-ca" >/dev/null 2>&1
for who in server client; do
  openssl req -newkey rsa:2048 -nodes -keyout "$D/$who.key" -out "$D/$who.csr" \
    -subj "/CN=trail-quic-peer" >/dev/null 2>&1
  printf 'subjectAltName=DNS:trail-quic-peer\n' > "$D/$who.ext"
  openssl x509 -req -in "$D/$who.csr" -CA "$D/ca.pem" -CAkey "$D/ca.key" -CAcreateserial \
    -out "$D/$who.pem" -days 1 -extfile "$D/$who.ext" >/dev/null 2>&1
done

"$(dirname "$0")/interop_server" "tcp:127.0.0.1:$PORT" "$D/server.pem" "$D/server.key" "$D/ca.pem" \
  > "$D/server.log" 2>&1 &
SRV_PID=$!
sleep 3
if ! kill -0 "$SRV_PID" 2>/dev/null; then
  echo "FAIL: the C provider did not start" >&2
  cat "$D/server.log" >&2
  exit 1
fi

# magic-consumer calls periapsis:magic/handler and prints a WHOLE line only
# after a successful round trip whose reply it has already checked. So the
# presence of that line IS the assertion - a broken wire produces trail's
# "connection died; re-dialling" loop and no WHOLE line at all.
timeout 90 "$TRAIL" --p3 \
  --plug-remote-quic "tcp:127.0.0.1:$PORT" \
  --tls-cert "$D/client.pem" --tls-key "$D/client.key" --tls-ca "$D/ca.pem" \
  --component "$CONSUMER" > "$D/consumer.log" 2>&1
rc=$?

if grep -q 'WHOLE' "$D/consumer.log"; then
  echo "-- trail <-> sdk/c round trip --"
  grep -o 'WHOLE.*' "$D/consumer.log" | head -1
  echo "INTEROP TEST PASSED"
  exit 0
fi

echo "FAIL: trail could not complete a call against sdk/c (exit $rc)" >&2
echo "--- consumer ---" >&2
tail -6 "$D/consumer.log" >&2
echo "--- provider ---" >&2
tail -6 "$D/server.log" >&2
exit 1
