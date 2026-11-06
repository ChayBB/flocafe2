import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('Marketing & Members lists automatic promotions and discount codes separately', async ({
  page,
}) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 20000 });

  await page.goto(`${BASE}/settings?tab=marketing`);
  const hub = page.getByTestId('settings-marketing-members');
  await expect(hub.locator('li')).toHaveCount(9);

  await page.getByTestId('marketing-option-promotions').getByRole('button').click();
  const automatic = page.getByTestId('marketing-promo-automatic');
  await expect(automatic.locator('tbody tr')).toHaveCount(8);
  await expect(page.getByTestId('marketing-promo-type-happyHour')).toContainText('14:00');
  await expect(page.getByTestId('marketing-promo-type-firstVisit')).toHaveCount(0);

  await automatic.getByRole('button', { name: 'Back to Marketing & Members' }).click();
  await page.getByTestId('marketing-option-coupons').getByRole('button').click();
  const codes = page.getByTestId('marketing-promo-codes');
  await expect(codes.locator('tbody tr')).toHaveCount(6);
  await expect(page.getByTestId('marketing-promo-type-firstVisit')).toContainText('FIRST50');
  await expect(page.getByTestId('marketing-promo-type-happyHour')).toHaveCount(0);
});
