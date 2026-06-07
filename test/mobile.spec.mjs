import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('.page-heading')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Solo', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
}

async function expectTouchTarget(locator, minimum = 40) {
  const box = await locator.boundingBox();
  expect(box, 'control should have a visible bounding box').not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(minimum);
  expect(box.height).toBeGreaterThanOrEqual(minimum);
}

test('mobile chrome remains reversible and controls remain tappable', async ({ page }) => {
  await ready(page);

  const app = page.locator('.app');
  const collapse = page.getByRole('button', { name: 'Collapse review chrome' });
  const expand = page.getByRole('button', { name: 'Expand review chrome' });

  await expect(collapse).toBeVisible();
  await expectTouchTarget(collapse);
  await collapse.tap();
  await expect(app).toHaveClass(/compact/);

  await expect(expand).toBeVisible();
  await expectTouchTarget(expand);
  for (const name of ['Split', 'Solo', 'Overlay']) {
    const button = page.getByRole('button', { name, exact: true });
    await expectTouchTarget(button);
    await button.tap();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  await page.getByRole('button', { name: 'Solo', exact: true }).tap();
  await expectTouchTarget(page.getByRole('button', { name: 'Reload both panes' }));
  await expectTouchTarget(page.getByRole('button', { name: 'Swap sides' }));
  await expectTouchTarget(page.getByRole('button', { name: 'Review notes' }));

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await expand.tap();
    await expect(app).not.toHaveClass(/compact/);
    await expect(collapse).toBeVisible();
    await collapse.tap();
    await expect(app).toHaveClass(/compact/);
    await expect(expand).toBeVisible();
  }
});

test('expanded mobile toolbar keeps route, collapse, and notes usable', async ({ page }) => {
  await ready(page);

  const route = page.getByRole('textbox', { name: 'Route' });
  const collapse = page.getByRole('button', { name: 'Collapse review chrome' });
  const notes = page.getByRole('button', { name: 'Review notes' });
  const status = page.locator('.label[data-label="dev"] .status-badge');

  await expect(route).toBeVisible();
  await expectTouchTarget(collapse);
  await expectTouchTarget(notes);
  await expectTouchTarget(status);

  await notes.tap();
  await expect(page.locator('.review-drawer')).toHaveClass(/open/);
  await page.locator('.stage').tap({ position: { x: 20, y: 100 } });
  await expect(page.locator('.review-drawer')).not.toHaveClass(/open/);
});

test('narrow phones keep essential controls on-screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await ready(page);

  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 320);
  await expectTouchTarget(page.getByRole('button', { name: 'Collapse review chrome' }));
  await expectTouchTarget(page.getByRole('button', { name: 'Swap sides' }));

  await page.getByRole('button', { name: 'Collapse review chrome' }).tap();
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 320);
  await expectTouchTarget(page.getByRole('button', { name: 'Expand review chrome' }));
  await expectTouchTarget(page.getByRole('button', { name: 'Swap sides' }));
  await expectTouchTarget(page.getByRole('button', { name: 'Review notes' }));
});
