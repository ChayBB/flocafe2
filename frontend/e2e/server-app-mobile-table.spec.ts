import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('on a phone, tapping a table keeps the picker and offers add items, kitchen status and the ordered list', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const run = Math.random().toString(36).slice(2, 7);

  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: `Phone cat ${run}` },
  });
  const extraName = `Extra ${run}`;
  const extra = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: extraName,
      category_id: (await category.json()).category.id,
      price: 30,
      tax_category_id: null,
      tax_behavior: 'exempt',
    },
  });
  expect(extra.status()).toBe(201);

  const tableRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: `Phone ${run}`, capacity: 4 },
  });
  const tableId = (await tableRes.json()).table.id;
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: tableId,
      items: [
        { product_id: 'e2e-product', quantity: 1 },
        { product_id: 'e2e-product', quantity: 2, special_instructions: 'two' },
        { product_id: 'e2e-product', quantity: 1, special_instructions: 'three' },
        { product_id: 'e2e-product', quantity: 1, special_instructions: 'four' },
      ],
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order;
  const items = created.items as { id: number }[];
  for (const [index, status] of [
    [1, 'preparing'],
    [2, 'ready'],
    [3, 'served'],
  ] as const) {
    const res = await page.request.patch(`${E2E_BASE_URL}/api/order-items/${items[index].id}/status`, {
      headers,
      data: { status },
    });
    expect(res.ok()).toBeTruthy();
  }

  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, managerToken],
  );
  await page.reload();
  await page.getByTestId('server-app-table-button').click();
  await page.getByRole('button', { name: new RegExp(`Phone ${run}`) }).click();

  // The picker stays open; above the menu search sit "Add food items" and the kitchen summary.
  await expect(page.getByRole('button', { name: new RegExp(`Phone ${run}`) })).toBeVisible();
  const actions = page.getByTestId('server-app-table-actions');
  await expect(actions).toBeVisible();
  const actionsBox = (await actions.boundingBox())!;
  const searchBox = (await page.getByTestId('pos-product-search').boundingBox())!;
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(searchBox.y);
  for (const [stage, label] of [
    ['pending', 'Waiting 1'],
    ['preparing', 'Preparing 1'],
    ['ready', 'Ready 1'],
    ['served', 'Served 1'],
  ]) {
    await expect(page.getByTestId(`server-app-stage-${stage}`)).toHaveText(label);
  }

  // The orange button opens the ordered-items list, filterable by stage.
  await page.getByTestId('server-app-ordered-items-button').click();
  const screen = page.getByTestId('server-app-ordered-items');
  await expect(screen).toContainText('Ordered items');
  await expect(screen).toContainText(created.order_number);
  await expect(screen.getByTestId('server-app-ordered-item')).toHaveCount(4);
  await expect(screen.getByTestId('server-app-ordered-tab-all')).toContainText('4');
  await screen.getByTestId('server-app-ordered-tab-ready').click();
  await expect(screen.getByTestId('server-app-ordered-item')).toHaveCount(1);
  await expect(screen.getByTestId('server-app-ordered-item')).toContainText('Ready');
  await expect(screen.getByTestId('server-app-ordered-item')).toContainText(/\d{2}:\d{2}/);
  // The list ends with "Exit" rather than a send button, and the cart button stays out of the way.
  await expect(screen.getByTestId('server-app-ordered-exit')).toHaveText('Exit');
  await expect(page.getByTestId('server-app-cart-button')).toBeHidden();

  // "Add food items" leads to the normal ordering screen for that table.
  await screen.getByTestId('server-app-ordered-add').click();
  await expect(screen).toHaveCount(0);
  await expect(page.getByTestId('server-app-table-actions')).toHaveCount(0);
  await expect(page.getByTestId('pos-product-search')).toBeVisible();
  await expect(page.locator('header')).toContainText(`Phone ${run}`);

  // Add a dish and send it from the cart; the table clears afterwards.
  const grid = page.getByTestId('pos-product-grid');
  await grid.getByTestId('pos-product-search').fill(extraName);
  await grid.getByTestId('pos-product-card').filter({ hasText: extraName }).click();
  await page.getByTestId('server-app-cart-button').click();
  await page.getByRole('button', { name: 'Add to order' }).last().click();
  await expect
    .poll(async () => {
      const body = await (await page.request.get(`${E2E_BASE_URL}/api/orders/${created.id}`, { headers })).json();
      return body.order.items.length;
    })
    .toBe(5);
  await expect(page.locator('header')).toContainText('Select a table');

  // Choosing the table again shows all five; "Exit" leaves the list and clears the table.
  const picker = page.getByTestId('server-app-table-button');
  if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
  await page.getByRole('button', { name: new RegExp(`Phone ${run}`) }).click();
  await page.getByTestId('server-app-ordered-items-button').click();
  await expect(page.getByTestId('server-app-ordered-item')).toHaveCount(5);
  await page.getByTestId('server-app-ordered-exit').click();
  await expect(page.getByTestId('server-app-ordered-items')).toHaveCount(0);
  await expect(page.locator('header')).toContainText('Select a table');
  await expect(page.getByTestId('server-app-cart-button')).toBeVisible();
});
