import { defineConfig, devices } from '@playwright/test';

// Defaults match the committed range; override SD_E2E_PORT to run alongside a
// live sitedrift preview (e.g. the `site` TUI) without a port collision.
const PORT = Number(process.env.SD_E2E_PORT || 45110);

export default defineConfig({
  testDir: './test',
  testMatch: /(visual|mobile)\.spec\.mjs/,
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
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
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
