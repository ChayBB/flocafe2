import { test, expect } from '@playwright/test';
import { E2E_KDS_BASE_URL } from './helpers/urls';

test('the KDS says which table’s kitchen ticket did not print, without reading an order number', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const run = Math.random().toString(36).slice(2, 7);
  await page.addInitScript(() => {
    const w = window as unknown as { __spoken: string[] } & Record<string, unknown>;
    w.__spoken = [];
    class FakeUtterance {
      lang = '';
      rate = 1;
      volume = 1;
      voice: unknown = null;
      constructor(public text: string) {}
    }
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
          connect: (node: unknown) => node,
          start() {},
          stop() {},
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (node: unknown) => node };
      }
    }
    w.AudioContext = FakeAudioContext;
    w.SpeechSynthesisUtterance = FakeUtterance;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [{ name: 'Fake Local English', lang: 'en-US', localService: true }],
        speak: (utterance: FakeUtterance & { onend?: () => void }) => {
          w.__spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), 0);
        },
      },
    });
  });
  const alerts = [
    {
      id: `kot-table-${run}`,
      kind: 'kot_unprinted',
      message: `ORD-T-${run}`,
      table: `T${run}`,
      sent_by: null,
      created_at: new Date().toISOString(),
    },
    {
      id: `kot-takeaway-${run}`,
      kind: 'kot_unprinted',
      message: `ORD-W-${run}`,
      table: null,
      sent_by: null,
      created_at: new Date().toISOString(),
    },
  ];
  // The display gets its alerts with the orders, over the socket or the first REST load.
  const withAlerts = (body: { alerts?: unknown[] }) => ({
    ...body,
    alerts: [...(body.alerts ?? []), ...alerts],
  });
  await page.route('**/api/kds/orders**', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withAlerts(await response.json()) });
  });
  await page.routeWebSocket(/\/kds(\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      try {
        const data = JSON.parse(String(message));
        if (data.type === 'initial_data' || data.type === 'orders') {
          ws.send(JSON.stringify(withAlerts(data)));
          return;
        }
      } catch {}
      ws.send(message);
    });
  });

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

  const notices = page.locator('[data-testid="kds-message"][data-kind="kot_unprinted"]');
  await expect(notices.filter({ hasText: `Table T${run}` })).toContainText(
    `Kitchen ticket for Table T${run} did not print`,
    { timeout: 20000 },
  );
  await expect(notices.filter({ hasText: `ORD-W-${run}` })).toContainText(
    `Kitchen ticket for Order ORD-W-${run} did not print`,
  );
  await expect(
    page.locator('[data-testid="kds-message"][data-kind="emergency"]', { hasText: run }),
  ).toHaveCount(0);

  const spoken = () =>
    page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join(' | '));
  await expect.poll(spoken).toContain(`Kitchen ticket for Table T${run} did not print`);
  await expect.poll(spoken).toContain('A kitchen ticket did not print');
  expect(await spoken()).not.toContain('ORD-');
});
