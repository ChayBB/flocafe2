import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

const manager = () => ({
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
});

async function createCategoryWithProducts(
  page: Page,
  name: string,
  productCount: number,
): Promise<string> {
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers: manager(),
    data: { name, sort_order: 900 },
  });
  expect(category.status()).toBe(201);
  const categoryId = (await category.json()).category.id as string;
  for (let index = 0; index < productCount; index += 1) {
    const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
      headers: manager(),
      data: {
        name: `${name} item ${index + 1}`,
        category_id: categoryId,
        price: 10,
        tax_category_id: null,
        tax_behavior: 'exempt',
      },
    });
    expect(product.status()).toBe(201);
  }
  return categoryId;
}

test('the highlighted category follows the menu scroll and choosing one scrolls to it', async ({
  page,
}) => {
  const run = Math.random().toString(36).slice(2, 6);
  const first = `Spy A ${run}`;
  const second = `Spy B ${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers: manager(),
    data: { number: `Spy ${run}`, capacity: 2 },
  });
  expect(table.ok()).toBeTruthy();
  await createCategoryWithProducts(page, first, 14);
  await createCategoryWithProducts(page, second, 24);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, getE2eToken('e2e-server', 'server@flo.local', 'server')],
  );
  await page.reload();

  const grid = page.getByTestId('pos-product-grid');
  const scroller = page.getByTestId('pos-catalog-scroll');
  const row = page.getByTestId('pos-category-row');
  const chip = (name: string) => row.getByRole('button', { name, exact: true });
  const isActive = async (name: string) =>
    (await chip(name).getAttribute('aria-pressed')) === 'true';

  await expect(grid.getByRole('heading', { name: first, exact: true })).toBeVisible();
  await expect(grid.getByRole('heading', { name: second, exact: true })).toHaveCount(1);
  await expect(page.getByText(`${second} item 24`)).toHaveCount(1);
  expect(await isActive('All')).toBe(true);
  expect(await isActive(second)).toBe(false);

  // Scrolling down to the second category highlights it.
  await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect.poll(() => isActive(second)).toBe(true);
  expect(await isActive(first)).toBe(false);
  expect(await isActive('All')).toBe(false);

  // Scrolling back to the first category moves the highlight back.
  await grid.getByRole('heading', { name: first, exact: true }).scrollIntoViewIfNeeded();
  await scroller.evaluate((element) => {
    const heading = Array.from(element.querySelectorAll('h2')).find((node) =>
      node.textContent?.startsWith('Spy A'),
    ) as HTMLElement;
    element.scrollTo(
      0,
      element.scrollTop + heading.getBoundingClientRect().top - element.getBoundingClientRect().top,
    );
  });
  await expect.poll(() => isActive(first)).toBe(true);

  // Choosing a category scrolls its section to the top and keeps it highlighted.
  await chip(second).click();
  await expect
    .poll(async () =>
      scroller.evaluate((element) => {
        const heading = Array.from(element.querySelectorAll('h2')).find((node) =>
          node.textContent?.startsWith('Spy B'),
        ) as HTMLElement;
        return Math.abs(heading.getBoundingClientRect().top - element.getBoundingClientRect().top);
      }),
    )
    .toBeLessThan(40);
  await page.waitForTimeout(1000);
  expect(await isActive(second)).toBe(true);

  // "All categories" returns to the top.
  await chip('All').click();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(5);
  await expect.poll(() => isActive('All')).toBe(true);

  // Picking a category ends a search and still scrolls to that category.
  const search = page.getByTestId('pos-product-search');
  await search.fill(`${first} item 3`);
  await expect(page.getByText(`${second} item 24`)).toHaveCount(0);
  await chip(second).click();
  await expect(search).toHaveValue('');
  await expect
    .poll(async () =>
      scroller.evaluate((element) => {
        const heading = Array.from(element.querySelectorAll('h2')).find((node) =>
          node.textContent?.startsWith('Spy B'),
        ) as HTMLElement;
        return Math.abs(heading.getBoundingClientRect().top - element.getBoundingClientRect().top);
      }),
    )
    .toBeLessThan(40);

  // Scrolling the menu ends a search too.
  await search.fill(`${first} item`);
  await scroller.hover();
  await page.mouse.wheel(0, 300);
  await expect(search).toHaveValue('');
  await expect(page.getByText(`${second} item 24`)).toHaveCount(1);
});

test('the menu shows two columns and scrolling past the last category carries on into the first', async ({
  page,
}) => {
  const run = Math.random().toString(36).slice(2, 6);
  await createCategoryWithProducts(page, `Loop ${run}`, 6);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, getE2eToken('e2e-server', 'server@flo.local', 'server')],
  );
  await page.reload();
  const scroller = page.getByTestId('pos-catalog-scroll');
  await expect(scroller.locator('[data-category-section]').first()).toBeVisible();

  const columns = await scroller
    .locator('[data-category-section] > div')
    .first()
    .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(2);

  const sectionOrder = () =>
    scroller.evaluate((element) =>
      Array.from(element.querySelectorAll<HTMLElement>('[data-category-section]')).map(
        (node) => node.dataset.categorySection,
      ),
    );
  const start = await sectionOrder();
  const total = start.length;
  expect(total).toBeGreaterThan(2);
  const cardCount = await scroller.getByTestId('pos-product-card').count();

  // The browser must not re-anchor the scroll on top of the loop's own shift, or the menu jumps.
  expect(await scroller.evaluate((element) => getComputedStyle(element).overflowAnchor)).toBe(
    'none',
  );
  await scroller.evaluate((element) => {
    const log: { top: number; heads: [string, number][] }[] = [];
    (window as unknown as { __menuFrames: typeof log }).__menuFrames = log;
    const tick = () => {
      const box = element.getBoundingClientRect();
      log.push({
        top: element.scrollTop,
        heads: Array.from(element.querySelectorAll<HTMLElement>('[data-category-section]')).map(
          (node) => [
            node.dataset.categorySection ?? '',
            node.getBoundingClientRect().top - box.top,
          ],
        ),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Scrolling on and on wraps round: the first category comes back after the last, nothing is duplicated.
  await scroller.hover();
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, 1500);
        return (await sectionOrder())[0];
      },
      { timeout: 20000, intervals: [100] },
    )
    .not.toBe(start[0]);
  const rotated = await sectionOrder();
  expect([...rotated].sort()).toEqual([...start].sort());
  const shift = rotated.indexOf(start[0]);
  expect(rotated).toEqual([...start.slice(total - shift), ...start.slice(0, total - shift)]);
  await expect(scroller.getByTestId('pos-product-card')).toHaveCount(cardCount);

  // While wrapping, a category on screen never jumps: when it moves, it moves only by what the wheel scrolled.
  const jumps = await page.evaluate(() => {
    const frames = (
      window as unknown as { __menuFrames: { top: number; heads: [string, number][] }[] }
    ).__menuFrames;
    const found: string[] = [];
    const height = (heads: [string, number][]) => Math.max(...heads.map(([, top]) => top));
    for (let index = 1; index < frames.length; index += 1) {
      const before = new Map(frames[index - 1].heads);
      const scrolled = frames[index].top - frames[index - 1].top;
      for (const [id, top] of frames[index].heads) {
        const previous = before.get(id);
        if (previous === undefined) continue;
        const moved = top - previous;
        const onScreen = previous > -50 && previous < window.innerHeight;
        const relocated = Math.abs(moved) > height(frames[index].heads) / 2;
        if (onScreen && !relocated && Math.abs(moved) > 2 && Math.abs(moved + scrolled) > 2)
          found.push(`${id}: ${moved} vs ${-scrolled}`);
      }
    }
    return found;
  });
  expect(jumps).toEqual([]);

  // Scrolling back up wraps the other way.
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, -1500);
        return JSON.stringify(await sectionOrder()) !== JSON.stringify(rotated);
      },
      { timeout: 20000, intervals: [100] },
    )
    .toBe(true);
});
