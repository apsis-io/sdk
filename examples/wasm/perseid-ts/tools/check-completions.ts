// Does the WIT interface argument still OFFER the known interface ids?
//
// ═══════════════════════════════════════════════════════════════════════════
// ***THIS EXISTS BECAUSE THE PROPERTY IS INVISIBLE TO THE TYPE CHECKER, AND
// THAT WAS MEASURED RATHER THAN ASSUMED*** (engi, 2026-08-29: "wit string =>
// auto completion", then "can you type wit string").
//
// `Wit` has to do two things at once: OFFER the three known ids, and REJECT a
// malformed one. Four forms were measured with the language service, and the
// obvious one is the trap:
//
//	KnownWit | (string & {})    completions 3   malformed rejected 0/2
//	KnownWit | WitId            completions 0   malformed rejected 2/2
//	KnownWit | (WitId & {})     completions 3   malformed rejected 2/2   ← shipped
//
// A template literal type in a union SUBSUMES the string literals for
// completion, so `KnownWit | WitId` silently offers NOTHING while every
// assertion about assignability still passes.
//
// ***MUTATION-TESTED: deleting the `& {}` from `Wit` produces NO COMPILER ERROR
// ANYWHERE.*** `tsgo --noEmit` is green, every type-level guard in
// perseid.test.ts is green, and the feature is gone. perseid.test.ts can only
// guard the nearest structural proxy — that `Wit` has not collapsed to `string`
// — and that proxy does not fire for this mutation. This tool is the only thing
// in the tree that does.
//
// It is a language-service query rather than a compile, because completion is a
// language-service fact and there is no other instrument that can see it.
// ═══════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'
import { writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The CJS build, deliberately: under bun the ESM entry resolves with `ts.sys`
// UNDEFINED, and the language-service host needs it for module resolution.
// The failure is a TypeError several frames from the cause.
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript')

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)))
const probe = join(projectDir, 'src', '__completion-probe.ts')

/** The ids that must be offered. Kept here, not imported, so a rename of the
 *  SDK constants cannot silently rename what this asserts. */
const WANT = [
  'perseid:reconcile/types@0.1.0',
  'perseid:reconcile/observe@0.1.0',
  'perseid:reconcile/observe-cluster@0.1.0',
  'perseid:reconcile/status@0.1.0',
]

const source = `import { defineEffect } from '@apsis-io/perseid/perseid'
const _probe = defineEffect<string, string>()('', 'get')
`
// The caret goes between the quotes of the FIRST argument.
const marker = "()('"
const position = source.indexOf(marker) + marker.length

const settings: import('typescript').CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
}

writeFileSync(probe, source)
try {
  const host: import('typescript').LanguageServiceHost = {
    getScriptFileNames: () => [probe],
    getScriptVersion: () => '1',
    getScriptSnapshot: (f) => {
      const text = f === probe ? source : ts.sys.readFile(f)

      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => projectDir,
    getCompilationSettings: () => settings,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }

  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const offered = new Set(
    (service.getCompletionsAtPosition(probe, position, {})?.entries ?? []).map((e) => e.name),
  )

  const missing = WANT.filter((w) => !offered.has(w))
  if (missing.length > 0) {
    console.error(`[check-completions] the wit argument offers ${offered.size} completion(s); these are MISSING:`)
    missing.forEach((m) => console.error(`    ${m}`))
    console.error(``)
    console.error(`  Wit = KnownWit | WitId  offers NOTHING: a template literal type in a union`)
    console.error(`  subsumes the string literals for completion. Keep the '& {}':`)
    console.error(``)
    console.error(`      export type Wit = KnownWit | (WitId & {})`)
    console.error(``)
    console.error(`  Nothing else in this tree can see this - tsgo is green either way.`)
    process.exit(1)
  }

  console.log(`[check-completions] ok: all ${WANT.length} known wit ids are offered at the argument`)
} finally {
  rmSync(probe, { force: true })
}
