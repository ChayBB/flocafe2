import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

test('switching off the in-progress and ready columns sends an item straight to served', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
  const run = Math.random().toString(36).slice(2, 7);

  const categoryName = `Drinks ${run}`;
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: categoryName },
  });
  expect(category.status()).toBe(201);
  const productName = `Iced tea ${run}`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: (await category.json()).category.id,
      price: 40,
      tax_category_id: null,
      tax_behavior: 'exempt',
    },
  });
  expect(product.status()).toBe(201);
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: { type: 'takeaway', items: [{ product_id: (await product.json()).product.id, quantity: 1 }] },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order;

  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace'))).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Kanban' }).click();
  await page.getByTestId('kds-station-select').selectOption({ label: categoryName });

  // Only the in-progress and ready columns carry a switch, under the column.
  await expect(page.getByTestId('kds-stage-switch-pending')).toHaveCount(0);
  await expect(page.getByTestId('kds-stage-switch-served')).toHaveCount(0);
  const preparing = page.getByTestId('kds-stage-switch-preparing');
  const ready = page.getByTestId('kds-stage-switch-ready');
  const columnBox = (await page.getByTestId('kds-column-preparing').boundingBox())!;
  const switchBox = (await preparing.boundingBox())!;
  expect(switchBox.y).toBeGreaterThan(columnBox.y + columnBox.height - switchBox.height - 20);
  await expect(preparing).toHaveAttribute('aria-checked', 'true');

  await preparing.click();
  await ready.click();
  await expect(preparing).toHaveAttribute('aria-checked', 'false');
  await expect(ready).toHaveAttribute('aria-checked', 'false');

  const row = page.getByText(productName).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  await row.getByRole('button', { name: 'Move to Delivered' }).click();
  await expect
    .poll(async () => {
      const body = await (await page.request.get(`${E2E_BASE_URL}/api/orders/${created.id}`, { headers })).json();
      return body.order.items[0].status;
    })
    .toBe('served');

  // The switches stay off for this station after a reload; other stations keep every stage.
  await page.reload();
  await page.getByTestId('kds-station-select').selectOption({ label: categoryName });
  await expect(page.getByTestId('kds-stage-switch-preparing')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('kds-station-select').selectOption({ label: 'All stations' });
  await expect(page.getByTestId('kds-stage-switch-preparing')).toHaveAttribute('aria-checked', 'true');
});
