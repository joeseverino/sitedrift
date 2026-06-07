import { test, expect } from '@playwright/test';

const SHOULD_RUN = process.env.VISUAL === '1';
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 412, height: 880 };
const SCREENSHOT = {
  animations: 'disabled',
  // Allow small cross-platform font rasterization differences while still
  // catching layout, visibility, spacing, and color regressions.
  maxDiffPixelRatio: 0.01,
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
});
