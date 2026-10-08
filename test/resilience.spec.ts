import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

test('the viewer starts when the browser refuses storage access', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await expect(page.locator('.page-heading')).toHaveCount(2);
  await page.getByRole('button', { name: 'Overlay', exact: true }).first().click();
  await expect(page.locator('.app')).toHaveClass(/overlay/);
  expect(errors).toEqual([]);
});

test.describe('overlay opacity', () => {
  const amount = (page: Page) => page.locator('.toolbar .overlay-slider input').inputValue();

  test('defaults to 50 when nothing is stored or requested', async ({ page }) => {
    await page.goto('/?view=overlay');
    await expect(page.locator('.page-heading')).toHaveCount(2);
    expect(await amount(page)).toBe('50');
    await expect(page.locator('.app')).toHaveClass(/overlay/);
    await expect(page.locator('html')).toHaveCSS('--overlay', '0.500');
  });

  test('honours an explicit amount, including 0', async ({ page }) => {
    await page.goto('/?view=overlay&overlayAmount=0');
    expect(await amount(page)).toBe('0');
    await page.goto('/?view=overlay&overlayAmount=20');
    expect(await amount(page)).toBe('20');
  });
});
