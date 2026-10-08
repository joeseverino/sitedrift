import { test, expect } from '@playwright/test';

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
