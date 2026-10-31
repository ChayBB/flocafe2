import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

type SoundLog = { __beeps: number; __bells: number; __spoken: string[]; __voices: string[] };

async function recordSounds(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as SoundLog & Record<string, unknown>;
    w.__beeps = 0;
    w.__bells = 0;
    w.__spoken = [];
    w.__voices = [];
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      state = 'running';
      onstatechange: (() => void) | null = null;
      resume() {
        return Promise.resolve();
      }
      createOscillator() {
        w.__beeps += 1;
        return { type: '', frequency: { value: 0 }, connect: (node: unknown) => node, start() {}, stop() {} };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (node: unknown) => node };
      }
      decodeAudioData(data: ArrayBuffer) {
        return Promise.resolve({ duration: data.byteLength > 0 ? 0.05 : 0 });
      }
      createBufferSource() {
        return {
          buffer: null,
          onended: null,
          connect: (node: unknown) => node,
          start() {
            w.__bells += 1;
          },
        };
      }
    }
    class FakeUtterance {
      lang = '';
      rate = 1;
      voice: unknown = null;
      constructor(public text: string) {}
    }
    w.AudioContext = FakeAudioContext;
    w.SpeechSynthesisUtterance = FakeUtterance;
    const voices = [
      { name: 'Fake Local English', lang: 'en-US', localService: true },
      { name: 'Microsoft Fake Online (Natural) - English', lang: 'en-US', localService: false },
    ];
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => voices,
        speak: (utterance: FakeUtterance & { onend?: () => void; voice: { name: string } | null }) => {
          w.__spoken.push(utterance.text);
          w.__voices.push(utterance.voice?.name ?? '');
          setTimeout(() => utterance.onend?.(), 0);
        },
      },
    });
  });
}

const sounds = (page: Page) => page.evaluate(() => ({ ...(window as unknown as SoundLog) }));

test('KDS sound switches turn reading new items aloud and the ready-to-serve announcement on and off', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
  const run = Math.random().toString(36).slice(2, 7);
  const categoryName = `Sounds ${run}`;
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, { headers, data: { name: categoryName } });
  expect(category.status()).toBe(201);
  const productName = `Lemonade ${run}`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: (await category.json()).category.id,
      price: 40,
      tax_category_id: null,
      tax_behavior: 'exempt',
    },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id as string;
  const placeOrder = async () => {
    const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'takeaway',
        items: [
          { product_id: productId, quantity: 2 },
          { product_id: productId, quantity: 1, special_instructions: 'later' },
        ],
      },
    });
    expect(order.status()).toBe(201);
    return (await order.json()).order as { order_number: string; items: { id: number }[] };
  };
  const markReady = async (itemId: number) => {
    const ready = await page.request.patch(`${E2E_BASE_URL}/api/order-items/${itemId}/status`, {
      headers,
      data: { status: 'ready' },
    });
    expect(ready.ok(), await ready.text()).toBeTruthy();
  };

  // The KDS server hands out the ready bell sound.
  const bell = await page.request.get(`${E2E_KDS_BASE_URL}/sounds/kds-ready-bell.wav`);
  expect(bell.ok()).toBeTruthy();
  expect((await bell.body()).subarray(0, 4).toString()).toBe('RIFF');

  await recordSounds(page);
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace'))).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByTestId('kds-station-select').selectOption({ label: categoryName });

  await page.getByTestId('kds-settings-button').click();
  const dialog = page.getByTestId('kds-settings-dialog');
  for (const setting of ['readAloud', 'statusChange', 'orderReady']) {
    await expect(dialog.getByTestId(`kds-sound-switch-${setting}`)).toHaveAttribute('aria-checked', 'true');
  }
  await page.keyboard.press('Escape');

  // On by default: a new order is read out, and the bell rings and names the order when a menu
  // item turns ready to serve, even while the rest of the order is still cooking.
  const first = await placeOrder();
  await expect.poll(async () => (await sounds(page)).__spoken.join(' | '), { timeout: 15000 }).toContain(productName);
  expect((await sounds(page)).__voices.at(-1)).toBe('Microsoft Fake Online (Natural) - English');
  expect((await sounds(page)).__spoken.join(' | ')).toContain(`Order ${first.order_number}: 2 ${productName}`);
  const bellsBefore = (await sounds(page)).__bells;
  await markReady(first.items[0].id);
  await expect.poll(async () => (await sounds(page)).__bells, { timeout: 15000 }).toBe(bellsBefore + 1);
  await expect
    .poll(async () => (await sounds(page)).__spoken.join(' | '), { timeout: 15000 })
    .toContain(`Order ${first.order_number} is ready to serve`);
  // The rest of the order turning ready within 10 seconds is not announced again.
  const afterFirst = await sounds(page);
  await markReady(first.items[1].id);
  await expect(page.getByTestId('kds-column-ready').or(page.getByTestId('kds-workspace')).first()).toBeVisible();
  await page.waitForTimeout(1500);
  expect((await sounds(page)).__bells).toBe(afterFirst.__bells);
  expect((await sounds(page)).__spoken).toEqual(afterFirst.__spoken);

  // The display can pick another voice; the choice is read out as a sample.
  await page.getByTestId('kds-settings-button').click();
  const voiceSelect = dialog.getByTestId('kds-voice-select');
  await expect(voiceSelect.locator('option')).toHaveText([
    'Automatic (Edge natural voice when available)',
    'Windows voice on the POS computer',
    'Microsoft Fake Online (Natural) - English · natural, online',
    'Fake Local English',
  ]);
  await expect(voiceSelect.locator('optgroup')).toHaveCount(2);
  await voiceSelect.selectOption('Fake Local English');
  await expect.poll(async () => (await sounds(page)).__voices.at(-1)).toBe('Fake Local English');
  expect((await sounds(page)).__spoken.at(-1)).toBe('Table 5, fried rice, 2');

  // Switched off, and still off after a reload: new orders and ready orders stay silent.
  await dialog.getByTestId('kds-sound-switch-readAloud').click();
  await dialog.getByTestId('kds-sound-switch-orderReady').click();
  await expect(dialog.getByTestId('kds-sound-switch-readAloud')).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByTestId('kds-sound-switch-statusChange')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByTestId('kds-station-select').selectOption({ label: categoryName });
  await page.getByTestId('kds-settings-button').click();
  await expect(dialog.getByTestId('kds-sound-switch-orderReady')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');

  const second = await placeOrder();
  await expect(page.getByText(`#${second.order_number}`).first()).toBeVisible({ timeout: 15000 });
  const quiet = await sounds(page);
  await markReady(second.items[0].id);
  await page.waitForTimeout(2000);
  const after = await sounds(page);
  expect(after.__spoken).toEqual(quiet.__spoken);
  expect(after.__spoken.join(' | ')).not.toContain(second.order_number);
  expect(after.__bells).toBe(quiet.__bells);
});

