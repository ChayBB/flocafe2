/**
 * Table QR ordering: public address, trusted proxy, and the per-party table sessions their codes belong to.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/guest-qr.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-guest-qr-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedTable,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const {
  normalizePublicBaseUrl,
  normalizeTrustedProxy,
  isTrustedGuestProxy,
  guestSessionToken,
  verifyGuestTableToken,
  rotateGuestQrSecret,
} = require('../main/lib/guest-qr');
const {
  openGuestTableSession,
  closeGuestTableSession,
  currentGuestTableSession,
} = require('../main/lib/guest-table-session');
const { nextDailyResetEpochSeconds } = require('../main/lib/daily-session-reset');
const { storeTimezone } = require('../main/services/attendance');
const { renderTableQrSlip } = require('../main/printers/table-qr-slip');

function main() {
  console.log('Guest QR network and tokens');
  console.log('='.repeat(60));
  const db = initTestDb();

  assertEqualOrThrow(normalizePublicBaseUrl(''), '', 'an empty address clears it');
  assertEqualOrThrow(
    normalizePublicBaseUrl(' https://Order.Example.com/shop/ '),
    'https://order.example.com/shop',
    'an https address is kept without its trailing slash',
  );
  for (const bad of [
    'http://order.example.com',
    'order.example.com',
    'https://a.com/?x=1',
    'https://u:p@a.com',
    42,
  ]) {
    assertEqualOrThrow(normalizePublicBaseUrl(bad), null, `rejects ${String(bad)}`);
  }
  assertEqualOrThrow(normalizeTrustedProxy('10.88.0.1'), '10.88.0.1', 'an IPv4 proxy is kept');
  assertEqualOrThrow(
    normalizeTrustedProxy('FD00::1'),
    'fd00::1',
    'an IPv6 proxy is kept in lower case',
  );
  assertEqualOrThrow(normalizeTrustedProxy('10.88.0.0/24'), null, 'a range is not a single proxy');

  assertOrThrow(!isTrustedGuestProxy('10.88.0.1'), 'no proxy is trusted until one is set');
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('guest_qr_trusted_proxy', '10.88.0.1', '')",
  ).run();
  assertOrThrow(isTrustedGuestProxy('10.88.0.1'), 'the configured proxy is trusted');
  assertOrThrow(isTrustedGuestProxy('::ffff:10.88.0.1'), 'its IPv4-mapped form is trusted too');
  assertOrThrow(!isTrustedGuestProxy('10.88.0.2'), 'any other address is not');

  seedTable(db, 'tbl-1', 1);
  seedTable(db, 'tbl-2', 2);
  assertOrThrow(
    !verifyGuestTableToken('tbl-1', 'x'.repeat(22)),
    'a table without a session takes no orders',
  );
  const session = openGuestTableSession(db, 'tbl-1', null);
  const token = guestSessionToken(session.id);
  assertEqualOrThrow(token.length, 22, 'tokens are 22 characters');
  assertOrThrow(verifyGuestTableToken('tbl-1', token), "the session's token verifies");
  assertEqualOrThrow(
    openGuestTableSession(db, 'tbl-1', null).id,
    session.id,
    'reopening shows the same code',
  );
  assertOrThrow(!verifyGuestTableToken('tbl-2', token), "another table's token is refused");
  assertOrThrow(!verifyGuestTableToken('tbl-1', undefined), 'a missing token is refused');
  assertOrThrow(
    !verifyGuestTableToken('tbl-1', `${token.slice(0, 21)}x`),
    'a changed token is refused',
  );
  assertOrThrow(
    session.expires_at ===
      new Date(
        nextDailyResetEpochSeconds(
          new Date(`${session.created_at.replace(' ', 'T')}Z`),
          storeTimezone(db),
          7,
        ) * 1000,
      )
        .toISOString()
        .replace('T', ' ')
        .replace(/\..*$/, ''),
    'a session ends at the next 07:00 store time',
  );

  const renewed = openGuestTableSession(db, 'tbl-1', null, { renew: true });
  assertOrThrow(!verifyGuestTableToken('tbl-1', token), 'a new code retires the old one');
  assertOrThrow(verifyGuestTableToken('tbl-1', guestSessionToken(renewed.id)), 'and works itself');

  assertOrThrow(closeGuestTableSession(db, 'tbl-1'), 'staff can end the session');
  assertOrThrow(
    !verifyGuestTableToken('tbl-1', guestSessionToken(renewed.id)),
    'an ended code takes no orders',
  );
  assertOrThrow(!closeGuestTableSession(db, 'tbl-1'), 'ending it twice reports nothing open');

  const seated = openGuestTableSession(db, 'tbl-1', null);
  db.prepare("UPDATE tables SET status = 'occupied' WHERE id = 'tbl-1'").run();
  assertOrThrow(currentGuestTableSession(db, 'tbl-1') !== null, 'seating the party keeps the code');
  db.prepare("UPDATE tables SET status = 'available' WHERE id = 'tbl-1'").run();
  assertOrThrow(
    !verifyGuestTableToken('tbl-1', guestSessionToken(seated.id)),
    'freeing the table ends the code',
  );

  const today = openGuestTableSession(db, 'tbl-1', null);
  db.prepare("UPDATE guest_table_sessions SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(
    today.id,
  );
  assertOrThrow(
    !verifyGuestTableToken('tbl-1', guestSessionToken(today.id)),
    'the daily reset ends the code',
  );
  const tomorrow = openGuestTableSession(db, 'tbl-1', null);
  assertOrThrow(tomorrow.id !== today.id, 'the next party after the reset gets a new code');

  const slip = renderTableQrSlip(
    {
      businessName: 'Flo Cafe',
      tableName: 'A1',
      url: 'https://order.example.com/x',
      validUntil: '4 พ.ย. 07:00',
    },
    {
      columns: 32,
      language: 'th',
      useUnicode: false,
      arabicShaping: false,
      cutMode: 'partial',
      widthDots: 384,
      maxBandHeight: 200,
    },
  );
  assertOrThrow(
    slip.lines.some((line: string) => line.includes('โต๊ะ A1')),
    'the slip names the table',
  );
  assertOrThrow(
    slip.lines.some((line: string) => line.startsWith('{RAW_BYTES:')),
    'the slip carries the QR',
  );
  assertOrThrow(
    slip.lines.some((line: string) => line.includes('ใช้ได้ถึง 4 พ.ย. 07:00')),
    'the slip says when the code stops working',
  );
  assertEqualOrThrow(slip.lines[slip.lines.length - 1], '{CUT}', 'the slip is cut off');

  const before = guestSessionToken(tomorrow.id);
  rotateGuestQrSecret();
  assertOrThrow(!verifyGuestTableToken('tbl-1', before), 'rotating the secret cancels every code');
  assertOrThrow(
    verifyGuestTableToken('tbl-1', guestSessionToken(tomorrow.id)),
    'the session shows its new code',
  );
}

try {
  main();
  console.log('\nGuest QR tests passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    closeDatabase();
  } catch {}
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
}
