import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL } from '../helpers/urls';
import { login, ownerAuth } from './helpers';

/** Settings theme picker: a light row and a dark row of three, plus System. */

async function storedSetting(page: Page, key: string): Promise<string | undefined> {
  const res = await page.request.get(`${E2E_BASE_URL}/api/settings/${key}`, {
    headers: ownerAuth(),
  });
  return ((await res.json()) as { setting?: { value?: string } }).setting?.value;
}

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));

test.describe('@ci-tier2 operations admin - theme picker', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'owner');
  });

  test.afterEach(async ({ request }) => {
    for (const [key, value] of [
      ['theme_mode', 'system'],
      ['theme_light_variant', '1'],
      ['theme_dark_variant', '1'],
    ]) {
      await request.put(`${E2E_BASE_URL}/api/settings/${key}`, {
        headers: ownerAuth(),
        data: { value },
      });
    }
  });

  test('lays out three light and three dark themes and saves the chosen variant', async ({
    page,
  }) => {
    await page.goto(`${E2E_BASE_URL}/settings?tab=appearance`);
    const group = page.getByRole('radiogroup', { name: 'Theme', exact: true });
    await expect(group).toBeVisible({ timeout: 20_000 });

    const names = ['Light', 'Light 2', 'Light 3', 'Dark', 'Dark 2', 'Dark 3', 'System'];
    await expect(group.getByRole('radio')).toHaveCount(names.length);
    const boxes = await Promise.all(
      names.map(async (name) => {
        const box = await group.getByRole('radio', { name, exact: true }).boundingBox();
        expect(box, `${name} is rendered`).not.toBeNull();
        return box!;
      }),
    );
    const rowTops = [0, 3, 6].map((start) => boxes[start].y);
    for (let i = 0; i < 6; i++) {
      expect(Math.abs(boxes[i].y - rowTops[Math.floor(i / 3)])).toBeLessThan(2);
    }
    expect(rowTops[1]).toBeGreaterThan(rowTops[0] + boxes[0].height - 1);
    expect(rowTops[2]).toBeGreaterThan(rowTops[1] + boxes[3].height - 1);
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
    expect(boxes[2].x).toBeGreaterThan(boxes[1].x);

    const radio = (name: string) => group.getByRole('radio', { name, exact: true });

    await radio('Dark 3').click();
    await expect(radio('Dark 3')).toHaveAttribute('aria-checked', 'true');
    await expect(radio('Dark')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => isDark(page)).toBe(true);
    await expect.poll(() => storedSetting(page, 'theme_mode')).toBe('dark');
    await expect.poll(() => storedSetting(page, 'theme_dark_variant')).toBe('3');

    await radio('Light 2').click();
    await expect(radio('Light 2')).toHaveAttribute('aria-checked', 'true');
    await expect(radio('Dark 3')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => isDark(page)).toBe(false);
    await expect.poll(() => storedSetting(page, 'theme_mode')).toBe('light');
    await expect.poll(() => storedSetting(page, 'theme_light_variant')).toBe('2');
    expect(await storedSetting(page, 'theme_dark_variant')).toBe('3');

    await page.reload();
    await expect(radio('Light 2')).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
    expect(await isDark(page)).toBe(false);

    await radio('Light').click();
    await expect(radio('Light')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => storedSetting(page, 'theme_light_variant')).toBe('1');
    expect(await storedSetting(page, 'theme_mode')).toBe('light');

    await radio('Dark').click();
    await expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => storedSetting(page, 'theme_dark_variant')).toBe('1');
    await expect.poll(() => isDark(page)).toBe(true);

    await radio('System').click();
    await expect(radio('System')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => storedSetting(page, 'theme_mode')).toBe('system');
  });

  test('Dark 2 paints the navy and gold palette and keeps it across a reload', async ({ page }) => {
    await page.goto(`${E2E_BASE_URL}/settings?tab=appearance`);
    const group = page.getByRole('radiogroup', { name: 'Theme', exact: true });
    const radio = (name: string) => group.getByRole('radio', { name, exact: true });
    const bodyBackground = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const hasDarkTwo = () =>
      page.evaluate(() => document.documentElement.classList.contains('theme-dark-2'));
    await expect(group).toBeVisible({ timeout: 20_000 });

    await radio('Dark').click();
    await expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => isDark(page)).toBe(true);
    expect(await hasDarkTwo()).toBe(false);
    const plainDark = await bodyBackground();

    await radio('Dark 2').click();
    await expect(radio('Dark 2')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(hasDarkTwo).toBe(true);
    await expect.poll(bodyBackground).toBe('rgb(28, 53, 70)');
    expect(plainDark).not.toBe('rgb(28, 53, 70)');
    await expect.poll(() => storedSetting(page, 'theme_dark_variant')).toBe('2');

    await page.reload();
    await expect.poll(hasDarkTwo).toBe(true);
    await expect.poll(bodyBackground).toBe('rgb(28, 53, 70)');
    await expect(radio('Dark 2')).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });

    await radio('Light').click();
    await expect.poll(() => isDark(page)).toBe(false);
    expect(await bodyBackground()).not.toBe('rgb(28, 53, 70)');

    await radio('Dark 3').click();
    await expect.poll(() => isDark(page)).toBe(true);
    await expect.poll(hasDarkTwo).toBe(false);
    await expect.poll(bodyBackground).toBe(plainDark);
  });
});
