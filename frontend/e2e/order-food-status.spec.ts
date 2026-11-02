import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('the order header shows how far its food has got, stage by stage', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: `Food ${run}`, capacity: 2 },
  });
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: (await table.json()).table.id,
      items: [1, 2, 3, 4].map((n) => ({
        product_id: 'e2e-product',
        quantity: 1,
        special_instructions: `${run} ${n}`,
      })),
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as {
    order_number: string;
    items: { id: number }[];
  };
  const moveTo = async (itemId: number, statuses: string[]) => {
    for (const status of statuses) {
      const res = await page.request.patch(`${E2E_BASE_URL}/api/order-items/${itemId}/status`, {
        headers,
        data: { status },
      });
      expect(res.ok(), `item ${itemId} to ${status}`).toBeTruthy();
    }
  };
  await moveTo(created.items[1].id, ['preparing']);
  await moveTo(created.items[2].id, ['preparing', 'ready']);
  await moveTo(created.items[3].id, ['preparing', 'ready']);

  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await setLanguage(page, 'en');
  await page.goto(`${E2E_BASE_URL}/orders`);
  await page.getByText(created.order_number).first().click();

  const bar = page.getByTestId('order-food-status');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('order-food-status-pending')).toHaveText('Waiting1');
  await expect(page.getByTestId('order-food-status-preparing')).toHaveText('Preparing1');
  await expect(page.getByTestId('order-food-status-ready')).toHaveText('Ready2');
  await expect(page.getByTestId('order-food-status-served')).toHaveText('Served0');
});
