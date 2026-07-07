// NOTE: importing this barrel pulls in EVERY periapsis:* interface these
// modules use, which (per identity.ts's header comment on Vite/Rollup's
// external-import handling) means your world.wit would need to import all of
// them regardless of which ones you actually call. Prefer importing directly
// from the specific module(s) you need (e.g. `./config.js`, `./log.js`) - this
// barrel is only for a consumer that already imports every periapsis:host
// capability anyway.
export * from "./codec.js";
export * from "./identity.js";
export * from "./config.js";
export * from "./log.js";
export * from "./metrics.js";
export * from "./status.js";
export * from "./checkpoint.js";
export * from "./exec.js";
export * from "./magic.js";
