// Refresh the cluster vocabulary a step's editor completes from.
//
//	bun tools/gen-cluster-vocab.ts              # every namespace
//	bun tools/gen-cluster-vocab.ts -n default   # one
//	bun tools/gen-cluster-vocab.ts --check      # fail if the file is stale
//
// ═══════════════════════════════════════════════════════════════════════════
// ***RUN BY HAND, ON PURPOSE*** (engi, 2026-08-29: "it should be dynamic, maybe
// even updated from cluster manually").
//
// Nothing in the build runs this. A generated file that refreshes itself during
// a build makes the build depend on a reachable cluster and on WHICH cluster —
// two artifacts compiled from one commit would differ, and the diff would be
// completions rather than behaviour, so nobody would notice it was happening.
// This writes a file you can read, diff and commit.
//
// # WHAT IT READS, AND WHAT IT DELIBERATELY DOES NOT
//
// It reads OBJECTS THAT EXIST — deployment paths, deployment names, the label
// selectors pods actually carry. It does NOT read Perseid CRs, and that is the
// whole design decision:
//
//	spec.capabilities   AUTHORED. A typo shipped in a CR would become a
//	                    suggestion, which is the self-certifying loop
//	                    reconcile.wit warns about one level up.
//	spec.imports        The artifact's derived DEMAND. 44 entries for
//	                    scaler-v4, 39 of them wasi:* noise.
//
// An object that exists is a fact about the world; both of those are claims
// about a program. Completion should be built on the first.
//
// # IT AFFECTS COMPLETION ONLY
//
// The emitted file adds members to three empty interfaces in the SDK, so
// `keyof` yields a union of real values. Deleting it loses SUGGESTIONS and
// changes nothing about what type-checks: `ApiPath`, `WorkloadName` and
// `LabelSelector` each keep their shape constraint independently. A stale entry
// is a suggestion for an object that no longer exists — annoying, never wrong.
// ═══════════════════════════════════════════════════════════════════════════

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(projectDir, 'src', 'cluster-vocab.generated.ts')

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const nsFlag = argv.findIndex((a) => a === '-n' || a === '--namespace')
const namespace = nsFlag >= 0 ? argv[nsFlag + 1] : undefined

/** The SDK, spelled exactly as `src/*.ts` imports it - a module augmentation
 *  only merges when the specifier resolves to the same file. */
const SDK = '@apsis-io/perseid/perseid'

function kubectl(args: string[]): string {
  // The cluster is reached DIRECTLY. A proxy in the environment sends these at
  // an external endpoint and the failure reads as an unreachable cluster.
  const env = { ...process.env }
  for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    delete env[k]
  }
  try {
    return execFileSync('kubectl', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    console.error(`[gen-cluster-vocab] kubectl ${args.join(' ')} failed:`)
    console.error(`  ${(err.stderr || err.message || '').trim().split('\n')[0]}`)
    console.error(`  The vocabulary is UNCHANGED - a cluster that cannot be reached must not`)
    console.error(`  silently empty the file, because an empty one looks exactly like a`)
    console.error(`  cluster with nothing on it.`)
    process.exit(1)
  }
}

const scope = namespace ? ['-n', namespace] : ['-A']

// Deployments: the objects `scale` writes and `Replicas` reads.
const deployments = kubectl([
  'get', 'deploy', ...scope, '-o',
  'jsonpath={range .items[*]}{.metadata.namespace}{"\\t"}{.metadata.name}{"\\n"}{end}',
])
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [ns, name] = l.split('\t')

    return { ns, name }
  })

// Label selectors pods actually carry. `app` only: it is the convention every
// resume expression in this tree uses, and enumerating every label would offer
// a vocabulary nobody selects on.
const selectors = kubectl([
  'get', 'pods', ...scope, '-o', 'jsonpath={range .items[*]}{.metadata.labels.app}{"\\n"}{end}',
])
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((app) => `app=${app}`)

// Pod names and namespaces - the ARGUMENTS of `path.ns(...).pods(...)`, which
// is where completion lives now that a path is BUILT rather than typed.
const pods = kubectl([
  'get', 'pods', ...scope, '-o',
  'jsonpath={range .items[*]}{.metadata.namespace}{"\\t"}{.metadata.name}{"\\n"}{end}',
])
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [ns, name] = l.split('\t')

    return { ns, name }
  })

const uniq = (xs: string[]) => [...new Set(xs)].sort()

const paths = uniq(deployments.map((d) => `/apis/apps/v1/namespaces/${d.ns}/deployments/${d.name}`))
const names = uniq(deployments.map((d) => d.name))
const sels = uniq(selectors)
const namespaces = uniq([...deployments.map((d) => d.ns), ...pods.map((p) => p.ns)])
const podNames = uniq(pods.map((p) => p.name))

if (paths.length === 0 && sels.length === 0) {
  console.error('[gen-cluster-vocab] the cluster returned NO deployments and NO labelled pods.')
  console.error('  Refusing to write an empty vocabulary: it is indistinguishable from a')
  console.error('  successful run against the wrong cluster or namespace.')
  process.exit(1)
}

const members = (xs: string[]) =>
  xs.length === 0 ? '    // (none)' : xs.map((x) => `    ${JSON.stringify(x)}: true`).join('\n')

const body = `// GENERATED by tools/gen-cluster-vocab.ts - do not edit by hand.
//
// Refresh:  bun tools/gen-cluster-vocab.ts${namespace ? ` -n ${namespace}` : ''}
//
// COMPLETION ONLY. These add members to three empty interfaces in the SDK so
// \`keyof\` yields a union of objects that exist. Deleting this file loses
// suggestions and changes nothing about what type-checks - ApiPath,
// WorkloadName and LabelSelector each keep their shape constraint on their own.
//
// A stale entry suggests an object that is gone. That is annoying and never
// wrong, which is why this is refreshed by hand rather than by the build.

declare module '${SDK}' {
  /** Deployment paths - what \`observe.get\` and \`scale\` address. */
  interface KnownWorkloadPaths {
${members(paths)}
  }

  /** Deployment names - what \`Replicas\`/\`replicasNe\` address, resolved in the grant's namespace. */
  interface KnownWorkloadNames {
${members(names)}
  }

  /** Label selectors in use - what \`ListPods\`/\`countNe\` address. */
  interface KnownSelectors {
${members(sels)}
  }

  /** Namespaces that exist - the argument of \`path.ns(...)\`. */
  interface KnownNamespaces {
${members(namespaces)}
  }

  /** Pod names - the argument of \`path.ns(...).pods(...)\`. */
  interface KnownPodNames {
${members(podNames)}
  }
}

export {}
`

if (check) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : ''
  if (current !== body) {
    console.error('[gen-cluster-vocab] src/cluster-vocab.generated.ts is STALE.')
    console.error(`  Refresh: bun tools/gen-cluster-vocab.ts${namespace ? ` -n ${namespace}` : ''}`)
    process.exit(1)
  }
  console.log(
    `[gen-cluster-vocab] ok: ${paths.length} path(s), ${names.length} name(s), ` +
      `${sels.length} selector(s), ${namespaces.length} namespace(s), ${podNames.length} pod(s)`,
  )
  process.exit(0)
}

writeFileSync(out, body)
console.log(
  `[gen-cluster-vocab] wrote src/cluster-vocab.generated.ts: ` +
    `${paths.length} path(s), ${names.length} name(s), ${sels.length} selector(s), ` +
    `${namespaces.length} namespace(s), ${podNames.length} pod(s)`,
)
