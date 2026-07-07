// Wraps periapsis:component/status@0.1.0. Depends on identity.ts (status.notify
// needs the component/instance fields identity.get() provides) - a real
// dependency, not an artificial one, so a consumer using reportStatus
// legitimately needs both interfaces declared in its world.wit. See
// identity.ts's header comment for why interfaces are split into separate
// modules at all rather than one big component.ts.

import { notify as hostNotify } from "periapsis:component/status@0.1.0";
import { identity } from "./identity.js";

export type HealthState = "starting" | "ready" | "degraded" | "failed" | "stopping";

/**
 * Report component health (periapsis:component/status). On Trail this drives
 * the live ComponentHealth pod condition + readiness + transition events
 * (ADR-0026 Phase D).
 */
export function reportStatus(state: HealthState, message?: string): void {
  const id = identity();
  hostNotify({
    component: id.component,
    instance: id.instance,
    state,
    reason: undefined,
    message,
    attributes: [],
    sequence: undefined,
  });
}
