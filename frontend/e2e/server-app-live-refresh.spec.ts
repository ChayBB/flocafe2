import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('the Server App drops a table’s old order on its own once the cashier takes the payment', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const run = Math.random().toString(36).slice(2, 7);
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: `Live ${run}`, capacity: 2 },
  });
  const tableId = (await table.json()).table.id as string;
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: { type: 'dine_in', table_id: tableId, items: [{ product_id: 'e2e-product', quantity: 1 }] },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as { id: number };

  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, managerToken],
  );
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${tableId}`);
  const rows = page.getByTestId('server-app-ticket-item');
  await expect(rows).toHaveCount(1);

  const bill = await page.request.post(`${E2E_BASE_URL}/api/bills/generate`, { headers, data: { order_id: created.id } });
  expect(bill.ok()).toBeTruthy();
  const billBody = (await bill.json()).bill as { id: number; total: number };
  const paid = await page.request.post(`${E2E_BASE_URL}/api/bills/${billBody.id}/payments`, {
    headers,
    data: { payments: [{ method: 'cash', amount: billBody.total }] },
  });
  expect(paid.ok(), await paid.text()).toBeTruthy();

  // No reload or reselect: the periodic refresh clears the paid order.
  await expect(rows).toHaveCount(0, { timeout: 12000 });
});
