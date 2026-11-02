import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

// A 4×4 red PNG: small enough for the settings API, real enough to decode.
const LOGO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC';

test('a browser bill waits for its logo to decode before it prints', async ({ page }) => {
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const businessRes = await page.request.get(`${BASE}/api/settings/business`, { headers });
  expect(businessRes.ok()).toBeTruthy();
  const original = await businessRes.json();
  const tableNumber = `E2E-LOGO-${Date.now()}`;
  let tableId: string | undefined;
  let orderId: number | undefined;
  try {
    const put = await page.request.put(`${BASE}/api/settings/business`, {
      headers,
      data: {
        ...original,
        billing_type: 'postpaid',
        tables_required: true,
        receipt_logo: LOGO,
        bill_show_logo: true,
      },
    });
    expect(put.ok()).toBeTruthy();
    const tableRes = await page.request.post(`${BASE}/api/tables`, {
      headers,
      data: { number: tableNumber },
    });
    tableId = (await tableRes.json()).table.id;
    const orderRes = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: {
        table_id: tableId,
        type: 'dine_in',
        guest_count: 1,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(orderRes.ok()).toBeTruthy();
    orderId = (await orderRes.json()).order.id;
    const billRes = await page.request.post(`${BASE}/api/bills/generate`, {
      headers,
      data: { order_id: orderId },
    });
    expect(billRes.ok()).toBeTruthy();

    // The real popup prints; its print() records whether every image had decoded by then.
    await page.addInitScript(() => {
      const appWindow = window as Window & { __billPrintImages?: boolean[][] };
      appWindow.__billPrintImages = [];
      const open = window.open.bind(window);
      window.open = ((...args: Parameters<typeof window.open>) => {
        const popup = open(...args);
        if (popup) {
          popup.print = () => {
            appWindow.__billPrintImages?.push(
              Array.from(popup.document.images).map((img) => img.complete && img.naturalWidth > 0),
            );
          };
        }
        return popup;
      }) as typeof window.open;
    });
    await page.route('**/api/printers', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ contentType: 'application/json', body: '{"printers":[]}' });
      } else {
        await route.continue();
      }
    });

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await page.getByRole('button', { name: 'Select Table' }).click();
    await page.getByRole('button').filter({ hasText: tableNumber }).click();
    await page.getByRole('button', { name: /Print Bill/ }).click();

    const printed = () =>
      page.evaluate(
        () => (window as Window & { __billPrintImages?: boolean[][] }).__billPrintImages ?? [],
      );
    await expect.poll(async () => (await printed()).length).toBe(1);
    const [images] = await printed();
    expect(images.length).toBeGreaterThan(0);
    expect(images.every(Boolean)).toBe(true);
  } finally {
    if (orderId) {
      await page.request.patch(`${BASE}/api/orders/${orderId}/status`, {
        headers,
        data: { status: 'cancelled' },
      });
    }
    if (tableId) {
      await page.request.patch(`${BASE}/api/tables/${tableId}/status`, {
        headers,
        data: { status: 'available' },
      });
    }
    await page.request.put(`${BASE}/api/settings/business`, { headers, data: original });
  }
});
