// Derive a component's WIT imports from the TYPES of the step it exports.
//
// ADR-0075's thesis is that a program's dependencies should come from the code
// rather than from a manifest maintained beside it. `--inspect-imports` already
// reads a built component's imports; this is the other direction — reading them
// out of the source before the component exists.
//
// How: a step's inferred type is Generator<Y, Outcome, any>, where Y is the
// union of every effect it can perform (see src/main.ts — that union IS the
// capability set, tracked by the compiler). Each effect type carries a
// type-only `wit?: '<interface>'` marker, so the world is a projection of Y.
//
// Usage:
//   bun tools/derive-wit.ts src/main.ts step            # print derived world
//   bun tools/derive-wit.ts src/main.ts step --check    # fail if derived/step.wit differs
//   bun tools/derive-wit.ts src/main.ts step --spec     # print the Perseid spec fields
//   bun tools/derive-wit.ts src/main.ts step --check --world wit/world.wit
//   bun tools/derive-wit.ts <e> <s> --selftest-world    # prove the world checker can fail
//
// EXIT 1 on drift, so it can gate a build.
//
// --spec exists because the SAME set is needed in two places, and until it
// existed the second one was hand-written. A Perseid's spec.imports declares
// what the component imports and spec.capabilities grants them; Radiant refuses
// a program whose declaration disagrees with the artifact (declaration-mismatch,
// internal/trailop/perseidimports.go). Hand-maintaining a list whose drift is a
// refusal is a standing outage waiting on someone adding an effect, so the list
// comes from the same projection the world does.
//
// It prints imports and capabilities as the SAME list, which is the useful
// default and not an identity: capabilities is what you GRANT, so narrowing it
// below imports is a deliberate act that fails closed at link time. Widening it
// past imports grants something the code cannot reach.
//
// --world <file> checks THE BUILD WORLD - the file dwarf actually compiles
// against (build.sh passes wit/world.wit) - against the demand this tool just
// derived. *** NOTHING ELSE COMPARED THEM *** until 2026-08-26: --check compares
// source against derived/step.wit, dwarf compiles against wit/world.wit, and the
// two were free to disagree. They did: world.wit got its imports fixed on
// 2026-08-25 (75a710249) and STILL declares no export of step, because nothing
// below ever read it - so scaler:v5 built green, ingested green, admitted green,
// and died in trail's linker as default/scaler-v4 with "no exported instance
// named perseid:reconcile/step@0.1.0" (42 passes in 12h). A world check runs
// here rather than in CI because the mistake happens AT BUILD TIME and the
// cheapest place to catch it is one step earlier than the compiler that would
// have silently dropped it.

import ts from 'typescript'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const entry = argv[0]
const stepName = argv[1]
let mode = ''
let worldPath = ''
let worldName = ''
let worldUnion: string[] = []
let derivedPath = 'derived/step.wit'
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--world') {
    worldPath = argv[++i] ?? ''
    if (!worldPath) {
      console.error('usage: --world <wit file the build compiles against>')
      process.exit(2)
    }
  } else if (argv[i] === '--world-name') {
    worldName = argv[++i] ?? ''
    if (!worldName) {
      console.error('--world-name needs a world name')
      process.exit(2)
    }
  } else if (argv[i] === '--world-union') {
    // ***THE WORLD IS THE UNION OF EVERY ENTRYPOINT'S DEMAND, AND UNTIL 2026-08-31
    // THIS TOOL COULD ONLY ASK ABOUT ONE.*** A component exporting `step` AND
    // `finalize` has two generators with different yield types - the janitor's
    // step CREATES the object it owns and its finalizer DELETES it, so neither
    // demands the other's capability. Checked one at a time, the world reports
    // each entrypoint's sibling capability as "declared and never demanded",
    // which is true of that entrypoint and false of the component.
    //
    // Naming every entrypoint's DERIVED file lets the world check union their
    // demands. Reading the derived files rather than re-deriving is deliberate:
    // each has just been verified against its own generator by the --check above,
    // so they are the demands, already proven, and the union needs no second
    // derivation that could disagree with the first. The
    // per-entrypoint DERIVED check is unaffected: that is a property of one
    // generator and stays one.
    worldUnion = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    if (worldUnion.length === 0) {
      console.error('--world-union needs a comma-separated list of derived wit files')
      process.exit(2)
    }
  } else if (argv[i] === '--derived') {
    // ***ONE PROJECT, MORE THAN ONE COMPONENT.*** The derived file is per-ENTRY
    // - it is that entry's demand, read out of its own Generator yield type -
    // so a second entry needs a second file or the two overwrite each other and
    // the check compares one component's code against the other's capabilities.
    //
    // Defaulted rather than required, so every existing invocation is unchanged.
    derivedPath = argv[++i] ?? ''
    if (!derivedPath) {
      console.error('usage: --derived <path to this entry\'s derived wit>')
      process.exit(2)
    }
  } else {
    mode = argv[i]
  }
}
if (!entry || !stepName) {
  console.error('usage: derive-wit.ts <entry.ts> <stepExportName> [--check|--write] [--world <wit>]')
  process.exit(2)
}

