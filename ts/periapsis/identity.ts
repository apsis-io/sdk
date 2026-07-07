// Wraps periapsis:component/identity@0.1.0. Split into its own module (rather
// than one big component.ts) because Vite/Rollup treats an `external` import
// (periapsis:*/wasi:* are marked external in every example's vite.config.ts,
// since dwarf/the host satisfies them, not the bundle) as having unknowable
// side effects and keeps it in the output even when the imported binding ends
// up unused - so a single shared module importing all six periapsis:component
// interfaces would force EVERY consumer's world.wit to import all six too,
// regardless of which ones it actually calls. Per-interface modules mean a
// consumer only pulls in (and must only declare) exactly what it imports -
// preserving this codebase's minimal-capability-surface principle
// (--host-caps: an unlisted interface fails closed at instantiation).

import { get as hostIdentityGet } from "periapsis:component/identity@0.1.0";

/** Host-provided pod/component identity (camelCase of the WIT identity-info). */
export function identity() {
  return hostIdentityGet();
}
