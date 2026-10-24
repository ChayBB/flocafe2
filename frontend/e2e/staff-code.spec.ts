import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('owner gives a server a 4-digit staff code from the staff page', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(pos|orders|dashboard|settings)/, { timeout: 20000 });
  await page.goto(`${BASE}/staff`);

  const name = `Code ${Math.random().toString(36).slice(2, 7)}`;
  await page.getByRole('button', { name: 'Add Staff' }).click();
  await page.getByPlaceholder('Name', { exact: true }).fill(name);
  await page.getByPlaceholder('Password', { exact: true }).fill('E2ePass123!');
  await page.getByPlaceholder('Confirm password').fill('E2ePass123!');

  const codeInput = page.getByTestId('staff-code-input');
  await codeInput.pressSequentially('48a2159');
  await expect(codeInput).toHaveValue('4821');
  await page.getByRole('button', { name: 'Add Staff' }).last().click();

  await expect(page.getByText('Staff added')).toBeVisible();
  const card = page.locator('div.rounded-xl', { hasText: name }).first();
  await expect(card.getByText('Staff code set')).toBeVisible();
});
