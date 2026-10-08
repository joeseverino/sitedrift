import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const root = path.join(import.meta.dirname, '..');
const outputDir = path.join(root, 'docs', 'images');
fs.mkdirSync(outputDir, { recursive: true });

const server = spawn(process.execPath, [path.join(import.meta.dirname, 'e2e-server.ts')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
});

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:45110/health');
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for the sitedrift showcase server.');
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(outputDir, name),
    type: 'jpeg',
    quality: 90,
    animations: 'disabled',
  });
}

let browser: Browser | undefined;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await desktop.goto('http://127.0.0.1:45110/?path=%2Fmenu&view=split', { waitUntil: 'networkidle' });
  await desktop.evaluate(() => localStorage.clear());
  await desktop.reload({ waitUntil: 'networkidle' });
  await capture(desktop, 'sitedrift-split.jpg');

  await desktop.getByRole('button', { name: 'Overlay', exact: true }).click();
  await desktop.getByRole('button', { name: 'Diff', exact: true }).click();
  await capture(desktop, 'sitedrift-diff.jpg');

  await desktop.getByRole('button', { name: 'Split', exact: true }).click();
  await desktop.getByRole('button', { name: 'Review notes', exact: true }).first().click();
  await capture(desktop, 'sitedrift-collaboration.jpg');

  const mobile = await browser.newPage({ viewport: { width: 412, height: 880 }, deviceScaleFactor: 1 });
  await mobile.goto('http://127.0.0.1:45110/?path=%2Fmenu', { waitUntil: 'networkidle' });
  await mobile.evaluate(() => localStorage.clear());
  await mobile.reload({ waitUntil: 'networkidle' });
  await capture(mobile, 'sitedrift-mobile.jpg');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
