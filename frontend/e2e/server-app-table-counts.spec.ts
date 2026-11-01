import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { openServerAppTables } from './helpers/server-app';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('each table shows waiting-ready-served counts, and its sent items spell out their status', async ({ page }) => {
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const run = Math.random().toString(36).slice(2, 7);

  const tableRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: `Count ${run}`, capacity: 4 },
  });
  const tableId = (await tableRes.json()).table.id;
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: tableId,
      items: [
        { product_id: 'e2e-product', quantity: 1 },
        { product_id: 'e2e-product', quantity: 2, special_instructions: 'second line' },
        { product_id: 'e2e-product', quantity: 1, special_instructions: 'third line' },
      ],
    },
  });
  expect(order.status()).toBe(201);
  const items = (await order.json()).order.items as { id: number }[];
  expect(items).toHaveLength(3);
  const setStatus = async (id: number, status: string) => {
    const res = await page.request.patch(`${E2E_BASE_URL}/api/order-items/${id}/status`, {
      headers,
      data: { status },
    });
    expect(res.ok(), `item ${id} -> ${status}`).toBeTruthy();
  };
  await setStatus(items[1].id, 'ready');
  await setStatus(items[2].id, 'served');

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
  await page.reload();
  await openServerAppTables(page);

  const tableButton = page.getByRole('button', { name: new RegExp(`Count ${run}`) });
  const counts = tableButton.getByTestId('table-kitchen-counts');
  await expect(counts).toHaveText('1-1-1');
  await expect(counts).toHaveClass(/text-gray-400/);
  await expect(counts).toHaveAttribute('title', 'Waiting 1 · Ready 1 · Served 1');

  // The sent items spell out their kitchen status in place of the old status icons.
  await tableButton.click();
  const statuses = page.getByTestId('server-app-item-status');
  await expect(statuses).toHaveText(['Waiting', 'Ready', 'Served']);
});
