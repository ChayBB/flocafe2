import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

type SpeechLog = { __spoken: string[] };

async function recordSpeech(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as SpeechLog & Record<string, unknown>;
    w.__spoken = [];
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      state = 'running';
      onstatechange: (() => void) | null = null;
      resume() {
        return Promise.resolve();
      }
      createOscillator() {
        return {
          type: '',
          frequency: { value: 0 },
          connect: (n: unknown) => n,
          start() {},
          stop() {},
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (n: unknown) => n };
      }
      decodeAudioData() {
        return Promise.resolve({ duration: 0 });
      }
      createBufferSource() {
        return { buffer: null, onended: null, connect: (n: unknown) => n, start() {} };
      }
    }
    class FakeUtterance {
      lang = '';
      rate = 1;
      volume = 1;
      voice: unknown = null;
      constructor(public text: string) {}
    }
    w.AudioContext = FakeAudioContext;
    w.SpeechSynthesisUtterance = FakeUtterance;
    const voices = [
      { name: 'Microsoft Fake Online (Natural) - English', lang: 'en-US', localService: false },
    ];
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => voices,
        speak: (utterance: FakeUtterance & { onend?: () => void }) => {
          if (utterance.volume > 0) w.__spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), 0);
        },
      },
    });
  });
}

const spokenAbout = async (page: Page, text: string) =>
  (await page.evaluate(() => (window as unknown as SpeechLog).__spoken)).filter((line) =>
    line.includes(text),
  );

test('the KDS shows a profane note masked and stops reading it at the first masked word', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const run = Math.random().toString(36).slice(2, 7);
  const filter = `${E2E_BASE_URL}/api/settings/customer-display/profanity-filter`;
  const before = await page.request.get(filter, { headers });
  expect(before.status()).toBe(200);
  const savedWords = (await before.json()).words as string[];
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: `Mask ${run}` },
  });
  expect(category.status()).toBe(201);
  const productName = `Stirfry ${run}`;
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
  const banned = `zz${run}`;
  expect(
    (await page.request.put(filter, { headers, data: { words: [banned, 'คำต้องห้าม'] } })).status(),
  ).toBe(200);

  try {
    await recordSpeech(page);
    await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
    await expect(
      page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
    ).toBeVisible();
    if (await page.getByTestId('kds-login-form').isVisible()) {
      await page.getByTestId('kds-login-email').fill('manager@flo.local');
      await page.getByTestId('kds-login-password').fill('E2ePass123!');
      await page.getByTestId('kds-login-submit').click();
    }
    await expect(page.getByTestId('kds-workspace')).toBeVisible();
    await page.waitForTimeout(1000);

    const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'takeaway',
        items: [
          {
            product_id: productId,
            quantity: 1,
            special_instructions: `spicy ${banned} | คำต้องห้าม เผ็ดมาก`,
          },
        ],
      },
    });
    expect(order.status()).toBe(201);

    await expect(page.getByText('spicy *** | *** เผ็ดมาก').first()).toBeVisible({
      timeout: 15000,
    });
    await expect.poll(() => spokenAbout(page, 'spicy'), { timeout: 15000 }).toEqual(['spicy']);
    const spoken = await page.evaluate(() => (window as unknown as SpeechLog).__spoken);
    expect(spoken.join(' ')).not.toContain('*');
    expect(spoken.join(' ')).not.toContain(banned);
    expect(spoken.join(' ')).not.toContain('เผ็ดมาก');
  } finally {
    await page.request.put(filter, { headers, data: { words: savedWords } });
  }
});
