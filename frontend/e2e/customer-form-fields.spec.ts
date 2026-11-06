import { randomInt } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

const FIELD_LABELS = ['First name', 'Last name', 'Phone number', 'Birthday', 'Note'];

function localThaiPhone(): string {
  return `08${randomInt(0, 100_000_000).toString().padStart(8, '0')}`;
}

async function loginAsManager(page: Page): Promise<Record<string, string>> {
  const loginResponse = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: E2E_PASSWORD },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const { access_token: token } = await loginResponse.json();

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  return { Authorization: `Bearer ${token}` };
}

async function expectFiveFieldsInOrder(modal: ReturnType<Page['locator']>) {
  const labels = await modal.locator('label').allInnerTexts();
  expect(labels.map((l) => l.trim()).filter((l) => FIELD_LABELS.includes(l))).toEqual(FIELD_LABELS);
  await expect(modal.locator('input[type="email"]')).toHaveCount(0);
  await expect(modal.getByLabel('Customer address')).toHaveCount(0);
  const phone = modal.getByLabel('Phone number');
  await expect(phone).toHaveAttribute('placeholder', 'e.g. 0812345678');
  await expect(phone).toHaveValue('');
  await expect(modal).not.toContainText('+66');
}

test('Customers page add form has first name, last name, phone, birthday and note, and saves a local number', async ({
  page,
}, testInfo) => {
  const auth = await loginAsManager(page);
  await page.goto(`${BASE}/customers`);
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();

  await page.getByRole('button', { name: 'Add Customer' }).click();
  const modal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Add Customer' }) });
  await expect(modal).toBeVisible();
  await expectFiveFieldsInOrder(modal);
  await page.screenshot({ path: testInfo.outputPath('customers-add-form.png') });

  const suffix = Date.now().toString(36);
  const firstName = `Form${suffix}`;
  const lastName = 'Jaidee';
  const phone = localThaiPhone();
  await modal.getByLabel('First name').fill(firstName);
  await modal.getByLabel('Last name').fill(lastName);
  await modal.getByLabel('Phone number').fill(phone);
  await modal.getByLabel('Birthday').fill('14031992');
  await modal.getByLabel('Note').fill('Less sugar');

  const createResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/customers',
  );
  await modal.getByRole('button', { name: 'Add Customer' }).click();
  const created = await createResponse;
  expect(created.status()).toBe(201);
  const sent = created.request().postDataJSON();
  expect('email' in sent || 'address' in sent).toBe(false);
  const customer = (await created.json()).customer;
  expect(customer).toMatchObject({
    name: `${firstName} ${lastName}`,
    first_name: firstName,
    last_name: lastName,
    phone: `+66${phone.slice(1)}`,
    birthday: '1992-03-14',
    notes: 'Less sugar',
  });
  await expect(modal).toBeHidden();

  // Search by last name and by the local number both find the new customer.
  const search = page.getByPlaceholder('Search by name, phone, or email…');
  await search.fill(lastName);
  await expect(
    page.locator('tbody tr').filter({ hasText: `${firstName} ${lastName}` }),
  ).toHaveCount(1);
  await search.fill(phone);
  const row = page.locator('tbody tr').filter({ hasText: `${firstName} ${lastName}` });
  await expect(row).toHaveCount(1);

  // The editor shows the same five fields with the number in local form.
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editModal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Edit Customer' }) });
  await expect(editModal).toBeVisible();
  await expect(editModal.getByLabel('First name')).toHaveValue(firstName);
  await expect(editModal.getByLabel('Last name')).toHaveValue(lastName);
  await expect(editModal.getByLabel('Phone number')).toHaveValue(phone);
  await expect(editModal.getByLabel('Birthday')).toHaveValue('14/03/1992');
  await expect(editModal.getByLabel('Note')).toHaveValue('Less sugar');

  // Email and address are no longer on the form, so an edit must leave them as stored.
  await page.request.put(`${BASE}/api/customers/${customer.id}`, {
    headers: auth,
    data: { email: 'kept@example.com', address: '9 Soi 1' },
  });
  await editModal.getByLabel('Last name').fill('Rakdee');
  await editModal.getByLabel('Birthday').fill('');
  const putResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      new URL(r.url()).pathname === `/api/customers/${customer.id}`,
  );
  await editModal.getByRole('button', { name: 'Update' }).click();
  const put = await putResponse;
  expect(put.status()).toBe(200);
  expect((await put.json()).customer).toMatchObject({
    name: `${firstName} Rakdee`,
    birthday: null,
    email: 'kept@example.com',
    address: '9 Soi 1',
  });
});

