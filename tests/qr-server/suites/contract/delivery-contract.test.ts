/**
 * L1.5 delivery contract: envelope/ack shape, state machine, dedup key, recovery predicate and the
 * wake-queue semantics. Pure functions only - no Docker, no Postgres.
 *
 * Usage: node tests/qr-server/suites/run.cjs contract
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DeliveryContractError,
  DeliveryEnvelope,
  assertAckMatches,
  assertDeliverable,
  canTransition,
  dedupKey,
  needsRecovery,
  parseAck,
  parseEnvelope,
  parseWakeEntry,
  wakeKey,
} from '../../harness/delivery';
import { FakeWakeQueue } from '../../harness/fake-redis';

let failures = 0;
let passed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log('  ok   ', name);
  } catch (error) {
    failures += 1;
    console.error('  FAIL ', name, '\n        ', (error as Error).message);
  }
}

function throwsCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof DeliveryContractError,
      `expected DeliveryContractError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected DeliveryContractError(${code})`);
}

const STORE = randomUUID();

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
      items: [{ name: 'ข้าวผัด', qty: 2, note: 'ไม่เผ็ด', posProductId: '12' }],
      knownPosItemIds: [],
    },
    ...overrides,
  };
}

function makeAck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    deliveryId: randomUUID(),
    storeId: STORE,
    orderId: randomUUID(),
    ok: true,
    posOrderId: '501',
    posItemIds: ['9001'],
    ackedAt: new Date().toISOString(),
    ...overrides,
  };
}

console.log('delivery contract');
console.log('='.repeat(60));

console.log('# envelope');
check('accepts a well formed envelope', () => {
  const parsed = parseEnvelope(makeEnvelope());
  assert.equal(parsed.payload.items[0].qty, 2);
  assert.equal(parsed.storeId, STORE);
});
check('rejects an unknown top-level key', () => {
  throwsCode(() => parseEnvelope({ ...makeEnvelope(), extra: true }), 'unknown_key');
});
check('rejects an unknown payload key', () => {
  const envelope = makeEnvelope();
  throwsCode(
    () => parseEnvelope({ ...envelope, payload: { ...envelope.payload, leak: 'customer phone' } }),
    'unknown_key',
  );
});
check('rejects a non-uuid order id', () => {
  throwsCode(() => parseEnvelope(makeEnvelope({ orderId: 'order-1' })), 'invalid_uuid');
});
check('rejects attempt 0', () => {
  throwsCode(() => parseEnvelope(makeEnvelope({ attempt: 0 })), 'bad_attempt');
});
check('rejects a deadline before the issue time', () => {
  const envelope = makeEnvelope();
  throwsCode(
    () =>
      parseEnvelope({
        ...envelope,
        deadlineAt: new Date(Date.parse(envelope.issuedAt) - 1).toISOString(),
      }),
    'bad_deadline',
  );
});
check('rejects an empty item list', () => {
  const envelope = makeEnvelope();
  throwsCode(
    () => parseEnvelope({ ...envelope, payload: { ...envelope.payload, items: [] } }),
    'bad_items',
  );
});
check('rejects qty 0 and 21', () => {
  const envelope = makeEnvelope();
  const item = envelope.payload.items[0];
  throwsCode(
    () =>
      parseEnvelope({
        ...envelope,
        payload: { ...envelope.payload, items: [{ ...item, qty: 0 }] },
      }),
    'bad_qty',
  );
  throwsCode(
    () =>
      parseEnvelope({
        ...envelope,
        payload: { ...envelope.payload, items: [{ ...item, qty: 21 }] },
      }),
    'bad_qty',
  );
});
check('rejects more than 30 lines', () => {
  const envelope = makeEnvelope();
  const item = envelope.payload.items[0];
  const items = Array.from({ length: 31 }, () => ({ ...item }));
  throwsCode(
    () => parseEnvelope({ ...envelope, payload: { ...envelope.payload, items } }),
    'too_many_items',
  );
});
check('rejects an item without posProductId', () => {
  const envelope = makeEnvelope();
  throwsCode(
    () =>
      parseEnvelope({
        ...envelope,
        payload: { ...envelope.payload, items: [{ name: 'x', qty: 1, note: null }] },
      }),
    'invalid_type',
  );
});
check('rejects a 201 character note', () => {
  const envelope = makeEnvelope();
  throwsCode(
    () => parseEnvelope({ ...envelope, payload: { ...envelope.payload, note: 'x'.repeat(201) } }),
    'too_long',
  );
});

console.log('# ack');
check('accepts a successful ack', () => {
  const ack = parseAck(makeAck());
  assert.equal(ack.ok, true);
  assert.equal(ack.posOrderId, '501');
});
check('rejects success without posOrderId', () => {
  throwsCode(() => parseAck(makeAck({ posOrderId: undefined })), 'missing_pos_order');
});
check('rejects failure without a code', () => {
  throwsCode(() => parseAck(makeAck({ ok: false, posOrderId: undefined })), 'invalid_type');
});
check('rejects a failure that carries posOrderId', () => {
  throwsCode(
    () => parseAck(makeAck({ ok: false, code: 'pos_rejected', posOrderId: '501' })),
    'unexpected_pos_order',
  );
});
check('rejects a success that carries a code', () => {
  throwsCode(() => parseAck(makeAck({ code: 'ok' })), 'unexpected_code');
});

console.log('# correlation and timing');
check('detects ack/envelope mismatches', () => {
  const envelope = makeEnvelope();
  const ack = parseAck(
    makeAck({
      deliveryId: envelope.deliveryId,
      orderId: envelope.orderId,
      storeId: envelope.storeId,
    }),
  );
  assertAckMatches(envelope, ack);
  throwsCode(
    () => assertAckMatches(envelope, { ...ack, deliveryId: randomUUID() }),
    'ack_delivery_mismatch',
  );
  throwsCode(
    () => assertAckMatches(envelope, { ...ack, orderId: randomUUID() }),
    'ack_order_mismatch',
  );
  throwsCode(
    () => assertAckMatches(envelope, { ...ack, storeId: randomUUID() }),
    'ack_store_mismatch',
  );
});
check('rejects an ack after the deadline', () => {
  const envelope = makeEnvelope();
  const ack = parseAck(
    makeAck({
      deliveryId: envelope.deliveryId,
      orderId: envelope.orderId,
      storeId: envelope.storeId,
    }),
  );
  const late = Date.parse(envelope.deadlineAt) + 3 * 60_000;
  throwsCode(() => assertAckMatches(envelope, ack, late), 'ack_too_late');
});
check('rejects an ack stamped in the future', () => {
  const envelope = makeEnvelope();
  const ack = parseAck(
    makeAck({
      deliveryId: envelope.deliveryId,
      orderId: envelope.orderId,
      storeId: envelope.storeId,
      ackedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  );
  throwsCode(() => assertAckMatches(envelope, ack), 'ack_from_future');
});
check('connector refuses a foreign store or an expired envelope', () => {
  const envelope = makeEnvelope();
  throwsCode(() => assertDeliverable(envelope, randomUUID()), 'store_mismatch');
  const stale = makeEnvelope({
    issuedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    deadlineAt: new Date(Date.now() - 15 * 60_000).toISOString(),
  });
  throwsCode(() => assertDeliverable(stale, STORE), 'envelope_expired');
});

console.log('# state machine');
check('allows only forward transitions', () => {
  assert.equal(canTransition('pending', 'queued'), true);
  assert.equal(canTransition('queued', 'delivering'), true);
  assert.equal(canTransition('delivering', 'acked'), true);
  assert.equal(canTransition('delivering', 'queued'), true);
  assert.equal(canTransition('pending', 'acked'), false);
  assert.equal(canTransition('acked', 'queued'), false);
  assert.equal(canTransition('failed', 'queued'), false);
});

console.log('# dedup and wake-up');
check('dedup key is per store', () => {
  const orderId = randomUUID();
  assert.equal(dedupKey(STORE, orderId), dedupKey(STORE, orderId));
  assert.notEqual(dedupKey(STORE, orderId), dedupKey(randomUUID(), orderId));
});
check('wake key never carries the order', () => {
  assert.equal(wakeKey(STORE), `qr:wake:${STORE}`);
});
check('wake entry carries only the delivery id', () => {
  const deliveryId = randomUUID();
  assert.deepEqual(parseWakeEntry({ deliveryId }), { deliveryId });
  throwsCode(() => parseWakeEntry({ deliveryId, orderId: randomUUID() }), 'unknown_key');
});

console.log('# recovery scan');
check('recovers stale pending/queued rows only', () => {
  const now = Date.now();
  assert.equal(
    needsRecovery({ state: 'pending', updatedAt: new Date(now - 5_000).toISOString() }, now),
    false,
  );
  assert.equal(
    needsRecovery({ state: 'pending', updatedAt: new Date(now - 60_000).toISOString() }, now),
    true,
  );
  assert.equal(
    needsRecovery({ state: 'queued', updatedAt: new Date(now - 60_000).toISOString() }, now),
    true,
  );
  assert.equal(
    needsRecovery({ state: 'acked', updatedAt: new Date(now - 60_000).toISOString() }, now),
    false,
  );
  assert.equal(
    needsRecovery({ state: 'failed', updatedAt: new Date(now - 60_000).toISOString() }, now),
    false,
  );
});
check('recovers a delivering row only after its lease expires', () => {
  const now = Date.now();
  assert.equal(
    needsRecovery(
      {
        state: 'delivering',
        updatedAt: new Date(now).toISOString(),
        leaseUntil: new Date(now + 30_000).toISOString(),
      },
      now,
    ),
    false,
  );
  assert.equal(
    needsRecovery(
      {
        state: 'delivering',
        updatedAt: new Date(now).toISOString(),
        leaseUntil: new Date(now - 1).toISOString(),
      },
      now,
    ),
    true,
  );
});

console.log('# wake queue');
check('claim hands out queued work and keeps duplicates', () => {
  const queue = new FakeWakeQueue();
  const deliveryId = randomUUID();
  queue.enqueue(deliveryId);
  queue.enqueue(deliveryId);
  assert.equal(queue.claim(1_000, 0)?.deliveryId, deliveryId);
  assert.equal(queue.claim(1_000, 0)?.deliveryId, deliveryId);
  assert.equal(queue.claim(1_000, 0), null);
});
check('an expired lease is claimable again', () => {
  const queue = new FakeWakeQueue();
  queue.enqueue(randomUUID());
  const first = queue.claim(1_000, 0);
  assert.ok(first);
  assert.equal(queue.claim(1_000, 500), null);
  const second = queue.claim(1_000, 2_000);
  assert.equal(second?.seq, first?.seq);
  assert.equal(second?.attempts, 2);
  queue.ack(second!);
  assert.equal(queue.depth(2_000), 0);
});

console.log(`\n${passed}/${passed + failures} checks passed`);
if (failures > 0) process.exitCode = 1;
