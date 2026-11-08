/**
 * L1.5 transport simulation: real WebSocket framing between a fake cloud and a fake connector, with
 * no Docker. Proves dedup and ack replay survive duplicate deliveries and a lost ack.
 *
 * Usage: node tests/qr-server/suites/run.cjs sim
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DeliveryEnvelope } from '../../harness/delivery';
import { FakeCloud } from '../../harness/fake-cloud';
import { FakeConnector, PosResult } from '../../harness/fake-connector';

let failures = 0;
let passed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ', name);
  } catch (error) {
    failures += 1;
    console.error('  FAIL ', name, '\n        ', (error as Error).message);
  }
}

const STORE = randomUUID();
const TOKEN = 'test-connector-token';

interface Rig {
  cloud: FakeCloud;
  connector: FakeConnector;
  posCalls: () => number;
}

async function withRig(
  fn: (rig: Rig) => Promise<void>,
  options: { inbox?: Map<string, PosResult>; token?: string } = {},
): Promise<void> {
  const cloud = new FakeCloud({ token: TOKEN, storeId: STORE, ackTimeoutMs: 600 });
  await cloud.listen();
  let created = 0;
  const connector = new FakeConnector({
    url: cloud.url,
    token: TOKEN,
    storeId: STORE,
    inbox: options.inbox,
    pos: async (): Promise<PosResult> => {
      created += 1;
      return { posOrderId: String(500 + created), posItemIds: [String(9000 + created)] };
    },
  });
  await connector.connect();
  await cloud.waitReady();
  try {
    await fn({ cloud, connector, posCalls: () => created });
  } finally {
    connector.close();
    await cloud.close();
  }
}

function makeEnvelope(overrides: Partial<DeliveryEnvelope> = {}): DeliveryEnvelope {
  const now = Date.now();
  return {
    v: 1,
    deliveryId: randomUUID(),
    storeId: STORE,
    orderId: randomUUID(),
    billId: randomUUID(),
    attempt: 1,
    issuedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
    payload: {
      table: { label: 'A1', posTableId: '8' },
      posOrderId: null,
      note: null,
      items: [{ name: 'ข้าวผัด', qty: 2, note: null, posProductId: '12' }],
      knownPosItemIds: [],
    },
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log('delivery transport simulation');
  console.log('='.repeat(60));

  await check('authenticated connector becomes ready and receives an envelope', async () => {
    await withRig(async ({ cloud, connector }) => {
      const envelope = makeEnvelope();
      const ack = await cloud.send(envelope);
      assert.equal(ack.ok, true);
      assert.equal(ack.orderId, envelope.orderId);
      assert.equal(ack.deliveryId, envelope.deliveryId);
      assert.equal(connector.deliveries, 1);
    });
  });

  await check('three deliveries of one order create one POS order', async () => {
    await withRig(async ({ cloud, connector, posCalls }) => {
      const orderId = randomUUID();
      const acks = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        acks.push(await cloud.send(makeEnvelope({ orderId, attempt })));
      }
      assert.equal(posCalls(), 1);
      assert.equal(connector.deliveries, 3);
      assert.equal(new Set(acks.map((ack) => ack.posOrderId)).size, 1);
    });
  });

  await check('a lost ack is replayed from the inbox without a second POS order', async () => {
    await withRig(async ({ cloud, connector, posCalls }) => {
      const orderId = randomUUID();
      connector.dropNextAck = true;
      await assert.rejects(
        () => cloud.send(makeEnvelope({ orderId, attempt: 1 })),
        (error: Error) => error.message === 'ack_timeout',
      );
      const ack = await cloud.send(makeEnvelope({ orderId, attempt: 2 }));
      assert.equal(ack.ok, true);
      assert.equal(posCalls(), 1);
    });
  });

  await check('a restarted connector reuses its persisted inbox', async () => {
    const inbox = new Map<string, PosResult>();
    const orderId = randomUUID();
    await withRig(
      async ({ cloud }) => {
        const ack = await cloud.send(makeEnvelope({ orderId }));
        assert.equal(ack.ok, true);
      },
      { inbox },
    );
    await withRig(
      async ({ cloud, posCalls }) => {
        const ack = await cloud.send(makeEnvelope({ orderId }));
        assert.equal(ack.ok, true);
        assert.equal(posCalls(), 0, 'a restarted connector must not create a second POS order');
      },
      { inbox },
    );
  });

  await check('a stale envelope is refused, not delivered', async () => {
    await withRig(async ({ cloud, posCalls }) => {
      const stale = makeEnvelope({
        issuedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        deadlineAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      });
      await assert.rejects(
        () => cloud.send(stale),
        (error: Error) => error.name === 'DeliveryError' && error.message === 'envelope_expired',
      );
      assert.equal(posCalls(), 0);
    });
  });

  await check('an envelope for another store is refused', async () => {
    await withRig(async ({ cloud, posCalls }) => {
      await assert.rejects(
        () => cloud.send(makeEnvelope({ storeId: randomUUID() })),
        (error: Error) => error.name === 'DeliveryError' && error.message === 'store_mismatch',
      );
      assert.equal(posCalls(), 0);
    });
  });

  await check('a connector without the right token is refused', async () => {
    const cloud = new FakeCloud({ token: TOKEN, storeId: STORE });
    await cloud.listen();
    const connector = new FakeConnector({
      url: cloud.url,
      token: 'wrong-token',
      storeId: STORE,
      pos: async () => ({ posOrderId: '1', posItemIds: [] }),
    });
    try {
      await assert.rejects(() => connector.connect(1_000), /closed_4001/);
    } finally {
      connector.close();
      await cloud.close();
    }
  });

  console.log(`\n${passed}/${passed + failures} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
