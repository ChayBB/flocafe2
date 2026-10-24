import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

test.use({ viewport: { width: 1280, height: 1000 } });

const EMAIL = 'manager@flo.local';
const PASSWORD = 'E2ePass123!';

type ApiTable = { id: string; number: string; orientation?: string };

async function apiAuth(request: import('@playwright/test').APIRequestContext) {
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const { access_token } = await login.json();
  return { Authorization: `Bearer ${access_token}` };
}

async function listTables(
  request: import('@playwright/test').APIRequestContext,
  headers: Record<string, string>,
): Promise<ApiTable[]> {
  return ((await (await request.get(`${BASE}/api/tables`, { headers })).json()).tables ??
    []) as ApiTable[];
}

test.beforeEach(async ({ request }) => {
  const headers = await apiAuth(request);
  let tables = await listTables(request, headers);
  for (const [number, capacity] of [
    ['R6', 6],
    ['R4', 4],
  ] as const) {
    if (!tables.some((t) => t.number === number)) {
      await request.post(`${BASE}/api/tables`, {
        headers,
        data: { number, capacity, floor: 'Rotate' },
      });
    }
  }
  tables = await listTables(request, headers);
  const positions = tables
    .filter((t) => t.number === 'R6' || t.number === 'R4')
    .map((t, i) => ({
      id: t.id,
      position_x: 30 + i * 40,
      position_y: 50,
      orientation: 'horizontal',
    }));
  await request.patch(`${BASE}/api/tables/positions`, { headers, data: { positions } });
});

async function openEditor(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.goto(`${BASE}/tables`);
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await page.getByRole('button', { name: 'Floor plan' }).click();
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await page
    .getByTestId('floorplan-floor-tabs')
    .getByRole('button', { name: 'Rotate' })
    .click();
}

const seatsBox = (page: import('@playwright/test').Page, name: string) =>
  page.getByTestId(`floorplan-chip-${name}`).locator('[data-seats]').boundingBox();

test('rotate: button only on 5+ seat tables, rotates, cancels, saves and persists', async ({
  page,
  request,
}) => {
  await openEditor(page);

  await expect(page.getByTestId('floorplan-rotate-R6')).toBeVisible();
  await expect(page.getByTestId('floorplan-rotate-R4')).toHaveCount(0);

  const before = (await seatsBox(page, 'R6'))!;
  expect(before.width).toBeGreaterThan(before.height);

  const chip = page.getByTestId('floorplan-chip-R6');
  const styleBefore = await chip.getAttribute('style');

  await page.getByTestId('floorplan-rotate-R6').click();
  const rotated = (await seatsBox(page, 'R6'))!;
  expect(rotated.height).toBeGreaterThan(rotated.width);
  // A click on the button must not count as a drag nor open the edit form.
  await expect(chip).toHaveAttribute('style', styleBefore!);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Cancel reverts
  await page.getByRole('button', { name: 'Cancel' }).click();
  const reverted = (await seatsBox(page, 'R6'))!;
  expect(reverted.width).toBeGreaterThan(reverted.height);

  // Rotate twice returns to saved state: nothing pending to save
  await page.getByTestId('floorplan-rotate-R6').click();
  await page.getByTestId('floorplan-rotate-R6').click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  // Rotate once, save, reload: persisted, position untouched
  await page.getByTestId('floorplan-rotate-R6').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Floorplan saved')).toBeVisible();

  const headers = await apiAuth(request);
  const saved = (await listTables(request, headers)).find((t) => t.number === 'R6')!;
  expect(saved.orientation).toBe('vertical');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await page.getByRole('button', { name: 'Floor plan' }).click();
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await page
    .getByTestId('floorplan-floor-tabs')
    .getByRole('button', { name: 'Rotate' })
    .click();
  await expect(chip).toHaveAttribute('style', styleBefore!);
  const after = (await seatsBox(page, 'R6'))!;
  expect(after.height).toBeGreaterThan(after.width);
});
