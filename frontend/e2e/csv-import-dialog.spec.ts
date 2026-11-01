import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('a long CSV import error list scrolls inside the dialog and the close button stays reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors = Array.from(
    { length: 150 },
    (_, index) => `Row ${index + 2}: unsupported flo_csv_encoding "quote-v${index + 1}"`,
  );
  await page.route(`${BASE}/api/menu-csv/import/**`, (route) =>
    route.fulfill({ json: { created: 0, skipped: errors.length, errors } }),
  );

  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${BASE}/products`);

  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  const dialog = page.locator('.rounded-2xl').filter({ has: page.locator('input[type="file"]') });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'products.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,flo_csv_encoding\nTea,quote-v2\n'),
  });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByText(errors[errors.length - 1])).toBeAttached();

  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);

  const close = dialog.getByRole('button', { name: 'Close' });
  await expect(close).toBeInViewport();
  await dialog.getByText(errors[errors.length - 1]).scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  await close.click();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});
