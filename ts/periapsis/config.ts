// Wraps periapsis:component/config@0.1.0. See identity.ts's header comment for
// why this is its own module rather than folded into one big component.ts.

import { get as hostConfigGet } from "periapsis:component/config@0.1.0";

/** Read a config key (from periapsis.io/config.<key>); undefined if unset. */
export function config(key: string): string | undefined {
  const v = hostConfigGet(key); // option<config-value> -> T | null; throws on error
  if (v === null) return undefined;
  return v.tag === "text" ? v.val : String(v.val);
}
