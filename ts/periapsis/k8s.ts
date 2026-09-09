// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// PARTIAL, READ-ONLY PROJECTIONS OF THE OBJECTS A PERSEID OBSERVES - AND THE
// DEFAULTS KUBERNETES OMITS.
//
// ***THE TYPES ARE THE SMALL HALF. THE DEFAULTS ARE WHY THIS FILE EXISTS.***
// Every program that reads a Deployment or a Node re-derives the same rule, and
// they do not agree with each other. Measured across `examples/wasm/perseid-ts`:
//
//     simple.ts    `spec?: { replicas?: number }`         absent means ONE
//     canary.ts    `readyReplicas === undefined ? 0 : …`  absent means ZERO
//     execcheck.ts `readyReplicas ?? null`                absent must STAY absent
//     drainer.ts   `unschedulable` absent means FALSE
//
// Four programs, three different defaults, one API. ***Kubernetes OMITS a field
// at its default rather than writing it***, so absence is a real answer with a
// per-field meaning - and a program that guesses the wrong one is wrong in the
// direction that reads as healthy: `readyReplicas` defaulted to 1 would report a
// fully-down workload as satisfied.
//
// ⛔ ***SO THIS FILE OFFERS BOTH, AND REFUSES TO CHOOSE FOR YOU.*** The raw
// optional field stays on the type; the defaulted reading is a named function you
// call deliberately. `execcheck.ts` is the case that proves the raw one is not
// redundant: it projects `readyReplicas ?? null` onto a wire a CHILD component
// parses, and defaulting there would invent an observation the apiserver never
// made.
//
// ***TYPES ONLY AND A HANDFUL OF PURE FUNCTIONS, SO THE COST IS ZERO BYTES.***
// TypeScript types are erased, and the accessors below compile to a few
// comparisons. The SDK has no runtime dependencies and this does not add one:
// `@kubernetes/client-node` would be the obvious source for these shapes and is
// declined on exactly that ground.
//
// ⚠ ***PARTIAL ON PURPOSE, AND THAT IS WHAT MAKES IT SAFE TO HAND-WRITE.*** This
// repo has been bitten repeatedly by hand-maintained second copies of a contract
// (`wit.d.ts` declaring `held(): number[]` long after the text cutover;
// `hostcontract.Functions` refusing a program mid-deploy). A partial READ-ONLY
// projection of a GA API is a different risk: `apps/v1` and `v1` do not remove or
// retype fields, so an upstream ADDITION cannot break a reader that never looked
// at it. What would break this is a field changing meaning, which is what the
// per-field comments are for.

/** What every object carries. Only the parts a program has a reason to read. */
export interface ObjectMeta {
  readonly name?: string
  readonly namespace?: string
  /** Changes on ANY write to the object - the widest "something moved" signal. */
  readonly resourceVersion?: string
  /** Bumped on a SPEC change only; unchanged when only status moves. */
  readonly generation?: number
  readonly labels?: Readonly<Record<string, string>>
  readonly annotations?: Readonly<Record<string, string>>
  /** Set once a delete is requested; its presence is the signal, not its value. */
  readonly deletionTimestamp?: string
}

/**
 * A status condition, as every Kubernetes object spells them.
 *
 * ⚠ ***`status` IS THE THREE-VALUED STRING `"True"｜"False"｜"Unknown"`, NOT A
 * BOOLEAN***, and the third value is the one that gets collapsed. `Unknown` means
 * the controller could not determine it - which is not `False`, and treating it
 * as one reports a machine down because a probe was late.
 */
export interface ObjectCondition {
  readonly type?: string
  readonly status?: 'True' | 'False' | 'Unknown'
  readonly reason?: string
  readonly message?: string
}

export interface Deployment {
  readonly metadata?: ObjectMeta
  readonly spec?: {
    /** ⚠ OMITTED AT ITS DEFAULT OF **1**. See `wantedReplicas`. */
    readonly replicas?: number
  }
  readonly status?: {
    readonly replicas?: number
    /** ⛔ OMITTED AT **0** - the failure a watchdog exists for. See `readyReplicas`. */
    readonly readyReplicas?: number
    readonly availableReplicas?: number
    readonly unavailableReplicas?: number
    readonly observedGeneration?: number
    readonly conditions?: readonly ObjectCondition[]
  }
}

