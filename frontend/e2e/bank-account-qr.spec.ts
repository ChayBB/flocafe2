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
      data: { account: '' },
    });
  });

  test('the bank method pays through the PromptPay ID linked to the account', async ({
    request,
  }) => {
    const missing = await request.get(`${BASE}/api/payment-methods/qr-code`, {
      headers: owner(),
      params: { amount: '100', kind: 'bank' },
    });
    expect(missing.status()).toBe(404);
    expect((await missing.json()).code).toBe('bank_qr_account_missing');

    for (const bad of ['1234567890', '12345', '0041234567890123']) {
      const res = await request.put(`${BASE}/api/payment-methods/bank-qr-account`, {
        headers: owner(),
        data: { account: bad },
      });
      expect(res.status(), bad).toBe(400);
    }

    const saved = await request.put(`${BASE}/api/payment-methods/bank-qr-account`, {
      headers: owner(),
      data: { account: '081-234-5678' },
    });
    expect(saved.ok()).toBeTruthy();
    expect((await saved.json()).account).toBe('0812345678');

    const qr = await request.get(`${BASE}/api/payment-methods/qr-code`, {
      headers: owner(),
      params: { amount: '150.5', kind: 'bank' },
    });
    expect(qr.ok()).toBeTruthy();
    const body = await qr.json();
    expect(body.payload).toContain('0016A000000677010111' + '01130066812345678');
    expect(body.payload).not.toContain('A00000067701011104');
    expect(body.payload).toContain('5406150.50');
    expect(body.data_url).toMatch(/^data:image\/png;base64,/);
  });

  test('the PromptPay ID form sits under the bank account payment method in settings', async ({
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
    await expect(form).toContainText('PromptPay ID linked to this bank account');
    await expect(form.getByRole('combobox')).toHaveCount(0);
    await form.getByPlaceholder('Phone number, 13-digit ID or tax ID').fill('0105556000000');
    await form.getByRole('button', { name: 'PromptPay ID linked to this bank account' }).click();
    await expect(page.getByText('Bank account saved')).toBeVisible();

    const stored = await (
      await page.request.get(`${BASE}/api/payment-methods/bank-qr-account`, { headers: owner() })
    ).json();
    expect(stored.account).toBe('0105556000000');
  });
});
