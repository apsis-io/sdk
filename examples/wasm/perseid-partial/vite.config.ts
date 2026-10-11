import { defineConfig } from 'vite'
export default defineConfig({
  build: {
    target: 'esnext', minify: false, emptyOutDir: true, outDir: 'dist',
    lib: { entry: 'src/main.ts', formats: ['es'], fileName: () => 'main.js' },
    rollupOptions: {
      external: (id) => id.startsWith('periapsis:') || id.startsWith('wasi:'),
    },
  },
})
