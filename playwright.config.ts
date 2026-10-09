import { defineConfig } from '@playwright/test';
const webPort = process.env.E2E_WEB_PORT ?? '5190',
  apiPort = process.env.E2E_API_PORT ?? '3091';
const origin = 'http://127.0.0.1:' + webPort;
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 960 },
    channel: process.env.E2E_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: origin + '/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    env: {
      DATABASE_MODE: 'embedded',
      PORT: apiPort,
      WEB_PORT: webPort,
      API_PORT: apiPort,
      APP_ORIGIN: origin,
    },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
