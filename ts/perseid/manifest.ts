// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * PerseidTS manifest generation - build and render a `PerseidTS` custom
 * resource (apiVersion `perseid.apsis/v1`; the CRD is
 * `deploy/perseidts-crd.yaml` in the periapsis tree, and it is the WHOLE
 * contract: there is no other schema to agree with).
 *
 * ***THE MANIFEST IS THE CODE***, in the CRD's own words: spec carries the
 * program - inline `step` or `stepRef.image`, never both - plus `backstopMs`
 * and `suspend`, and NOTHING else that could disagree with it. There are no
 * capabilities, reads or writes fields: admission derives all three from the
 * step itself and records the derivation on the status. This module therefore
 * has nothing to compute and nothing to keep in step. It validates the fields
 * that exist, renders them, and refuses to invent the rest.
 *
 * ⚠ NOT the retired kind. `path.perseids()` addresses
 * `/apis/radiant.apsis/.../perseids/...` - the wasm-era Perseid, a different
 * object. This module speaks `perseid.apsis/v1 kind: PerseidTS`, which has no
 * path builder yet (a step that wants to read a sibling's `status.carry` needs
 * one, and the WIT capability story for that is still host-side).
 *
 * The apply flow is plain `kubectl apply -f`, so `toYaml` is the primary
 * output. The built object is JSON-ready as-is:
 * `JSON.stringify(perseidTS(...))` is the JSON form - there is no `toJson`,
 * because a second name for `JSON.stringify` is a second thing to keep honest.
 */

/** The spec fields every program form carries. */
export interface PerseidTSObjectSpec {
  /** Park bound in milliseconds. Omit for the operator default; 0 is refused. */
  readonly backstopMs?: number
  /** The operator stops driving passes while this is true. */
  readonly suspend?: boolean
}

/**
 * The program: inline source, or a reference to the pushed OCI artifact.
 *
 * The `stepRef?: never` / `step?: never` arms are the compile-time half of the
 * mutual exclusion; a literal carrying BOTH keys fails to typecheck, and the
 * builder repeats the refusal at runtime for callers without the types.
 */
export type PerseidTSSpec =
  | ({ readonly step: string; readonly stepRef?: never } & PerseidTSObjectSpec)
  | ({ readonly step?: never; readonly stepRef: { readonly image: string } } & PerseidTSObjectSpec)

/** Loose input: what a caller writes. Validated into a
 * {@link PerseidTSManifest} by {@link perseidTS}. */
export interface PerseidTSManifestInput {
  readonly metadata: {
    readonly name: string
    readonly namespace: string
    readonly labels?: Readonly<Record<string, string>>
    readonly annotations?: Readonly<Record<string, string>>
  }
  readonly spec: PerseidTSSpec
}

/** The validated manifest. `apiVersion` and `kind` are not input fields: a
 * field the caller cannot set cannot be mis-typed. */
export interface PerseidTSManifest {
  readonly apiVersion: 'perseid.apsis/v1'
  readonly kind: 'PerseidTS'
  readonly metadata: {
    readonly name: string
    readonly namespace: string
    readonly labels?: Readonly<Record<string, string>>
    readonly annotations?: Readonly<Record<string, string>>
  }
  readonly spec: PerseidTSSpec
}

const isDns1123Label = (s: string): boolean =>
  s.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s)

const isDns1123Subdomain = (s: string): boolean =>
  s.length <= 253 && s.split('.').every(isDns1123Label)

const k8sNameSegment = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/

const validLabelKey = (k: string): boolean => {
  const slash = k.indexOf('/')
  const name = slash === -1 ? k : k.slice(slash + 1)
  const prefix = slash === -1 ? undefined : k.slice(0, slash)
  return (
    name.length <= 63 &&
    k8sNameSegment.test(name) &&
    (prefix === undefined || isDns1123Subdomain(prefix))
  )
}

const validLabelValue = (v: string): boolean =>
  v.length <= 63 && (v === '' || /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/.test(v))

const checkEntries = (
  what: 'labels' | 'annotations',
  entries: Readonly<Record<string, string>> | undefined,
): void => {
  if (entries === undefined) return
  for (const [k, v] of Object.entries(entries)) {
    if (!validLabelKey(k)) {
      throw new Error(
        `perseidTS: metadata.${what} key "${k}" is not a Kubernetes label key - an optional DNS-1123 subdomain prefix, a '/', then a 63-char alphanumeric name.`,
      )
    }
    // ⚠ VALUES ARE VALIDATED FOR LABELS ONLY. An annotation's value is an
    // arbitrary string - that is the point of annotations, and it is
    // load-bearing here: the capability cross-check rides config annotations,
    // so a comma or a URL in one is normal, not suspect.
    if (what === 'labels' && !validLabelValue(v)) {
      throw new Error(
        `perseidTS: metadata.labels["${k}"] is not a Kubernetes label value - 63 chars, alphanumeric at the ends.`,
      )
    }
  }
}

/**
 * Build and validate a PerseidTS manifest.
 *
 * The refusals repeat, verbatim, the ones the host's own `ParseStepSource`
 * produces at admission - the same words at the boundary, so an author who
 * meets one here has already met the other.
 */
