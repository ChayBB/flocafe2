/**
 * Loyalty points and member tiers: the earning formula, payment hook, FIFO expiry,
 * redemption limits, the tier engine (promotion, grace, demotion, override) and ledger immutability.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/loyalty-points.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-loyalty-points-'));
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
  seedCustomer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { customerRoutes } = require('../main/routes/customers');
const { refundRoutes } = require('../main/routes/refunds');
const points = require('../main/lib/loyalty-points');

function setSetting(db: any, key: string, value: string) {
  db.prepare(
    'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
  ).run(key, value);
}

function throwsCode(fn: () => unknown, code: string, message: string) {
  try {
    fn();
  } catch (error: any) {
    assertEqualOrThrow(error?.code, code, message);
    return;
  }
  throw new Error(`Expected ${code}: ${message}`);
}

function formula() {
  console.log('\n1. Earning formula');
  assertEqualOrThrow(
    points.computeEarnedPoints(42_000, 100, 20, 1.25),
    26,
    'Gold 420 baht: 21 × 1.25 = 26.25, floor 26',
  );
  assertEqualOrThrow(
    points.computeEarnedPoints(42_000, 100, 20, 1),
    21,
    'Silver 420 baht earns 21',
  );
  assertEqualOrThrow(
    points.computeEarnedPoints(1_999, 100, 20, 1.5),
    0,
    'under one spend unit earns nothing',
  );
  assertEqualOrThrow(
    points.computeEarnedPoints(200_000, 100, 20, 1.15),
    115,
    '100 × 1.15 stays 115 despite float error',
  );
  assertEqualOrThrow(points.computeEarnedPoints(0, 100, 20, 1), 0, 'no spend, no points');
  const config = { redeemPoints: 100, redeemValue: 20 };
  assertEqualOrThrow(
    points.redemptionValueMinor(100, config, 100),
    2_000,
    '100 points are worth 20 baht',
  );
  assertEqualOrThrow(
    points.redemptionValueMinor(150, config, 100),
    3_000,
    '150 points are worth 30 baht',
  );
}

async function paymentHook(db: any) {
  console.log('\n2. A paid bill earns points with the tier multiplier, once');
  const { authHeader } = seedOwnerUser(db);
  const { userId: managerId } = seedManagerUser(db);
  seedCategory(db, 'cat-points', 'Points Menu');
  seedProduct(db, 'prod-rice', 'cat-points', 'Rice soup', 420, { cb_percent: 5 });
  seedProduct(db, 'prod-giftcard', 'cat-points', 'Gift card', 100, { cb_percent: 5 });
  db.prepare("UPDATE products SET points_eligible = 0 WHERE id = 'prod-giftcard'").run();
  seedCustomer(db, 'cust-gold', 'Gold Member', '0811111111');
  db.prepare("UPDATE customers SET qualifying_cents = 500000 WHERE id = 'cust-gold'").run();
  points.evaluateTier(db, 'cust-gold', now());
  assertEqualOrThrow(
    points.effectiveTier(db, 'cust-gold', now())?.code,
    'gold',
    '5,000 baht qualifies for Gold',
  );

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/customers': customerRoutes,
    '/api/refunds': refundRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  try {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'takeaway',
        customer_id: 'cust-gold',
        items: [
          { product_id: 'prod-rice', quantity: 1 },
          { product_id: 'prod-giftcard', quantity: 1 },
        ],
      },
    });
    assertEqualOrThrow(order.status, 201, 'order created');
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: authHeader,
      body: { order_id: order.data.order.id },
    });
    assertEqualOrThrow(bill.status, 201, 'bill created');
    const billId = bill.data.bill.id;
    const paid = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      headers: authHeader,
      body: { method: 'cash', amount: bill.data.bill.total, customer_id: 'cust-gold' },
    });
    assertEqualOrThrow(paid.status, 200, 'payment accepted');
    assertEqualOrThrow(paid.data.pointsEarned, 26, 'the response reports 26 points');

    const earn = db
      .prepare("SELECT * FROM points_ledger WHERE bill_id = ? AND kind = 'earn'")
      .get(billId);
    assertEqualOrThrow(earn?.points, 26, 'the gift card is not eligible, so 420 baht earns 26');
    assertEqualOrThrow(
      earn?.eligible_cents,
      42_000,
      'net eligible amount is stored in minor units',
    );
    assertEqualOrThrow(earn?.tier_code, 'gold', 'the tier at earning time is recorded');
    assertOrThrow(Boolean(earn?.expires_at), 'earned points carry an expiry date');
    assertEqualOrThrow(
      db.prepare('SELECT COUNT(*) AS n FROM loyalty_ledger WHERE bill_id = ?').get(billId).n,
      0,
      'points mode credits no cashback',
    );
    assertEqualOrThrow(
      db.prepare("SELECT qualifying_cents FROM customers WHERE id = 'cust-gold'").get()
        .qualifying_cents,
      542_000,
      'tier qualification grows by the net eligible amount',
    );
    assertEqualOrThrow(
      points.awardBillPoints(db, {
        billId,
        customerId: 'cust-gold',
        eligibleMinor: 42_000,
        minorFactor: 100,
        at: now(),
      }),
      0,
      'a bill earns only once',
    );

    const standing = await api(baseUrl, '/api/customers/cust-gold/points', { headers: authHeader });
    assertEqualOrThrow(standing.status, 200, 'points endpoint answers');
    assertEqualOrThrow(standing.data.balance, 26, 'balance is 26');
    assertEqualOrThrow(standing.data.tier?.code, 'gold', 'tier is Gold');

    console.log('\n2b. Refunds take earned points back in proportion');
    const total = Number(bill.data.bill.total);
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
    const half = await refund(total / 2);
    assertEqualOrThrow(half.status, 201, 'half the bill is refunded');
    const reversed = () =>
      db
        .prepare(
          "SELECT COALESCE(-SUM(points), 0) AS points, COALESCE(SUM(eligible_cents), 0) AS eligible FROM points_ledger WHERE bill_id = ? AND kind = 'reverse_earn'",
        )
        .get(billId);
    assertEqualOrThrow(reversed().points, 13, 'a half refund takes back 13 of 26 points');
    assertEqualOrThrow(reversed().eligible, 21_000, 'and half the eligible amount');
    assertEqualOrThrow(points.pointsBalance(db, 'cust-gold'), 13, 'balance drops to 13');
    const rest = await refund(total / 2);
    assertEqualOrThrow(rest.status, 201, 'the rest is refunded');
    assertEqualOrThrow(reversed().points, 26, 'a full refund takes back exactly what was earned');
    assertEqualOrThrow(points.pointsBalance(db, 'cust-gold'), 0, 'balance is back to zero');
    assertEqualOrThrow(
      db.prepare("SELECT qualifying_cents FROM customers WHERE id = 'cust-gold'").get()
        .qualifying_cents,
      500_000,
      'tier qualification returns to its value before the bill',
    );

    const noReason = await api(baseUrl, '/api/customers/cust-gold/tier-override', {
      method: 'PUT',
      headers: authHeader,
      body: { tier_code: 'platinum', until: '2999-01-01 00:00:00', note: ' ' },
    });
    assertEqualOrThrow(noReason.status, 400, 'an override without a reason is refused');
    const override = await api(baseUrl, '/api/customers/cust-gold/tier-override', {
      method: 'PUT',
      headers: authHeader,
      body: { tier_code: 'platinum', until: '2999-01-01 00:00:00', note: 'Owner friend' },
    });
    assertEqualOrThrow(override.status, 200, 'an owner can set an override');
    assertEqualOrThrow(override.data.tier?.code, 'platinum', 'the override applies');
    const audit = db
      .prepare(
        "SELECT * FROM member_tier_audit WHERE customer_id = 'cust-gold' AND reason = 'override_set'",
      )
      .get();
    assertEqualOrThrow(audit?.note, 'Owner friend', 'the override is audited with its reason');
    assertOrThrow(Boolean(audit?.actor_user_id), 'the override is attributed to the actor');
  } finally {
    server.close();
  }
}

function cashbackModeUntouched(db: any) {
  console.log('\n3. Cashback mode earns no points');
  setSetting(db, 'loyalty_mode', 'cashback');
  seedCustomer(db, 'cust-cash', 'Cashback Customer', '0822222222');
  assertEqualOrThrow(
    points.awardBillPoints(db, {
      billId: 999_001,
      customerId: 'cust-cash',
      eligibleMinor: 50_000,
      minorFactor: 100,
      at: now(),
    }),
    0,
    'no points while the store runs cashback',
  );
  setSetting(db, 'loyalty_mode', 'points');
}

function expiryAndRedemption(db: any) {
  console.log('\n4. FIFO expiry and redemption limits');
  seedCustomer(db, 'cust-exp', 'Expiry Customer', '0833333333');
  const insert = db.prepare(
    `INSERT INTO points_ledger (customer_id, bill_id, kind, points, expires_at, created_at)
     VALUES ('cust-exp', ?, ?, ?, ?, ?)`,
  );
  insert.run(900_001, 'earn', 100, '2025-02-01 00:00:00', '2024-02-01 00:00:00');
  insert.run(900_002, 'earn', 80, '2999-01-01 00:00:00', '2024-06-01 00:00:00');
  insert.run(null, 'redeem', -60, null, '2024-07-01 00:00:00');
  const at = '2025-03-01 00:00:00';
  assertEqualOrThrow(
    points.expireDuePoints(db, 'cust-exp', at),
    40,
    'spending used the oldest lot first, so 40 of it expire',
  );
  assertEqualOrThrow(points.pointsBalance(db, 'cust-exp'), 80, 'the newer lot is untouched');
  assertEqualOrThrow(points.expireDuePoints(db, 'cust-exp', at), 0, 'expiry is written once');

  throwsCode(
    () =>
      points.redeemPoints(db, {
        customerId: 'cust-exp',
        points: 50,
        billId: null,
        minorFactor: 100,
        actorUserId: null,
        at,
      }),
    'points_below_minimum',
    'below the 100-point minimum is refused',
  );
  throwsCode(
    () =>
      points.redeemPoints(db, {
        customerId: 'cust-exp',
        points: 100,
        billId: null,
        minorFactor: 100,
        actorUserId: null,
        at,
      }),
    'points_insufficient',
    'more than the balance is refused',
  );
  throwsCode(
    () =>
      points.redeemPoints(db, {
        customerId: 'cust-exp',
        points: 100.5,
        billId: null,
        minorFactor: 100,
        actorUserId: null,
        at,
      }),
    'points_invalid',
    'fractional points are refused',
  );
  insert.run(900_003, 'earn', 120, '2999-01-01 00:00:00', '2025-02-15 00:00:00');
  const redeemed = points.redeemPoints(db, {
    customerId: 'cust-exp',
    points: 150,
    billId: null,
    minorFactor: 100,
    actorUserId: null,
    at,
  });
  assertEqualOrThrow(redeemed.valueMinor, 3_000, '150 points pay 30 baht');
  assertEqualOrThrow(redeemed.balance, 50, 'balance drops to 50');
}

function tierEngine(db: any) {
  console.log('\n5. Tier engine: grace, demotion and override expiry');
  setSetting(db, 'tier_grace_days', '30');
  seedCustomer(db, 'cust-tier', 'Tier Customer', '0844444444');
  db.prepare("UPDATE customers SET qualifying_cents = 2000000 WHERE id = 'cust-tier'").run();
  points.evaluateTier(db, 'cust-tier', '2025-01-01 00:00:00');
  assertEqualOrThrow(
    points.effectiveTier(db, 'cust-tier', '2025-01-01 00:00:00')?.code,
    'platinum',
    'promoted to Platinum at once',
  );

  db.prepare("UPDATE customers SET qualifying_cents = 600000 WHERE id = 'cust-tier'").run();
  points.evaluateTier(db, 'cust-tier', '2025-01-10 00:00:00');
  const row = () =>
    db.prepare("SELECT tier_code, tier_grace_until FROM customers WHERE id = 'cust-tier'").get();
  assertEqualOrThrow(
    row().tier_code,
    'platinum',
    'a drop below the threshold keeps the tier during grace',
  );
  assertEqualOrThrow(row().tier_grace_until, '2025-02-09 00:00:00', 'grace lasts 30 days');
  points.evaluateTier(db, 'cust-tier', '2025-02-01 00:00:00');
  assertEqualOrThrow(row().tier_code, 'platinum', 'still Platinum inside grace');
  points.evaluateTier(db, 'cust-tier', '2025-02-10 00:00:00');
  assertEqualOrThrow(row().tier_code, 'gold', 'demoted to the earned tier after grace');
  assertEqualOrThrow(row().tier_grace_until, null, 'grace is cleared');

  points.setTierOverride(db, {
    customerId: 'cust-tier',
    tierCode: 'platinum',
    until: '2025-03-01 00:00:00',
    note: 'Event partner',
    actorUserId: null,
    at: '2025-02-11 00:00:00',
  });
  assertEqualOrThrow(
    points.effectiveTier(db, 'cust-tier', '2025-02-20 00:00:00')?.code,
    'platinum',
    'override applies until it ends',
  );
  throwsCode(
    () =>
      points.setTierOverride(db, {
        customerId: 'cust-tier',
        tierCode: 'gold',
        until: null,
        note: 'x',
        actorUserId: null,
        at: '2025-02-11 00:00:00',
      }),
    'override_until_required',
    'an override must expire',
  );
  points.evaluateTier(db, 'cust-tier', '2025-03-02 00:00:00');
  assertEqualOrThrow(
    points.effectiveTier(db, 'cust-tier', '2025-03-02 00:00:00')?.code,
    'gold',
    'the override lapses on its date',
  );
  const reasons = db
    .prepare("SELECT reason FROM member_tier_audit WHERE customer_id = 'cust-tier' ORDER BY id")
    .all()
    .map((r: any) => r.reason)
    .join(',');
  assertEqualOrThrow(
    reasons,
    'promoted,grace_started,demoted,override_set,override_expired',
    'every tier change is audited',
  );
}

function appendOnly(db: any) {
  console.log('\n6. The points ledger is append-only');
  throwsCode(
    () => db.prepare('UPDATE points_ledger SET points = 9999').run(),
    'SQLITE_CONSTRAINT_TRIGGER',
    'rows cannot be edited',
  );
  throwsCode(
    () => db.prepare('DELETE FROM points_ledger').run(),
    'SQLITE_CONSTRAINT_TRIGGER',
    'rows cannot be deleted',
  );
}

function refundAfterSpending(db: any) {
  console.log('\n7. A refund after the points were spent can leave a negative balance');
  seedCustomer(db, 'cust-neg', 'Spent Customer', '0855555555');
  db.prepare(
    "UPDATE customers SET qualifying_cents = 520000, tier_code = 'gold' WHERE id = 'cust-neg'",
  ).run();
  db.prepare(
    `INSERT INTO points_ledger (customer_id, bill_id, kind, points, eligible_cents, expires_at, created_at)
     VALUES ('cust-neg', 910001, 'earn', 120, 40000, '2999-01-01 00:00:00', '2025-01-01 00:00:00')`,
  ).run();
  points.redeemPoints(db, {
    customerId: 'cust-neg',
    points: 120,
    billId: null,
    minorFactor: 100,
    actorUserId: null,
    at: '2025-01-02 00:00:00',
  });
  const taken = points.reverseRefundedPoints(db, {
    billId: 910001,
    refundedCents: 40000,
    paidCents: 40000,
    refundId: 1,
    at: '2025-01-03 00:00:00',
  });
  assertEqualOrThrow(taken, 120, 'all earned points are taken back');
  assertEqualOrThrow(points.pointsBalance(db, 'cust-neg'), -120, 'the balance goes negative');
  throwsCode(
    () =>
      points.redeemPoints(db, {
        customerId: 'cust-neg',
        points: 100,
        billId: null,
        minorFactor: 100,
        actorUserId: null,
        at: '2025-01-03 00:00:00',
      }),
    'points_insufficient',
    'a negative balance blocks redemption',
  );
  const row = db
    .prepare(
      "SELECT qualifying_cents, tier_code, tier_grace_until FROM customers WHERE id = 'cust-neg'",
    )
    .get();
  assertEqualOrThrow(row.qualifying_cents, 480000, 'tier qualification falls below Gold');
  assertEqualOrThrow(row.tier_code, 'gold', 'the tier holds during grace');
  assertEqualOrThrow(row.tier_grace_until, '2025-02-02 00:00:00', 'grace starts from the refund');
  assertEqualOrThrow(
    points.reverseRefundedPoints(db, {
      billId: 910001,
      refundedCents: 40000,
      paidCents: 40000,
      refundId: 2,
      at: '2025-01-04 00:00:00',
    }),
    0,
    'repeating the same refunded total takes nothing more',
  );
}

async function main() {
  console.log('Loyalty points and member tiers');
  console.log('='.repeat(60));
  const db = initTestDb();
  setSetting(db, 'loyalty_enabled', 'true');
  setSetting(db, 'loyalty_mode', 'points');
  formula();
  await paymentHook(db);
  cashbackModeUntouched(db);
  expiryAndRedemption(db);
  tierEngine(db);
  refundAfterSpending(db);
  appendOnly(db);
  closeDatabase();
  console.log('\nAll loyalty points checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
