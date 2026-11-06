/**
 * Migration v140: theme_light_variant and theme_dark_variant default to "1". A fresh install gets
 * them, an upgrade from v139 adds them without touching an existing theme_mode, and a saved
 * variant survives a re-run.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v140-fresh-'));

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
const { isThemeVariant } = require('../main/title-bar-theme');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const setting = (db: any, key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value;

function main() {
  console.log('Migration v140: theme variants');
  for (const ok of ['1', '2', '3']) assertOrThrow(isThemeVariant(ok), `"${ok}" is a variant`);
  for (const bad of ['0', '4', 1, 'light', null, undefined]) {
    assertOrThrow(!isThemeVariant(bad), `${JSON.stringify(bad)} is not a variant`);
  }

  const originalMigrations = MIGRATIONS.slice();
  const latest = originalMigrations[originalMigrations.length - 1].version;

  initDatabase();
  let db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'fresh database reaches the latest schema');
  assertEqualOrThrow(setting(db, 'theme_light_variant'), '1', 'fresh: light variant is "1"');
  assertEqualOrThrow(setting(db, 'theme_dark_variant'), '1', 'fresh: dark variant is "1"');
  closeDatabase();

  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v140-upgrade-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((m: any) => m.version <= 139));
  initDatabase();
  db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), 139, 'upgrade store starts at v139');
  assertEqualOrThrow(setting(db, 'theme_light_variant'), undefined, 'v139 has no light variant');
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('theme_mode', 'dark') ON CONFLICT(key) DO UPDATE SET value = 'dark'",
  ).run();

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
  assertEqualOrThrow(setting(db, 'theme_mode'), 'dark', 'an existing dark choice survives');
  assertEqualOrThrow(setting(db, 'theme_light_variant'), '1', 'upgrade: light variant is "1"');
  assertEqualOrThrow(setting(db, 'theme_dark_variant'), '1', 'upgrade: dark variant is "1"');

  db.prepare("UPDATE settings SET value = '3' WHERE key = 'theme_dark_variant'").run();
  for (const migration of MIGRATIONS.filter((m: any) => m.version === 140)) migration.up();
  assertEqualOrThrow(setting(db, 'theme_dark_variant'), '3', 'v140 re-run keeps a saved variant');
  closeDatabase();
  console.log('  all migration v140 checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
