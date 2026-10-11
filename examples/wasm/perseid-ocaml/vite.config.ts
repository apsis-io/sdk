import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'esnext',
    minify: false,
    emptyOutDir: true,
    outDir: 'dist',
    lib: { entry: 'src/main.ts', formats: ['es'], fileName: () => 'main.js' },
    rollupOptions: {
      external: (id) => id.startsWith('periapsis:') || id.startsWith('wasi:'),
      // dwarf takes exactly one --js; without this vite code-splits main.ts's
      // dynamic import of the jsoo bundle into a second chunk — and the build
      // still "succeeds", producing a component containing only the 0.23 kB
      // stub, which traps at runtime. Silently wrong, so verify by RUNNING.
      //
      // vite 8.2.1 deprecates output.inlineDynamicImports in favour of
      // `codeSplitting: false` but does not say where it goes. Measured, all
      // three positions (../js-dwarf-nitro's note says only
      // inlineDynamicImports works — it was testing the top-level one):
      //   build.codeSplitting: false                    silently ignored, still splits
      //   build.rollupOptions.codeSplitting: false      "Invalid input options", still splits
      //   build.rollupOptions.output.codeSplitting      WORKS, single bundle, no warning
      output: { codeSplitting: false },
    },
  },
})
