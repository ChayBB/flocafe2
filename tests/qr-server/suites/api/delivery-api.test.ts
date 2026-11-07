/**
 * L2 API integration against a real Postgres and a running Bun API:
 * order commit invariants, idempotency, the connector ack path, ACK spoofing and RLS.
 *
 * Requires: DATABASE_URL, ADMIN_DATABASE_URL, GUEST_QR_SECRET and a running API at POS_API_URL.
 * Usage: node tests/qr-server/suites/run.cjs api
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { adminDb, appDb, posApiUrl, tableToken } from '../../harness/db';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ', name);
  } catch (error) {
    failed += 1;
    console.error('  FAIL ', name, '\n        ', (error as Error).message);
  }
}

const API = posApiUrl();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(18).toString('base64url');
let ipSeed = 0;
const nextIp = () => `10.${(ipSeed >> 8) & 255}.${ipSeed++ & 255}.9`;

const slug = `qr${randomBytes(4).toString('hex')}`;
const admin = adminDb();
const app = appDb();

interface CallOptions {
  slug?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Result {
  status: number;
  json: any;
  text: string;
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Result> {
  const headers: Record<string, string> = {
    'x-tenant-slug': options.slug ?? slug,
    'x-real-ip': nextIp(),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...options.headers,
  };
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

interface Store {
  id: string;
  slug: string;
  tableId: string;
  qrVersion: number;
  menuIds: string[];
  connectorToken: string;
  managerToken: string;
}

async function seedStore(
  storeSlug: string,
  settings: Record<string, unknown> = {},
): Promise<Store> {
  const [tenant] = await admin`
    insert into tenant (slug, name, settings)
    values (${storeSlug}, 'Harness', ${admin.json({
      require_open: false,
      require_confirm: false,
      pos_forward: true,
      order_cooldown_sec: 0,
      ...settings,
    })})
    returning id`;
  const [table] = await admin`
    insert into dining_table (tenant_id, label, pos_table_id)
    values (${tenant.id}, 'A1', '8') returning id, qr_version`;
  const [menuA] = await admin`
    insert into menu_item (tenant_id, name, price_satang, pos_product_id)
    values (${tenant.id}, 'ข้าวผัด', 6000, '12') returning id`;
  const [menuB] = await admin`
    insert into menu_item (tenant_id, name, price_satang, pos_product_id)
    values (${tenant.id}, 'ต้มยำ', 5000, '34') returning id`;

  const connectorToken = token();
  const managerToken = token();
  await admin`
    insert into staff_user (tenant_id, name, role, token_hash)
    values (${tenant.id}, 'connector', 'connector', ${sha256(connectorToken)})`;
  await admin`
    insert into staff_user (tenant_id, name, role, token_hash)
    values (${tenant.id}, 'manager', 'manager', ${sha256(managerToken)})`;

  return {
    id: tenant.id,
    slug: storeSlug,
    tableId: table.id,
    qrVersion: table.qr_version,
    menuIds: [menuA.id, menuB.id],
    connectorToken,
    managerToken,
  };
}

async function guestDevice(store: Store): Promise<string> {
  const response = await call('POST', '/api/session', {
    slug: store.slug,
    body: { token: tableToken(store.id, store.tableId, store.qrVersion) },
  });
  assert.equal(response.status, 200, `session failed: ${response.text}`);
  return response.json.device;
}

const lineItems = (store: Store) => [
  { menuItemId: store.menuIds[0], qty: 2, note: 'ไม่เผ็ด' },
  { menuItemId: store.menuIds[1], qty: 1 },
];

function placeOrder(
  store: Store,
  device: string,
  key: string,
  items = lineItems(store),
): Promise<Result> {
  return call('POST', '/api/orders', {
    slug: store.slug,
    token: device,
    body: { items },
    headers: { 'idempotency-key': key },
  });
}

async function main(): Promise<void> {
  console.log('delivery api (Postgres + Bun API)');
  console.log('='.repeat(60));

  await check('API is reachable and healthy', async () => {
    const health = await fetch(`${API}/healthz`);
    assert.equal(health.status, 200);
  });

  const store = await seedStore(slug);
  const device = await guestDevice(store);
  const firstKey = token();

  await check('one order commits orders, items, outbox and a pending delivery row', async () => {
    const created = await placeOrder(store, device, firstKey);
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.order.total_satang, 2 * 6000 + 5000);

    const [row] = await admin`
      select o.id, o.total_satang,
        (select count(*)::int from order_item i where i.order_id = o.id) as lines
      from orders o where o.tenant_id = ${store.id} and o.idempotency_key = ${firstKey}`;
    assert.equal(row.lines, 2);
    assert.equal(row.total_satang, 17000);

    const [outbox] = await admin`
      select payload from outbox
      where tenant_id = ${store.id} and topic = 'order.created' and payload->>'orderId' = ${row.id}`;
    assert.ok(outbox, 'order.created must be enqueued in the same transaction');

    const [forward] = await admin`
      select status from pos_forward where tenant_id = ${store.id} and order_id = ${row.id}`;
    assert.equal(forward.status, 'pending');
  });

  await check('replaying the same key returns the same order', async () => {
    const [before] =
      await admin`select count(*)::int as n from orders where tenant_id = ${store.id}`;
    const replay = await placeOrder(store, device, firstKey);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.replayed, true);
    const [after] =
      await admin`select count(*)::int as n from orders where tenant_id = ${store.id}`;
    assert.equal(after.n, before.n);
  });

  await check('reusing the key with a different body is rejected', async () => {
    const changed = await placeOrder(store, device, firstKey, [
      { menuItemId: store.menuIds[0], qty: 1 },
    ]);
    assert.equal(changed.status, 422);
    assert.equal(changed.json.error, 'idempotency_mismatch');
  });

  await check('ten concurrent submissions of one key create one order', async () => {
    const key = token();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => placeOrder(store, device, key)),
    );
    const accepted = responses.filter(
      (response) => response.status === 201 || response.status === 200,
    );
    assert.equal(accepted.length, 10, JSON.stringify(responses.map((r) => r.status)));
    const [row] = await admin`
      select count(*)::int as n from orders where tenant_id = ${store.id} and idempotency_key = ${key}`;
    assert.equal(row.n, 1);
  });

  await check('the connector claims the job and an ack marks the bill', async () => {
    const jobs = await call('GET', '/api/connector/jobs', {
      slug: store.slug,
      token: store.connectorToken,
    });
    assert.equal(jobs.status, 200, jobs.text);
    const job = jobs.json.jobs[0];
    assert.ok(job, 'expected a pending job');

    const acked = await call('POST', `/api/connector/jobs/${job.jobId}/result`, {
      slug: store.slug,
      token: store.connectorToken,
      body: { ok: true, posOrderId: '501', posItemIds: ['9001', '9002'] },
    });
    assert.equal(acked.status, 200, acked.text);

    const [forward] =
      await admin`select status, pos_item_ids from pos_forward where id = ${job.jobId}`;
    assert.equal(forward.status, 'sent');
    assert.deepEqual(forward.pos_item_ids, ['9001', '9002']);

    const [bill] = await admin`select pos_order_id from bill where id = ${job.billId}`;
    assert.equal(bill.pos_order_id, '501');
  });

  await check('a repeated ack is idempotent', async () => {
    const [done] = await admin`
      select id from pos_forward where tenant_id = ${store.id} and status = 'sent' order by id limit 1`;
    const replay = await call('POST', `/api/connector/jobs/${done.id}/result`, {
      slug: store.slug,
      token: store.connectorToken,
      body: { ok: true, posOrderId: '999' },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.replayed, true);
    const [bill] = await admin`
      select b.pos_order_id from bill b join pos_forward f on f.bill_id = b.id where f.id = ${done.id}`;
    assert.equal(bill.pos_order_id, '501', 'a replay must not overwrite the stored POS order');
  });

  await check('a connector cannot ack another store job', async () => {
    const otherSlug = `qr${randomBytes(4).toString('hex')}`;
    const other = await seedStore(otherSlug);
    const otherDevice = await guestDevice(other);
    const created = await placeOrder(other, otherDevice, token());
    assert.equal(created.status, 201, created.text);

    const otherJobs = await call('GET', '/api/connector/jobs', {
      slug: other.slug,
      token: other.connectorToken,
    });
    const otherJob = otherJobs.json.jobs[0];
    assert.ok(otherJob, 'expected a pending job for the other store');

    const spoof = await call('POST', `/api/connector/jobs/${otherJob.jobId}/result`, {
      slug: store.slug,
      token: store.connectorToken,
      body: { ok: true, posOrderId: '666' },
    });
    assert.equal(spoof.status, 404, spoof.text);
  });

  await check('roles cannot call each other endpoints', async () => {
    const connectorOnStaff = await call('GET', '/api/staff/orders', {
      slug: store.slug,
      token: store.connectorToken,
    });
    assert.equal(connectorOnStaff.status, 403);
    const managerOnConnector = await call('GET', '/api/connector/jobs', {
      slug: store.slug,
      token: store.managerToken,
    });
    assert.equal(managerOnConnector.status, 403);
    const anonymous = await call('GET', '/api/connector/jobs', { slug: store.slug });
    assert.equal(anonymous.status, 401);
  });

  await check('outbox payloads stay on the id allowlist', async () => {
    const [{ n }] = await admin`
      select count(*)::int as n from outbox o, jsonb_object_keys(o.payload) k
      where o.tenant_id = ${store.id}
        and k not in ('orderId','billId','tableId','epoch','action','from','to','by',
                      'cancelledOrderIds','reason','movedToBillId','toTableId','toBillId','fromBillId')`;
    assert.equal(n, 0);
  });

  await check('RLS hides every tenant row without app.tenant', async () => {
    const [orders] = await app`select count(*)::int as n from orders`;
    const [tables] = await app`select count(*)::int as n from dining_table`;
    assert.equal(orders.n, 0);
    assert.equal(tables.n, 0);
  });

  await check('a guest device from one store is rejected on another store', async () => {
    const otherSlug = `qr${randomBytes(4).toString('hex')}`;
    const other = await seedStore(otherSlug);
    const otherDevice = await guestDevice(other);
    const cross = await call('GET', '/api/orders', { slug: store.slug, token: otherDevice });
    assert.equal(cross.status, 401, cross.text);
  });

  await check('an oversized body is refused before it reaches the handler', async () => {
    const huge = 'x'.repeat(200 * 1024);
    const response = await fetch(`${API}/api/orders`, {
      method: 'POST',
      headers: {
        'x-tenant-slug': store.slug,
        'x-real-ip': nextIp(),
        authorization: `Bearer ${device}`,
        'content-type': 'application/json',
        'idempotency-key': token(),
      },
      body: JSON.stringify({ items: lineItems(store), note: huge }),
    });
    assert.equal(response.status, 413);
  });

  await check('a transient ack failure keeps the job pending and leased', async () => {
    const fresh = await seedStore(`qr${randomBytes(4).toString('hex')}`);
    const freshDevice = await guestDevice(fresh);
    await placeOrder(fresh, freshDevice, token());
    const jobs = await call('GET', '/api/connector/jobs', {
      slug: fresh.slug,
      token: fresh.connectorToken,
    });
    const job = jobs.json.jobs[0];
    assert.ok(job, 'expected a pending job');

    const failed = await call('POST', `/api/connector/jobs/${job.jobId}/result`, {
      slug: fresh.slug,
      token: fresh.connectorToken,
      body: { ok: false, error: 'flocafe 500: upstream' },
    });
    assert.equal(failed.status, 200, failed.text);

    const [row] = await admin`
      select status, attempts, last_error, lease_until from pos_forward where id = ${job.jobId}`;
    assert.equal(row.status, 'pending');
    assert.ok(row.attempts >= 1);
    assert.match(row.last_error, /upstream/);
    assert.ok(row.lease_until, 'a failed attempt keeps the lease so it is retried after backoff');
    assert.ok(new Date(row.lease_until).getTime() > Date.now());

    const again = await call('GET', '/api/connector/jobs', {
      slug: fresh.slug,
      token: fresh.connectorToken,
    });
    assert.equal(
      again.json.jobs.some((candidate: any) => candidate.jobId === job.jobId),
      false,
      'a leased job must not be claimed again straight away',
    );
  });

  await check('a permanent ack failure marks the job failed and stops dispatching', async () => {
    const fresh = await seedStore(`qr${randomBytes(4).toString('hex')}`);
    const freshDevice = await guestDevice(fresh);
    await placeOrder(fresh, freshDevice, token());
    const jobs = await call('GET', '/api/connector/jobs', {
      slug: fresh.slug,
      token: fresh.connectorToken,
    });
    const job = jobs.json.jobs[0];
    assert.ok(job);

    const failed = await call('POST', `/api/connector/jobs/${job.jobId}/result`, {
      slug: fresh.slug,
      token: fresh.connectorToken,
      body: { ok: false, permanent: true, error: 'table not mapped' },
    });
    assert.equal(failed.status, 200, failed.text);

    const [row] = await admin`select status from pos_forward where id = ${job.jobId}`;
    assert.equal(row.status, 'failed');
    const after = await call('GET', '/api/connector/jobs', {
      slug: fresh.slug,
      token: fresh.connectorToken,
    });
    assert.equal(
      after.json.jobs.some((candidate: any) => candidate.jobId === job.jobId),
      false,
    );
  });

  await check(
    'two orders on one bill are delivered in order and append to the same POS order',
    async () => {
      const fresh = await seedStore(`qr${randomBytes(4).toString('hex')}`);
      const freshDevice = await guestDevice(fresh);
      await placeOrder(fresh, freshDevice, token());
      await placeOrder(fresh, freshDevice, token(), [{ menuItemId: fresh.menuIds[1], qty: 1 }]);

      const first = await call('GET', '/api/connector/jobs', {
        slug: fresh.slug,
        token: fresh.connectorToken,
      });
      assert.equal(first.json.jobs.length, 1, 'only the oldest pending job of a bill is claimable');

      const acked = await call('POST', `/api/connector/jobs/${first.json.jobs[0].jobId}/result`, {
        slug: fresh.slug,
        token: fresh.connectorToken,
        body: { ok: true, posOrderId: '777', posItemIds: ['1'] },
      });
      assert.equal(acked.status, 200, acked.text);

      const second = await call('GET', '/api/connector/jobs', {
        slug: fresh.slug,
        token: fresh.connectorToken,
      });
      assert.equal(second.json.jobs.length, 1);
      assert.equal(
        second.json.jobs[0].posOrderId,
        '777',
        'the next order appends to the stored POS order',
      );
    },
  );

  await check('the outbox drains and leaves no pending order.created rows', async () => {
    let pending = Number.POSITIVE_INFINITY;
    for (let pass = 0; pass < 10 && pending !== 0; pass += 1) {
      const result = spawnSync(
        'bun',
        [
          '-e',
          "import { tick } from './src/worker.ts'; import { sql } from './src/db.ts';" +
            " console.log('drained', await tick()); await sql.end({ timeout: 2 });",
        ],
        {
          cwd: path.join(ROOT, 'pos-server'),
          env: { ...process.env },
          stdio: 'inherit',
        },
      );
      assert.equal(result.status, 0, 'worker tick must succeed');
      const [row] = await admin`
        select count(*)::int as n from outbox
        where processed_at is null and topic = 'order.created'
          and tenant_id in (select id from tenant where slug like 'qr%')`;
      pending = row.n;
    }
    assert.equal(pending, 0);
  });

  await check('delivery rows stay consistent for every seeded order', async () => {
    const [bad] = await admin`
      select count(*)::int as n from pos_forward f join bill b on b.id = f.bill_id
      where f.status = 'sent' and b.pos_order_id is null`;
    assert.equal(bad.n, 0);
    const [missing] = await admin`
      select count(*)::int as n from orders o left join pos_forward f on f.order_id = o.id
      where f.id is null and o.tenant_id in (select id from tenant where slug like 'qr%')`;
    assert.equal(missing.n, 0);
  });

  console.log(`\n${passed}/${passed + failed} checks passed`);
  await admin.end({ timeout: 5 });
  await app.end({ timeout: 5 });
  if (failed > 0) process.exitCode = 1;
}

void main().catch(async (error) => {
  console.error(error);
  await admin.end({ timeout: 5 }).catch(() => {});
  await app.end({ timeout: 5 }).catch(() => {});
  process.exitCode = 1;
});
