/**
 * Migration v136: customers gain first_name, last_name and birthday.
 * A fresh install gets the columns, and an upgrade from v135 keeps every existing customer as it was.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v136-fresh-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase,
  getDatabase,
  getCurrentSchemaVersion,
  MIGRATIONS,
  closeDatabase,
} = require('../main/db');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const NEW_COLUMNS = ['first_name', 'last_name', 'birthday'];

function customerColumns(db: any): string[] {
  return (db.prepare('PRAGMA table_info(customers)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

function main() {
  console.log('Migration v136: customer first/last name and birthday');
  const originalMigrations = MIGRATIONS.slice();
  const latest = originalMigrations[originalMigrations.length - 1].version;

  initDatabase();
  let db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'fresh database reaches the latest schema');
  for (const column of NEW_COLUMNS) {
    assertOrThrow(customerColumns(db).includes(column), `fresh database has customers.${column}`);
  }
  closeDatabase();

  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v136-upgrade-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((m: any) => m.version <= 135));
  initDatabase();
  db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), 135, 'upgrade store starts at v135');
  assertOrThrow(!customerColumns(db).includes('birthday'), 'v135 schema has no birthday column');

  db.prepare(`
    INSERT INTO customers (id, name, phone, country_code, email, address, notes, created_at, updated_at)
    VALUES ('cust-legacy', 'สมชาย ใจดี', '+66812345678', '+66', 'a@example.com', '1 Main Rd', 'VIP', datetime('now'), datetime('now'))
  `).run();
  const before = db.prepare("SELECT * FROM customers WHERE id = 'cust-legacy'").get();

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }

  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'upgrade reaches the latest schema');
  const after = db.prepare("SELECT * FROM customers WHERE id = 'cust-legacy'").get();
  for (const key of Object.keys(before)) {
    assertEqualOrThrow(after[key], before[key], `existing customers.${key} survives the upgrade`);
  }
  for (const column of NEW_COLUMNS) {
    assertEqualOrThrow(after[column], null, `upgraded customer has a NULL ${column}`);
  }

  for (const migration of MIGRATIONS.filter((m: any) => m.version === 136)) {
    migration.up();
  }
  assertOrThrow(customerColumns(db).includes('birthday'), 'v136 is safe to re-run');
  closeDatabase();
  console.log('  ✓ all migration v136 checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
