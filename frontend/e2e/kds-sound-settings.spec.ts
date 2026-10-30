import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

type SoundLog = { __beeps: number; __spoken: string[]; __voices: string[] };

async function recordSounds(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as SoundLog & Record<string, unknown>;
    w.__beeps = 0;
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
      data: { type: 'takeaway', items: [{ product_id: productId, quantity: 2 }] },
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

  // On by default: a new order is read out, and its chime sounds once it is ready to serve.
  const first = await placeOrder();
  await expect.poll(async () => (await sounds(page)).__spoken.join(' | '), { timeout: 15000 }).toContain(productName);
  expect((await sounds(page)).__voices.at(-1)).toBe('Microsoft Fake Online (Natural) - English');
  expect((await sounds(page)).__spoken.join(' | ')).toContain(`Order ${first.order_number}: 2 ${productName}`);
  const beepsBefore = (await sounds(page)).__beeps;
  await markReady(first.items[0].id);
  await expect.poll(async () => (await sounds(page)).__beeps, { timeout: 15000 }).toBe(beepsBefore + 2);
  await expect
    .poll(async () => (await sounds(page)).__spoken.join(' | '), { timeout: 15000 })
    .toContain(`Order ${first.order_number} is ready to serve`);

  // The display can pick another voice; the choice is read out as a sample.
  await page.getByTestId('kds-settings-button').click();
  const voiceSelect = dialog.getByTestId('kds-voice-select');
  await expect(voiceSelect.locator('option')).toHaveText([
    'Automatic (Edge natural voice when available)',
    'Microsoft Fake Online (Natural) - English · natural, online',
    'Fake Local English',
  ]);
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
  expect(after.__beeps).toBe(quiet.__beeps);
});
