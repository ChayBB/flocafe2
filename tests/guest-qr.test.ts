/**
 * Table QR ordering from outside the shop: public address, trusted proxy, and signed table tokens.
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

const { initTestDb, assertEqualOrThrow, assertOrThrow, closeDatabase } = require('./helpers/test-setup');
const {
  normalizePublicBaseUrl,
  normalizeTrustedProxy,
  isTrustedGuestProxy,
  guestTableToken,
  verifyGuestTableToken,
  rotateGuestQrSecret,
} = require('../main/lib/guest-qr');

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
  for (const bad of ['http://order.example.com', 'order.example.com', 'https://a.com/?x=1', 'https://u:p@a.com', 42]) {
    assertEqualOrThrow(normalizePublicBaseUrl(bad), null, `rejects ${String(bad)}`);
  }
  assertEqualOrThrow(normalizeTrustedProxy('10.88.0.1'), '10.88.0.1', 'an IPv4 proxy is kept');
  assertEqualOrThrow(normalizeTrustedProxy('FD00::1'), 'fd00::1', 'an IPv6 proxy is kept in lower case');
  assertEqualOrThrow(normalizeTrustedProxy('10.88.0.0/24'), null, 'a range is not a single proxy');

  assertOrThrow(!isTrustedGuestProxy('10.88.0.1'), 'no proxy is trusted until one is set');
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('guest_qr_trusted_proxy', '10.88.0.1', '')").run();
  assertOrThrow(isTrustedGuestProxy('10.88.0.1'), 'the configured proxy is trusted');
  assertOrThrow(isTrustedGuestProxy('::ffff:10.88.0.1'), 'its IPv4-mapped form is trusted too');
  assertOrThrow(!isTrustedGuestProxy('10.88.0.2'), 'any other address is not');

  const token = guestTableToken('tbl-1');
  assertEqualOrThrow(token.length, 22, 'tokens are 22 characters');
  assertEqualOrThrow(guestTableToken('tbl-1'), token, 'a table keeps its token');
  assertOrThrow(verifyGuestTableToken('tbl-1', token), 'the table token verifies');
  assertOrThrow(!verifyGuestTableToken('tbl-2', token), "another table's token is refused");
  assertOrThrow(!verifyGuestTableToken('tbl-1', undefined), 'a missing token is refused');
  assertOrThrow(!verifyGuestTableToken('tbl-1', `${token.slice(0, 21)}x`), 'a changed token is refused');
  rotateGuestQrSecret();
  assertOrThrow(!verifyGuestTableToken('tbl-1', token), 'rotating the secret cancels printed QR codes');
  assertOrThrow(verifyGuestTableToken('tbl-1', guestTableToken('tbl-1')), 'new QR codes work after rotating');
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
