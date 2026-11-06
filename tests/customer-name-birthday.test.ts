/**
 * Customers save first name, last name, birthday and note; `name` stays the joined display name
 * that search, orders and receipts read. A local Thai number (08...) is stored as E.164.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-name-birthday-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  closeDatabase,
  seedOwnerUser,
  api,
  assertEqualOrThrow,
  assertOrThrow,
  createApp,
  startServer,
} = require('./helpers/test-setup');
const { customerRoutes, parseCustomerBirthday } = require('../main/routes/customers');

async function main() {
  console.log('Customers: first/last name, birthday, note');

  assertEqualOrThrow(
    parseCustomerBirthday('1990-02-28').value,
    '1990-02-28',
    'valid birthday is kept',
  );
  assertEqualOrThrow(parseCustomerBirthday('').value, null, 'empty birthday clears');
  assertOrThrow(!parseCustomerBirthday('1990-02-30').valid, 'impossible date is refused');
  assertOrThrow(!parseCustomerBirthday('28/02/1990').valid, 'non-ISO date is refused');

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'TH', datetime('now'))",
  ).run();

  const app = createApp({ '/api/customers': customerRoutes });
  const { baseUrl, server } = await startServer(app);
  const base = baseUrl + '/api';

  try {
    const created = await api(base, '/customers', {
      method: 'POST',
      headers: authHeader,
      body: {
        first_name: ' สมชาย ',
        last_name: 'ใจดี',
        phone: '0812345678',
        birthday: '1990-05-17',
        notes: 'ชอบหวานน้อย',
      },
    });
    assertEqualOrThrow(created.status, 201, `create succeeds: ${JSON.stringify(created.data)}`);
    const c = created.data.customer;
    assertEqualOrThrow(c.name, 'สมชาย ใจดี', 'name is first and last name joined');
    assertEqualOrThrow(c.first_name, 'สมชาย', 'first name is trimmed and stored');
    assertEqualOrThrow(c.last_name, 'ใจดี', 'last name is stored');
    assertEqualOrThrow(c.phone, '+66812345678', 'local phone is stored as E.164');
    assertEqualOrThrow(c.birthday, '1990-05-17', 'birthday is stored');
    assertEqualOrThrow(c.notes, 'ชอบหวานน้อย', 'note is stored');

    const noLast = await api(base, '/customers', {
      method: 'POST',
      headers: authHeader,
      body: { first_name: 'Mint', last_name: '', phone: '0898765432' },
    });
    assertEqualOrThrow(noLast.status, 201, 'last name and birthday are optional');
    assertEqualOrThrow(
      noLast.data.customer.name,
      'Mint',
      'name without last name has no trailing space',
    );
    assertEqualOrThrow(noLast.data.customer.birthday, null, 'missing birthday is NULL');

    const noFirst = await api(base, '/customers', {
      method: 'POST',
      headers: authHeader,
      body: { first_name: '', last_name: 'ใจดี', phone: '0811111111' },
    });
    assertEqualOrThrow(noFirst.status, 400, 'first name is required');

    const badBirthday = await api(base, '/customers', {
      method: 'POST',
      headers: authHeader,
      body: { first_name: 'Bad', phone: '0822222222', birthday: '2001-13-01' },
    });
    assertEqualOrThrow(badBirthday.status, 400, 'invalid birthday is refused');

    const legacy = await api(base, '/customers', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Walk In Guest', phone: '0833333333' },
    });
    assertEqualOrThrow(legacy.status, 201, 'name-only create still works');
    assertEqualOrThrow(
      legacy.data.customer.first_name,
      null,
      'name-only create leaves first_name NULL',
    );

    for (const [term, label] of [
      ['ใจดี', 'last name'],
      ['สมชาย', 'first name'],
      ['0812345678', 'local phone'],
    ]) {
      const found = await api(base, `/customers?search=${encodeURIComponent(term)}`, {
        headers: authHeader,
      });
      assertOrThrow(
        found.data.data.some((row: any) => row.id === c.id),
        `search by ${label} finds the customer`,
      );
    }

    db.prepare(
      "UPDATE customers SET email = 'keep@example.com', address = '9 Soi 1' WHERE id = ?",
    ).run(c.id);
    const updated = await api(base, `/customers/${c.id}`, {
      method: 'PUT',
      headers: authHeader,
      body: { first_name: 'สมหญิง', last_name: 'ใจดี', phone: '0812345678', birthday: '', notes: '' },
    });
    assertEqualOrThrow(updated.status, 200, 'update succeeds');
    const u = updated.data.customer;
    assertEqualOrThrow(u.name, 'สมหญิง ใจดี', 'update rejoins the name');
    assertEqualOrThrow(u.birthday, null, 'empty birthday clears it');
    assertEqualOrThrow(u.notes, null, 'empty note clears it');
    assertEqualOrThrow(u.email, 'keep@example.com', 'email the form no longer shows is kept');
    assertEqualOrThrow(u.address, '9 Soi 1', 'address the form no longer shows is kept');

    const sameName = await api(base, `/customers/${c.id}`, {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'สมหญิง ใจดี' },
    });
    assertEqualOrThrow(
      sameName.data.customer.first_name,
      'สมหญิง',
      'resaving the same full name keeps the split',
    );

    const renamed = await api(base, `/customers/${c.id}`, {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'Somying Jaidee' },
    });
    assertEqualOrThrow(renamed.data.customer.name, 'Somying Jaidee', 'name-only rename is applied');
    assertEqualOrThrow(
      renamed.data.customer.first_name,
      null,
      'name-only rename drops the stale split',
    );

    const insertCustomer = db.prepare(
      "INSERT INTO customers (id, name, is_active, created_at, updated_at) VALUES (?, ?, 1, datetime('now'), datetime('now'))",
    );
    const insertOrder = db.prepare(
      "INSERT INTO orders (order_number, customer_id, total, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
    );
    insertCustomer.run('avg-high', 'Avg High');
    insertCustomer.run('avg-low', 'Avg Low');
    insertCustomer.run('avg-none', 'Avg None');
    insertOrder.run('AVG-1', 'avg-high', 900);
    insertOrder.run('AVG-2', 'avg-low', 300);
    insertOrder.run('AVG-3', 'avg-low', 300);
    insertOrder.run('AVG-4', 'avg-low', 300);
    const bySpend = await api(base, '/customers?search=Avg&sort=avg_spent&order=desc', {
      headers: authHeader,
    });
    assertEqualOrThrow(bySpend.status, 200, 'sorting by average spend is accepted');
    assertEqualOrThrow(
      bySpend.data.data.map((row: any) => row.id).join(','),
      'avg-high,avg-low,avg-none',
      'average spend sorts 900/visit above 300/visit, with no visits last',
    );
    const low = bySpend.data.data.find((row: any) => row.id === 'avg-low');
    assertEqualOrThrow(
      low.total_spent / low.visits_count,
      300,
      'average spend is total spent over visits',
    );

    console.log('  ✓ all customer name/birthday checks passed');
  } finally {
    server?.close?.();
    closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
