import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // every module under test is dependency-free: no DOM, no WebGL, no fetch
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,          // the golden replay loads and steps the 45,808-neuron subnet
    coverage: { provider: 'v8', include: ['src/pet/{sim,sensors,motor,world,packed}.ts'] },
  },
})