// ─── build-world checking ───────────────────────────────────────────────────
//
// Textual on purpose: this file has no WIT parser and pulling one in to compare
// IDENTIFIERS is how a guard grows dependencies. The grammar these two files use
// is one declaration per line ending in ';', which is what every world in this
// tree is written as. A parse that finds NOTHING is an instrument failure, not a
// clean result - same rule ci/verify-wit-imports.sh applies to its LIVE set -
// so parseWorld throws rather than returning empty sets.

// ⚠ ***A MULTI-WORLD FILE IS AMBIGUOUS AND THIS USED TO ANSWER ANYWAY.***
//
// parseWitDecls scanned EVERY line of the file, so a `wit/world.wit` holding two
// worlds reported the UNION of their imports. That was invisible while both
// worlds declared the same set, and became wrong the moment they did not:
// migrating one component from `workloads` to `ensure` made the check fail for
// the two components that had not moved, reporting `ensure` as "declared and
// never demanded" against a world that does not declare it.
//
// So a name is required once there is more than one world. NOT a default to the
// first, and not a union: both silently answer a question about a world the
// caller did not ask about, which is what produced the confusing failure.
function worldRegion(src: string, worldName: string): string {
  const names = [...src.matchAll(/^world\s+([A-Za-z0-9_-]+)\s*\{/gm)].map((m) => m[1])
  if (!worldName) {
    if (names.length > 1) {
      throw new Error(
        `the build world declares ${names.length} worlds (${names.join(', ')}) and no ` +
          `--world-name was given. Scanning all of them reports the UNION of their imports, ` +
          `which is a question about no world in particular - pass --world-name <name>.`,
      )
    }

    return src
  }
  const start = src.search(new RegExp(`^world\\s+${worldName}\\s*\\{`, 'm'))
  if (start < 0) {
    throw new Error(
      `no world named '${worldName}' in the build world (found: ${names.join(', ') || 'none'})`,
    )
  }
  // Worlds do not nest, so the first line that is a bare `}` ends this one.
  const rest = src.slice(start)
  const end = rest.search(/^\}/m)

  return end < 0 ? rest : rest.slice(0, end)
}

function parseWitDecls(src: string): { imports: Set<string>, exports: Set<string> } {
  const imports = new Set<string>()
  const exports = new Set<string>()
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//')) continue
    const m = /^(import|export)\s+([A-Za-z0-9_:@/.-]+)\s*;/.exec(line)
    if (!m) continue
    // Version-stripped FULL id (`perseid:reconcile/observe`), so qualified and
    // versioned spellings compare equal; includes are NOT imports and a bare
    // `include wasi:cli/command@0.3.0;` correctly matches neither arm.
    const id = m[2].split('@')[0]
    ;(m[1] === 'import' ? imports : exports).add(id)
  }

  return { imports, exports }
}

function ifaceName(id: string): string {
  return id.split('/').pop()!
}

