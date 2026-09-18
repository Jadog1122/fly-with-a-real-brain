import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// port comes from the environment so the preview harness can pick a free one
export default defineConfig({
  // Relative, so the same build works at a domain root and under a project subpath
  // like /fly-with-a-real-brain/ on GitHub Pages. The data files are already fetched
  // relative to the page, so they follow.
  base: './',
  plugins: [react()],
  // The dep optimizer pre-bundled the UI library with its own copy of react/jsx-runtime,
  // which gave the app two React instances ("Invalid hook call").  Deduping React and
  // pinning what gets pre-bundled fixes it.  (crystal-menu-ui was listed here until it
  // was replaced by @rpgjs/ui-css, which is CSS-only and needs no pre-bundling.)
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { include: ['react', 'react-dom', 'react/jsx-runtime'] },
  server: { port: Number(process.env.PORT) || 5173, strictPort: false, open: false },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        pet: resolve(__dirname, 'pet.html'),
        how: resolve(__dirname, 'how.html'),
      },
      output: {
        // Both pages are three.js on first paint - the explorer IS the point cloud and
        // the pet IS the 3-D world - so three cannot be deferred behind an interaction.
        // Naming it makes the size report legible instead of attributing ~580 kB of
        // renderer to whichever app module Rollup happened to key the shared chunk to.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three'
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
        },
      },
    },
    // 'three' is legitimately ~580 kB (149 kB gzipped) and is shared by both entries,
    // so the default 500 kB warning only ever fires on it.
    chunkSizeWarningLimit: 650,
  },
})
