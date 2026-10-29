import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('a failed background refresh of the orders list stays quiet; a failed load the user asked for still says so', async ({
  page,
}) => {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${BASE}/orders`);
  await expect(page.getByRole('heading', { name: 'Orders' }).first()).toBeVisible();

  // The server goes away: the 10-second poll fails without a toast.
  let failedRequests = 0;
  await page.route('**/api/orders?**', async (route) => {
    failedRequests += 1;
    await route.abort('connectionrefused');
  });
  await expect.poll(() => failedRequests, { timeout: 15000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  await expect(page.getByText('Failed to load orders')).toHaveCount(0);

  // Switching tabs is the user's own request, so its failure is reported.
  await page.getByRole('button', { name: 'All', exact: true }).first().click();
  await expect(page.getByText('Failed to load orders').first()).toBeVisible();
});
