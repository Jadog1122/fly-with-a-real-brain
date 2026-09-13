import { defineConfig, devices } from '@playwright/test'

// Cross-engine smoke tests. Everything before this was verified on Chromium only, so
// WebGL2, ES-module workers and roundRect were checked against published baselines
// rather than against a real WebKit or Gecko run.
export default defineConfig({
  testDir: './e2e',
  // Headless WebGL falls back to software rendering, so booting the 3-D world takes
  // ~70 s here against ~5 s in a real browser. These budgets are about that, not about
  // how the app performs on a GPU.
  timeout: 240_000,
  expect: { timeout: 90_000 },
  // each test boots a 45,808-neuron simulation; running several at once starves the
  // CPU and they time out rather than fail on anything real
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: { baseURL: 'http://localhost:4180', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // Playwright's bundled WebKit segfaults on launch on this macOS host (Darwin 25),
    // before any page is created, so it is only actually exercised by CI on Linux.
    // `npm run test:e2e:local` skips it; CI runs all three.
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npx vite preview --port 4180 --strictPort',
    url: 'http://localhost:4180/pet.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
