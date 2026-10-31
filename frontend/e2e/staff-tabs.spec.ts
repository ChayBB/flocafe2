import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from './helpers/urls';
import { E2E_OPERATIONAL_PASSWORD, E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('the staff page keeps staff, time and wages, and zone responsibility behind their own tabs', async ({ page }) => {
  const headers = { Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}` };
  const run = Math.random().toString(36).slice(2, 7);
  const name = `Zoner ${run}`;
  const created = await page.request.post(`${E2E_BASE_URL}/api/staff`, {
    headers,
    data: { name, password: E2E_OPERATIONAL_PASSWORD, role: 'server' },
  });
  expect(created.status()).toBe(201);
  const userId = (await created.json()).staff.id as string;
  const zone = `Terrace ${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: `T ${run}`, capacity: 2, floor: zone },
  });
  expect(table.status()).toBe(201);
  const tableId = (await table.json()).table.id as string;
  const owner = await page.request.put(`${E2E_BASE_URL}/api/tables/${tableId}/owner`, {
    headers,
    data: { user_id: userId },
  });
  expect(owner.ok(), await owner.text()).toBeTruthy();

  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${E2E_BASE_URL}/staff`);

  // The staff tab opens first; the other sections wait behind their tabs.
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['Staff', 'Time and wages', 'Zone responsibility']);
  await expect(page.getByTestId('staff-tab-staff')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(name).first()).toBeVisible();
  await expect(page.getByTestId('attendance-panel')).toHaveCount(0);
  await expect(page.getByTestId('zone-panel')).toHaveCount(0);

  await page.getByTestId('staff-tab-attendance').click();
  await expect(page.getByTestId('attendance-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Staff' })).toHaveCount(0);

  await page.getByTestId('staff-tab-zones').click();
  const card = page.getByTestId('zone-card').filter({ hasText: zone });
  await expect(card.getByTestId('zone-owner')).toHaveText(`${name} · T ${run}`);
  await expect(page.getByRole('link', { name: 'Manage on the floor plan' })).toHaveAttribute('href', /^\/tables\/?$/);
});
