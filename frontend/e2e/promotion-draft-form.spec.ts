import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('the draft promotion form previews its rules and blocks invalid values', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 20000 });

  await page.goto(`${BASE}/settings?tab=marketing`);
  await page.getByTestId('marketing-create-promotion').click();
  const form = page.getByTestId('promotion-draft-form');
  const preview = page.getByTestId('promotion-draft-preview');
  await expect(form.getByLabel('Coupon Code')).toBeChecked();
  await expect(preview).toContainText('Minimum spend: 300 baht');
  await expect(preview).toContainText('Discount: 10% (up to 100 baht)');
  await expect(preview).toContainText('Limit: 1 per member');

  await form.getByLabel('Discount (%)').fill('150');
  await expect(preview).toContainText('at most 100%');
  await expect(form.getByRole('button', { name: 'Copy example Config' })).toBeDisabled();

  await form.getByRole('button', { name: 'Back to Marketing & Members' }).click();
  await expect(page.getByTestId('settings-marketing-members')).toBeVisible();
});
