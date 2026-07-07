// Convenience wrappers around periapsis:magic/handler (ADR-0028's magic seam) -
// a versioned, fallible cross-component call the runtime binds across tiers
// (link / local-plug / remote-plug) transparently. `handle` is a PLAIN sync
// WIT func (not `async func`), so both the provider and consumer sides here
// are synchronous - a provider that needs async I/O isn't expressible through
// this seam (matches wit/magic/magic.wit's actual contract; the exec seam
// handles the "spawn a real async subprocess-like thing" case instead).
//
// Reference provider this was extracted/generalized from:
// examples/wasm/js-dwarf-plug's hand-rolled `throw { tag: "too-large" }`.

/** The seam's three WIT-defined failure modes (wit/magic/magic.wit's `error` variant). */
export type SeamErrorTag = "unavailable" | "rejected" | "too-large";

/**
 * Typed error a provider throws (instead of a raw `{ tag: "..." }` object
 * literal) to signal one of the seam's WIT error variants, and the shape a
 * consumer catches. `dwarf`'s export/import ABI encodes/decodes a thrown
 * `{ tag }` object as the WIT `result`'s `Err` case either way - this class
 * just gives both sides a typed, `instanceof`-checkable value instead of a
 * bare object literal.
 */
export class SeamError extends Error {
  readonly tag: SeamErrorTag;
  constructor(tag: SeamErrorTag) {
    super(`magic seam: ${tag}`);
    this.tag = tag;
  }
}
export const seamUnavailable = () => new SeamError("unavailable");
export const seamRejected = () => new SeamError("rejected");
export const seamTooLarge = () => new SeamError("too-large");

/**
 * Define a magic-seam PROVIDER export: wraps a plain `(request) => response`
 * function so that (a) a thrown `SeamError` encodes as the matching WIT error
 * variant, and (b) any OTHER unexpected exception (a provider bug) encodes as
 * `unavailable` rather than propagating as an uncaught host-side trap -
 * mirroring how a Local-plug provider TRAP already becomes `Unavailable` on
 * the host side (trail's plug.rs `dispatch`), so a buggy provider degrades the
 * same way whether the bug is a JS exception or a genuine wasm trap.
 *
 * Usage: `export const handler = definePlugProvider(request => transform(request))`
 */
export function definePlugProvider(
  handle: (request: Uint8Array) => Uint8Array,
): { handle: (request: Uint8Array) => Uint8Array } {
  return {
    handle(request: Uint8Array): Uint8Array {
      try {
        return handle(request);
      } catch (e) {
        if (e instanceof SeamError) throw { tag: e.tag };
        throw { tag: "unavailable" as const };
      }
    },
  };
}

/**
 * Call the magic seam as a CONSUMER (a component importing
 * periapsis:magic/handler) with the raw WIT `handle` import, converting its
 * thrown `{ tag }` error object into a typed `SeamError` instead of a bare
 * object literal - the consumer-side mirror of `definePlugProvider`.
 *
 * Usage:
 *   import { handle } from "periapsis:magic/handler@0.1.0"
 *   const response = callSeam(handle, request)
 */
export function callSeam(
  hostHandle: (request: Uint8Array) => Uint8Array,
  request: Uint8Array,
): Uint8Array {
  try {
    return hostHandle(request);
  } catch (e) {
    const tag = (e as { tag?: SeamErrorTag })?.tag;
    if (tag === "unavailable" || tag === "rejected" || tag === "too-large") {
      throw new SeamError(tag);
    }
    throw e;
  }
}
