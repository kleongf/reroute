import { defineConfig, devices } from '@playwright/test';

// `pnpm verify` boots the built app on a free port and passes BASE_URL.
// Without BASE_URL (plain `pnpm test:e2e`), Playwright starts the dev server itself.
const externalBaseUrl = process.env['BASE_URL'];
const LOCAL_PORT = 3100;
const isCI = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'artifacts/playwright/test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright/report', open: 'never' }]],
  use: {
    baseURL: externalBaseUrl ?? `http://127.0.0.1:${String(LOCAL_PORT)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(externalBaseUrl === undefined && {
    webServer: {
      command: 'node --import tsx src/server.ts',
      url: `http://127.0.0.1:${String(LOCAL_PORT)}/health`,
      env: { PORT: String(LOCAL_PORT), DATABASE_PATH: ':memory:', HEARTBEAT_MS: '500' },
      reuseExistingServer: !isCI,
    },
  }),
});
