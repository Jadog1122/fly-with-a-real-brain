import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 30_000,          // the golden replay loads and steps the 45,808-neuron subnet
    // the simulation modules are dependency-free and run in node; the few component
    // tests need a DOM, so they opt in per file with @vitest-environment jsdom
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/pet/{sim,sensors,motor,world,packed,mind,BootOverlay,ErrorBoundary}.ts?(x)',
                'src/support.ts'],
    },
  },
})
