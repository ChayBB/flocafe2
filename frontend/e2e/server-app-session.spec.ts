import { test, expect, Page } from '@playwright/test';
import { E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';
const SERVER_EMAIL = 'server@flo.local';

async function openLogin(page: Page): Promise<void> {
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(() => {
    const raw = localStorage.getItem('pos-settings');
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...parsed.state, language: 'en' };
    localStorage.setItem('pos-settings', JSON.stringify(parsed));
  });
  await page.reload();
}

async function signIn(page: Page): Promise<void> {
  await page.locator('input[type="email"]').fill(SERVER_EMAIL);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByTestId('server-app-session-button')).toBeVisible();
}

test.describe('Server App session', () => {
  test('sign-in screen shows a red user icon and the signed-in header a green one', async ({
    page,
  }) => {
    await openLogin(page);
    await expect(page.locator('form svg.text-red-600')).toBeVisible();
    await expect(page.getByTestId('server-app-session-button')).toHaveCount(0);

    await signIn(page);
    await expect(page.getByTestId('server-app-session-button')).toHaveClass(/text-green-600/);
  });

  test('the session token ends at a 06:00 boundary within the next 24 hours', async ({ page }) => {
    await openLogin(page);
    await signIn(page);
    const exp = await page.evaluate(
      (key) => JSON.parse(atob(localStorage.getItem(key)!.split('.')[1])).exp as number,
      TOKEN_KEY,
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(exp).toBeGreaterThan(nowSeconds);
    expect(exp - nowSeconds).toBeLessThanOrEqual(24 * 3600);
    expect(exp % 900).toBe(0);
  });

  test('the page signs out by itself when the session ends', async ({ page }) => {
    await page.clock.install();
    await openLogin(page);
    await signIn(page);
    await page.clock.fastForward('25:00:00');
    await expect(page.locator('form svg.text-red-600')).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  });

  test('pressing the user icon signs out', async ({ page }) => {
    await openLogin(page);
    await signIn(page);
    await page.getByTestId('server-app-session-button').click();
    await expect(page.locator('form svg.text-red-600')).toBeVisible();
  });
});