// Returns one human-readable problem per finding, EMPTY when the world is good.
// Each problem names the mechanism - what will fail, where, and which shipped
// incident it is - because a red that does not name the mechanism is a guess.
export function checkWorld(worldSrc: string, demandImports: string[], entrypoint: string, worldName = ''): string[] {
  const w = parseWitDecls(worldRegion(worldSrc, worldName))
  if (w.imports.size === 0 && w.exports.size === 0) {
    throw new Error(`parsed no import/export declarations from the build world - that is a broken instrument or a non-WIT file, not a clean pass`)
  }

  const problems: string[] = []
  // Version-normalised on BOTH sides: the demand spells full ids
  // (`perseid:reconcile/observe@0.1.0`), parseWitDecls stores them stripped.
  // Comparing one side versioned and the other not would report every import
  // missing - a guard that fails on everything is removed by the second person
  // who runs it.
  const demand = new Set(demandImports.map((d) => d.split('@')[0]))

  const unsupplied = [...demand].filter((d) => !w.imports.has(d))
  if (unsupplied.length) {
    problems.push(
      `error: the build world does not supply ${unsupplied.length} capability the code demands:` +
        `\n       ${unsupplied.join('\n       ')}` +
        `\n       dwarf builds against THIS file, so the built component lacks those` +
        `\n       imports entirely - the source calls them and nothing binds them.` +
        `\n       Fix wit/world.wit (or regenerate ${derivedPath} if the source moved).`,
    )
  }

  const unused = [...w.imports].filter((i) => !demand.has(i))
  if (unused.length) {
    problems.push(
      `error: the build world declares ${unused.length} capability the code never demands:` +
        `\n       ${unused.join('\n       ')}` +
        `\n       The built component will import them and the host linker must bind` +
        `\n       them anyway - the shape that killed scaler:v1 when emit was deleted.` +
        `\n       Align wit/world.wit with ${derivedPath}.`,
    )
  }

  const exportNames = [...w.exports].map(ifaceName)
  if (!exportNames.includes(entrypoint)) {
    problems.push(
      `error: the build world declares NO export of '${entrypoint}'` +
        `(exports found: ${exportNames.length ? exportNames.map((n) => `'${n}'`).join(', ') : 'none'}).` +
        `\n       The component will build and admit, and trail's instantiate will fail` +
        `\n       with "no exported instance named perseid:reconcile/${entrypoint}@<ver>"` +
        `\n       inside the pod - exactly how scaler:v5 shipped to default/scaler-v4.` +
        `\n       Add 'export perseid:reconcile/${entrypoint};' to the world (or implement` +
        `\n       '${entrypoint}' in the source - a world cannot export what no code provides).`,
    )
  }

  return problems
}

