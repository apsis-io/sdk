// Wraps periapsis:component/checkpoint@0.1.0 (ADR-0028 Phase 7). See
// identity.ts's header comment for why this is its own module rather than
// folded into one big component.ts.

import {
  requested as hostCheckpointRequested,
  save as hostCheckpointSave,
  load as hostCheckpointLoad,
} from "periapsis:component/checkpoint@0.1.0";
import { stringToBytes, bytesToString } from "./codec.js";

/**
 * True when Trail wants a checkpoint before an imminent coordinated restart -
 * poll this and, when true, call `checkpointSave`, CLOSE WHAT YOU OPENED, and
 * return (the guest drives this; the host only persists/produces the bytes).
 *
 * Closing is part of the contract, not tidiness. Returning does NOT release your
 * resources - they belong to the host's store, which outlives the entrypoint
 * task. A listening socket left bound keeps completing TCP handshakes into a
 * backlog nothing will accept, which is not quiescent and keeps a tcpSocket
 * readiness probe green long after you stopped serving. Measured 2026-08-12: the
 * same component, differing only by dropping its listener before returning, gave
 * port STILL OPEN vs CLOSED. See periapsis:component/checkpoint in
 * sdk/c/periapsis/wit/component.wit for the canonical statement and for the gap
 * this does NOT cover (returning for a non-checkpoint reason).
 */
export function checkpointRequested(): boolean {
  return hostCheckpointRequested();
}

/**
 * Serialize `state` as JSON and persist it across the restart. Must be the
 * final call before returning - and close what you opened first - so the
 * checkpoint is a consistent, quiescent snapshot. A still-bound listening socket
 * is NOT quiescent; returning does not close it for you. Application-level,
 * hand-rolled state, not a raw memory dump
 * (dwarf has no memory-snapshot primitive - this hand-serialization approach
 * is the one Periapsis's ADR-0028 actually ships).
 */
export function checkpointSave(state: unknown): void {
  hostCheckpointSave(stringToBytes(JSON.stringify(state)));
}

/** The JSON state persisted by a prior `checkpointSave`; undefined on a cold start. */
export function checkpointLoad<T = unknown>(): T | undefined {
  const bytes = hostCheckpointLoad(); // option<list<u8>> -> Uint8Array | null
  if (bytes === null) return undefined;
  return JSON.parse(bytesToString(bytes)) as T;
}
