import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('the current ticket lists sent items without customer fields, and its menu moves the order to a free table', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const run = Math.random().toString(36).slice(2, 7);
  const makeTable = async (label: string) =>
    (
      await (
        await page.request.post(`${E2E_BASE_URL}/api/tables`, {
          headers,
          data: { number: label, capacity: 2 },
        })
      ).json()
    ).table.id as string;
  const from = `From ${run}`;
  const to = `To ${run}`;
  const fromId = await makeTable(from);
  const toId = await makeTable(to);
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: fromId,
      items: [
        { product_id: 'e2e-product', quantity: 1 },
        { product_id: 'e2e-product', quantity: 2, special_instructions: 'second' },
      ],
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as { id: number; order_number: string };

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
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${fromId}`);

  // No phone or customer name; sent items are rows with quantity, status and a menu.
  await expect(page.getByPlaceholder('Phone')).toHaveCount(0);
  await expect(page.getByPlaceholder('Customer name')).toHaveCount(0);
  const rows = page.getByTestId('server-app-ticket-item');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('x 1');
  await expect(rows.first().getByTestId('server-app-item-status')).toHaveText('Waiting');
  await expect(rows.first().getByTestId('server-app-item-menu')).toBeEnabled();

  // The ticket menu moves the order to a free table and follows it there.
  await page.getByTestId('server-app-ticket-menu').click();
  await page.getByRole('menuitem', { name: 'Move table' }).click();
  const dialog = page.getByTestId('server-app-table-transfer');
  await expect(dialog).toContainText(`Move the order from table ${from} to:`);
  // A typed table that is in use is refused; the free one is accepted.
  await dialog.getByTestId('server-app-table-transfer-input').fill(from);
  await dialog.getByTestId('server-app-table-transfer-confirm').click();
  await expect(dialog.getByTestId('server-app-table-transfer-error')).toHaveText(
    'That is this table',
  );
  await dialog.getByTestId('server-app-table-transfer-input').fill(to);
  await dialog.getByTestId('server-app-table-transfer-confirm').click();
  await expect(page.getByText(`Moved to table ${to}`).first()).toBeVisible();
  await expect(page.locator('header')).toContainText(to);
  await expect(rows).toHaveCount(2);

  const moved = await (
    await page.request.get(`${E2E_BASE_URL}/api/orders/${created.id}`, { headers })
  ).json();
  expect(moved.order.table_id).toBe(toId);
});
