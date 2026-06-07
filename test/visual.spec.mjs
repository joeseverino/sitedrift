import { test, expect } from '@playwright/test';

const SHOULD_RUN = process.env.VISUAL === '1';
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 412, height: 880 };
const SCREENSHOT = {
  animations: 'disabled',
  // Linux and macOS rasterize the same system fonts differently. Keep local
  // review strict; CI still catches layout, visibility, spacing, and color
  // regressions while allowing the measured 4-5% cross-OS text variance.
  maxDiffPixelRatio: process.env.CI ? 0.06 : 0.01,
};

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('.page-heading')).toHaveCount(2);
  await expect(page.locator('.page-heading').filter({ hasText: 'Development product analytics' })).toHaveCount(1);
  await expect(page.locator('.page-heading').filter({ hasText: 'Production product analytics' })).toHaveCount(1);
  const origins = await page.locator('iframe').evaluateAll((frames) => frames.map((frame) => new URL(frame.src).origin));
  expect(new Set(origins).size).toBe(2);
}

test.describe('visual regression', () => {
  test.skip(!SHOULD_RUN, 'Set VISUAL=1 to run visual snapshots.');

  test('split view desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await ready(page);
    await expect(page).toHaveScreenshot('split-desktop.png', SCREENSHOT);
  });

  test('solo view mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await ready(page);
    await expect(page.getByRole('button', { name: 'Solo', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Swap sides', exact: true }).click();
    await expect(page.locator('.app')).toHaveAttribute('data-focus', 'live');
    await page.getByRole('button', { name: 'Swap sides', exact: true }).click();
    await expect(page).toHaveScreenshot('solo-mobile.png', SCREENSHOT);
    await page.getByRole('button', { name: 'Collapse review chrome' }).click();
    await expect(page).toHaveScreenshot('solo-mobile-compact.png', SCREENSHOT);
  });

  test('difference overlay', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await ready(page);
    await page.getByRole('button', { name: 'Overlay', exact: true }).click();
    await page.getByRole('button', { name: 'Diff', exact: true }).click();
    await expect(page).toHaveScreenshot('difference-overlay.png', SCREENSHOT);
  });

  test('notes drawer', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await ready(page);
    const notes = page.getByRole('button', { name: 'Review notes', exact: true });
    await notes.first().click();
    await expect(page.locator('.note-list li')).toHaveCount(2);
    await expect(page).toHaveScreenshot('notes-drawer.png', SCREENSHOT);
  });

  test('response details popover and stable compact controls', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await ready(page);

    const status = page.locator('.label[data-label="dev"] .status-badge');
    await expect(status).toHaveText('200');
    await expect(status).toHaveAttribute('data-summary', /^Response \d+ ms$/);
    await status.click();
    await expect(page.locator('.status-popover')).toBeVisible();
    await expect(page.locator('.status-grid')).toContainText('DOM ready');
    await expect(page.locator('.status-grid')).toContainText('Delta');

    const devFrame = await page.locator('iframe[data-side="dev"]').boundingBox();
    await page.mouse.click((devFrame?.x || 0) + 80, (devFrame?.y || 0) + 600);
    await expect(page.locator('.status-popover')).toBeHidden();

    await page.locator('[data-action="compact"]:visible').click();
    await page.getByRole('button', { name: 'Solo', exact: true }).click();
    const controls = page.locator('.compact-controls');
    const before = await controls.boundingBox();
    await page.locator('[data-compact-title="dev"]').click();
    const after = await controls.boundingBox();
    expect(after?.x).toBe(before?.x);
  });
});
