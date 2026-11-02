/**
 * QR ordering secrets live in OS-backed storage when available: SQLite keeps only a marker, an
 * older plaintext value moves out on first read, and a store that cannot yield the value reads ''.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/protected-setting.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-protected-setting-'));
let encryptionAvailable = true;
Module._load = function (request: string) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
      safeStorage: {
        isEncryptionAvailable: () => encryptionAvailable,
        encryptString: (value: string) =>
          Buffer.from('enc:' + Buffer.from(value).toString('base64')),
        decryptString: (value: Buffer) => {
          const text = value.toString();
          if (!text.startsWith('enc:')) throw new Error('not decryptable');
          return Buffer.from(text.slice(4), 'base64').toString();
        },
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, upsertSettings } = require('../main/db');
const {
  PROTECTED_SETTING_MARKER,
  readProtectedSetting,
  writeProtectedSetting,
} = require('../main/security/protected-setting');
const { guestSessionToken, rotateGuestQrSecret } = require('../main/lib/guest-qr');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const KEY = 'guest_qr_secret';
const file = path.join(testDir, `${KEY}.enc`);
const stored = () =>
  (
    getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
      | { value: string }
      | undefined
  )?.value;

try {
  initDatabase();

  const token = guestSessionToken('session-1');
  assertEqualOrThrow(stored(), PROTECTED_SETTING_MARKER, 'SQLite holds only the marker');
  const secret = readProtectedSetting(KEY);
  assertOrThrow(/^[0-9a-f]{64}$/.test(secret), 'a first QR secret is minted');
  assertOrThrow(!fs.readFileSync(file).toString().includes(secret), 'the file is not plaintext');
  assertEqualOrThrow(
    guestSessionToken('session-1'),
    token,
    'table codes come from the stored secret',
  );

  rotateGuestQrSecret();
  assertOrThrow(guestSessionToken('session-1') !== token, 'rotating retires the old table codes');
  assertEqualOrThrow(stored(), PROTECTED_SETTING_MARKER, 'the rotated secret stays out of SQLite');

  const legacy = 'ab'.repeat(32);
  upsertSettings({ [KEY]: legacy });
  assertEqualOrThrow(readProtectedSetting(KEY), legacy, 'an upgraded install keeps its secret');
  assertEqualOrThrow(stored(), PROTECTED_SETTING_MARKER, 'the plaintext moves out of SQLite');
  assertEqualOrThrow(readProtectedSetting(KEY), legacy, 'the moved secret reads back');

  // A database restored on another machine carries the marker but no readable file.
  fs.writeFileSync(file, 'garbage');
  assertEqualOrThrow(readProtectedSetting(KEY), '', 'an unreadable store yields no secret');

  writeProtectedSetting(KEY, '');
  assertEqualOrThrow(stored(), '', 'clearing empties the row');
  assertOrThrow(!fs.existsSync(file), 'clearing removes the file');

  encryptionAvailable = false;
  writeProtectedSetting(KEY, 'cd'.repeat(32));
  assertEqualOrThrow(stored(), 'cd'.repeat(32), 'without OS encryption the value stays in SQLite');
  assertEqualOrThrow(readProtectedSetting(KEY), 'cd'.repeat(32), 'and reads back from there');
  assertEqualOrThrow(
    readProtectedSetting('qr_relay_private_key'),
    '',
    'an unset secret reads as empty',
  );
  console.log('protected-setting: all assertions passed');
} finally {
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
}
