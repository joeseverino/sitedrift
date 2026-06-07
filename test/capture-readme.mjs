import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const outputDir = new URL('../docs/images/', import.meta.url);
fs.mkdirSync(outputDir, { recursive: true });

const server = spawn(process.execPath, [new URL('./e2e-server.mjs', import.meta.url).pathname], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
});

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:45110/health');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the sitedrift showcase server.');
}

async function capture(page, name) {
  await page.screenshot({
    path: path.join(outputDir.pathname, name),
    type: 'jpeg',
    quality: 90,
    animations: 'disabled',
  });
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await desktop.goto('http://127.0.0.1:45110/?path=%2Fproduct&view=split', { waitUntil: 'networkidle' });
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
  await mobile.goto('http://127.0.0.1:45110/?path=%2Fproduct', { waitUntil: 'networkidle' });
  await mobile.evaluate(() => localStorage.clear());
  await mobile.reload({ waitUntil: 'networkidle' });
  await capture(mobile, 'sitedrift-mobile.jpg');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
