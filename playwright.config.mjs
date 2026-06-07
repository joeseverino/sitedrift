import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: /visual\.spec\.mjs/,
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:45110',
    trace: 'on-first-retry',
  },
  projects: [{
    name: 'chromium-desktop',
    use: { ...devices['Desktop Chrome'] },
  }],
  webServer: {
    command: 'node test/e2e-server.mjs',
    url: 'http://127.0.0.1:45110/health',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
