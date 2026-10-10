// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Perseid manifest generation - build and render a `Perseid` custom resource
 * (apiVersion `perseid.apsis/v1`, plural `perseids`, short name `psd`; the
 * CRD is `deploy/perseid-crd.yaml` in the periapsis tree, and it is the WHOLE
 * contract: there is no other schema to agree with).
 *
 * ***THE MANIFEST IS THE CODE***, in the CRD's own words: spec carries the
 * program - inline `step` or `stepRef.image`, never both - plus the optional
 * `engine`, `backstopMs` and `suspend`, and NOTHING else that could disagree
 * with it. There are no capabilities, reads or writes fields: admission
 * derives all three from the step itself and records the derivation on the
 * status. This module therefore has nothing to compute and nothing to keep in
 * step. It validates the fields that exist, renders them, and refuses to
 * invent the rest.
 *
 * ***THE KIND MERGE, 2026-10-10*** (engi: "remove PerseidTS, instead extend
 * Perseid CRD" + "perseid is perseid.apsis"): PerseidTS is gone - this IS the
 * merged destination, and its refusal words are the CRD's own CEL messages
 * where the two could be one voice. The wasm-era kind keeps its old world:
 * `path.perseids()` addresses `/apis/radiant.apsis/.../perseids/...`
 * (radiant.apsis Perseids, off `deploy/perseid-wasm-crd.yaml`), while the
 * kernel kind's paths are `/apis/perseid.apsis/v1/namespaces/NS/perseids/NAME`
 * - same plural, different group, no builder for it yet (reading a sibling's
 * `status.carry` needs one, and the WIT capability story is still host-side).
 *
 * The apply flow is plain `kubectl apply -f`, so `toYaml` is the primary
 * output. The built object is JSON-ready as-is:
 * `JSON.stringify(perseid(...))` is the JSON form - there is no `toJson`,
 * because a second name for `JSON.stringify` is a second thing to keep honest.
 */

/** The spec fields every program form carries. */
export interface PerseidObjectSpec {
  /**
   * The execution engine. IMPLIED BY THE PROGRAM SHAPE today - a `step` runs
   * the kinetics engine, a wasm `component` ran trail - and spelled here
   * anyway, so the choice is legible on the object. Admission refuses
   * `trail` for a TS step before the compile; so does this builder, with
   * the same words.
   */
  readonly engine?: 'kinetics' | 'trail'
  /** Park bound in milliseconds. Omit for the operator default; 0 is refused. */
  readonly backstopMs?: number
  /** The operator stops driving passes while this is true. */
  readonly suspend?: boolean
}

/**
 * The program: inline source, or a reference to the pushed OCI artifact.
 *
 * The `stepRef?: never` / `step?: never` arms are the compile-time half of the
 * mutual exclusion - the same refusal the CRD's CEL carries apiserver-side,
 * word for word. The builder repeats it at runtime for callers without the
 * types.
 */
export type PerseidSpec =
  | ({ readonly step: string; readonly stepRef?: never } & PerseidObjectSpec)
  | ({ readonly step?: never; readonly stepRef: { readonly image: string } } & PerseidObjectSpec)

/** Loose input: what a caller writes. Validated into a {@link PerseidManifest}
 * by {@link perseid}. */
export interface PerseidManifestInput {
  readonly metadata: {
    readonly name: string
    readonly namespace: string
    readonly labels?: Readonly<Record<string, string>>
    readonly annotations?: Readonly<Record<string, string>>
  }
  readonly spec: PerseidSpec
}

/** The validated manifest. `apiVersion` and `kind` are not input fields: a
 * field the caller cannot set cannot be mis-typed. */
export interface PerseidManifest {
  readonly apiVersion: 'perseid.apsis/v1'
  readonly kind: 'Perseid'
  readonly metadata: {
    readonly name: string
    readonly namespace: string
    readonly labels?: Readonly<Record<string, string>>
    readonly annotations?: Readonly<Record<string, string>>
  }
  readonly spec: PerseidSpec
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
        `perseid: metadata.${what} key "${k}" is not a Kubernetes label key - an optional DNS-1123 subdomain prefix, a '/', then a 63-char alphanumeric name.`,
      )
    }
    // ⚠ VALUES ARE VALIDATED FOR LABELS ONLY. An annotation's value is an
    // arbitrary string - that is the point of annotations, and it is
    // load-bearing here: the capability cross-check rides config annotations,
    // so a comma or a URL in one is normal, not suspect.
    if (what === 'labels' && !validLabelValue(v)) {
      throw new Error(
        `perseid: metadata.labels["${k}"] is not a Kubernetes label value - 63 chars, alphanumeric at the ends.`,
      )
    }
  }
}

