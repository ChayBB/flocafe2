/**
 * Merging tables: a table's open order folds into another table's open order. Every item moves,
 * the target's totals are recomputed, the source order closes and its table frees up, and printed
 * unpaid bills combine into one. Merges that would lose a payment or an order discount are refused.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/table-merge.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-table-merge-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.JWT_SECRET = 'test-secret-table-merge';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');

function seedUser(db: any, id: string, role: string) {
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, id, `${id}@test.local`, bcrypt.hashSync('4821', 10), role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main() {
  console.log('Table merge');
  console.log('='.repeat(60));
  const db = initTestDb();
  const serverAuth = seedUser(db, 'server-merge', 'server');
  const chefAuth = seedUser(db, 'chef-merge', 'chef');

  const addTable = (id: string) =>
    db
      .prepare(
        "INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at) VALUES (?, ?, 4, 'occupied', 1, ?, ?)",
      )
      .run(id, id, now(), now());
  const addOrder = (number: string, tableId: string, total: number) => {
    db.prepare(`INSERT INTO orders (order_number, type, status, table_id, subtotal, tax_amount, total, created_at, updated_at)
      VALUES (?, 'dine_in', 'pending', ?, ?, 0, ?, ?, ?)`).run(
      number,
      tableId,
      total,
      total,
      now(),
      now(),
    );
    return (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(number) as any)
      .id as number;
  };
  const addItem = (orderId: number, name: string, price: number) =>
    db
      .prepare(`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, status, created_at, updated_at)
      VALUES (?, 'p-merge', ?, 1, ?, ?, ?, 'pending', ?, ?)`)
      .run(orderId, name, price, price, price, now(), now());
  const orderRow = (id: number) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;

  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) addTable(id);
  const source = addOrder('ORD-SRC', 'T1', 200);
  addItem(source, 'Fish', 120);
  addItem(source, 'Rice', 80);
  const target = addOrder('ORD-DST', 'T2', 50);
  addItem(target, 'Tea', 50);
  db.prepare("UPDATE tables SET status = 'available' WHERE id = 'T3'").run();

  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);
  const merge = (orderId: number, tableId: string, headers = serverAuth) =>
    api(baseUrl, `/api/orders/${orderId}/merge-table`, {
      method: 'POST',
      body: { target_table_id: tableId },
      headers,
    });

  try {
    assertEqualOrThrow(
      (await merge(source, 'T2', chefAuth)).status,
      403,
      'kitchen staff cannot merge tables',
    );
    const empty = await merge(source, 'T3');
    assertEqualOrThrow(empty.status, 409, 'a table without an order cannot receive a merge');
    assertEqualOrThrow(empty.data.code, 'target_empty', 'the refusal suggests moving instead');

    const merged = await merge(source, 'T2');
    assertEqualOrThrow(merged.status, 200, 'the server merges table T1 into T2');
    const targetItems = db
      .prepare('SELECT product_name FROM order_items WHERE order_id = ? ORDER BY product_name')
      .all(target) as any[];
    assertEqualOrThrow(
      targetItems.map((item) => item.product_name).join(','),
      'Fish,Rice,Tea',
      'every item joins the target order',
    );
    assertEqualOrThrow(Number(orderRow(target).total), 250, 'the target total covers all items');
    assertEqualOrThrow(merged.data.order.items.length, 3, 'the response lists the merged order');
    const closed = orderRow(source);
    assertEqualOrThrow(closed.status, 'cancelled', 'the emptied source order closes');
    assertEqualOrThrow(Number(closed.total), 0, 'the closed source order carries no amount');
    assertEqualOrThrow(
      closed.cancellation_reason,
      'Merged into ORD-DST',
      'the source order says where it went',
    );
    assertEqualOrThrow(
      (db.prepare("SELECT status FROM tables WHERE id = 'T1'").get() as any).status,
      'available',
      'the source table frees up',
    );
    const audits = db
      .prepare("SELECT order_id FROM order_audit_log WHERE action = 'order_merged'")
      .all() as any[];
    assertEqualOrThrow(audits.length, 2, 'both orders record the merge');
    const targetDetail = await api(baseUrl, `/api/orders/${target}`, { headers: serverAuth });
    assertEqualOrThrow(targetDetail.status, 200, 'the POS can read the merged order');
    assertEqualOrThrow(
      targetDetail.data.order.merged_from_table,
      'T1',
      'the target carries the source table label',
    );
    assertEqualOrThrow(
      (await merge(source, 'T2')).status,
      409,
      'a merged order cannot merge again',
    );

    // A printed, unpaid bill joins the target: it moves over when the target has none...
    const billRow = (number: string) =>
      db.prepare('SELECT * FROM bills WHERE bill_number = ?').get(number) as any;
    const billed = addOrder('ORD-BILLED', 'T4', 30);
    addItem(billed, 'Soup', 30);
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, payment_status, created_at, updated_at)
      VALUES ('B-SRC', ?, 30, 0, 30, 'unpaid', ?, ?)`).run(billed, now(), now());
    assertEqualOrThrow(
      (await merge(billed, 'T2')).status,
      200,
      'a table with a printed bill merges',
    );
    assertEqualOrThrow(
      billRow('B-SRC').order_id,
      target,
      'the printed bill now belongs to the merged order',
    );
    assertEqualOrThrow(Number(billRow('B-SRC').total), 280, 'the bill covers both tables');

    // ...and folds into the target's bill when both tables printed one.
    const second = addOrder('ORD-SECOND', 'T4', 20);
    addItem(second, 'Juice', 20);
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, payment_status, created_at, updated_at)
      VALUES ('B-SECOND', ?, 20, 0, 20, 'unpaid', ?, ?)`).run(second, now(), now());
    db.prepare(
      "INSERT INTO print_logs (bill_id, user_id, print_type) VALUES (?, 'server-merge', 'bill')",
    ).run(billRow('B-SECOND').id);
    assertEqualOrThrow((await merge(second, 'T2')).status, 200, 'two printed bills merge');
    assertOrThrow(!billRow('B-SECOND'), 'the source bill folds into the target bill');
    assertEqualOrThrow(Number(billRow('B-SRC').total), 300, 'one bill carries every item');
    const billCount = db
      .prepare('SELECT COUNT(*) AS n FROM bills WHERE order_id = ?')
      .get(target) as any;
    assertEqualOrThrow(billCount.n, 1, 'the merged order has one bill');
    const printed = db.prepare('SELECT bill_id FROM print_logs').get() as any;
    assertEqualOrThrow(
      printed.bill_id,
      billRow('B-SRC').id,
      'the print history follows the kept bill',
    );

    // Refusals that would lose money.
    const paid = addOrder('ORD-PAID', 'T4', 30);
    addItem(paid, 'Soup', 30);
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, payment_status, created_at, updated_at)
      VALUES ('B-PAID', ?, 30, 0, 30, 10, 'partial', ?, ?)`).run(paid, now(), now());
    const paidMerge = await merge(paid, 'T2');
    assertEqualOrThrow(paidMerge.status, 409, 'a source order that started paying is refused');
    assertEqualOrThrow(paidMerge.data.code, 'source_billed', 'the refusal names the payment');

    const discounted = addOrder('ORD-DISC', 'T5', 40);
    addItem(discounted, 'Cake', 40);
    db.prepare('UPDATE orders SET discount_amount = 5 WHERE id = ?').run(discounted);
    assertEqualOrThrow(
      (await merge(discounted, 'T2')).data.code,
      'source_discount',
      'a source order discount is refused',
    );

    const paying = addOrder('ORD-PAYING', 'T6', 60);
    addItem(paying, 'Noodles', 60);
    db.prepare(
      "UPDATE bills SET paid_amount = 100, payment_status = 'partial' WHERE bill_number = 'B-SRC'",
    ).run();
    const payingMerge = await merge(paying, 'T2');
    assertEqualOrThrow(
      payingMerge.data.code,
      'target_paying',
      'a target that started paying is refused',
    );
    assertOrThrow(
      orderRow(paying).status === 'pending',
      'a refused merge leaves the source order open',
    );

    console.log('\nAll table merge checks passed');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
