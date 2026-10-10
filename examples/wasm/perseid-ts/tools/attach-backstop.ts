#!/usr/bin/env bun
// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Attach this program's declared park bound to the built component, and REFUSE
 * to build when it declared none.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ***WHY A BUILD STEP AND NOT A TYPE.***
 *
 * engi asked to "warn at compile time that backstop isn't redefined", then chose
 * the stronger form: "do required parameter". TypeScript has no `#[warn]`, and
 * its two nearest devices both miss - a `@deprecated` tag is advisory and only
 * surfaces if the consumer opts into that lint, and a genuinely required
 * FUNCTION parameter would have to sit on the park call, which contradicts
 * "define once": the bound is one fact about the PROGRAM, not an argument to
 * every quiesce.
 *
 * So the requirement lives where the declaration does. The build refuses a
 * program that has not made one, which is a hard error with the same force as a
 * required parameter and without pushing a per-program fact into a per-park
 * signature.
 *
 * ***AND THE ATTACH HAS TO HAPPEN HERE ANYWAY***, which is what makes the check
 * free. componentize-js cannot emit a wasm custom section, so the bound is
 * appended to the finished component (measured 2026-09-04: a section appended to
 * a real component reads back through `trail --inspect`, and the component still
 * validates). The step that attaches is the step that knows whether there was
 * anything to attach.
 *
 * ***FAILS THE BUILD*** (engi: "do required parameter"), which is the stronger
 * of the two options and was chosen knowing it breaks every program that does
 * not yet declare a bound.
 *
 * ⚠ THE OTHER OPTION WAS A WARNING AND IT IS WORTH SAYING WHY IT LOST. A warning
 * about a value whose default is usually fine is one nobody acts on: it scrolls
 * past in a green build. That is not hypothetical - it is exactly how every
 * Perseid on the fleet came to sit on the 300s default without one author having
 * chosen it.
 *
 * Declaring the DEFAULT satisfies the requirement, which is deliberate rather
 * than a loophole: what is required is that somebody DECIDED, not that they
 * picked a small number.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { attachBackstop, DEFAULT_BACKSTOP_MS, type BackstopDecl } from '../../../../ts/perseid/backstop.js'

const [componentPath, declPath = 'src/backstop.ts'] = process.argv.slice(2)

if (!componentPath) {
  console.error('usage: attach-backstop.ts <component.wasm> [declaration.ts]')
  process.exit(2)
}

/** The declaration, or undefined when the program does not make one. */
async function declared(): Promise<BackstopDecl | undefined> {
  if (!existsSync(declPath)) return undefined
  const mod = (await import(`${process.cwd()}/${declPath}`)) as { backstop?: BackstopDecl }
  // ***A FILE THAT EXISTS BUT EXPORTS NOTHING IS A MISTAKE, NOT A DECISION.***
  // Somebody meant to declare a bound and the export name drifted; treating it
  // as "declared none" would be the silent reading of a typo.
  if (mod.backstop === undefined) {
    console.error(
      `attach-backstop: ${declPath} exists but exports no \`backstop\`.\n` +
        '  Export one:  export const backstop = declareBackstop.seconds(60)\n' +
        '  To take the host default, declare it EXPLICITLY - deleting the file does not\n' +
        '  mean "default", it means "undeclared", and undeclared no longer builds:\n' +
        '    export const backstop = declareBackstop(DEFAULT_BACKSTOP_MS)',
    )
    process.exit(1)
  }

  return mod.backstop
}

const decl = await declared()

if (!decl) {
  // ***REQUIRED, NOT ADVISORY*** (engi, 2026-09-04: "do required parameter",
  // choosing this over a warning after being told it breaks every program that
  // does not yet declare one).
  //
  // ⚠ THE COST IS REAL AND IT IS THE POINT: a program that has never thought
  // about its bound no longer BUILDS. The alternative was a warning, and a
  // warning about a value whose default is usually fine is one nobody acts on -
  // it scrolls past in a green build, which is precisely how every Perseid on
  // the fleet came to sit on 300s without a single author choosing it.
  //
  // Declaring the DEFAULT satisfies this. That is deliberate rather than a
  // loophole: the requirement is that somebody DECIDED, not that they picked a
  // small number, and `declareBackstop(DEFAULT_BACKSTOP_MS)` is a decision in a
  // way that silence is not.
  console.error(
    `\n  ⛔ NO BACKSTOP DECLARED - this program does not build.\n\n` +
      '    A Perseid that parks is asleep until its condition fires. If that condition is\n' +
      '    too narrow, or a watch is dropped, the backstop is the ONLY thing that wakes it\n' +
      `    again - and undeclared that is ${DEFAULT_BACKSTOP_MS}ms (${DEFAULT_BACKSTOP_MS / 1000}s), ` +
      'which for a probe\n' +
      '    or a test is far too long and is why a suite that should fail fast appears to hang.\n\n' +
      `    Declare one in ${declPath}:\n\n` +
      "      import { declareBackstop } from '@apsis-io/perseid/backstop.js'\n" +
      '      export const backstop = declareBackstop.seconds(60)\n\n' +
      '    To keep the host default, say so explicitly - that is a decision and it builds:\n\n' +
      "      import { declareBackstop, DEFAULT_BACKSTOP_MS } from '@apsis-io/perseid/backstop.js'\n" +
      '      export const backstop = declareBackstop(DEFAULT_BACKSTOP_MS)\n',
  )
  process.exit(1)
}

// `node:fs` rather than `Bun.*`, matching derive-wit.ts and check-completions.ts:
// the project's own `tsgo --noEmit -p .` covers tools/, and the Bun globals are
// not in its lib set - so a Bun-flavoured tool fails build.sh at step 1.
const src = new Uint8Array(readFileSync(componentPath))
writeFileSync(componentPath, attachBackstop(src, decl))
console.log(`  attached perseid:backstop = ${decl.ms}ms to ${componentPath}`)
