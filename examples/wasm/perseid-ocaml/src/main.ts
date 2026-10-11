// Wrapper around the js_of_ocaml bundle.
//
// THE DYNAMIC IMPORT IS LOAD-BEARING, do not turn it into a static one.
// dwarf's Wizer pre-init pass evaluates top-level module code at BUILD time,
// so a static `import './step.js'` runs the OCaml program during
// componentization - its output lands in the build log and never happens at
// runtime. Deferring the import into run() puts it after pre-init.
//
// (Same wrinkle ../js-dwarf-checkpoint-also-run documents for checkpointLoad()
// at module scope, reached from the other direction.)
//
// It also needs rollupOptions.output.inlineDynamicImports in vite.config.ts:
// vite would otherwise code-split the dynamic import, and dwarf takes exactly
// one --js file.

export const run = {
  async run() {
    console.log('[wrapper] run() entered — importing jsoo bundle now')
    await import('./step.js')
    console.log('[wrapper] jsoo import returned')
  },
}
