import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: /(visual|mobile)\.spec\.mjs/,
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:45110',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-desktop',
      testMatch: /visual\.spec\.mjs/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-mobile',
      testMatch: /mobile\.spec\.mjs/,
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: 'node test/e2e-server.mjs',
    url: 'http://127.0.0.1:45110/health',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
