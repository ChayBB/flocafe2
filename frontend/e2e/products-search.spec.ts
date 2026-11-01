import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('the products search finds a menu item by its name, its category or its price', async ({
  page,
}) => {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const run = Math.random().toString(36).slice(2, 7);
  const price = 9000 + Math.floor(Math.random() * 900);
  const category = await page.request.post(`${BASE}/api/categories`, {
    headers,
    data: { name: `Searchcat ${run}` },
  });
  expect(category.status()).toBe(201);
  const product = await page.request.post(`${BASE}/api/products`, {
    headers,
    data: { name: `Searchdish ${run}`, category_id: (await category.json()).category.id, price },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id as string;

  try {
    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await page.goto(`${BASE}/products`);

    const search = page.locator('#products-search');
    await expect(search).toHaveAttribute('placeholder', 'Search menu name, category, price');
    const row = page.getByText(`Searchdish ${run}`, { exact: true });

    // The price is found as typed and as the list shows it, decimals and thousands separator included.
    for (const query of [
      `Searchdish ${run}`,
      `Searchcat ${run}`,
      String(price),
      `${price}.00`,
      `${String(price).slice(0, 1)},${String(price).slice(1)}.00`,
    ]) {
      await search.fill(query);
      await expect(row, `found by "${query}"`).toBeVisible();
    }
    await search.fill(`nothing-${run}`);
    await expect(row).toHaveCount(0);
  } finally {
    await page.request.delete(`${BASE}/api/products/${productId}`, { headers });
  }
});
