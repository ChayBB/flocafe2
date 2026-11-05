/**
 * QR-ordering relay client: pairing by code, the signed tunnel, and what it lets through.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/qr-relay.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-qr-relay-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { createFakeQrRelay } = require('./helpers/fake-qr-relay.cjs');
const { setServerAppPort } = require('../main/server-app-state');
const { getSettingValue } = require('../main/db');
const { isTrustedGuestProxy } = require('../main/lib/guest-qr');
const relayClient = require('../main/services/qr-relay');

const waitFor = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function main() {
  console.log('QR relay client');
  console.log('='.repeat(60));
  initTestDb();

  assertEqualOrThrow(
    relayClient.normalizeRelayServerUrl('https://relay.example.com/'),
    'https://relay.example.com',
    'an https relay is kept',
  );
  assertEqualOrThrow(
    relayClient.normalizeRelayServerUrl('http://127.0.0.1:9000'),
    'http://127.0.0.1:9000',
    'plain http is allowed on this machine',
  );
  assertEqualOrThrow(
    relayClient.normalizeRelayServerUrl('http://relay.example.com'),
    null,
    'plain http elsewhere is refused',
  );
  for (const inside of [
    'https://10.0.0.5',
    'https://192.168.1.20:8443',
    'https://169.254.169.254',
    'https://127.0.0.1',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
  ]) {
    assertEqualOrThrow(
      relayClient.normalizeRelayServerUrl(inside),
      null,
      `an https relay at ${inside} is refused`,
    );
  }
  for (const [method, pathname, allowed] of [
    ['GET', '/api/guest/menu', true],
    ['GET', '/api/guest/table', true],
    ['POST', '/api/guest/order', true],
    ['POST', '/api/guest/join', true],
    ['GET', '/api/server-app/info', true],
    ['GET', '/api/guest/order', true],
    ['GET', '/api/server-app/branding/logo', true],
    ['GET', '/api/server-app/branding/cover', true],
    ['GET', '/api/products/prod-1a2b/image', true],
    ['GET', '/api/server-app/branding/other', false],
    ['GET', '/api/products/prod-1a2b', false],
    ['GET', '/api/products/popular', false],
    ['GET', '/server-standalone/', true],
    ['GET', '/_next/static/chunks/app.js', true],
    ['POST', '/api/guest/menu', false],
    ['GET', '/api/orders', false],
    ['POST', '/api/auth/login', false],
    ['GET', '/api/customers-search', false],
    ['GET', '/server-standalone/../api/orders', false],
  ] as [string, string, boolean][]) {
    assertEqualOrThrow(
      relayClient.isRelayPathAllowed(method, pathname),
      allowed,
      `${method} ${pathname} allowed=${allowed}`,
    );
  }

  const seen: { method: string; url: string; forwardedFor: string | undefined; body: string }[] =
    [];
  const target = http.createServer((req: any, res: any) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        forwardedFor: req.headers['x-forwarded-for'],
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'secret=1' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  setServerAppPort(target.address().port);
  const relay = await createFakeQrRelay();

  try {
    let failed = false;
    try {
      await relayClient.startQrRelayPairing('ftp://relay');
    } catch (error: any) {
      failed = error.code === 'server_url_invalid';
    }
    assertOrThrow(failed, 'a bad relay address is refused');
    failed = false;
    try {
      await relayClient.startQrRelayPairing('https://localhost:9');
    } catch (error: any) {
      failed = error.code === 'server_url_invalid';
    }
    assertOrThrow(failed, 'an https relay name that resolves to this host is refused');

    await relayClient.startQrRelayPairing(relay.url);
    let status = relayClient.getQrRelayStatus();
    assertEqualOrThrow(status.state, 'pairing', 'pairing starts');
    assertOrThrow(/^\d{6}$/.test(status.pairing.code), 'a 6-digit code is shown');
    assertOrThrow(
      status.pairing.qr_data_url.startsWith('data:image/png;base64,'),
      'with a QR image',
    );
    const sent = [...relay.pairings.values()][0];
    assertOrThrow(
      typeof sent.publicKey === 'string' && sent.publicKey.length > 40,
      'the public key goes to the relay',
    );
    assertOrThrow(!String(sent.publicKey).includes('PRIVATE'), 'the private key stays on the POS');

    await relayClient.checkQrRelayPairing();
    assertEqualOrThrow(
      relayClient.getQrRelayStatus().state,
      'pairing',
      'still pairing until the admin approves',
    );

    relay.approve(status.pairing.code, {
      storeId: 'store-1',
      publicBaseUrl: 'https://shop-1.order.example.com/',
    });
    await relayClient.checkQrRelayPairing();
    status = relayClient.getQrRelayStatus();
    assertEqualOrThrow(status.state, 'paired', 'approval pairs the POS');
    assertEqualOrThrow(
      status.public_base_url,
      'https://shop-1.order.example.com',
      'the public address comes from the relay',
    );
    assertEqualOrThrow(
      getSettingValue('guest_qr_public_base_url'),
      'https://shop-1.order.example.com',
      'and is used for QR links',
    );
    await relay.waitForTunnel();
    await waitFor(() => relayClient.getQrRelayStatus().connected, 'the tunnel to report connected');
    assertOrThrow(
      isTrustedGuestProxy('127.0.0.1'),
      'the tunnel may report the customer address over loopback',
    );

    const menu = await relay.request('GET', '/api/guest/menu?x=1', {
      headers: { cookie: 'staff=1', accept: 'application/json' },
    });
    assertEqualOrThrow(menu.status, 200, 'a guest route passes through');
    assertEqualOrThrow(
      JSON.parse(menu.body.toString()).url,
      '/api/guest/menu?x=1',
      'with its query',
    );
    assertEqualOrThrow(
      seen.at(-1)!.forwardedFor,
      '203.0.113.7',
      'the customer address is forwarded',
    );
    assertOrThrow(!('set-cookie' in menu.headers), 'cookies are not returned through the tunnel');

    const order = await relay.request('POST', '/api/guest/order', {
      headers: { 'content-type': 'application/json' },
      body: { table_id: 't' },
    });
    assertEqualOrThrow(order.status, 200, 'a guest order passes through');
    assertEqualOrThrow(seen.at(-1)!.body, '{"table_id":"t"}', 'with its body');
    const seenBeforeAnonymous = seen.length;
    for (const clientIp of ['', 'not-an-ip']) {
      const anonymous = await relay.request('GET', '/api/guest/menu', { clientIp });
      assertEqualOrThrow(
        anonymous.status,
        400,
        `a request without a customer address (${JSON.stringify(clientIp)}) is refused`,
      );
    }
    assertEqualOrThrow(
      seen.length,
      seenBeforeAnonymous,
      'and never reaches the Server App as loopback',
    );

    const before = seen.length;
    for (const [method, blocked] of [
      ['GET', '/api/orders'],
      ['POST', '/api/auth/login'],
      ['GET', '/server-standalone/../api/orders'],
      ['GET', 'http://evil.example.com/api/guest/menu'],
    ]) {
      assertEqualOrThrow(
        (await relay.request(method, blocked)).status,
        404,
        `${method} ${blocked} is refused`,
      );
    }
    assertEqualOrThrow(seen.length, before, 'refused requests never reach the Server App');

    await relayClient.unpairQrRelay();
    status = relayClient.getQrRelayStatus();
    assertEqualOrThrow(status.state, 'unpaired', 'unpairing forgets the relay');
    assertOrThrow(relay.unpaired.includes('store-1'), 'and tells the relay with a signed request');
    assertEqualOrThrow(
      getSettingValue('qr_relay_private_key') || '',
      '',
      'the private key is cleared',
    );
    assertEqualOrThrow(
      getSettingValue('guest_qr_public_base_url') || '',
      '',
      'QR links go back to the shop network',
    );
    assertOrThrow(!isTrustedGuestProxy('127.0.0.1'), 'loopback is no longer trusted');
    await waitFor(() => !relay.connected, 'the tunnel to close');
  } finally {
    relayClient.stopQrRelay();
    await relay.close();
    await new Promise((resolve) => target.close(resolve));
  }
}

main()
  .then(() => console.log('\nQR relay tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      closeDatabase();
    } catch {}
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  });
