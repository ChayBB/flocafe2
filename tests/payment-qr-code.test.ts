/**
 * QR payment account setting and the dynamic PromptPay QR endpoint.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/payment-qr-code.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-payment-qr-'));
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
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { paymentMethodRoutes } = require('../main/routes/payment-methods');
const { crc16Ccitt } = require('../main/lib/promptpay');

async function main() {
  console.log('QR payment account and code');
  console.log('='.repeat(60));
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const app = createApp({ '/api/payment-methods': paymentMethodRoutes });
  const { baseUrl, server } = await startServer(app);
  const qr = (amount: unknown) =>
    api(baseUrl, `/api/payment-methods/qr-code?amount=${amount}`, { headers: authHeader });

  try {
    const missing = await qr(100);
    assertEqualOrThrow(missing.status, 404, 'no QR without an account');
    assertEqualOrThrow(missing.data.code, 'qr_account_missing', 'missing account is reported');

    const bad = await api(baseUrl, '/api/payment-methods/qr-account', {
      method: 'PUT',
      headers: authHeader,
      body: { account: '12345' },
    });
    assertEqualOrThrow(bad.status, 400, 'invalid account is rejected');

    const saved = await api(baseUrl, '/api/payment-methods/qr-account', {
      method: 'PUT',
      headers: authHeader,
      body: { account: '081-234-5678' },
    });
    assertEqualOrThrow(saved.status, 200, 'valid account is saved');
    assertEqualOrThrow(saved.data.account, '0812345678', 'account is stored without separators');
    const read = await api(baseUrl, '/api/payment-methods/qr-account', { headers: authHeader });
    assertEqualOrThrow(read.data.account, '0812345678', 'account is readable by managers');

    const ok = await qr(267.5);
    assertEqualOrThrow(ok.status, 200, 'QR is created once an account exists');
    assertOrThrow(String(ok.data.data_url).startsWith('data:image/png;base64,'), 'QR is a PNG data URL');
    assertOrThrow(ok.data.payload.includes('5406267.50'), 'payload carries the bill amount');
    assertEqualOrThrow(
      ok.data.payload.slice(-4),
      crc16Ccitt(ok.data.payload.slice(0, -4)),
      'payload checksum is valid',
    );

    for (const amount of [0, -5, 'abc']) {
      const response = await qr(amount);
      assertEqualOrThrow(response.status, 400, `amount ${amount} is rejected`);
    }

    const cleared = await api(baseUrl, '/api/payment-methods/qr-account', {
      method: 'PUT',
      headers: authHeader,
      body: { account: '' },
    });
    assertEqualOrThrow(cleared.status, 200, 'account can be cleared');
    assertEqualOrThrow((await qr(100)).status, 404, 'cleared account stops QR creation');
    console.log('\nAll QR payment checks passed');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
