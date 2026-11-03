import { defineConfig, devices } from '@playwright/test';

// Current-main UI integration against synthetic local public data only.
// No production/preprod URLs, secrets, database, or merchant credentials.
// Zero retries exposes flakes; locator waits provide synchronization.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['storefront-smoke.spec.ts', 'catalogue-navigation-regression.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'playwright-results.json' }]],
  use: { baseURL: 'http://127.0.0.1:3100', serviceWorkers: 'block',
    trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000 },
  webServer: [
    { command: 'node --experimental-strip-types e2e/read-only-fixture.spec.ts',
      url: 'http://127.0.0.1:3101/health', reuseExistingServer: false },
    { command: 'node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3100',
      url: 'http://127.0.0.1:3100/r/e2e-classic', timeout: 180_000, reuseExistingServer: false,
      env: { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:3101',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-e2e-not-a-credential', NEXT_TELEMETRY_DISABLED: '1' } },
  ],
  projects: [
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
});
