import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_OPERATIONAL_PASSWORD, E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('sign-in and sign-out record a shift, and the staff page turns it into a wage', async ({ page }) => {
  const ownerHeaders = { Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}` };
  const name = `Shift ${Math.random().toString(36).slice(2, 7)}`;
  const created = await page.request.post(`${E2E_BASE_URL}/api/staff`, {
    headers: ownerHeaders,
    data: { name, password: E2E_OPERATIONAL_PASSWORD, role: 'server' },
  });
  expect(created.status()).toBe(201);
  const userId = (await created.json()).staff.id;

  // The first sign-in of the day starts the shift; signing out ends it.
  const login = await page.request.post(`${E2E_SERVER_APP_BASE_URL}/api/auth/login`, {
    data: { identifier: name, password: E2E_OPERATIONAL_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const token = (await login.json()).access_token;
  const logout = await page.request.post(`${E2E_SERVER_APP_BASE_URL}/api/auth/logout`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(logout.status()).toBe(200);

  const report = await (await page.request.get(`${E2E_BASE_URL}/api/attendance`, { headers: ownerHeaders })).json();
  const row = report.staff.find((member: { user_id: string }) => member.user_id === userId);
  expect(row.entries).toHaveLength(1);
  expect(row.entries[0].clock_out_at).not.toBeNull();

  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${E2E_BASE_URL}/staff`);

  const panel = page.getByTestId('attendance-panel');
  await expect(panel.getByRole('heading', { name: 'Attendance and wages' })).toBeVisible();
  const staffRow = panel.getByTestId(`attendance-row-${userId}`);
  await staffRow.getByTestId('attendance-rate').fill('100');
  await staffRow.getByTestId('attendance-rate').blur();
  await expect(page.getByText('Hourly rate saved')).toBeVisible();

  // Correct the shift to 09:00-17:00 store time: 8 hours at 100.
  await staffRow.getByRole('button', { name }).click();
  const entry = panel.getByTestId('attendance-entry');
  await expect(entry).toHaveCount(1);
  await entry.getByRole('button', { name: 'Edit' }).click();
  await panel.getByLabel('Clock in').fill(`${report.today}T09:00`);
  await panel.getByLabel('Clock out').fill(`${report.today}T17:00`);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Shift times saved')).toBeVisible();

  await expect(staffRow.getByTestId('attendance-hours')).toHaveText('8.00');
  await expect(staffRow.getByTestId('attendance-wage')).toContainText('800.00');
  await expect(panel.getByTestId('attendance-entry')).toContainText('09:00');
  await expect(panel.getByTestId('attendance-entry')).toContainText('17:00');
  await expect(panel.getByTestId('attendance-entry')).toContainText('edited');
});
