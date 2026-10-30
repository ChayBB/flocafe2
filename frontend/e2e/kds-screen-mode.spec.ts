import { test, expect, type Page } from '@playwright/test';
import { E2E_KDS_BASE_URL } from './helpers/urls';

async function openKds(page: Page) {
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace'))).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
}

const screen = (page: Page) =>
  page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    lowLight: document.documentElement.classList.contains('kds-lowlight'),
    background: getComputedStyle(document.body).backgroundColor,
  }));

test('each KDS display picks day, night, or low light and keeps it over the app theme', async ({ page }) => {
  // The app itself is dark on this device.
  await page.emulateMedia({ colorScheme: 'dark' });
  await openKds(page);
  await expect.poll(async () => (await screen(page)).background).toBe('rgb(23, 28, 35)');

  await page.getByTestId('kds-settings-button').click();
  const dialog = page.getByTestId('kds-settings-dialog');
  await expect(dialog.getByTestId('kds-screen-mode-auto')).toHaveAttribute('aria-checked', 'true');

  await dialog.getByTestId('kds-screen-mode-day').click();
  await expect.poll(() => screen(page)).toEqual({ dark: false, lowLight: false, background: 'rgb(243, 245, 247)' });

  await dialog.getByTestId('kds-screen-mode-lowlight').click();
  await expect.poll(() => screen(page)).toEqual({ dark: true, lowLight: true, background: 'rgb(14, 15, 17)' });
  await expect(dialog.getByTestId('kds-screen-mode-lowlight')).toHaveAttribute('aria-checked', 'true');

  // The choice belongs to this display and survives a reload, even with the app theme now light.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect.poll(() => screen(page)).toEqual({ dark: true, lowLight: true, background: 'rgb(14, 15, 17)' });

  await page.getByTestId('kds-settings-button').click();
  await dialog.getByTestId('kds-screen-mode-night').click();
  await expect.poll(() => screen(page)).toEqual({ dark: true, lowLight: false, background: 'rgb(23, 28, 35)' });

  // Following the app again returns to the app's light theme.
  await dialog.getByTestId('kds-screen-mode-auto').click();
  await expect.poll(() => screen(page)).toEqual({ dark: false, lowLight: false, background: 'rgb(243, 245, 247)' });
});