// Prove the checker can fail before anybody trusts a pass from it - the same
// precedent verify-wit-imports.sh set with --selftest. The bad cases are not
// hypothetical shapes: case 3 is perseid-ts's world AS IT SHIPPED scaler:v5, and
// case 1's export line is reactor-probe's real spelling, so the parser is pinned
// to both forms that exist in this tree rather than to a fixture invented here.
if (mode === '--selftest-world') {
  const cases: Array<{ name: string, src: string, wantFail: boolean }> = [
    {
      name: 'qualified export passes (reactor-probe spelling)',
      src: 'package p:x@0.1.0;\n\nworld w {\n  import perseid:reconcile/observe@0.1.0;\n  export perseid:reconcile/step@0.1.0;\n}\n',
      wantFail: false,
    },
    {
      // Supplies the demand import as well, so this case can only be deciding
      // the EXPORT SPELLING. Without that line it went red on the unsupplied-
      // import arm and read as "a bare export is rejected", which is a false
      // account of a working checker - the fixture was wrong, not the code.
      name: 'bare local export passes',
      src: 'world w {\n  import perseid:reconcile/observe@0.1.0;\n  export step;\n}\n',
      wantFail: false,
    },
    {
      name: 'no export fails naming the mechanism (scaler:v5 as shipped)',
      src: 'world w {\n  import perseid:reconcile/observe@0.1.0;\n  include wasi:cli/command@0.3.0;\n}\n',
      wantFail: true,
    },
    {
      name: 'unsupplied demand import fails',
      src: 'world w {\n  import perseid:reconcile/status@0.1.0;\n  export perseid:reconcile/step@0.1.0;\n}\n',
      wantFail: true,
    },
    {
      name: 'world-only import fails (the emit shape)',
      src: 'world w {\n  import perseid:reconcile/emit@0.1.0;\n  import perseid:reconcile/observe@0.1.0;\n  export step;\n}\n',
      wantFail: true,
    },
  ]

  let bad = 0
  for (const c of cases) {
    const problems = checkWorld(c.src, ['perseid:reconcile/observe@0.1.0'], 'step')
    const failed = problems.length > 0
    if (failed === c.wantFail) {
      console.log(`[derive-wit] selftest-world ok:   ${c.name}`)
    } else {
      bad++
      console.error(`[derive-wit] selftest-world FAIL: ${c.name} - wanted ${c.wantFail ? 'failure' : 'pass'}, got the opposite`)
    }
  }

  // *** THE POSITIVE CONTROL IS A REAL FILE, NOT A FIXTURE. *** A guard that
  // refuses everything is indistinguishable from one that works, and the five
  // cases above are all strings typed in this file - they prove the predicate,
  // not that any world in this tree can satisfy it. reactor-probe is the
  // smallest real reactor here: it exports step and deliberately imports
  // nothing.
  //
  // *** PAIRED WITH ITS OWN DEMAND, WHICH IS THE PART THAT WAS WRONG FIRST. ***
  // Run against perseid-ts's 3-import demand it goes RED - correctly, because
  // that pairs one component's world with another's code, and the refusal is
  // about the imports rather than about the export arm this control exists to
  // exercise. A control has to be a pair that could actually be built.
  const ctlPath = '../reactor-probe/wit/world.wit'
  try {
    const ctl = checkWorld(readFileSync(ctlPath, 'utf8'), [], 'step')
    if (ctl.length === 0) {
      console.log(`[derive-wit] selftest-world ok:   ${ctlPath} PASSES (real-file positive control)`)
    } else {
      bad++
      console.error(`[derive-wit] selftest-world FAIL: ${ctlPath} must pass - a guard that refuses`)
      console.error(`             every world is indistinguishable from one that works:\n${ctl.join('\n')}`)
    }
  } catch (e) {
    bad++
    console.error(`[derive-wit] selftest-world FAIL: could not read the control ${ctlPath}: ${e}`)
  }

  // Instrument-failure arm: garbage input must THROW, not pass silently.
  try {
    checkWorld('this is not wit at all\n', [], 'step')
    bad++
    console.error('[derive-wit] selftest-world FAIL: non-WIT input did not throw')
  } catch {
    console.log('[derive-wit] selftest-world ok:   non-WIT input throws instead of passing')
  }

  if (bad) process.exit(1)
  console.log('[derive-wit] selftest-world: all cases behaved')
  process.exit(0)
}

const program = ts.createProgram([entry], {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
})
const checker = program.getTypeChecker()
const sf = program.getSourceFile(entry)
if (!sf) throw new Error(`cannot load ${entry}`)

// Find the step by name — a function declaration, OR a const bound to a
// callable.
//
// ***THE SECOND FORM WAS UNREACHABLE UNTIL 2026-08-29 AND IT SILENTLY DISABLED
// THE SDK'S OWN STEP SUGAR.*** `defineStep` (engi: "step syntax sugar, with
// types") produces `const step = defineStep(function* () {…})`, which is a
// VariableStatement — so this walk found nothing and the tool died with "no
// function declaration named 'step'", one step before the world was derived.
//
// That is the failure mode this tool exists to prevent, arriving in the tool:
// a program using the sugar could not have its capabilities derived at all, so
// the manifest would have to be hand-written and free to drift. Measured
// against src/sugar.ts, which is exactly that shape.
let decl: ts.Node | undefined
ts.forEachChild(sf, (n) => {
  if (ts.isFunctionDeclaration(n) && n.name?.text === stepName) decl = n
  if (ts.isVariableStatement(n)) {
    for (const d of n.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === stepName) decl = d
    }
  }
})
if (!decl) throw new Error(`no function declaration or const named '${stepName}' in ${entry}`)

// Its return type is Generator<Y, R, N>; Y is the capability union.
//
// Read off the step's TYPE rather than its declaration, because the two forms
// have nothing in common syntactically and everything in common here: a
// function declaration and a const holding `() => Step<E, Outcome>` both have
// one call signature returning the same Generator.
const stepType = checker.getTypeAtLocation(decl)
const sigs = stepType.getCallSignatures()
if (sigs.length === 0) {
  throw new Error(
    `'${stepName}' in ${entry} is not callable (${checker.typeToString(stepType)}) - a step is ` +
      `a generator FUNCTION, or a const holding one (e.g. defineStep(function* () {…}))`,
  )
}
const ret = checker.getReturnTypeOfSignature(sigs[0])
const args = checker.getTypeArguments(ret as ts.TypeReference)
if (!args?.length) throw new Error(`'${stepName}' does not return a Generator`)
const yielded = args[0]

