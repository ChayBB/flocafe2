/**
 * Integration Test: GET /api/products/popular ranks the last 30 days of sales.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/products-popular.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-products-popular-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-products-popular';

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { now } = require('../main/db');
const { productRoutes } = require('../main/routes/products');

let orderCount = 0;
function sell(
  db: any,
  productId: string,
  quantity: number,
  opts: { daysAgo?: number; orderStatus?: string; itemStatus?: string } = {},
) {
  orderCount += 1;
  const at = db.prepare('SELECT datetime(?, ?) AS at').get(now(), `-${opts.daysAgo ?? 0} days`).at;
  const orderNumber = `ORD-POP-${orderCount}`;
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at)
    VALUES (?, 'takeaway', ?, 0, 0, 0, ?, ?)`).run(
    orderNumber,
    opts.orderStatus ?? 'completed',
    at,
    at,
  );
  const orderId = db.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNumber).id;
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, ?, 'Item', 10, ?, 0, 0, 0, ?, ?, ?)`).run(
    orderId,
    productId,
    quantity,
    opts.itemStatus ?? 'served',
    at,
    at,
  );
}

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-pop', 'Food');
  for (const id of ['tea', 'rice', 'soup', 'old', 'void', 'gone']) {
    seedProduct(db, `p-${id}`, 'cat-pop', id, 10);
  }
  sell(db, 'p-rice', 3);
  sell(db, 'p-rice', 2);
  sell(db, 'p-tea', 4);
  sell(db, 'p-soup', 1, { daysAgo: 29 });
  sell(db, 'p-old', 50, { daysAgo: 31 });
  sell(db, 'p-void', 50, { itemStatus: 'cancelled' });
  sell(db, 'p-void', 50, { orderStatus: 'cancelled' });
  sell(db, 'p-gone', 50);
  db.prepare("UPDATE products SET is_active = 0 WHERE id = 'p-gone'").run();

  const app = createApp({ '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const res = await api(baseUrl, '/api/products/popular', { headers: authHeader });
    assertEqualOrThrow(res.status, 200, `popular responds (${JSON.stringify(res.data)})`);
    assertEqualOrThrow(
      JSON.stringify(res.data.product_ids),
      JSON.stringify(['p-rice', 'p-tea', 'p-soup']),
      'best sellers of the last 30 days come first; older, cancelled and inactive sales are left out',
    );
    const limited = await api(baseUrl, '/api/products/popular?limit=1', { headers: authHeader });
    assertEqualOrThrow(
      JSON.stringify(limited.data.product_ids),
      JSON.stringify(['p-rice']),
      'limit caps the list',
    );
    const anonymous = await api(baseUrl, '/api/products/popular');
    assertEqualOrThrow(anonymous.status, 401, 'popular needs a signed-in user');
    console.log('All popular product checks passed');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