/**
 * Build and validate a Perseid manifest.
 *
 * The refusals quote the host: the mutual-exclusion and neither-set
 * sentences are `ParseStepSource`'s own (minus its `stepref:` log prefix),
 * and they are ALSO the CRD's CEL messages verbatim - schema and admission
 * refuse with one voice, and this builder is the third copy of the same
 * words, which is the point.
 */
export const perseid = (input: PerseidManifestInput): PerseidManifest => {
  const { metadata, spec } = input

  if (!isDns1123Subdomain(metadata.name)) {
    throw new Error(
      `perseid: metadata.name "${metadata.name}" is not a DNS-1123 subdomain - lowercase alphanumerics, '-' and '.', 253 chars max.`,
    )
  }
  if (!isDns1123Label(metadata.namespace)) {
    throw new Error(
      `perseid: metadata.namespace "${metadata.namespace}" is not a DNS-1123 label - lowercase alphanumerics and '-', 63 chars max, no dots.`,
    )
  }
  checkEntries('labels', metadata.labels)
  checkEntries('annotations', metadata.annotations)

  if ('step' in spec && spec.step !== undefined && (typeof spec.step !== 'string' || spec.step === '')) {
    throw new Error(
      'perseid: spec.step is missing or not a string - a Perseid object without a step (or component) is not a kernel program',
    )
  }

  const hasStep = 'step' in spec && typeof spec.step === 'string' && spec.step !== ''
  const hasStepRef =
    'stepRef' in spec &&
    typeof spec.stepRef === 'object' &&
    spec.stepRef !== null &&
    typeof spec.stepRef.image === 'string' &&
    spec.stepRef.image !== ''

  if (hasStep && hasStepRef) {
    throw new Error('perseid: spec.step and spec.stepRef are mutually exclusive; set one')
  }
  if (!hasStep && !hasStepRef) {
    throw new Error('perseid: neither spec.step nor spec.stepRef is set')
  }
  if (spec.engine !== undefined && spec.engine !== 'kinetics' && spec.engine !== 'trail') {
    throw new Error('perseid: spec.engine must be "kinetics" or "trail".')
  }
  if (hasStep && spec.engine === 'trail') {
    // Admission's own sentence (internal/prime-perseid/admission.go), mine
    // only in the prefix: trail executes spec.component artifacts, and a TS
    // step naming it is refusing the kernel.
    throw new Error(
      'perseid: spec.engine=trail cannot run this program - trail executes spec.component artifacts, not a TS step; omit spec.engine or declare kinetics',
    )
  }
  if (spec.backstopMs !== undefined && !(Number.isInteger(spec.backstopMs) && spec.backstopMs > 0)) {
    throw new Error(
      'perseid: spec.backstopMs must be a positive integer number of milliseconds - 0 is the operator default in the CRD; omit the field to say that.',
    )
  }
  if (spec.suspend !== undefined && typeof spec.suspend !== 'boolean') {
    throw new Error('perseid: spec.suspend must be a boolean.')
  }

  return {
    apiVersion: 'perseid.apsis/v1',
    kind: 'Perseid',
    metadata: { ...metadata },
    spec: { ...spec },
  }
}

// ---------------------------------------------------------------------------
// YAML. The LAYOUT is ours - structural key order, the literal block for the
// step source - because kubectl-applied manifests are read by humans and
// block style is what `kubectl get -o yaml` produces. The SCALARS are Bun's:
// `Bun.YAML.stringify` emits bare-when-unambiguous and double-quoted
// otherwise (YAML 1.2 quoted scalars are JSON strings), which retires the
// hand-rolled safe-character regex this module used to carry. So toYaml runs
// where Bun runs - an ops-side tool, not a guest import; the builder above is
// pure TypeScript and portable everywhere.

/** One scalar, emitted by Bun.YAML (trailing newline stripped; the layout
 * owns line breaks). */
const scalar = (s: string): string => {
  if (typeof Bun === 'undefined') {
    throw new Error(
      'toYaml runs where Bun runs - it emits scalars through Bun.YAML. The builder is portable; render the YAML under bun.',
    )
  }
  return Bun.YAML.stringify(s).replace(/\n$/, '')
}

/**
 * Render a validated manifest as one YAML document - no leading `---`;
 * concatenating documents into one file is the caller's job.
 *
 * Throws if the step source carries a tab: a literal block scalar cannot
 * carry tabs, and the YAML reader would reject or reinterpret them.
 */
export const toYaml = (m: PerseidManifest): string => {
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
  if (m.spec.engine !== undefined) lines.push(`  engine: ${scalar(m.spec.engine)}`)
  if (m.spec.backstopMs !== undefined) lines.push(`  backstopMs: ${m.spec.backstopMs}`)
  if (m.spec.suspend !== undefined) lines.push(`  suspend: ${m.spec.suspend}`)

  return lines.join('\n') + '\n'
}
