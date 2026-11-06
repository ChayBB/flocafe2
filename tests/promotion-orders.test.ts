/**
 * Promotions on live orders: automatic promotions reprice the order through the shared totals path,
 * time windows lock to each item's order time, manual discounts are refused while a promotion
 * applies, and paid bills count redemptions that a full refund gives back.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/promotion-orders.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-promotion-orders-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { resolveRegionalSnapshot } = require('../main/countries');

function setting(db: any, key: string): string | undefined {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

function localClock(db: any, offsetMinutes: number): string {
  const timezone = resolveRegionalSnapshot({
    country: setting(db, 'country'),
    currency: setting(db, 'currency'),
    timezone: setting(db, 'timezone'),
  }).timezone;
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

function utcMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

function savePromotion(
  db: any,
  id: string,
  fields: { status?: string; conditions: unknown; reward: unknown; priority?: number },
) {
  db.prepare(
    `INSERT OR REPLACE INTO promotions (id, name, kind, status, priority, stack_policy, conditions_json, reward_json, created_at, updated_at)
     VALUES (?, ?, 'automatic', ?, ?, 'stack', ?, ?, ?, ?)`,
  ).run(
    id,
    `Promo ${id}`,
    fields.status ?? 'active',
    fields.priority ?? 100,
    JSON.stringify(fields.conditions),
    JSON.stringify(fields.reward),
    now(),
    now(),
  );
}

async function main() {
  console.log('Promotions on orders and bills');
  console.log('='.repeat(60));
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const { userId: managerId } = seedManagerUser(db);
  seedCategory(db, 'cat-drinks', 'Drinks');
  seedCategory(db, 'cat-food', 'Food');
  seedProduct(db, 'prod-coffee', 'cat-drinks', 'Coffee', 100);
  seedProduct(db, 'prod-cake', 'cat-food', 'Cake', 200);

  savePromotion(db, 'happy-hour', {
    conditions: {
      categoryIds: ['cat-drinks'],
      schedule: { start: localClock(db, -60), end: localClock(db, 60) },
    },
    reward: { type: 'percent', percent: 20 },
  });

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  try {
    console.log('\n1. An automatic promotion reprices a new order');
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-coffee', quantity: 2 },
          { product_id: 'prod-cake', quantity: 1 },
        ],
      },
    });
    assertEqualOrThrow(created.status, 201, 'order created');
    const orderId = created.data.order.id;
    const order = created.data.order;
    assertEqualOrThrow(order.discount_type, 'promotion', 'the order discount is a promotion');
    assertEqualOrThrow(Number(order.discount_amount), 40, '20% off two coffees is 40');
    assertEqualOrThrow(Number(order.subtotal), 400, 'the subtotal is before the promotion');
    assertEqualOrThrow(
      Number(order.total),
      360 + Number(order.tax_amount || 0),
      'the total is the subtotal less the promotion',
    );
    const stored = db.prepare('SELECT * FROM order_promotions WHERE order_id = ?').all(orderId);
    assertEqualOrThrow(stored.length, 1, 'one promotion is stored on the order');
    assertEqualOrThrow(stored[0].discount_cents, 4000, 'the stored discount is in minor units');
    const allocations = JSON.parse(stored[0].allocations_json);
    assertEqualOrThrow(allocations.length, 1, 'only the coffee line carries the discount');

    console.log('\n2. Manual discounts are refused while a promotion applies');
    const orderDiscount = await api(baseUrl, `/api/orders/${orderId}/discount`, {
      method: 'POST',
      headers: authHeader,
      body: { discount_type: 'amount', discount_value: 10 },
    });
    assertEqualOrThrow(orderDiscount.status, 409, 'order discount is refused');
    assertEqualOrThrow(orderDiscount.data.code, 'promotion_applied', 'with the promotion code');
    const itemId = created.data.order.items[0].id;
    const itemDiscount = await api(baseUrl, `/api/orders/${orderId}/items/${itemId}/discount`, {
      method: 'POST',
      headers: authHeader,
      body: { discount_type: 'amount', discount_value: 10 },
    });
    assertEqualOrThrow(itemDiscount.status, 409, 'item discount is refused');

    console.log('\n3. Adding items re-evaluates the promotion');
    const added = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      headers: authHeader,
      body: { items: [{ product_id: 'prod-coffee', quantity: 1 }] },
    });
    assertEqualOrThrow(added.status, 200, 'item added');
    assertEqualOrThrow(Number(added.data.order.discount_amount), 60, 'three coffees take 60 off');

    console.log('\n4. The bill carries the promotion and payment counts the redemption');
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: authHeader,
      body: { order_id: orderId },
    });
    assertEqualOrThrow(bill.status, 201, 'bill created');
    const billId = bill.data.bill.id;
    const orderRow = db
      .prepare('SELECT total, discount_amount FROM orders WHERE id = ?')
      .get(orderId);
    assertEqualOrThrow(Number(bill.data.bill.discount_amount), 60, 'the bill shows the promotion');
    assertEqualOrThrow(
      Number(bill.data.bill.total),
      Number(orderRow.total),
      'bill and order agree',
    );
    const billDiscount = await api(baseUrl, `/api/bills/${billId}/discount`, {
      method: 'POST',
      headers: authHeader,
      body: { type: 'amount', value: 10 },
    });
    assertEqualOrThrow(billDiscount.status, 409, 'bill discount is refused');
    const paid = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      headers: authHeader,
      body: { method: 'cash', amount: bill.data.bill.total },
    });
    assertEqualOrThrow(paid.status, 200, 'payment accepted');
    const redemptions = () =>
      db
        .prepare(
          "SELECT COALESCE(SUM(uses), 0) AS uses, COALESCE(SUM(discount_cents), 0) AS spent FROM promotion_redemptions WHERE promotion_id = 'happy-hour'",
        )
        .get();
    assertEqualOrThrow(redemptions().uses, 1, 'the paid order counts one use');
    assertEqualOrThrow(redemptions().spent, 6000, 'and its discount toward the budget');

    console.log('\n5. A full refund gives the use back, once');
    const refund = (amount: number) =>
      api(baseUrl, '/api/refunds', {
        method: 'POST',
        headers: authHeader,
        body: {
          bill_id: billId,
          amount,
          method: 'cash',
          override_pin: '1234',
          approver_id: managerId,
        },
      });
    const total = Number(bill.data.bill.total);
    const half = await refund(total / 2);
    assertEqualOrThrow(half.status, 201, 'half refunded');
    assertEqualOrThrow(redemptions().uses, 1, 'a partial refund keeps the use');
    const rest = await refund(total / 2);
    assertEqualOrThrow(rest.status, 201, 'the rest refunded');
    assertEqualOrThrow(redemptions().uses, 0, 'a full refund returns the use');
    assertEqualOrThrow(redemptions().spent, 0, 'and the budget');

    console.log('\n6. Time windows lock to when each item was ordered');
    savePromotion(db, 'happy-hour', {
      conditions: {
        categoryIds: ['cat-drinks'],
        schedule: { start: localClock(db, -300), end: localClock(db, -180) },
      },
      reward: { type: 'percent', percent: 20 },
    });
    const late = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-coffee', quantity: 1 }] },
    });
    assertEqualOrThrow(late.status, 201, 'order created outside the window');
    const lateId = late.data.order.id;
    assertEqualOrThrow(Number(late.data.order.discount_amount || 0), 0, 'no happy hour now');
    db.prepare('UPDATE order_items SET created_at = ? WHERE order_id = ?').run(
      utcMinutesAgo(240),
      lateId,
    );
    const more = await api(baseUrl, `/api/orders/${lateId}/items`, {
      method: 'POST',
      headers: authHeader,
      body: { items: [{ product_id: 'prod-coffee', quantity: 1 }] },
    });
    assertEqualOrThrow(more.status, 200, 'another coffee added');
    assertEqualOrThrow(
      Number(more.data.order.discount_amount),
      20,
      'only the coffee ordered in the window is discounted',
    );

    console.log('\n7. A manual discount keeps promotions off the order');
    savePromotion(db, 'happy-hour', {
      status: 'paused',
      conditions: { categoryIds: ['cat-drinks'] },
      reward: { type: 'percent', percent: 20 },
    });
    const manual = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-coffee', quantity: 1 }] },
    });
    const manualId = manual.data.order.id;
    const applied = await api(baseUrl, `/api/orders/${manualId}/discount`, {
      method: 'POST',
      headers: authHeader,
      body: { discount_type: 'percentage', discount_value: 10 },
    });
    assertEqualOrThrow(applied.status, 200, 'manual discount applied');
    savePromotion(db, 'happy-hour', {
      conditions: { categoryIds: ['cat-drinks'] },
      reward: { type: 'percent', percent: 50 },
    });
    const after = await api(baseUrl, `/api/orders/${manualId}/items`, {
      method: 'POST',
      headers: authHeader,
      body: { items: [{ product_id: 'prod-coffee', quantity: 1 }] },
    });
    assertEqualOrThrow(after.status, 200, 'item added to the manually discounted order');
    assertOrThrow(after.data.order.discount_type !== 'promotion', 'the manual discount stays');
    assertEqualOrThrow(
      Number(after.data.order.discount_amount),
      20,
      'the manual 10% now covers two coffees',
    );
    assertEqualOrThrow(
      db.prepare('SELECT COUNT(*) AS n FROM order_promotions WHERE order_id = ?').get(manualId).n,
      0,
      'no promotion is stored',
    );
  } finally {
    server.close();
  }
  closeDatabase();
  console.log('\nAll promotion order checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
