import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// port comes from the environment so the preview harness can pick a free one
export default defineConfig({
  plugins: [react()],
  // crystal-menu-ui is pre-bundled by the dep optimizer, which inlined its own copy of
  // react/jsx-runtime and gave the app two React instances ("Invalid hook call")
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { include: ['react', 'react-dom', 'react/jsx-runtime', 'crystal-menu-ui'] },
  server: { port: Number(process.env.PORT) || 5173, strictPort: false, open: false },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        pet: resolve(__dirname, 'pet.html'),
      },
    },
  },
})
