// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ═══════════════════════════════════════════════════════════════════════════
// TRAVERSAL OVER AN ENUMERATED COLLECTION - THE SET-VALUED HALF OF THE OBJECT
// GRAPH, IN THE GUEST.
//
// `reconcile.enumerate(collection)` hands a program every object it is already
// authorised to read. These are the edges over that set: the pods on a machine,
// the pods a workload owns. They are the `PodsOf`/`EventsFor` that
// `internal/aperture/graph.go` declined to add HOST-side, delivered where they
// cost nothing.
//
// ***WHY HERE AND NOT IN THE APERTURE, WHICH IS THE WHOLE DESIGN DECISION.***
// A host-side set edge would be usable in a PARK condition, and the wake index
// matches sets by LABEL SELECTOR - it stores a parsed `labels.Selector` and
// tests informer events against it. "Owned by this ReplicaSet" and "on this
// node" are not label selectors, so such a park could not be indexed and would
// fall back to the backstop while LOOKING subscribed. This repo has already
// decided that a park which looks subscribed and polls is worse than an honest
// deadline (see the drainer's `clusterRecheck`).
//
// Filtering in the guest has none of that: no new authority, no new symbol, no
// park that lies about its own liveness. The program holds the objects.
//
// ⚠ ***AND NONE OF IT IS AUTHORITY TO WRITE.*** `spec.writes` matches an object
// path exactly, so a name learned here was not declared and cannot be. Traversal
// is for DECIDING and REPORTING. That boundary is what lets admission prove no
// two Perseids claim one object, and it is not an oversight to route around.
// ═══════════════════════════════════════════════════════════════════════════

/** A Kubernetes object as it arrives from a collection read: decoded, untyped. */
export type K8sObject = Record<string, unknown>

/** The fields of an `ownerReference` this module reads. */
export type OwnerRef = {
  readonly kind: string
  readonly name: string
  readonly controller: boolean
}

/**
 * The items of a collection read, still untyped.
 *
 * ***RETURNS THE RAW ITEMS RATHER THAN OBJECTS, WHICH IS DELIBERATE.*** Dropping
 * a malformed entry here would decide policy for every caller, and the safe
 * policy differs: a drainer must treat an unreadable pod as STILL THERE, while a
 * reporter may skip it. So this answers only "did the host send a list", and
 * `asObject` lets a caller see what it is skipping.
 *
 * Null means the body is not a JSON array - a host or wire fault, never a fact
 * about the cluster.
 */
export const objectsIn = (raw: string): unknown[] | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  return Array.isArray(parsed) ? parsed : null
}

/** One item as an object, or null if it is not one. */
export const asObject = (item: unknown): K8sObject | null =>
  typeof item === 'object' && item !== null && !Array.isArray(item)
    ? (item as K8sObject)
    : null

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

const sub = (o: K8sObject, key: string): K8sObject | null =>
  asObject((o as Record<string, unknown>)[key])

/** `metadata.name`, or null if it is missing or not a string. */
export const nameOf = (o: K8sObject): string | null => {
  const meta = sub(o, 'metadata')

  return meta === null ? null : str(meta['name'])
}

/**
 * `spec.nodeName`, or null.
 *
 * ⚠ ***AN UNSCHEDULED POD HAS NO NODE, AND THAT IS NOT SOME NODE.*** The field is
 * empty until the scheduler places the pod, so null here is a real answer -
 * `internal/aperture/graph.go`'s `NodeOf` makes the same distinction and for the
 * same reason: a drainer reading it as a node acts on the wrong machine.
 */
export const nodeNameOf = (o: K8sObject): string | null => {
  const spec = sub(o, 'spec')

  return spec === null ? null : str(spec['nodeName'])
}

/** `status.phase`, or null. */
export const phaseOf = (o: K8sObject): string | null => {
  const status = sub(o, 'status')

  return status === null ? null : str(status['phase'])
}

/** Every well-formed `metadata.ownerReferences` entry. */
export const ownersOf = (o: K8sObject): OwnerRef[] => {
  const meta = sub(o, 'metadata')
  if (meta === null) return []
  const refs = meta['ownerReferences']
  if (!Array.isArray(refs)) return []

  const out: OwnerRef[] = []
  for (const r of refs) {
    const ref = asObject(r)
    if (ref === null) continue
    const kind = str(ref['kind'])
    const name = str(ref['name'])
    if (kind === null || name === null) continue
    out.push({ kind, name, controller: ref['controller'] === true })
  }

  return out
}

/**
 * The CONTROLLING owner, which is the one edge worth calling "the owner".
 *
 * ***NOT INDEX ZERO.*** An object may carry several ownerReferences and only one
 * may set `controller: true`; taking the first would follow a different edge
 * with the same shape. `internal/aperture/graph.go` picks the same way, and the
 * two must agree or a park and a step disagree about what owns a pod.
 */
export const controllerOf = (o: K8sObject): OwnerRef | null =>
  ownersOf(o).find((r) => r.controller) ?? null

/**
 * The objects scheduled on one machine.
 *
 * ***THE EDGE `count` CANNOT EXPRESS, WHICH IS WHY THIS MODULE EXISTS.***
 * `observe.count` takes a LABEL SELECTOR, and a pod's node is not a label - so
 * "the pods on machine X" was not a narrower version of an available query, it
 * was unavailable. Enumerating and filtering here is what makes it a query.
 */
export const onNode = (items: readonly K8sObject[], nodeName: string): K8sObject[] =>
  items.filter((o) => nodeNameOf(o) === nodeName)

/**
 * The objects a given owner controls - `PodsOf`, guest-side.
 *
 * Matches on the CONTROLLING reference, so a pod appears under exactly one
 * owner. Kind is compared exactly (`ReplicaSet`, not `replicaset`): an
 * ownerReference carries the Kind spelling, and a wrong capital is an owner that
 * silently never resolves.
 */
export const childrenOf = (
  items: readonly K8sObject[],
  owner: { readonly kind: string; readonly name: string },
): K8sObject[] =>
  items.filter((o) => {
    const c = controllerOf(o)

    return c !== null && c.kind === owner.kind && c.name === owner.name
  })
