/**
 * Order, item, and delivery notes are masked with the profanity word list before they are stored,
 * so POS, KDS, the Server App, and printouts all show the same masked text.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/profanity-notes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-profanity-notes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-profanity-notes';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { PROFANITY_WORDS_KEY } = require('../main/services/profanity-filter');

async function main() {
  console.log('Profanity masking of stored order notes');
  const db = initTestDb();
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('owner-notes', 'Owner', 'owner-notes@test.local', ?, 'owner', 1, ?, ?)`,
  ).run(bcrypt.hashSync('testpass123', 10), now(), now());
  const auth = {
    Authorization: `Bearer ${jwt.sign({ userId: 'owner-notes', email: 'owner-notes@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-notes', 'Food', 1)`).run();
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
     VALUES ('prod-notes', 'cat-notes', 'ผัดพริกขิง', 100, 'none', 1, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PROFANITY_WORDS_KEY, JSON.stringify(['ควย', 'เย็ดแม่', 'ชี']));

  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);
  let key = 0;
  const post = (url: string, body: unknown) =>
    api(baseUrl, url, {
      method: 'POST',
      body,
      headers: { ...auth, 'Idempotency-Key': `profanity-notes-${++key}` },
    });
  try {
    const created = await post('/api/orders', {
      type: 'delivery',
      delivery_address: '1 Test Road',
      delivery_note: 'บอกไอ้เย็ดแม่ที่ประตู',
      special_instructions: 'ใส่ควยเยอะ',
      items: [{ product_id: 'prod-notes', quantity: 1, special_instructions: 'ควยผัดพริกขิง ใส่ชีส' }],
    });
    assertEqualOrThrow(created.status, 201, `order is created (${JSON.stringify(created.data)})`);
    const orderId = created.data.id ?? created.data.order?.id;
    const order = db
      .prepare('SELECT special_instructions, delivery_note FROM orders WHERE id = ?')
      .get(orderId);
    assertEqualOrThrow(order.special_instructions, 'ใส่***เยอะ', 'order note is masked');
    assertEqualOrThrow(order.delivery_note, 'บอกไอ้***ที่ประตู', 'delivery note is masked');
    const firstItem = db
      .prepare('SELECT special_instructions FROM order_items WHERE order_id = ? ORDER BY id')
      .get(orderId);
    assertEqualOrThrow(
      firstItem.special_instructions,
      '***ผัดพริกขิง ใส่ชีส',
      'item note is masked and a longer word such as ชีส is kept',
    );

    const added = await post(`/api/orders/${orderId}/items`, {
      items: [{ product_id: 'prod-notes', quantity: 1, special_instructions: 'เย็ดแม่' }],
      special_instructions: 'ควย แก้ไข',
    });
    assertEqualOrThrow(added.status < 300, true, `items are added (${JSON.stringify(added.data)})`);
    const notes = db
      .prepare('SELECT special_instructions FROM order_items WHERE order_id = ? ORDER BY id')
      .all(orderId)
      .map((row: any) => row.special_instructions);
    assertEqualOrThrow(notes[notes.length - 1], '***', 'an added item note is masked');
    assertEqualOrThrow(
      db.prepare('SELECT special_instructions FROM orders WHERE id = ?').get(orderId)
        .special_instructions,
      '*** แก้ไข',
      'an updated order note is masked',
    );

    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('[]', PROFANITY_WORDS_KEY);
    const unfiltered = await post('/api/orders', {
      type: 'takeaway',
      special_instructions: 'ควย',
      items: [{ product_id: 'prod-notes', quantity: 1 }],
    });
    assertEqualOrThrow(unfiltered.status, 201, 'order without a word list is created');
    assertEqualOrThrow(
      db
        .prepare('SELECT special_instructions FROM orders WHERE id = ?')
        .get(unfiltered.data.id ?? unfiltered.data.order?.id).special_instructions,
      'ควย',
      'an empty word list stores notes unchanged',
    );
    console.log('profanity-notes: all assertions passed');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