export interface Node {
  readonly metadata?: ObjectMeta
  readonly spec?: {
    /** ⚠ OMITTED ON A SCHEDULABLE NODE rather than written `false`. */
    readonly unschedulable?: boolean
  }
  readonly status?: {
    readonly conditions?: readonly ObjectCondition[]
  }
}

export interface Pod {
  readonly metadata?: ObjectMeta
  readonly status?: {
    readonly phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'
    readonly podIP?: string
    readonly conditions?: readonly ObjectCondition[]
  }
}

export interface ConfigMap {
  readonly metadata?: ObjectMeta
  readonly data?: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// THE DEFAULTS. One function per omitted field, named for what it answers.
//
// Each is the rule a program would otherwise write inline, and the inline
// versions in this repo did not agree. Call these when you want the NUMBER
// Kubernetes means; read the raw field when you need to know it was absent.
// ---------------------------------------------------------------------------

/**
 * Replicas the spec asks for. **Absent means 1**, which is the apiserver's
 * default for `apps/v1` Deployments.
 *
 * ⛔ NOT ZERO. Defaulting this to 0 makes an ordinary single-replica Deployment
 * look satisfied at zero ready pods - it inverts the verdict of every watchdog
 * that compares ready against wanted.
 */
export const wantedReplicas = (d: Deployment): number => d.spec?.replicas ?? 1

/**
 * Replicas actually ready. **Absent means 0.**
 *
 * ⛔ Kubernetes omits `readyReplicas` entirely when nothing is ready rather than
 * writing 0, so the total-outage case arrives as a MISSING FIELD. A reader that
 * treats absent as "unknown, skip" reports a fully-down workload as healthy.
 */
export const readyReplicas = (d: Deployment): number => d.status?.readyReplicas ?? 0

/** Whether the node is cordoned. **Absent means schedulable.** */
export const unschedulable = (n: Node): boolean => n.spec?.unschedulable ?? false

/**
 * A condition's status by type, THREE-VALUED, or `undefined` when the object
 * carries no such condition at all.
 *
 * ⚠ ***CONDITION ORDER IS NOT API.*** Indexing `conditions[0]` reads whichever
 * one the controller happened to write first; this searches by `type`, which is
 * the only stable way to name one - the same reason the park language grew a
 * `[?type=Ready]` selector rather than an index.
 */
export const conditionStatus = (
  conditions: readonly ObjectCondition[] | undefined,
  type: string,
): 'True' | 'False' | 'Unknown' | undefined =>
  conditions?.find((c) => c.type === type)?.status

/**
 * Is this object Ready? **Three-valued, and the third is not `false`.**
 *
 * `true` / `false` / `null` — where `null` covers BOTH `Unknown` and "no Ready
 * condition yet", because a program's correct response to either is the same:
 * it has not been told, so it must not conclude.
 */
export const isReady = (conditions: readonly ObjectCondition[] | undefined): boolean | null => {
  const s = conditionStatus(conditions, 'Ready')

  return s === 'True' ? true : s === 'False' ? false : null
}

// ---------------------------------------------------------------------------
// DECODERS, for `reader(observe, decode)`.
//
// ***`null` MEANS "THIS BODY IS NOT THAT OBJECT", AND `reader` MAPS IT TO
// `unknown` RATHER THAN `absent`.*** A body that does not parse is not an object
// that is not there - the read reached something and could not read it, which is
// the third value the whole model is built on.
// ---------------------------------------------------------------------------

const parse = <T>(raw: string): T | null => {
  try {
    const v: unknown = JSON.parse(raw)

    // A JSON scalar or array is a well-formed body that is not an object, and
    // casting one to a record would hand every accessor `undefined` and read as
    // a Deployment with no spec - indistinguishable from a real one.
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as T) : null
  } catch {
    return null
  }
}

export const asDeployment = (raw: string): Deployment | null => parse<Deployment>(raw)
export const asNode = (raw: string): Node | null => parse<Node>(raw)
export const asPod = (raw: string): Pod | null => parse<Pod>(raw)
export const asConfigMap = (raw: string): ConfigMap | null => parse<ConfigMap>(raw)
