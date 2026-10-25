import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

const brandVariable = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim().toLowerCase(),
  );

test('the Server App uses an orange brand colour while the rest of the app stays blue', async ({
  page,
}) => {
  const manager = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const created = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers: manager,
    data: { number: `Theme ${Math.random().toString(36).slice(2, 7)}`, capacity: 2 },
  });
  expect(created.ok()).toBeTruthy();

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
  await page.reload();

  const allChip = page.getByTestId('pos-category-row').getByRole('button', { name: 'All', exact: true });
  await expect(allChip).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/theme-server-app/);
  expect(await brandVariable(page)).toBe('#ea580c');
  // The selected category chip paints with the brand colour: orange, not blue.
  await expect(allChip).toHaveCSS('background-color', 'rgb(234, 88, 12)');

  // The same page signed out (login form) is orange too.
  await page.evaluate((key) => localStorage.removeItem(key), TOKEN_KEY);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/theme-server-app/);

  // The main app keeps the blue brand and carries no Server App theme class.
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await expect(page.locator('html')).not.toHaveClass(/theme-server-app/);
  expect(await brandVariable(page)).toBe('#3248ff');
});
