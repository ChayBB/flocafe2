/**
 * L3 end-to-end: guest order → connector → real FloCafe Server App → kitchen → payment close.
 * Starts its own FloCafe (tests/e2e-server.cjs), pos-server API and the connector on test ports.
 *
 * Requires: DATABASE_URL, ADMIN_DATABASE_URL, GUEST_QR_SECRET, a built dist/, and `bun` on PATH.
 * Usage: node tests/qr-server/suites/run.cjs e2e
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminDb, tableToken } from '../../harness/db';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const API = 'http://127.0.0.1:3311';
const FLO_MAIN = 'http://127.0.0.1:3301';
const FLO_APP = 'http://127.0.0.1:3303';
const FLO_EMAIL = 'server@flo.local';
const FLO_OWNER = 'owner@flo.local';
const FLO_PASSWORD = 'E2ePass123!';

const children: ChildProcess[] = [];
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(18).toString('base64url');
const admin = adminDb();
const floUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-e2e-'));
let stopping = false;

function start(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping && code !== 0) console.error(`[e2e] ${command} ${args.join(' ')} exited ${code}`);
  });
  return child;
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function http(url: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

const jsonInit = (body: unknown, token?: string, method: string = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

async function main(): Promise<void> {
  console.log('delivery e2e (connector + real FloCafe)');
  console.log('='.repeat(60));

  start('node', ['tests/e2e-server.cjs'], ROOT, {
    E2E_TASK_LOCAL_PORTS: '1',
    E2E_BASE_URL: FLO_MAIN,
    E2E_KDS_BASE_URL: 'http://127.0.0.1:3302',
    E2E_SERVER_APP_BASE_URL: FLO_APP,
    FLO_DEV_USER_DATA: floUserData,
    FLO_MATRIX_OFFLINE: '1',
    FLO_WHATSAPP_SOCKET_DISABLED: '1',
  });
  await waitFor(
    'FloCafe main API',
    async () => (await http(`${FLO_MAIN}/api/health`)).status === 200,
  );
  await waitFor(
    'FloCafe Server App',
    async () => (await http(`${FLO_APP}/api/health`)).status === 200,
  );

  const ownerLogin = await http(
    `${FLO_MAIN}/api/auth/login`,
    jsonInit({ email: FLO_OWNER, password: FLO_PASSWORD }),
  );
  assert.equal(ownerLogin.status, 200, `owner login failed: ${JSON.stringify(ownerLogin.json)}`);
  const ownerToken = ownerLogin.json.access_token ?? ownerLogin.json.token;
  assert.ok(ownerToken, 'owner token missing');

  const tableResponse = await http(
    `${FLO_MAIN}/api/tables`,
    jsonInit({ number: 'E2E-1' }, ownerToken),
  );
  assert.ok(
    [200, 201].includes(tableResponse.status),
    `table create failed: ${JSON.stringify(tableResponse.json)}`,
  );
  const floTableId = String(tableResponse.json.table?.id ?? tableResponse.json.id);
  assert.ok(floTableId && floTableId !== 'undefined', 'floCafe table id missing');

  start('bun', ['run', 'src/api.ts'], path.join(ROOT, 'pos-server'), {
    DATABASE_URL: process.env.DATABASE_URL!,
    GUEST_QR_SECRET: process.env.GUEST_QR_SECRET!,
    BASE_DOMAIN: 'localhost',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3311',
  });
  await waitFor('pos-server API', async () => (await http(`${API}/healthz`)).status === 200);

  const slug = `qr${randomBytes(4).toString('hex')}`;
  const [tenant] = await admin`
    insert into tenant (slug, name, settings)
    values (${slug}, 'E2E Store', ${admin.json({
      require_open: false,
      require_confirm: false,
      pos_forward: true,
      order_cooldown_sec: 0,
    })})
    returning id`;
  const [table] = await admin`
    insert into dining_table (tenant_id, label, pos_table_id)
    values (${tenant.id}, 'E2E-1', ${floTableId}) returning id, qr_version`;
  const [menu] = await admin`
    insert into menu_item (tenant_id, name, price_satang, pos_product_id)
    values (${tenant.id}, 'E2E Coffee', 6000, 'e2e-product') returning id`;
  const connectorToken = token();
  await admin`
    insert into staff_user (tenant_id, name, role, token_hash)
    values (${tenant.id}, 'connector', 'connector', ${sha256(connectorToken)})`;

  start('bun', ['run', 'connector/flocafe.ts'], path.join(ROOT, 'pos-server'), {
    POS_URL: API,
    POS_TOKEN: connectorToken,
    POS_DEV_SLUG: slug,
    FLO_URL: FLO_APP,
    FLO_EMAIL: FLO_EMAIL,
    FLO_PASSWORD: FLO_PASSWORD,
  });

  const session = await http(`${API}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-slug': slug, 'x-real-ip': '10.1.1.1' },
    body: JSON.stringify({ token: tableToken(tenant.id, table.id, table.qr_version) }),
  });
  assert.equal(session.status, 200, `session failed: ${JSON.stringify(session.json)}`);
  const device = session.json.device;

  const order = await http(`${API}/api/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-slug': slug,
      'x-real-ip': '10.1.1.1',
      authorization: `Bearer ${device}`,
      'idempotency-key': token(),
    },
    body: JSON.stringify({ items: [{ menuItemId: menu.id, qty: 2 }] }),
  });
  assert.equal(order.status, 201, `order failed: ${JSON.stringify(order.json)}`);

  await waitFor(
    'connector delivery to FloCafe',
    async () => {
      const [row] =
        await admin`select pos_order_id from bill where tenant_id = ${tenant.id} and pos_order_id is not null`;
      return Boolean(row?.pos_order_id);
    },
    20_000,
  );
  const [delivered] = await admin`
    select b.id, b.pos_order_id from bill b
    where b.tenant_id = ${tenant.id} and b.pos_order_id is not null limit 1`;
  console.log('  ok    connector delivered order', delivered.pos_order_id);

  const floOrder = await http(
    `${FLO_MAIN}/api/orders/${encodeURIComponent(delivered.pos_order_id)}`,
    {
      headers: { authorization: `Bearer ${ownerToken}` },
    },
  );
  assert.equal(floOrder.status, 200, JSON.stringify(floOrder.json));
  const detail = floOrder.json.order ?? floOrder.json;
  const productIds = (detail.items ?? []).map((item: any) => String(item.product_id));
  assert.ok(
    productIds.includes('e2e-product'),
    `unexpected FloCafe items: ${JSON.stringify(detail.items)}`,
  );
  const quantity = (detail.items ?? []).reduce(
    (sum: number, item: any) => sum + Number(item.quantity ?? 0),
    0,
  );
  assert.equal(quantity, 2);
  console.log('  ok    FloCafe order has the mapped product and quantity');

  const billResponse = await http(
    `${FLO_MAIN}/api/bills/generate`,
    jsonInit({ order_id: delivered.pos_order_id }, ownerToken),
  );
  assert.ok(
    [200, 201].includes(billResponse.status),
    `bill generate failed: ${JSON.stringify(billResponse.json)}`,
  );
  const floBill = billResponse.json.bill ?? billResponse.json;
  assert.ok(floBill?.id, 'FloCafe bill id missing');
  const amount = Number(floBill.total ?? floBill.balance ?? 0);
  assert.ok(amount > 0, `unexpected bill total: ${JSON.stringify(floBill)}`);

  const paid = await http(
    `${FLO_MAIN}/api/bills/${encodeURIComponent(floBill.id)}/payment`,
    jsonInit({ method: 'cash', amount }, ownerToken),
  );
  assert.equal(paid.status, 200, `payment failed: ${JSON.stringify(paid.json)}`);
  console.log('  ok    FloCafe bill paid');

  await waitFor(
    'cloud bill closed after payment',
    async () => {
      const [row] = await admin`select status, closed_reason from bill where id = ${delivered.id}`;
      return row?.status === 'closed';
    },
    15_000,
  );
  const [closed] = await admin`select status, closed_reason from bill where id = ${delivered.id}`;
  assert.equal(closed.closed_reason, 'paid');

  const after = await http(`${API}/api/orders`, {
    headers: { 'x-tenant-slug': slug, 'x-real-ip': '10.1.1.1', authorization: `Bearer ${device}` },
  });
  assert.equal(after.status, 401, 'guest session must end when the cloud bill closes');
  console.log('  ok    cloud bill closed (paid) and the guest session ended');

  const lowered = await http(
    `${FLO_MAIN}/api/settings/server_app_api_rate_limit_max`,
    jsonInit({ value: '60' }, ownerToken, 'PUT'),
  );
  assert.equal(lowered.status, 200, `lowering the setting failed: ${JSON.stringify(lowered.json)}`);
  let throttled = false;
  for (let attempt = 0; attempt < 65; attempt += 1) {
    const response = await fetch(`${FLO_APP}/api/products`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    if (response.status === 429) {
      throttled = true;
      break;
    }
  }
  assert.ok(throttled, 'lowering the setting must throttle the next requests without a restart');
  console.log('  ok    rate limit setting applies at runtime (server-app 429)');
}

async function stop(): Promise<void> {
  stopping = true;
  for (const child of children.reverse()) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await admin.end({ timeout: 5 }).catch(() => {});
  fs.rmSync(floUserData, { recursive: true, force: true });
}

void main()
  .then(async () => {
    console.log('\ne2e checks passed');
    await stop();
  })
  .catch(async (error) => {
    console.error('\ne2e failed:', error instanceof Error ? error.message : error);
    await stop();
    process.exitCode = 1;
  });
