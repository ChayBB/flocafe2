import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('an add-on group can be marked "Awaiting price" from the editor, under Required', async ({
  page,
}) => {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const groupName = `Market price ${Math.random().toString(36).slice(2, 8)}`;
  const created = await page.request.post(`${BASE}/api/addon-groups`, {
    headers,
    data: {
      name: groupName,
      is_required: false,
      min_selection: 0,
      max_selection: 1,
      allow_multiple_quantities: false,
      addons: [{ name: 'Per kg', price: 0 }],
    },
  });
  expect(created.status()).toBe(201);
  const group = (await created.json()).addon_group;
  expect(group.price_pending).toBe(false);

  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${BASE}/products`);
  await page.getByRole('tab', { name: 'Addon Groups', exact: true }).click();

  const row = page.getByRole('row').filter({ hasText: groupName });
  await row.getByRole('button', { name: 'Edit' }).click();

  const required = page.getByRole('checkbox', { name: 'Required', exact: true });
  const pricePending = page.getByRole('checkbox', { name: 'Awaiting price', exact: true });
  await expect(pricePending).not.toBeChecked();
  // The new option sits directly under "Required".
  const requiredBox = await required.boundingBox();
  const pendingBox = await pricePending.boundingBox();
  expect(pendingBox!.y).toBeGreaterThan(requiredBox!.y);

  await pricePending.check();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByText('Addon group updated')).toBeVisible();

  const stored = await page.request.get(`${BASE}/api/addon-groups/${group.id}`, { headers });
  expect((await stored.json()).addon_group.price_pending).toBe(true);

  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('checkbox', { name: 'Awaiting price', exact: true })).toBeChecked();
});
