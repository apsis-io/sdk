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
 * poll this and, when true, call `checkpointSave` as your LAST act before
 * returning (the guest drives this; the host only persists/produces the bytes).
 */
export function checkpointRequested(): boolean {
  return hostCheckpointRequested();
}

/**
 * Serialize `state` as JSON and persist it across the restart. Must be the
 * final call before returning so the checkpoint is a consistent, quiescent
 * snapshot - application-level, hand-rolled state, not a raw memory dump
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
