import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

// 1x1 orange PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

test('a small store logo uploads under the app CSP and is saved', async ({ page }) => {
  const owner = { Authorization: `Bearer ${getE2eToken()}` };
  const enabled = await page.request.put(`${BASE}/api/settings/server_app_enabled`, {
    headers: owner,
    data: { value: 'true' },
  });
  expect(enabled.ok()).toBeTruthy();
  await page.request.put(`${BASE}/api/settings/branding`, {
    headers: owner,
    data: { store_logo: '' },
  });

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 20000 });

  await page.goto(`${BASE}/settings?tab=server-app`);
  const card = page.getByTestId('settings-store-branding');
  await expect(card).toBeVisible();
  await page.getByTestId('settings-store-logo-input').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG,
  });

  await expect(card.locator('img').first()).toHaveAttribute('src', /^data:image\/webp;base64,/);
  await expect(page.getByTestId('sidebar-store-logo')).toHaveAttribute(
    'src',
    /^data:image\/webp;base64,/,
  );
  await expect(page.getByTestId('sidebar-store-header')).toContainText(/\S/);
  const saved = await page.request.get(`${BASE}/api/settings/branding`, { headers: owner });
  expect((await saved.json()).store_logo).toMatch(/^data:image\/webp;base64,/);
});
