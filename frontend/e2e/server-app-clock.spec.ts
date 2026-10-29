import { test, expect } from '@playwright/test';
import { E2E_SERVER_APP_BASE_URL } from './helpers/urls';

test('the Server App sign-in page shows a running 24-hour store clock', async ({ page }) => {
  const info = await (await page.request.get(`${E2E_SERVER_APP_BASE_URL}/api/server-app/info`)).json();
  expect(typeof info.timezone).toBe('string');
  expect(Math.abs(Date.parse(info.server_time) - Date.now())).toBeLessThan(5 * 60 * 1000);

  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(() => localStorage.removeItem('flocafe:server-app-token'));
  await page.reload();

  const clock = page.getByTestId('store-clock');
  await expect(clock).toBeVisible();
  const time = clock.locator('time');
  await expect(time).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  const first = await time.textContent();
  await expect(time).not.toHaveText(first!, { timeout: 3000 });

  // The clock sits above the sign-in fields.
  const clockBox = (await clock.boundingBox())!;
  const nameBox = (await page.getByRole('textbox').first().boundingBox())!;
  expect(clockBox.y).toBeLessThan(nameBox.y);
});
