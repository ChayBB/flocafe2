/**
 * Guest (table QR) order sanitising: prices and names come from the catalog, never the request.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/guest-order.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-guest-order-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedCategory,
  seedProduct,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const {
  sanitizeGuestOrderItems,
  sanitizeGuestOrderNote,
  sanitizeGuestProduct,
} = require('../main/lib/guest-order');

function main() {
  console.log('Guest order sanitising');
  console.log('='.repeat(60));
  const db = initTestDb();
  seedCategory(db, 'g-cat', 'Menu');
  seedProduct(db, 'g-coffee', 'g-cat', 'Coffee', 100);
  seedProduct(db, 'g-retired', 'g-cat', 'Retired', 50);
  db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run('g-retired');
  db.prepare(
    `INSERT INTO addon_groups (id, name, created_at, updated_at) VALUES ('g-group', 'Extras', ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active, created_at, updated_at)
     VALUES ('g-shot', 'g-group', 'Extra shot', 25, 1, ?, ?), ('g-gone', 'g-group', 'Gone', 5, 0, ?, ?)`,
  ).run(now(), now(), now(), now());

  const ok = sanitizeGuestOrderItems(db, [{ product_id: 'g-coffee', quantity: 2 }]);
  assertOrThrow(ok.ok === true, 'a plain line is accepted');
  assertEqualOrThrow(ok.items[0].variant_id, null, 'no variant by default');
  assertEqualOrThrow(ok.items[0].addons, null, 'no add-ons by default');

  const forged = sanitizeGuestOrderItems(db, [
    {
      product_id: 'g-coffee',
      quantity: 1,
      unit_price: 0,
      discount: 100,
      addons: [{ id: 'g-shot', name: 'Free', price: 0, quantity: 2 }],
    },
  ]);
  assertOrThrow(forged.ok === true, 'a line with forged fields is still accepted after cleaning');
  assertEqualOrThrow(
    forged.items[0].addons[0].price,
    25,
    'the add-on price comes from the catalog',
  );
  assertEqualOrThrow(
    forged.items[0].addons[0].name,
    'Extra shot',
    'the add-on name comes from the catalog',
  );
  assertEqualOrThrow(forged.items[0].addons[0].quantity, 2, 'the add-on quantity is kept');
  assertOrThrow(
    !('unit_price' in forged.items[0]) && !('discount' in forged.items[0]),
    'price and discount fields from the request are dropped',
  );

  for (const [label, items] of [
    ['an empty order', []],
    ['not an array', 'x'],
    ['an unknown product', [{ product_id: 'nope', quantity: 1 }]],
    ['an inactive product', [{ product_id: 'g-retired', quantity: 1 }]],
    ['a missing quantity', [{ product_id: 'g-coffee' }]],
    ['a zero quantity', [{ product_id: 'g-coffee', quantity: 0 }]],
    ['a negative quantity', [{ product_id: 'g-coffee', quantity: -1 }]],
    ['a huge quantity', [{ product_id: 'g-coffee', quantity: 51 }]],
    ['a fractional quantity', [{ product_id: 'g-coffee', quantity: 0.001 }]],
    ['a quantity sent as text', [{ product_id: 'g-coffee', quantity: '2' }]],
    [
      'over 100 items in all',
      Array.from({ length: 3 }, () => ({ product_id: 'g-coffee', quantity: 34 })),
    ],
    ['an unknown add-on', [{ product_id: 'g-coffee', quantity: 1, addons: [{ id: 'zzz' }] }]],
    ['an inactive add-on', [{ product_id: 'g-coffee', quantity: 1, addons: [{ id: 'g-gone' }] }]],
    [
      'a fractional add-on quantity',
      [{ product_id: 'g-coffee', quantity: 1, addons: [{ id: 'g-shot', quantity: 1.5 }] }],
    ],
    ['an unknown variant', [{ product_id: 'g-coffee', quantity: 1, variant_id: 'v-none' }]],
    [
      'a long item note',
      [{ product_id: 'g-coffee', quantity: 1, special_instructions: 'x'.repeat(201) }],
    ],
    ['too many lines', Array.from({ length: 31 }, () => ({ product_id: 'g-coffee', quantity: 1 }))],
  ] as Array<[string, unknown]>) {
    assertEqualOrThrow(sanitizeGuestOrderItems(db, items).ok, false, `${label} is refused`);
  }

  assertOrThrow(
    sanitizeGuestOrderItems(
      db,
      Array.from({ length: 2 }, () => ({ product_id: 'g-coffee', quantity: 50 })),
    ).ok,
    'exactly 100 items in all is accepted',
  );

  assertEqualOrThrow(
    sanitizeGuestOrderNote('  Birthday  '),
    'Birthday',
    'an order note is trimmed',
  );
  assertEqualOrThrow(sanitizeGuestOrderNote(''), null, 'a blank note is none');
  assertEqualOrThrow(
    sanitizeGuestOrderNote('x'.repeat(301)),
    false,
    'a long order note is refused',
  );
  assertEqualOrThrow(sanitizeGuestOrderNote(5), false, 'a non-text note is refused');

  const clean = sanitizeGuestProduct({
    id: 'p',
    name: 'Coffee',
    price: 100,
    cost: 12,
    inventory_product_id: 'x',
    variants: [{ id: 'v', price: 1, cost_price: 3, recipe_multiplier: 2 }],
  });
  assertOrThrow(
    !('cost' in clean) && !('inventory_product_id' in clean),
    'product cost and links are removed',
  );
  assertOrThrow(
    !('cost_price' in (clean.variants as any[])[0]) &&
      !('recipe_multiplier' in (clean.variants as any[])[0]),
    'variant cost fields are removed',
  );
  assertEqualOrThrow(clean.price, 100, 'the shown price is kept');
}

try {
  main();
  console.log('\nGuest order tests passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    closeDatabase();
  } catch {}
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
}
