import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('a product in a kitchen-priced category saves without a price', async ({ page }) => {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const run = Math.random().toString(36).slice(2, 7);

  const group = await page.request.post(`${BASE}/api/addon-groups`, {
    headers,
    data: {
      name: `Chef order ${run}`,
      kitchen_price: true,
      min_selection: 0,
      max_selection: 1,
      addons: [{ name: 'Chef pick', price: 0 }],
    },
  });
  expect(group.status()).toBe(201);
  const groupId = (await group.json()).addon_group.id;

  const category = await page.request.post(`${BASE}/api/categories`, {
    headers,
    data: { name: `As you like ${run}`, addon_group_ids: [groupId] },
  });
  expect(category.status()).toBe(201);
  const categoryId = (await category.json()).category.id;

  const productName = `Seafood dip ${run}`;
  const product = await page.request.post(`${BASE}/api/products`, {
    headers,
    data: { name: productName, category_id: categoryId, price: 0, tax_category_id: null, tax_behavior: 'exempt' },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id;

  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${BASE}/products`);

  await page.getByRole('row').filter({ hasText: productName }).getByRole('button').first().click();
  const kitchenPrice = page.getByTestId('product-price-kitchen');
  await expect(kitchenPrice).toBeVisible();
  await expect(kitchenPrice).toHaveValue('Kitchen sets the price for approval');

  await page.getByRole('button', { name: 'Update Product', exact: true }).click();
  await expect(kitchenPrice).toBeHidden();

  const stored = await (await page.request.get(`${BASE}/api/products/${productId}`, { headers })).json();
  expect(Number(stored.product.price)).toBe(0);
});
