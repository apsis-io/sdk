import { defineConfig } from 'vite'
export default defineConfig({
  build: {
    target: 'esnext', minify: false, emptyOutDir: true, outDir: 'dist',
    // ENTRY/OUTFILE are env-driven so ONE config builds more than one component
    // from this project. Defaults are exactly what they were, so `vite build`
    // with no environment is unchanged - a second target must not change how
    // the first one is produced.
    lib: {
      entry: process.env.ENTRY ?? 'src/main.ts',
      formats: ['es'],
      fileName: () => process.env.OUTFILE ?? 'main.js',
    },
    rollupOptions: {
      // WIT specifiers stay external - componentize-js satisfies them from
      // the world. `perseid:` joined `radiant:` with the capability-vocabulary
      // rename (the ids are `perseid:reconcile/...` now), and a missing prefix
      // here sends rollup hunting for an npm module named after the id.
      external: (id) =>
        id.startsWith('radiant:') ||
        id.startsWith('perseid:') ||
        id.startsWith('periapsis:') ||
        id.startsWith('wasi:'),
    },
  },
})
