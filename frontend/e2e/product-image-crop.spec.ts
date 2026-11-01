import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('a wide product photo starts fully in view and is saved whole on a white square', async ({
  page,
}) => {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${BASE}/products`);

  const wide = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 100;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 400, 100);
    return canvas.toDataURL('image/png').split(',')[1];
  });

  await page.getByRole('button', { name: 'Add Product' }).click();
  await page.locator('input[type="file"]:not([capture])').setInputFiles({
    name: 'wide.png',
    mimeType: 'image/png',
    buffer: Buffer.from(wide, 'base64'),
  });
  const slider = page.locator('input[type="range"]');
  await expect(slider).toBeVisible();
  await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(0.25, 2);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Apply' }).click();

  const preview = page.getByRole('img', { name: 'Product' });
  await expect(preview).toBeVisible();
  const pixels = await preview.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    const size = canvas.width;
    return {
      square: canvas.width === canvas.height,
      corner: at(5, 5),
      bottom: at(size / 2, size - 5),
      left: at(3, size / 2),
      right: at(size - 3, size / 2),
    };
  });
  const near = (actual: number[], expected: number[]) =>
    actual.every((value, index) => Math.abs(value - expected[index]) < 40);
  expect(pixels.square).toBe(true);
  expect(near(pixels.corner, [255, 255, 255]), `corner ${pixels.corner}`).toBe(true);
  expect(near(pixels.bottom, [255, 255, 255]), `bottom ${pixels.bottom}`).toBe(true);
  expect(near(pixels.left, [255, 0, 0]), `left edge ${pixels.left}`).toBe(true);
  expect(near(pixels.right, [255, 0, 0]), `right edge ${pixels.right}`).toBe(true);
});
