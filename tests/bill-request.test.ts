/**
 * Bill requests: printing a table's bill from the Server App records who asked and when, the POS
 * lists the table as waiting for payment, and paying the last open bill stamps when it was received.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/bill-request.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-bill-request-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.JWT_SECRET = 'test-secret-bill-request';

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
const { billRequestRoutes } = require('../main/routes/bill-requests');

function seedUser(db: any, id: string, name: string, role: string) {
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, `${id}@test.local`, bcrypt.hashSync('4821', 10), role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main() {
  console.log('Bill requests');
  console.log('='.repeat(60));
  const db = initTestDb();
  const serverAuth = seedUser(db, 'server-bill', 'แมว', 'server');
  const cashierAuth = seedUser(db, 'cashier-bill', 'Cashier', 'cashier');
  db.prepare("INSERT INTO tables (id, number, capacity, status, created_at, updated_at) VALUES ('tbl-26', '26', 4, 'occupied', ?, ?)").run(now(), now());
  db.prepare(`INSERT INTO orders (order_number, type, status, table_id, subtotal, tax_amount, total, created_at, updated_at)
    VALUES ('ORD-BILL-1', 'dine_in', 'served', 'tbl-26', 300, 0, 300, ?, ?)`).run(now(), now());
  const orderId = (db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-BILL-1'").get() as any).id;

  const app = createApp({ '/api/orders': orderRoutes, '/api/bill-requests': billRequestRoutes });
  const { baseUrl, server } = await startServer(app);
  const orderRow = () => db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
  const pending = async () =>
    (await api(baseUrl, '/api/bill-requests', { headers: cashierAuth })).data.requests as any[];

  try {
    const request = await api(baseUrl, `/api/orders/${orderId}/bill-request`, { method: 'POST', body: {}, headers: serverAuth });
    assertEqualOrThrow(request.status, 200, `a server asks for the bill (${JSON.stringify(request.data)})`);
    const first = orderRow();
    assertOrThrow(Boolean(first.bill_requested_at), 'the request time is recorded');
    assertEqualOrThrow(first.bill_requested_by, 'server-bill', 'the requesting staff member is recorded');
    assertEqualOrThrow(first.bill_requested_by_name, 'แมว', 'their name is kept for the POS');
    assertOrThrow(
      Boolean(db.prepare("SELECT 1 FROM order_audit_log WHERE order_id = ? AND action = 'bill_requested'").get(String(orderId))),
      'the request is in the order audit log',
    );

    // A reprint keeps the first time, so the wait keeps counting from it.
    db.prepare('UPDATE orders SET bill_requested_at = ? WHERE id = ?').run('2026-01-01 10:00:00', orderId);
    await api(baseUrl, `/api/orders/${orderId}/bill-request`, { method: 'POST', body: {}, headers: serverAuth });
    assertEqualOrThrow(orderRow().bill_requested_at, '2026-01-01 10:00:00', 'a reprint does not restart the wait');

    const waiting = await pending();
    const listed = waiting.find((entry) => entry.id === orderId);
    assertOrThrow(Boolean(listed), 'the POS lists the table as waiting for payment');
    assertEqualOrThrow(listed.table_name, '26', 'the list names the table');
    assertEqualOrThrow(listed.bill_requested_by_name, 'แมว', 'the list names who asked');
    const forbidden = await api(baseUrl, '/api/bill-requests', { headers: serverAuth });
    assertEqualOrThrow(forbidden.status, 403, 'only staff who take payments see the list');

    // Two bills: paying one leaves the table waiting; paying the last stamps the receipt time.
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, payment_status, created_at, updated_at)
      VALUES ('B-1', ?, 150, 0, 150, 'unpaid', ?, ?), ('B-2', ?, 150, 0, 150, 'unpaid', ?, ?)`).run(orderId, now(), now(), orderId, now(), now());
    db.prepare("UPDATE bills SET payment_status = 'paid', paid_at = '2026-01-01 10:03:00' WHERE bill_number = 'B-1'").run();
    assertEqualOrThrow(orderRow().bill_payment_received_at, null, 'an open second bill keeps the table waiting');
    db.prepare("UPDATE bills SET payment_status = 'paid', paid_at = '2026-01-01 10:04:30' WHERE bill_number = 'B-2'").run();
    assertEqualOrThrow(orderRow().bill_payment_received_at, '2026-01-01 10:04:30', 'paying the last bill stamps when money was received');
    assertOrThrow(!(await pending()).some((entry) => entry.id === orderId), 'a paid table leaves the waiting list');

    db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(orderId);
    const closed = await api(baseUrl, `/api/orders/${orderId}/bill-request`, { method: 'POST', body: {}, headers: serverAuth });
    assertEqualOrThrow(closed.status, 409, 'a closed order cannot ask for its bill');

    console.log('\nAll bill request checks passed');
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
