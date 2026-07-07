// Wraps periapsis:component/log@0.1.0. See identity.ts's header comment for
// why this is its own module rather than folded into one big component.ts.

import { emit as hostLogEmit } from "periapsis:component/log@0.1.0";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

function attrs(o: Record<string, string>): { key: string; value: string }[] {
  return Object.entries(o).map(([key, value]) => ({ key, value }));
}

/** Structured log through the host (-> journal -> kubectl logs). */
export function log(level: LogLevel, message: string, a: Record<string, string> = {}): void {
  hostLogEmit({ level, target: undefined, message, attributes: attrs(a) });
}
export const trace = (m: string, a?: Record<string, string>) => log("trace", m, a);
export const debug = (m: string, a?: Record<string, string>) => log("debug", m, a);
export const info = (m: string, a?: Record<string, string>) => log("info", m, a);
export const warn = (m: string, a?: Record<string, string>) => log("warn", m, a);
export const error = (m: string, a?: Record<string, string>) => log("error", m, a);