// Project each member of the union onto its declared WIT interface.
const members = yielded.isUnion() ? yielded.types : [yielded]
const ifaces = new Set<string>()
const unmarked: string[] = []
for (const m of members) {
  const prop = m.getProperty('wit')
  const t = prop ? checker.getTypeOfSymbolAtLocation(prop, decl) : undefined
  // optional property -> string literal | undefined; take the literal(s)
  const parts = t?.isUnion() ? t.types : t ? [t] : []
  const lits = parts.filter((p) => p.isStringLiteral()).map((p) => (p as ts.StringLiteralType).value)
  if (lits.length === 0) unmarked.push(checker.typeToString(m))
  lits.forEach((l) => ifaces.add(l))
}

// FAIL CLOSED. An effect with no `wit` marker means the derived world is
// silently incomplete, which is worse than no derivation at all — the whole
// point is that the manifest cannot drift from the code.
if (unmarked.length) {
  console.error(`error: ${unmarked.length} effect type(s) carry no 'wit' marker, so the`)
  console.error(`       derived world would be incomplete. Add a 'readonly wit?:' field to:`)
  unmarked.forEach((u) => console.error(`         ${u}`))
  process.exit(1)
}

const sorted = [...ifaces].sort()
const world = [
  `// DERIVED from ${entry} by tools/derive-wit.ts — do not edit by hand.`,
  `// These are the capabilities '${stepName}' can actually perform, read out of`,
  `// its inferred Generator yield type. Regenerate with: bun tools/derive-wit.ts ${entry} ${stepName} --write`,
  ``,
  `world ${stepName}-derived {`,
  ...sorted.map((i) => `  import ${i};`),
  `}`,
  ``,
].join('\n')

if (mode === '--spec') {
  // YAML fragment, paste-able under a Perseid's `spec:`. Sorted, like the world,
  // so regenerating it produces no diff when nothing changed.
  const list = sorted.map((i) => `    - ${i}`).join('\n')
  await Bun.write(Bun.stdout, 
    [
      `  # DERIVED from ${entry} by tools/derive-wit.ts --spec — do not edit by hand.`,
      `  imports:`,
      list,
      `  capabilities:`,
      list,
      ``,
    ].join('\n'),
  )
  process.exit(0)
}

const out = derivedPath
if (mode === '--write') {
  writeFileSync(out, world)
  console.log(`wrote ${out} (${sorted.length} imports)`)
} else if (mode === '--check') {
  const have = existsSync(out) ? readFileSync(out, 'utf8') : ''
  if (have !== world) {
    console.error(`error: ${out} is stale — the code's capabilities changed.`)
    console.error(`       regenerate: bun tools/derive-wit.ts ${entry} ${stepName} --write`)
    console.error('--- derived ---')
    console.error(world)
    process.exit(1)
  }
  console.log(`derive-wit: ${out} matches the code (${sorted.length} imports)`)

  if (worldPath) {
    let worldSrc: string
    try {
      worldSrc = readFileSync(worldPath, 'utf8')
    } catch (e) {
      // An unreadable build world is an INSTRUMENT failure, not a pass - exit 2
      // so "could not check" can never be scripted as "checked".
      console.error(`error: could not read the build world ${worldPath}: ${e}`)
      process.exit(2)
    }
    let problems: string[]
    try {
      let demand = sorted
      if (worldUnion.length > 0) {
        const all = new Set(sorted)
        for (const f of worldUnion) {
          for (const m of readFileSync(f, 'utf8').matchAll(/^\s+import\s+([^;]+);/gm)) {
            all.add(m[1].trim())
          }
        }
        demand = [...all].sort()
      }
      problems = checkWorld(worldSrc, demand, stepName, worldName)
    } catch (e) {
      console.error(`[derive-wit] BROKEN: ${(e as Error).message}`)
      process.exit(2)
    }
    if (problems.length) {
      for (const p of problems) console.error(p)
      process.exit(1)
    }
    console.log(`build-world: ${worldPath} supplies all ${sorted.length} demand import(s) and exports '${stepName}'`)
  }
} else {
  await Bun.write(Bun.stdout, world)
}
