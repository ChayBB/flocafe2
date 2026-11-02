import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createFakeQrRelay } = require('../../tests/helpers/fake-qr-relay.cjs');

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
  const qr = await page.request.post(`${E2E_BASE_URL}/api/tables/order-qr`, {
    headers: manager(),
    data: { table_ids: [table.id] },
  });
  expect(qr.ok()).toBeTruthy();
  const url = new URL((await qr.json()).qrs[0].url as string);
  const token = url.searchParams.get('t') as string;
  return {
    name,
    id: table.id as string,
    token,
    query: `table=${encodeURIComponent(table.id)}&t=${token}`,
  };
}

test.describe('Server App guest from a table QR', () => {
  test('shows a Guest label and orange login button, no table picker, and orders for that table only', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);

    const header = page.locator('header');
    await expect(header.getByTestId('server-app-guest-name')).toHaveText('Guest');
    await expect(header.getByTestId('server-app-login-button')).toBeVisible();
    await expect(header.getByTestId('server-app-login-button')).toHaveClass(/bg-orange-500/);
    await expect(header.getByTestId('server-app-login-button')).toHaveText('');
    await expect(header.getByRole('img', { name: 'Flo' })).toHaveCount(0);
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
      await page.request.get(`${E2E_BASE_URL}/api/tables/owner-candidates`, {
        headers: ownerHeaders,
      })
    ).json();
    expect(
      candidates.staff.some((member: { name: string }) => member.name === 'Guest'),
    ).toBeFalsy();
  });

  test('an open page reloads itself when the POS serves a newer frontend, but not over unsent items', async ({
    page,
  }) => {
    const info = await page.request.get(`${E2E_SERVER_APP_BASE_URL}/api/server-app/info`);
    expect((await info.json()).frontend_build).toMatch(/^[0-9a-f]{12}$/);

    let build = 'build-a';
    await page.route('**/api/server-app/info', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), frontend_build: build },
      });
    });
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await expect(page.locator('header').getByTestId('server-app-guest-name')).toBeVisible();
    const mark = () => page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 1));
    const marked = () =>
      page.evaluate(() => (window as unknown as { __mark?: number }).__mark === 1);
    const comeBack = () =>
      page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(500);
    await mark();

    // The same build leaves the page alone; a new one reloads it.
    await comeBack();
    await page.waitForTimeout(1000);
    expect(await marked()).toBe(true);
    build = 'build-b';
    await comeBack();
    await expect.poll(marked, { timeout: 10000 }).toBe(false);
    await expect(page.locator('header').getByTestId('server-app-guest-name')).toBeVisible();

    // With items waiting to be sent it holds off.
    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await expect(page.getByRole('button', { name: 'Send to kitchen' }).first()).toBeEnabled();
    await mark();
    build = 'build-c';
    await comeBack();
    await page.waitForTimeout(1500);
    expect(await marked()).toBe(true);
  });

  test('customers always see the day theme, and staff get the night theme back after signing in', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.evaluate(() => localStorage.setItem('flo-theme-resolved', 'dark'));
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    const html = page.locator('html');
    await expect(page.locator('header').getByTestId('server-app-guest-name')).toBeVisible();
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);

    await page.getByTestId('server-app-login-button').click();
    await page.getByPlaceholder('Staff name').fill('server@flo.local');
    await page.getByPlaceholder('Staff code').fill('E2ePass123!');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.locator('header').getByTestId('server-app-staff-name')).toBeVisible();
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  });

  test('the guest label reads ลูกค้า in Thai', async ({ page }) => {
    const table = await createTable(page);
    const setServerLanguage = (value: string) =>
      page.request.put(`${E2E_BASE_URL}/api/settings/language`, {
        headers: manager(),
        data: { value },
      });
    await setServerLanguage('th');
    try {
      await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
      await page.evaluate(() => {
        const raw = localStorage.getItem('pos-settings');
        const parsed = raw ? JSON.parse(raw) : { state: {} };
        parsed.state = { ...parsed.state, language: 'th' };
        localStorage.setItem('pos-settings', JSON.stringify(parsed));
      });
      await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
      await expect(page.getByTestId('server-app-guest-name')).toHaveText('ลูกค้า');
    } finally {
      await setServerLanguage('en');
    }
  });

  test('signing in shows the staff name and the table list while keeping the QR table', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await page.getByTestId('server-app-login-button').click();
    await page.getByPlaceholder('Staff name').fill('server@flo.local');
    await page.getByPlaceholder('Staff code').fill('E2ePass123!');
    await page.getByRole('button', { name: 'Sign In' }).click();

    const header = page.locator('header');
    await expect(header.getByTestId('server-app-staff-name')).toHaveText('E2E server');
    await expect(header.getByTestId('server-app-table-button')).toHaveCount(0);
    await expect(page.getByTestId('server-app-table-picker')).toBeVisible();
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
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
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

    expect(
      (await post({ table_id: 'nope', items: [{ product_id: 'x', quantity: 1 }] })).status(),
    ).toBe(404);
    // A table id alone, or with another token, is not enough to order.
    const item = [{ product_id: 'e2e-product', quantity: 1 }];
    expect((await post({ table_id: table.id, items: item })).status()).toBe(404);
    expect(
      (await post({ table_id: table.id, table_token: 'x'.repeat(22), items: item })).status(),
    ).toBe(404);
    const tableOnly = await request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/table`, {
      params: { table_id: table.id },
    });
    expect(tableOnly.status()).toBe(404);
    expect((await post({ table_id: table.id, table_token: table.token, items: [] })).status()).toBe(
      400,
    );
    expect(
      (
        await post({
          table_id: table.id,
          table_token: table.token,
          items: [{ product_id: 'not-a-product', quantity: 1 }],
        })
      ).status(),
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

test('guests at one table ordering at the same moment share one bill, and every order needs a key', async ({
  page,
  request,
}) => {
  const table = await createTable(page);
  const post = (data: Record<string, unknown>) =>
    request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, {
      data: {
        table_id: table.id,
        table_token: table.token,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
        ...data,
      },
    });

  const keyless = await post({});
  expect(keyless.status()).toBe(400);
  expect((await keyless.json()).code).toBe('idempotency_key_required');

  const run = Math.random().toString(36).slice(2, 10);
  const sent = await Promise.all(
    ['a', 'b'].map((phone) => post({ idempotency_key: `guest-${run}-${phone}` })),
  );
  for (const response of sent) expect(response.status()).toBe(201);
  // A retry with a key already used is a replay, not another dish.
  expect((await post({ idempotency_key: `guest-${run}-a` })).status()).toBe(201);

  const orders = (
    await (
      await page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers: manager(),
        params: { table_id: table.id, type: 'dine_in', per_page: 5 },
      })
    ).json()
  ).orders as { items: { quantity: number; status: string }[] }[];
  expect(orders).toHaveLength(1);
  expect(orders[0].items.reduce((sum, item) => sum + item.quantity, 0)).toBe(2);
});

test('the QR ordering checkbox in OrderFlow settings closes and reopens ordering from a table QR', async ({
  page,
}) => {
  const table = await createTable(page);
  const owner = { Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}` };
  try {
    await page.goto(`${E2E_BASE_URL}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
    const checkbox = page.getByTestId('settings-qr-ordering');
    await expect(checkbox).toBeChecked();
    await expect(page.getByText('Take orders by QR code')).toBeVisible();
    await checkbox.uncheck();
    await expect(page.getByText('QR ordering turned off')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('settings-qr-ordering')).not.toBeChecked();

    // A guest scanning the table QR is told to ask staff, and the order route refuses.
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await expect(page.getByTestId('server-app-guest-closed')).toContainText(
      'Ordering by QR code is closed',
    );
    const refused = await page.request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, {
      data: {
        table_id: table.id,
        table_token: table.token,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('guest_ordering_disabled');

    await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
    await page.getByTestId('settings-qr-ordering').check();
    await expect(page.getByText('QR ordering turned on')).toBeVisible();
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await expect(page.locator('header').getByTestId('server-app-guest-name')).toHaveText('Guest');
  } finally {
    await page.request.put(`${E2E_BASE_URL}/api/settings/guest_qr_ordering_enabled`, {
      headers: owner,
      data: { value: 'true' },
    });
  }
});

test('table QR links use the public address, and cancelling QR codes in OrderFlow settings retires printed ones', async ({
  page,
}) => {
  const table = await createTable(page);
  const owner = { Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}` };
  const reset = () =>
    page.request.put(`${E2E_BASE_URL}/api/settings/guest-qr`, {
      headers: owner,
      data: { public_base_url: '', trusted_proxy: '' },
    });
  try {
    await page.goto(`${E2E_BASE_URL}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
    const network = page.getByTestId('settings-qr-network');
    await expect(network.getByText('Manual setup (your own VPS)')).toHaveCount(0);
    await expect(network.getByLabel('Public address for QR codes')).toHaveCount(0);

    const saved = await page.request.put(`${E2E_BASE_URL}/api/settings/guest-qr`, {
      headers: owner,
      data: { public_base_url: 'https://order.example.com/', trusted_proxy: '' },
    });
    expect((await saved.json()).public_base_url).toBe('https://order.example.com');

    // New QR codes point at the public address.
    const qr = await page.request.post(`${E2E_BASE_URL}/api/tables/order-qr`, {
      headers: owner,
      data: { table_ids: [table.id] },
    });
    const body = await qr.json();
    expect(body.public).toBe(true);
    expect(body.qrs[0].url).toBe(`https://order.example.com/server-standalone/?${table.query}`);

    // The settings button shows a QR for every active table on the public address.
    await network.getByRole('button', { name: 'Create QR and register tables' }).click();
    const sheet = page.getByTestId('table-qr-sheet');
    const card = sheet
      .locator('div', { has: page.getByRole('img', { name: 'QR' }) })
      .filter({ hasText: table.name })
      .last();
    await expect(card.getByText(table.name, { exact: true })).toHaveCSS('font-size', '23.4px');
    await expect(card.getByText('Menu', { exact: true })).toHaveCSS('font-size', '20.8px');
    await expect(card.getByRole('img', { name: 'QR' })).toHaveCSS('width', '166px');
    await expect(card.getByText(`Table ${table.name}`)).toHaveCount(0);
    await expect(sheet.getByText('https://order.example.com/server-standalone/')).toBeVisible();

    // Download saves every card as one PNG image.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      sheet.getByRole('button', { name: 'Download' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^QR-.+\.png$/);
    const png = await readFile(await download.path());
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.length).toBeGreaterThan(5000);

    await sheet.getByRole('button', { name: 'Close' }).first().click();
    await expect(sheet).toHaveCount(0);

    // Cancelling every QR code makes the printed one stop working.
    await network.getByRole('button', { name: 'Cancel all table QR codes' }).click();
    await page.getByRole('button', { name: 'Cancel all table QR codes' }).last().click();
    await expect(
      page.getByText('Old QR codes cancelled. Reprint the table QR codes.'),
    ).toBeVisible();
    const old = await page.request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/table`, {
      params: { table_id: table.id, t: table.token },
    });
    expect(old.status()).toBe(404);
  } finally {
    await reset();
  }
});

test('pairing with a QR ordering server by code opens a tunnel that serves guests only', async ({
  page,
}) => {
  const table = await createTable(page);
  const owner = { Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}` };
  const relay = await createFakeQrRelay();
  try {
    await page.goto(`${E2E_BASE_URL}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
    const pairing = page.getByTestId('settings-qr-relay');
    await pairing.getByLabel('QR ordering server address').fill(relay.url);
    await pairing.getByRole('button', { name: 'Create pairing code' }).click();
    const code = pairing.getByTestId('qr-relay-code');
    await expect(code).toHaveText(/^\d{6}$/);
    await expect(pairing.getByRole('img', { name: 'Pairing code' })).toBeVisible();
    await expect(pairing.getByText('Waiting for approval…')).toBeVisible();

    relay.approve((await code.textContent())!.trim(), {
      storeId: 'e2e-store',
      publicBaseUrl: 'https://e2e.order.example.com',
    });
    await expect(page.getByText('POS paired. Reprint the table QR codes.')).toBeVisible({
      timeout: 10000,
    });
    await relay.waitForTunnel();
    await expect(pairing.getByTestId('qr-relay-state')).toHaveText(
      'Connected to the QR ordering server',
      {
        timeout: 15000,
      },
    );
    await expect(
      pairing.getByText('Customers order at https://e2e.order.example.com'),
    ).toBeVisible();

    const qr = await page.request.post(`${E2E_BASE_URL}/api/tables/order-qr`, {
      headers: owner,
      data: { table_ids: [table.id] },
    });
    expect((await qr.json()).qrs[0].url).toBe(
      `https://e2e.order.example.com/server-standalone/?${table.query}`,
    );

    const guestTable = await relay.request(
      'GET',
      `/api/guest/table?table_id=${encodeURIComponent(table.id)}&t=${table.token}`,
    );
    expect(guestTable.status).toBe(200);
    expect(JSON.parse(guestTable.body.toString()).table.id).toBe(table.id);
    const page_ = await relay.request('GET', '/server-standalone/');
    expect(page_.status).toBe(200);
    expect((await relay.request('GET', '/api/orders')).status).toBe(404);
    expect(
      (await relay.request('POST', '/api/auth/login', { body: { email: 'owner@flo.local' } }))
        .status,
    ).toBe(404);

    await pairing.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('button', { name: 'Disconnect' }).last().click();
    await expect(page.getByText('Disconnected from the QR ordering server')).toBeVisible();
    expect(relay.unpaired).toContain('e2e-store');
    await expect(pairing.getByLabel('QR ordering server address')).toBeVisible();
  } finally {
    await page.request.delete(`${E2E_BASE_URL}/api/qr-relay`, { headers: owner });
    await relay.close();
  }
});

