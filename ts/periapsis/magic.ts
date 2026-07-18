// Convenience wrappers around periapsis:magic/handler (ADR-0028's magic seam) -
// a versioned, fallible cross-component call the runtime binds across tiers
// (link / local-plug / remote-plug) transparently. `handle` is `async func` in
// the WIT (component-model-async, WASI P3-only - see wit/magic/magic.wit's own
// doc comment) so trail's host-side plug dispatch can run genuinely
// concurrent in-flight calls into one local provider instead of serializing
// every call behind a single blocking host function - both the provider and
// consumer sides here are Promise-based to match. Built on `dwarf` (QuickJS +
// wit-dylib), which supports arbitrary async WIT funcs as plain JS `async
// function`s - see ~/git/dwarf's own README for the general pattern this
// relies on.
//
// Reference provider this was extracted/generalized from:
// examples/wasm/js-dwarf-plug's hand-rolled `throw { tag: "too-large" }`.

/** The seam's three WIT-defined failure modes (wit/magic/magic.wit's `error` variant). */
export type SeamErrorTag = "unavailable" | "rejected" | "too-large";

/**
 * Typed error a provider throws (instead of a raw `{ tag: "..." }` object
 * literal) to signal one of the seam's WIT error variants, and the shape a
 * consumer catches. `dwarf`'s export/import ABI encodes/decodes a thrown
 * `{ tag }` object as the WIT `result`'s `Err` case either way (unchanged by
 * a function being async - a thrown value inside an `async function` becomes
 * the rejected Promise's reason, which dwarf maps the same way) - this class
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
 * Define a magic-seam PROVIDER export: wraps a `(request) => response` function
 * (sync or async - either is awaited) so that (a) a thrown/rejected
 * `SeamError` encodes as the matching WIT error variant, and (b) any OTHER
 * unexpected exception (a provider bug) encodes as `unavailable` rather than
 * propagating as an uncaught host-side trap - mirroring how a Local-plug
 * provider TRAP already becomes `Unavailable` on the host side (trail's
 * plug.rs `dispatch`), so a buggy provider degrades the same way whether the
 * bug is a JS exception or a genuine wasm trap. The returned `handle` is
 * itself an `async function`, matching the WIT's `async func` export shape -
 * dwarf requires a real JS `async function` for an async WIT export, a plain
 * function returning a Promise is not equivalent.
 *
 * Usage: `export const handler = definePlugProvider(request => transform(request))`
 * (or `async (request) => { ...; return transform(request); }` for a provider
 * that itself needs to await something, e.g. a WASI 0.3 import).
 */
export function definePlugProvider(
  handle: (request: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): { handle: (request: Uint8Array) => Promise<Uint8Array> } {
  return {
    async handle(request: Uint8Array): Promise<Uint8Array> {
      try {
        return await handle(request);
      } catch (e) {
        if (e instanceof SeamError) throw { tag: e.tag };
        throw { tag: "unavailable" as const };
      }
    },
  };
}

/**
 * Call the magic seam as a CONSUMER (a component importing
 * periapsis:magic/handler) with the raw WIT `handle` import (an async
 * function - must be awaited), converting its thrown/rejected error object
 * into a typed `SeamError` instead of a bare object literal - the
 * consumer-side mirror of `definePlugProvider`.
 *
 * Confirmed empirically (examples/wasm/js-dwarf-magic-consumer's own
 * validation - NOT documented in dwarf's own README as of this writing): an
 * IMPORTED async func's thrown error arrives NESTED as `{ payload: { tag } }`,
 * unlike an EXPORTED async func's own thrown error, which dwarf delivers as a
 * flat `{ tag }` (definePlugProvider's own convention above) - imports and
 * exports are wrapped differently. Checked defensively (payload-nested
 * first, flat as a fallback) since this asymmetry isn't a documented, stable
 * contract.
 *
 * Usage:
 *   import { handle } from "periapsis:magic/handler@0.1.0"
 *   const response = await callSeam(handle, request)
 */
export async function callSeam(
  hostHandle: (request: Uint8Array) => Promise<Uint8Array>,
  request: Uint8Array,
): Promise<Uint8Array> {
  try {
    return await hostHandle(request);
  } catch (e) {
    const tag =
      (e as { payload?: { tag?: SeamErrorTag } })?.payload?.tag ??
      (e as { tag?: SeamErrorTag })?.tag;
    if (tag === "unavailable" || tag === "rejected" || tag === "too-large") {
      throw new SeamError(tag);
    }
    throw e;
  }
}