test('Customer saved before the split loads its full name into first and last name', async ({
  page,
}) => {
  const auth = await loginAsManager(page);
  const phone = localThaiPhone();
  const name = `Legacy${Date.now().toString(36)} Old Surname`;
  const res = await page.request.post(`${BASE}/api/customers`, {
    headers: auth,
    data: { name, phone },
  });
  expect(res.status()).toBe(201);

  await page.goto(`${BASE}/customers`);
  await page.getByPlaceholder('Search by name, phone, or email…').fill(phone);
  const row = page.locator('tbody tr').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editModal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Edit Customer' }) });
  await expect(editModal.getByLabel('First name')).toHaveValue(name.split(' ')[0]);
  await expect(editModal.getByLabel('Last name')).toHaveValue('Old Surname');
});

test('POS add-customer dialog shows the same five fields and saves them', async ({ page }) => {
  await loginAsManager(page);
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible({ timeout: 20000 });

  const phone = localThaiPhone();
  const posCustomerInput = page.getByTestId('pos-customer-search-input').first();
  await posCustomerInput.fill(phone);
  const addButton = page
    .getByRole('button', { name: new RegExp(`Create customer with phone: ${phone}`) })
    .first();
  await expect(addButton).toBeVisible({ timeout: 10000 });
  await addButton.click();

  const modal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Add Customer' }) });
  await expect(modal).toBeVisible();
  const labels = await modal.locator('label').allInnerTexts();
  expect(labels.map((l) => l.trim()).filter((l) => FIELD_LABELS.includes(l))).toEqual(FIELD_LABELS);
  await expect(modal.getByLabel('Phone number')).toHaveValue(phone);
  await expect(modal).not.toContainText('+66');

  const firstName = `Pos${Date.now().toString(36)}`;
  await modal.getByLabel('First name').fill(firstName);
  await modal.getByLabel('Last name').fill('Meesuk');
  await modal.getByLabel('Birthday').fill('31/01/2543');
  await modal.getByLabel('Note').fill('Regular');

  const createResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/customers',
  );
  await modal.getByRole('button', { name: 'Save' }).click();
  const created = await createResponse;
  expect(created.status()).toBe(201);
  expect((await created.json()).customer).toMatchObject({
    name: `${firstName} Meesuk`,
    phone: `+66${phone.slice(1)}`,
    birthday: '2000-01-31',
    notes: 'Regular',
  });
});

test('Customers table shows Visits, then Average Spend, then Total Spent, and sorts by average spend', async ({
  page,
}) => {
  const auth = await loginAsManager(page);
  const phone = localThaiPhone();
  const name = `NoVisit${Date.now().toString(36)}`;
  const res = await page.request.post(`${BASE}/api/customers`, {
    headers: auth,
    data: { name, phone },
  });
  expect(res.status()).toBe(201);

  await page.goto(`${BASE}/customers`);
  await expect(page.locator('thead th').filter({ hasText: 'Average Spend' })).toBeVisible();
  const headers = (await page.locator('thead th').allTextContents()).map((h) =>
    h.replace(/[↕\s]+$/u, '').trim(),
  );
  const visits = headers.indexOf('Visits');
  expect(visits).toBeGreaterThan(-1);
  expect(headers.slice(visits, visits + 3)).toEqual(['Visits', 'Average Spend', 'Total Spent']);

  await page.getByPlaceholder('Search by name, phone, or email…').fill(phone);
  const row = page.locator('tbody tr').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('customer-average-spend')).toHaveText('—');

  const sorted = page.waitForRequest((r) => {
    const url = new URL(r.url());
    return url.pathname === '/api/customers' && url.searchParams.get('sort') === 'avg_spent';
  });
  await page.locator('thead th').filter({ hasText: 'Average Spend' }).click();
  await sorted;
});

test('Customers page Exit button returns to Marketing & Members', async ({ page }) => {
  await loginAsManager(page);
  await page.goto(`${BASE}/customers`);
  const exit = page.getByTestId('customers-exit');
  await expect(exit).toHaveText('Exit');
  await exit.click();
  await page.waitForURL(
    (url) => url.pathname.startsWith('/settings') && url.searchParams.get('tab') === 'marketing',
    { timeout: 10000 },
  );
  await expect(page.getByTestId('settings-marketing-members')).toBeVisible();
});
