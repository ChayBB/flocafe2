import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';
import { optionsNote, spokenItemName, withoutOptionsNote } from '../src/lib/item-options-note';

const TOKEN_KEY = 'flocafe:server-app-token';

test('the KDS reads the chosen option and size instead of the listed choices and brackets', () => {
  const addons = [{ name: 'หมู' }];
  expect(spokenItemName('ข้าวต้ม หมู/กุ้ง/ไก่/ปลาหมึก', 'จานเล็ก', addons)).toBe('ข้าวต้มหมู จานเล็ก');
  expect(spokenItemName('ข้าวต้ม (หมู/กุ้ง)', 'ชามใหญ่', addons)).toBe('ข้าวต้มหมู ชามใหญ่');
  expect(spokenItemName('ข้าวต้ม หมู/กุ้ง', null, [])).toBe('ข้าวต้ม หมู/กุ้ง');
  // Invisible characters from imported names never reach the voice.
  expect(spokenItemName('ข้าวไข่เจียว\u200B หมู/กุ้ง/ไก่', null, [{ name: 'กุ้ง\uFEFF' }])).toBe(
    'ข้าวไข่เจียวกุ้ง',
  );
  const note = optionsNote('จานเล็ก', addons);
  expect(note).toBe('จานเล็ก หมู');
  expect(withoutOptionsNote('จานเล็ก หมู', note)).toBe('');
  expect(withoutOptionsNote('จานเล็ก หมู | ไม่ใส่ผัก', note)).toBe('ไม่ใส่ผัก');
  expect(withoutOptionsNote('ไม่ใส่ผัก', note)).toBe('ไม่ใส่ผัก');
});

test('a one-kind option folds once picked, and the size and option go into the special instructions', async ({
  page,
}) => {
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const group = await page.request.post(`${E2E_BASE_URL}/api/addon-groups`, {
    headers,
    data: {
      name: `Meat ${run}`,
      min_selection: 0,
      max_selection: 10,
      allow_multiple_quantities: true,
      addons: [
        { name: `Pork ${run}`, price: 0 },
        { name: `Shrimp ${run}`, price: 0 },
        { name: `Squid ${run}`, price: 0 },
      ],
    },
  });
  expect(group.status()).toBe(201);
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: `Soup ${run}` },
  });
  expect(category.status()).toBe(201);
  const productName = `Rice soup ${run}`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: (await category.json()).category.id,
      price: 60,
      tax_category_id: null,
      tax_behavior: 'exempt',
      addon_group_ids: [(await group.json()).addon_group.id],
      variants: [
        { name: 'Small plate', price: 60 },
        { name: 'Large plate', price: 70 },
      ],
    },
  });
  expect(product.status()).toBe(201);
  // Removed afterwards, so later suites that open the first menu card do not get this product's options.
  const cleanup = async () => {
    await page.request.delete(`${E2E_BASE_URL}/api/products/${(await product.json()).product.id}`, {
      headers,
    });
    await page.request.delete(
      `${E2E_BASE_URL}/api/addon-groups/${(await group.json()).addon_group.id}`,
      { headers },
    );
    await page.request.delete(
      `${E2E_BASE_URL}/api/categories/${(await category.json()).category.id}`,
      { headers },
    );
  };
  try {
    const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: `Opt ${run}`, capacity: 2 },
    });
    const tableId = (await table.json()).table.id;

    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
    await page.evaluate(
      ([key, token]) => {
        localStorage.setItem(key, token);
        const raw = localStorage.getItem('pos-settings');
        const parsed = raw ? JSON.parse(raw) : { state: {} };
        parsed.state = { ...parsed.state, language: 'en' };
        localStorage.setItem('pos-settings', JSON.stringify(parsed));
      },
      [TOKEN_KEY, getE2eToken('e2e-server', 'server@flo.local', 'server')],
    );
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${tableId}`);

    const grid = page.getByTestId('pos-product-grid');
    await grid.getByTestId('pos-product-search').fill(productName);
    await grid.getByTestId('pos-product-card').filter({ hasText: productName }).click();

    await page.getByRole('radio', { name: /Large plate/ }).click();
    const row = (name: string) => page.locator('div.min-h-14').filter({ hasText: name });
    await expect(row(`Shrimp ${run}`)).toBeVisible();
    await row(`Pork ${run}`).getByRole('button').click();
    await expect(row(`Shrimp ${run}`)).toHaveCount(0);
    await expect(row(`Squid ${run}`)).toHaveCount(0);
    // Dialling the pick back to 0 brings the other choices back.
    await row(`Pork ${run}`).getByRole('button').first().click();
    await expect(row(`Shrimp ${run}`)).toBeVisible();
    await row(`Shrimp ${run}`).getByRole('button').click();
    await expect(row(`Pork ${run}`)).toHaveCount(0);

    await page.getByRole('button', { name: /Add to Cart/ }).click();
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();

    const orders = await (
      await page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers,
        params: { table_id: tableId, type: 'dine_in', per_page: 1 },
      })
    ).json();
    expect(orders.orders[0].items[0].special_instructions).toBe(`Large plate Shrimp ${run}`);
  } finally {
    await cleanup();
  }
});
