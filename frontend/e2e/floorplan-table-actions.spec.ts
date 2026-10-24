import { test, expect, type APIRequestContext } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

test.use({ viewport: { width: 1280, height: 1300 } });

const EMAIL = 'manager@flo.local';
const PASSWORD = 'E2ePass123!';
const FLOOR = 'Actions';

type ApiTable = { id: string; number: string; is_active: boolean };

async function apiAuth(request: APIRequestContext) {
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const { access_token } = await login.json();
  return { Authorization: `Bearer ${access_token}` };
}

async function listTables(request: APIRequestContext, headers: Record<string, string>) {
  const body = await (await request.get(`${BASE}/api/tables`, { headers })).json();
  return (body.tables ?? []) as ApiTable[];
}

async function createPlacedTable(
  request: APIRequestContext,
  headers: Record<string, string>,
  number: string,
  position: { x: number; y: number },
) {
  const created = await request.post(`${BASE}/api/tables`, {
    headers,
    data: {
      number,
      capacity: 4,
      floor: FLOOR,
      position_x: position.x,
      position_y: position.y,
    },
  });
  expect(created.ok()).toBeTruthy();
  return ((await created.json()).table ?? (await listTables(request, headers)).find((t) => t.number === number)) as ApiTable;
}

async function openPlan(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.goto(`${BASE}/tables`);
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await page.getByRole('button', { name: 'Floor plan' }).click();
  await page.getByTestId('floorplan-floor-tabs').getByRole('button', { name: FLOOR }).click();
}

test('table actions: Add Table opens the form on the current floor', async ({ page, request }) => {
  const headers = await apiAuth(request);
  const runId = Math.random().toString(36).slice(2, 7);
  await createPlacedTable(request, headers, `A-${runId}`, { x: 40, y: 40 });

  await openPlan(page);
  await page.getByTestId(`floorplan-chip-A-${runId}`).click();
  const sheet = page.getByRole('dialog', { name: `A-${runId}` });
  await expect(sheet.getByRole('button', { name: 'Edit Table' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Add Table' }).click();

  const form = page.getByTestId('floorplan-table-form');
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Floor')).toHaveValue(FLOOR);
});

test('table actions: Delete Table deactivates it and removes it from the plan', async ({
  page,
  request,
}) => {
  const headers = await apiAuth(request);
  const runId = Math.random().toString(36).slice(2, 7);
  const name = `D-${runId}`;
  await createPlacedTable(request, headers, name, { x: 60, y: 60 });

  await openPlan(page);
  await page.getByTestId(`floorplan-chip-${name}`).click();
  await page
    .getByRole('dialog', { name })
    .getByRole('button', { name: 'Delete Table' })
    .click();

  const confirm = page.getByTestId('floorplan-table-delete-form');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByTestId(`floorplan-chip-${name}`)).toBeVisible();

  await page.getByTestId(`floorplan-chip-${name}`).click();
  await page
    .getByRole('dialog', { name })
    .getByRole('button', { name: 'Delete Table' })
    .click();
  await page
    .getByTestId('floorplan-table-delete-form')
    .getByRole('button', { name: 'Delete Table' })
    .click();

  await expect(page.getByText('Table deleted')).toBeVisible();
  await expect(page.getByTestId(`floorplan-chip-${name}`)).toBeHidden();

  const row = (await listTables(request, headers)).find((t) => t.number === name);
  expect(row).toBeDefined();
  expect(Boolean(row!.is_active)).toBe(false);
});
