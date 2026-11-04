/**
 * Server App header: store logo and cover validation, and the table order a QR guest may read.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/store-branding.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-store-branding-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedTable,
  seedCustomer,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const {
  STORE_IMAGE_MAX_LENGTH,
  decodeStoreImage,
  isStoreImageKind,
  storeImageError,
  storeImageVersion,
} = require('../main/lib/store-branding');
const { guestTableOrder } = require('../main/lib/guest-order');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function main() {
  console.log('Store branding and guest table order');
  console.log('='.repeat(60));

  assertOrThrow(isStoreImageKind('logo') && isStoreImageKind('cover'), 'logo and cover are kinds');
  assertOrThrow(!isStoreImageKind('favicon'), 'other names are not');
  assertEqualOrThrow(storeImageError('logo', ''), null, 'an empty value clears the image');
  assertEqualOrThrow(storeImageError('logo', PNG), null, 'a PNG data URI is accepted');
  assertOrThrow(storeImageError('logo', 42) !== null, 'a number is rejected');
  assertOrThrow(
    storeImageError('cover', 'data:image/svg+xml;base64,PHN2Zz4=') !== null,
    'SVG is rejected, so no script can ride in on the image',
  );
  assertOrThrow(
    storeImageError('logo', 'https://example.com/logo.png') !== null,
    'a remote address is rejected',
  );
  const tooBig = `data:image/png;base64,${'A'.repeat(STORE_IMAGE_MAX_LENGTH.logo)}`;
  assertOrThrow(storeImageError('logo', tooBig) !== null, 'an oversized logo is rejected');
  assertEqualOrThrow(storeImageError('cover', tooBig), null, 'the cover may be larger');

  const decoded = decodeStoreImage(PNG);
  assertEqualOrThrow(decoded?.type, 'image/png', 'the image keeps its type');
  assertEqualOrThrow(decoded?.body.subarray(1, 4).toString(), 'PNG', 'the bytes decode');
  assertEqualOrThrow(decodeStoreImage(''), null, 'no image decodes to nothing');
  assertEqualOrThrow(storeImageVersion(''), null, 'no image has no version');
  assertOrThrow(
    storeImageVersion(PNG) !== storeImageVersion(`${PNG}A`),
    'a changed image gets a new version',
  );

  const db = initTestDb();
  seedTable(db, 'tb-1', 1);
  seedTable(db, 'tb-2', 2);
  seedCustomer(db, 'cust-a', 'Khun A');
  assertEqualOrThrow(guestTableOrder(db, 'tb-1'), null, 'a table with no open order has none');

  const insertOrder = db.prepare(
    `INSERT INTO orders (order_number, table_id, customer_id, type, status)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status)
     VALUES (?, 'p', ?, 50, ?, ?, ?, ?)`,
  );
  const paid = insertOrder.run('B-1', 'tb-1', null, 'dine_in', 'completed').lastInsertRowid;
  insertItem.run(paid, 'Yesterday soup', 1, 50, 50, 'served');
  const open = insertOrder.run('B-2', 'tb-1', 'cust-a', 'dine_in', 'preparing').lastInsertRowid;
  insertItem.run(open, 'Fried rice', 2, 100, 100, 'preparing');
  insertItem.run(open, 'Iced tea', 1, 50, 50, 'cancelled');
  insertItem.run(open, 'Voided line', 1, 50, 50, 'voided');
  insertOrder.run('B-3', 'tb-2', null, 'dine_in', 'pending');

  const order = guestTableOrder(db, 'tb-1');
  assertEqualOrThrow(order?.order_number, 'B-2', 'the open order is shown, not a paid one');
  assertEqualOrThrow(order?.customer_name, 'Khun A', 'the customer name comes along');
  assertEqualOrThrow(
    order?.items.map((item: { product_name: string }) => item.product_name).join(','),
    'Fried rice,Iced tea',
    'cancelled lines stay visible and voided ones are hidden',
  );
  assertEqualOrThrow(
    Object.keys(order!.items[0]).sort().join(','),
    'created_at,id,product_name,quantity,status,total',
    'only the fields a guest needs leave the server',
  );
  assertEqualOrThrow(
    guestTableOrder(db, 'tb-2')?.items.length,
    0,
    "another table's order is its own",
  );

  closeDatabase();
  console.log('All store branding checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
