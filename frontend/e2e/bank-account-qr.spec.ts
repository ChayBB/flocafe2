import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

const owner = () => ({
  Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
});

test.describe('bank account payment QR', () => {
  test.afterEach(async ({ request }) => {
    await request.put(`${BASE}/api/payment-methods/bank-qr-account`, {
      headers: owner(),
      data: { bank_code: '', account_number: '' },
    });
  });

  test('the API validates the bank account and builds a bank-transfer QR for the amount', async ({
    request,
  }) => {
    const missing = await request.get(`${BASE}/api/payment-methods/qr-code`, {
      headers: owner(),
      params: { amount: '100', kind: 'bank' },
    });
    expect(missing.status()).toBe(404);
    expect((await missing.json()).code).toBe('bank_qr_account_missing');

    for (const bad of [
      { bank_code: '999', account_number: '1234567890' },
      { bank_code: '004', account_number: '12345' },
      { bank_code: '', account_number: '1234567890' },
    ]) {
      const res = await request.put(`${BASE}/api/payment-methods/bank-qr-account`, {
        headers: owner(),
        data: bad,
      });
      expect(res.status(), JSON.stringify(bad)).toBe(400);
    }

    const saved = await request.put(`${BASE}/api/payment-methods/bank-qr-account`, {
      headers: owner(),
      data: { bank_code: '004', account_number: '123-4-56789-0' },
    });
    expect(saved.ok()).toBeTruthy();
    expect((await saved.json()).account).toEqual({ bank_code: '004', account_number: '1234567890' });

    const qr = await request.get(`${BASE}/api/payment-methods/qr-code`, {
      headers: owner(),
      params: { amount: '150.5', kind: 'bank' },
    });
    expect(qr.ok()).toBeTruthy();
    const body = await qr.json();
    expect(body.payload).toContain('0016A000000677010111' + '0413' + '0041234567890');
    expect(body.payload).toContain('5406150.50');
    expect(body.data_url).toMatch(/^data:image\/png;base64,/);
  });

  test('the bank account form sits under the bank account payment method in settings', async ({
    page,
  }) => {
    const methods = await (
      await page.request.get(`${BASE}/api/payment-methods?include_inactive=true`, { headers: owner() })
    ).json();
    if (!methods.payment_methods.some((method: { name: string }) => method.name === 'Bank account')) {
      const created = await page.request.post(`${BASE}/api/payment-methods`, {
        headers: owner(),
        data: { name: 'Bank account' },
      });
      expect(created.ok()).toBeTruthy();
    }

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/(pos|orders|dashboard|settings)/, { timeout: 20000 });
    await page.goto(`${BASE}/settings?tab=payments`);

    const form = page.getByTestId('bank-qr-account-form');
    await expect(form).toBeVisible();
    await form.getByRole('combobox', { name: 'Bank' }).selectOption('014');
    const accountInput = form.getByPlaceholder('Account number');
    await accountInput.fill('12a3-456-7890');
    await expect(accountInput).toHaveValue('123-456-7890');
    await form.getByRole('button', { name: 'Bank account for payment QR' }).click();
    await expect(page.getByText('Bank account saved')).toBeVisible();

    const stored = await (
      await page.request.get(`${BASE}/api/payment-methods/bank-qr-account`, { headers: owner() })
    ).json();
    expect(stored.account).toEqual({ bank_code: '014', account_number: '1234567890' });
  });
});
