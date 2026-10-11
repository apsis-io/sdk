import { defineConfig } from 'vite'

// The governance monitor's bundle. A SECOND config rather than a second entry in
// the first: `emptyOutDir` would have each build delete the other's output, and
// the two components are built and ingested independently.
export default defineConfig({
  build: {
    target: 'esnext',
    minify: false,
    emptyOutDir: false,
    outDir: 'dist',
    lib: { entry: 'src/governance-main.ts', formats: ['es'], fileName: () => 'governance.js' },
    rollupOptions: {
      // The host interfaces are supplied by the component model at link time,
      // not bundled - the same externals the main build uses.
      external: (id) => id.startsWith('radiant:') || id.startsWith('periapsis:') || id.startsWith('wasi:'),
    },
  },
})
