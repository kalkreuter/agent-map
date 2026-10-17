import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const baseURL = process.env.AGENT_MAP_TEST_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.js',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'artifacts/playwright-report' }]],
  outputDir: 'test-results/browser',
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    httpCredentials: { username: 'andre', password: process.env.AGENT_MAP_TEST_PASSWORD || 'demo' },
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.AGENT_MAP_TEST_URL ? undefined : {
    command: 'npm run demo',
    url: `${baseURL}/healthz`,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
    env: { PORT: '3000', HOST: '127.0.0.1' },
  },
});
