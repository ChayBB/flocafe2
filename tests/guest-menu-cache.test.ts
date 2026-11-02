/**
 * The guest menu is read once per 30 seconds, and a successful catalog write drops it at once.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/guest-menu-cache.test.ts
 */
import express from 'express';
import request from 'supertest';

const {
  GUEST_MENU_TTL_MS,
  guestMenu,
  invalidateGuestMenu,
  invalidateGuestMenuOnCatalogWrite,
} = require('../main/lib/guest-menu-cache');
const { assertEqualOrThrow } = require('./helpers/test-setup');

async function main() {
  let clock = 1_000;
  const now = () => clock;
  let loads = 0;
  const load = async () => ({ version: ++loads });

  assertEqualOrThrow((await guestMenu(load, now)).version, 1, 'the first read loads the menu');
  assertEqualOrThrow((await guestMenu(load, now)).version, 1, 'a second read is served cached');
  clock += GUEST_MENU_TTL_MS;
  assertEqualOrThrow((await guestMenu(load, now)).version, 2, 'an expired menu loads again');
  invalidateGuestMenu();
  assertEqualOrThrow((await guestMenu(load, now)).version, 3, 'an invalidated menu loads again');

  invalidateGuestMenu();
  assertEqualOrThrow(await guestMenu(async () => null, now), null, 'a failed load is passed on');
  assertEqualOrThrow((await guestMenu(load, now)).version, 4, 'and is never cached');

  invalidateGuestMenu();
  const overtaken = await guestMenu(async () => {
    invalidateGuestMenu();
    return { version: 0 };
  }, now);
  assertEqualOrThrow(overtaken.version, 0, 'a load overtaken by an edit still answers its request');
  assertEqualOrThrow((await guestMenu(load, now)).version, 5, 'but is not kept');

  const app = express();
  app.use(invalidateGuestMenuOnCatalogWrite);
  app.put('/api/products/:id', (_req, res) => res.json({ ok: true }));
  app.post('/api/categories', (_req, res) => res.status(400).json({ error: 'bad' }));
  app.post('/api/orders', (_req, res) => res.json({ ok: true }));
  app.get('/api/products', (_req, res) => res.json({ ok: true }));
  const cachedVersion = async () => (await guestMenu(load, now)).version;

  const steps: [string, () => Promise<unknown>, boolean][] = [
    ['a product edit', () => request(app).put('/api/products/p1').send({}), true],
    ['a refused category write', () => request(app).post('/api/categories').send({}), false],
    ['an order', () => request(app).post('/api/orders').send({}), false],
    ['a catalog read', () => request(app).get('/api/products'), false],
  ];
  for (const [label, send, drops] of steps) {
    const before = await cachedVersion();
    await send();
    assertEqualOrThrow(
      (await cachedVersion()) !== before,
      drops,
      `${label} ${drops ? 'drops' : 'keeps'} the cached menu`,
    );
  }
  console.log('Guest menu cache tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
