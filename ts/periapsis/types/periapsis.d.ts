// Hand-written ambient module declarations matching dwarf's WIT<->JS mapping
// (option<T> -> T | null, u64 -> plain number, result<T,E> at a call site
// returns T / throws E) for every periapsis:* interface this package wraps.
// dwarf has no type-generation of its own (unlike jco - and even jco's own
// `--emit-types` doesn't actually match dwarf's runtime conventions, see
// exec.ts's header comment / the periapsis README), so there's
// nothing to run to keep these in sync - they're maintained by hand against
// the source-of-truth WIT (wit/periapsis/component.wit, wit/host/exec.wit,
// wit/magic/magic.wit).
//
// Split out from dwarf.d.ts (dwarf's own runtime globals, not WIT-derived)
// and wit.d.ts (the generic `wit`/Stream component-model-async plumbing) -
// three separate concerns, three separate files.
//
// Deliberately no top-level import/export (ambient SCRIPT, not module) - a
// top-level `export {}` here would turn this into a real ES module and break
// cross-referencing between the declare-module blocks below.

declare module "periapsis:component/identity@0.1.0" {
  export interface Attribute {
    key: string;
    value: string;
  }
  export interface IdentityInfo {
    component: string;
    instance: string;
    sdkVersion: string;
    workload: string | null | undefined;
    namespace: string | null | undefined;
    podName: string | null | undefined;
    podUid: string | null | undefined;
    pawnName: string | null | undefined;
    nodeName: string | null | undefined;
    attributes: Attribute[];
  }
  export function get(): IdentityInfo;
}

declare module "periapsis:component/config@0.1.0" {
  export type ConfigValue =
    | { tag: "text"; val: string }
    | { tag: "boolean"; val: boolean }
    | { tag: "signed"; val: number }
    | { tag: "unsigned"; val: number }
    | { tag: "float"; val: number }
    | { tag: "bytes"; val: Uint8Array }
    | { tag: "text-list"; val: string[] };
  export function get(key: string): ConfigValue | null;
}

declare module "periapsis:component/log@0.1.0" {
  export type Level = "trace" | "debug" | "info" | "warn" | "error";
  export interface Entry {
    level: Level;
    target: string | null | undefined;
    message: string;
    attributes: { key: string; value: string }[];
  }
  export function emit(entry: Entry): void;
}

declare module "periapsis:component/metrics@0.1.0" {
  export interface Labels {
    values: { key: string; value: string }[];
  }
  export function incrementCounter(name: string, by: number, labels: Labels): void;
  export function recordGauge(name: string, value: number, labels: Labels): void;
  export function recordHistogram(name: string, value: number, labels: Labels): void;
}

declare module "periapsis:component/status@0.1.0" {
  export type State = "starting" | "ready" | "degraded" | "failed" | "stopping";
  export interface Report {
    component: string;
    instance: string;
    state: State;
    reason: string | null | undefined;
    message: string | null | undefined;
    attributes: { key: string; value: string }[];
    sequence: number | null | undefined;
  }
  export function notify(report: Report): void;
}

declare module "periapsis:component/checkpoint@0.1.0" {
  export function requested(): boolean;
  export function save(state: Uint8Array): void;
  export function load(): Uint8Array | null;
}

declare module "periapsis:host/exec@0.1.0" {
  // StreamReadableU8 is declared in ./wit.d.ts (the generic component-model-
  // async stream plumbing, not periapsis-specific) - ambient scripts share one
  // global scope, so no import needed, just co-location.
  export class ChildProcess {
    static spawn(name: string, args: string[], stdin: StreamReadableU8): ChildProcess;
    stdout(): StreamReadableU8;
    wait(): Promise<number>;
  }
}

declare module "periapsis:magic/handler@0.1.0" {
  export function handle(request: Uint8Array): Uint8Array;
}
