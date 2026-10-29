import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

async function countBeeps(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __beeps: number; AudioContext: unknown };
    w.__beeps = 0;
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      state = 'running';
      onstatechange: (() => void) | null = null;
      resume() {
        return Promise.resolve();
      }
      createOscillator() {
        w.__beeps += 1;
        return { type: '', frequency: { value: 0 }, connect: (node: unknown) => node, start() {}, stop() {} };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (node: unknown) => node };
      }
    }
    w.AudioContext = FakeAudioContext;
  });
}

test('printing a fully served table’s bill makes the POS time the wait for payment, with a two-beep alert', async ({
  page,
  context,
}) => {
  const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
  const run = Math.random().toString(36).slice(2, 7);
  const label = `Bill ${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, { headers, data: { number: label, capacity: 2 } });
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: (await table.json()).table.id,
      items: [
        { product_id: 'e2e-product', quantity: 1 },
        { product_id: 'e2e-product', quantity: 1, special_instructions: `${label} two` },
      ],
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as { id: number; order_number: string; items: { id: number }[] };
  for (const item of created.items) {
    await page.request.patch(`${E2E_BASE_URL}/api/order-items/${item.id}/status`, { headers, data: { status: 'served' } });
  }

  // POS first, so the request arrives while it is open.
  await countBeeps(page);
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${E2E_BASE_URL}/orders`);
  await page.waitForTimeout(500);
  const beepsBefore = await page.evaluate(() => (window as unknown as { __beeps: number }).__beeps);

  // Server App on a phone: no printer until every item is confirmed at the table.
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await phone.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, getE2eToken('e2e-server', 'server@flo.local', 'server')],
  );
  await phone.reload();
  await phone.getByTestId('server-app-table-button').click();
  await phone.getByRole('button', { name: new RegExp(label) }).click();
  await phone.getByTestId('server-app-ordered-items-button').click();
  const printer = phone.getByTestId('server-app-print-bill');
  await expect(phone.getByTestId('server-app-ordered-item')).toHaveCount(2);
  await expect(printer).toHaveCount(0);
  for (const index of [0, 1]) {
    await phone.getByTestId('server-app-ordered-item').nth(index).getByTestId('server-app-item-menu').click();
    await phone.getByRole('menuitem', { name: 'Confirm served' }).click();
    await expect(phone.getByTestId('server-app-ordered-item').nth(index).getByTestId('server-app-served-confirmed-tag')).toBeVisible();
  }
  await expect(printer).toBeVisible();
  await printer.click();
  await expect(phone.getByText('Bill printed; the cashier has been told').first()).toBeVisible();

  // POS: two beeps, no top bar; the order row turns pink and the wait counts up.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __beeps: number }).__beeps), { timeout: 15000 })
    .toBe(beepsBefore + 2);
  await expect(page.getByTestId('bill-request-alerts')).toHaveCount(0);
  const row = page.getByRole('button').filter({ hasText: `#${created.order_number}` }).first();
  await expect(row).toHaveAttribute('data-bill-awaiting', 'true', { timeout: 15000 });
  await expect(row).toHaveClass(/animate-bill-awaiting/);
  await expect(row.getByTestId('bill-request-waiting')).toContainText(/Awaiting payment\s*\d+:\d{2}/);
  await row.click();
  await expect(page.getByText('Bill printed by').first()).toBeVisible();

  // The cashier takes the money: the wait stops, is stamped, and the table leaves the bar.
  const bill = await page.request.post(`${E2E_BASE_URL}/api/bills/generate`, { headers, data: { order_id: created.id } });
  expect(bill.ok()).toBeTruthy();
  const billBody = (await bill.json()).bill as { id: number; total: number };
  const paid = await page.request.post(`${E2E_BASE_URL}/api/bills/${billBody.id}/payments`, {
    headers,
    data: { payments: [{ method: 'cash', amount: billBody.total }] },
  });
  expect(paid.ok(), await paid.text()).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: 'All', exact: true }).first().click();
  await page.getByRole('button').filter({ hasText: `#${created.order_number}` }).first().click();
  await expect(page.getByTestId('bill-request-received').first()).toContainText(/Paid \d{2}:\d{2} · waited \d+ min/);
  await expect(page.getByRole('button').filter({ hasText: `#${created.order_number}` }).first()).not.toHaveAttribute(
    'data-bill-awaiting',
    'true',
  );
});
