import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const manager = () => ({
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
});

async function setEnglish(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(() => {
    const raw = localStorage.getItem('pos-settings');
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...parsed.state, language: 'en' };
    localStorage.setItem('pos-settings', JSON.stringify(parsed));
  });
}

async function createTable(page: import('@playwright/test').Page) {
  const name = `QR ${Math.random().toString(36).slice(2, 7)}`;
  const created = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers: manager(),
    data: { number: name, capacity: 2 },
  });
  expect(created.ok()).toBeTruthy();
  const { table } = await created.json();
  return { name, id: table.id as string };
}

test.describe('Server App guest from a table QR', () => {
  test('shows a Guest label and orange login button, no table picker, and orders for that table only', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${table.id}`);

    const header = page.locator('header');
    await expect(header.getByTestId('server-app-guest-name')).toHaveText('Guest');
    await expect(header.getByTestId('server-app-login-button')).toBeVisible();
    await expect(header.getByTestId('server-app-login-button')).toHaveClass(/bg-orange-500/);
    await expect(header.getByTestId('server-app-table-button')).toHaveCount(0);
    await expect(header.getByTestId('server-app-session-button')).toHaveCount(0);
    await expect(header).toContainText(table.name);
    await expect(page.getByRole('heading', { name: 'Tables' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Phone')).toHaveCount(0);

    const grid = page.getByTestId('pos-product-grid');
    const search = grid.getByPlaceholder('Search menu');
    await search.fill('2*E2E Coffee');
    await search.press('Enter');
    await page.getByPlaceholder('Order notes (optional)').first().fill('From the QR');
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();

    const orders = await (
      await page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers: manager(),
        params: { table_id: table.id, type: 'dine_in', per_page: 5 },
      })
    ).json();
    expect(orders.orders).toHaveLength(1);
    expect(orders.orders[0].special_instructions).toBe('From the QR');
    expect(
      orders.orders[0].items.some(
        (item: { product_name: string; quantity: number }) =>
          item.product_name === 'E2E Coffee' && item.quantity === 2,
      ),
    ).toBeTruthy();

    // A second send from the same table adds to the open order rather than opening another.
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();
    const again = await (
      await page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers: manager(),
        params: { table_id: table.id, type: 'dine_in', per_page: 5 },
      })
    ).json();
    expect(again.orders).toHaveLength(1);

    // The Guest account that placed the orders never shows up as staff.
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const staff = await (
      await page.request.get(`${E2E_BASE_URL}/api/staff`, { headers: ownerHeaders })
    ).json();
    expect(staff.staff.some((member: { name: string }) => member.name === 'Guest')).toBeFalsy();
    const candidates = await (
      await page.request.get(`${E2E_BASE_URL}/api/tables/owner-candidates`, { headers: ownerHeaders })
    ).json();
    expect(candidates.staff.some((member: { name: string }) => member.name === 'Guest')).toBeFalsy();
  });

  test('signing in shows the staff name and the Select Table button while keeping the QR table', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${table.id}`);
    await page.getByTestId('server-app-login-button').click();
    await page.getByPlaceholder('Staff name').fill('server@flo.local');
    await page.getByPlaceholder('Staff code').fill('E2ePass123!');
    await page.getByRole('button', { name: 'Sign In' }).click();

    const header = page.locator('header');
    await expect(header.getByTestId('server-app-staff-name')).toHaveText('E2E server');
    await expect(header.getByTestId('server-app-table-button')).toBeVisible();
    await expect(header.getByTestId('server-app-session-button')).toHaveClass(/text-green-600/);
    await expect(header.getByTestId('server-app-login-button')).toHaveCount(0);
    await expect(header).toContainText(table.name);

    // Signing out returns to the guest view of the same table.
    await header.getByTestId('server-app-session-button').click();
    await expect(header.getByTestId('server-app-guest-name')).toBeVisible();
    await expect(header).toContainText(table.name);
  });

  test('guests can go back from the sign-in form, and an unknown table asks for sign-in', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${table.id}`);
    await page.getByTestId('server-app-login-button').click();
    await page.getByRole('button', { name: 'Continue as guest' }).click();
    await expect(page.getByTestId('server-app-guest-name')).toBeVisible();

    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=does-not-exist`);
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByTestId('server-app-guest-name')).toHaveCount(0);
  });

  test('the guest API refuses unknown tables and products and keeps staff endpoints closed', async ({
    page,
    request,
  }) => {
    const table = await createTable(page);
    const post = (data: unknown) =>
      request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, { data: data as object });

    expect((await post({ table_id: 'nope', items: [{ product_id: 'x', quantity: 1 }] })).status()).toBe(404);
    expect((await post({ table_id: table.id, items: [] })).status()).toBe(400);
    expect(
      (await post({ table_id: table.id, items: [{ product_id: 'not-a-product', quantity: 1 }] })).status(),
    ).toBe(400);

    for (const path of ['/api/orders', '/api/tables', '/api/customers-search?q=a']) {
      const res = await request.get(`${E2E_SERVER_APP_BASE_URL}${path}`);
      expect(res.status(), `${path} must still need a sign-in`).toBe(401);
    }

    const menu = await (await request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/menu`)).json();
    expect(menu.products.length).toBeGreaterThan(0);
    for (const product of menu.products) {
      expect(product).not.toHaveProperty('cost');
    }
  });
});