test('a table with several items turning ready is announced once, and not again for 10 seconds', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
  const run = Math.random().toString(36).slice(2, 7);
  const tableName = `Bell ${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, { headers, data: { number: tableName, capacity: 4 } });
  expect(table.status()).toBe(201);
  const tableId = (await table.json()).table.id;
  // Two tickets on the same table, as when staff add a second round.
  const tickets: { items: { id: number }[] }[] = [];
  for (const note of ['first round', 'second round']) {
    const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        table_id: tableId,
        items: [
          { product_id: 'e2e-product', quantity: 1, special_instructions: `${note} a` },
          { product_id: 'e2e-product', quantity: 1, special_instructions: `${note} b` },
          { product_id: 'e2e-product', quantity: 1, special_instructions: `${note} c` },
        ],
      },
    });
    expect(order.status()).toBe(201);
    tickets.push((await order.json()).order);
  }
  const markReady = async (itemId: number) => {
    const ready = await page.request.patch(`${E2E_BASE_URL}/api/order-items/${itemId}/status`, {
      headers,
      data: { status: 'ready' },
    });
    expect(ready.ok(), await ready.text()).toBeTruthy();
  };
  const announced = async () =>
    (await sounds(page)).__spoken.filter((text) => text === `Table ${tableName} is ready to serve`).length;

  await page.clock.install();
  await recordSounds(page);
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace'))).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByText(`first round a`).first()).toBeVisible({ timeout: 15000 });
  const start = await sounds(page);
  const readyColumn = page.getByTestId('kds-column-ready');

  // Items from both tickets turn ready together: one bell, one announcement for the table.
  await Promise.all([markReady(tickets[0].items[0].id), markReady(tickets[1].items[0].id)]);
  await expect.poll(announced, { timeout: 15000 }).toBe(1);
  await page.waitForTimeout(1500);
  expect(await announced()).toBe(1);
  expect((await sounds(page)).__bells).toBe(start.__bells + 1);

  // More items for the same table within 10 seconds stay quiet, but still move on the screen.
  await page.clock.fastForward(5000);
  await markReady(tickets[0].items[1].id);
  await expect(readyColumn.getByText('first round b')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  expect(await announced()).toBe(1);
  expect((await sounds(page)).__bells).toBe(start.__bells + 1);

  // A skipped item is not announced later when the 10 seconds run out.
  await page.clock.fastForward(6000);
  await page.waitForTimeout(1500);
  expect(await announced()).toBe(1);

  // After the 10 seconds the next item for the table is announced again.
  await markReady(tickets[1].items[1].id);
  await expect.poll(announced, { timeout: 15000 }).toBe(2);
  expect((await sounds(page)).__bells).toBe(start.__bells + 2);
});