test('the guest site sends no referrer, hides dotfiles and keeps guest bodies small', async ({
  request,
}) => {
  const page = await request.get(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  expect(page.headers()['referrer-policy']).toBe('no-referrer');
  expect((await request.get(`${E2E_SERVER_APP_BASE_URL}/server-standalone/.env`)).status()).toBe(
    404,
  );
  expect((await request.get(`${E2E_SERVER_APP_BASE_URL}/.hidden/index.html`)).status()).toBe(404);
  const big = await request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, {
    data: { note: 'x'.repeat(150 * 1024) },
  });
  expect(big.status()).toBe(413);
  expect((await big.json()).code).toBe('body_too_large');
});

test('guests share one cached menu, and a menu edit shows on the next read', async ({
  request,
}) => {
  const menuNames = async (): Promise<Record<string, string>> => {
    const menu = await (await request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/menu`)).json();
    return Object.fromEntries(
      (menu.products as { id: string; name: string }[]).map((product) => [
        product.id,
        product.name,
      ]),
    );
  };
  const before = await menuNames();
  const productId = Object.keys(before)[0];
  expect(productId).toBeTruthy();
  const renamed = `${before[productId]} ${Math.random().toString(36).slice(2, 6)}`;
  try {
    const put = await request.put(`${E2E_BASE_URL}/api/products/${productId}`, {
      headers: manager(),
      data: { name: renamed },
    });
    expect(put.ok()).toBeTruthy();
    expect((await menuNames())[productId]).toBe(renamed);
  } finally {
    await request.put(`${E2E_BASE_URL}/api/products/${productId}`, {
      headers: manager(),
      data: { name: before[productId] },
    });
  }
  expect((await menuNames())[productId]).toBe(before[productId]);
});
