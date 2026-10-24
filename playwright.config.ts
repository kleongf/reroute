import { defineConfig, devices } from '@playwright/test';
import { TEST_SERVER_ENV } from './scripts/lib/app-process.ts';

// `pnpm verify` boots the built app on a free port and passes BASE_URL.
// Without BASE_URL (plain `pnpm test:e2e`), Playwright starts the dev server itself.
const externalBaseUrl = process.env['BASE_URL'];
const LOCAL_PORT = 3100;
const isCI = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'artifacts/playwright/test-results',
  // One shared server and World: tests that reset or drive the demo must not interleave.
  fullyParallel: false,
  workers: 1,
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
      env: {
        ...TEST_SERVER_ENV,
        PORT: String(LOCAL_PORT),
        DATABASE_PATH: ':memory:',
        HEARTBEAT_MS: '500',
      },
      reuseExistingServer: !isCI,
    },
  }),
});