export const perseidTS = (input: PerseidTSManifestInput): PerseidTSManifest => {
  const { metadata, spec } = input

  if (!isDns1123Subdomain(metadata.name)) {
    throw new Error(
      `perseidTS: metadata.name "${metadata.name}" is not a DNS-1123 subdomain - lowercase alphanumerics, '-' and '.', 253 chars max.`,
    )
  }
  if (!isDns1123Label(metadata.namespace)) {
    throw new Error(
      `perseidTS: metadata.namespace "${metadata.namespace}" is not a DNS-1123 label - lowercase alphanumerics and '-', 63 chars max, no dots.`,
    )
  }
  checkEntries('labels', metadata.labels)
  checkEntries('annotations', metadata.annotations)

  const hasStep = 'step' in spec && typeof spec.step === 'string' && spec.step !== ''
  const hasStepRef =
    'stepRef' in spec &&
    typeof spec.stepRef === 'object' &&
    spec.stepRef !== null &&
    typeof spec.stepRef.image === 'string' &&
    spec.stepRef.image !== ''

  if (hasStep && hasStepRef) {
    throw new Error('perseidTS: spec.step and spec.stepRef are mutually exclusive; set one.')
  }
  if (!hasStep && !hasStepRef) {
    throw new Error(
      'perseidTS: neither spec.step nor spec.stepRef is set - a manifest with no program is not a program.',
    )
  }
  if (spec.backstopMs !== undefined && !(Number.isInteger(spec.backstopMs) && spec.backstopMs > 0)) {
    throw new Error(
      'perseidTS: spec.backstopMs must be a positive integer number of milliseconds - 0 is the operator default in the CRD; omit the field to say that.',
    )
  }
  if (spec.suspend !== undefined && typeof spec.suspend !== 'boolean') {
    throw new Error('perseidTS: spec.suspend must be a boolean.')
  }

  return {
    apiVersion: 'perseid.apsis/v1',
    kind: 'PerseidTS',
    metadata: { ...metadata },
    spec: { ...spec },
  }
}

// ---------------------------------------------------------------------------
// YAML. Zero deps, ~60 lines, and safe for exactly one reason: the schema is
// flat, so the writer renders from the TYPED fields in CRD presentation order
// and never walks an untyped object.

/** Bare iff it cannot possibly be misread; otherwise quoted. YAML 1.2
 * double-quoted scalars ARE JSON strings, so `JSON.stringify` is the quoting
 * layer - the same move as the expression language's `lit`, which is proven
 * against the host's decoder rather than hand-rolled. */
const scalar = (s: string): string =>
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) &&
  !/^(?:true|false|null|yes|no|on|off|~|[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i.test(s)
    ? s
    : JSON.stringify(s)

/**
 * Render a validated manifest as one YAML document - no leading `---`;
 * concatenating documents into one file is the caller's job.
 *
 * Throws if the step source carries a tab: a literal block scalar cannot
 * carry tabs, and the YAML reader would reject or reinterpret them.
 */
export const toYaml = (m: PerseidTSManifest): string => {
  const lines: string[] = [`apiVersion: ${scalar(m.apiVersion)}`, `kind: ${scalar(m.kind)}`, 'metadata:']

  lines.push(`  name: ${scalar(m.metadata.name)}`)
  lines.push(`  namespace: ${scalar(m.metadata.namespace)}`)
  for (const what of ['labels', 'annotations'] as const) {
    const entries = m.metadata[what]
    if (entries === undefined) continue
    lines.push(`  ${what}:`)
    for (const k of Object.keys(entries).sort()) {
      lines.push(`    ${scalar(k)}: ${scalar(entries[k])}`)
    }
  }

  lines.push('spec:')
  if (typeof m.spec.step === 'string') {
    const source = m.spec.step
    if (source.includes('\t')) {
      throw new Error(
        'toYaml: the step source carries a tab - a literal block scalar cannot carry tabs, and the YAML reader would reject or reinterpret them.',
      )
    }
    // Chomping is decided by the source, not chosen: `|` when it ends with
    // exactly one newline (clip keeps that newline), `|+` when it ends with
    // several (keep preserves them all), `|-` when it ends with none (strip
    // round-trips exactly). The manifest is the code - the rendered manifest
    // must hand back the bytes that went in.
    const endsWithNewline = source.endsWith('\n')
    const keep = endsWithNewline && source.endsWith('\n\n')
    lines.push(`  step: |${keep ? '+' : endsWithNewline ? '' : '-'}`)
    const body = endsWithNewline ? source.slice(0, -1) : source
    for (const line of body.split('\n')) {
      lines.push(line === '' ? '' : `    ${line}`)
    }
  } else {
    lines.push('  stepRef:')
    lines.push(`    image: ${scalar(m.spec.stepRef.image)}`)
  }
  if (m.spec.backstopMs !== undefined) lines.push(`  backstopMs: ${m.spec.backstopMs}`)
  if (m.spec.suspend !== undefined) lines.push(`  suspend: ${m.spec.suspend}`)

  return lines.join('\n') + '\n'
}
