/**
 * Delivery contract shared by the harness, the fakes and (later) the real dispatcher/worker/connector.
 *
 * The envelope is metadata plus a payload snapshot the worker composed from Postgres; Redis only ever
 * carries a wake-up id. Everything that crosses the wire is validated here first.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_ITEMS = 30;
export const MAX_QTY = 20;
export const MAX_NOTE = 200;
export const CLOCK_SKEW_MS = 2 * 60_000;
export const ENVELOPE_TTL_MS = 10 * 60_000;

export const STATES = ['pending', 'queued', 'delivering', 'acked', 'failed'] as const;
export type DeliveryState = (typeof STATES)[number];

export const TERMINAL_STATES: readonly DeliveryState[] = ['acked', 'failed'];

const TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  pending: ['queued', 'failed'],
  queued: ['delivering', 'failed'],
  delivering: ['acked', 'failed', 'queued'],
  acked: [],
  failed: [],
};

export class DeliveryContractError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryContractError';
  }
}

export interface DeliveryItem {
  name: string;
  qty: number;
  note?: string | null;
  posProductId: string | null;
}

export interface DeliveryPayload {
  table: { label: string | null; posTableId: string | null };
  posOrderId: string | null;
  note: string | null;
  items: DeliveryItem[];
  knownPosItemIds: string[];
}

export interface DeliveryEnvelope {
  v: number;
  deliveryId: string;
  storeId: string;
  orderId: string;
  billId: string;
  attempt: number;
  issuedAt: string;
  deadlineAt: string;
  payload: DeliveryPayload;
}

export interface DeliveryAck {
  v: number;
  deliveryId: string;
  storeId: string;
  orderId: string;
  ok: boolean;
  posOrderId?: string;
  posItemIds?: string[];
  code?: string;
  permanent?: boolean;
  ackedAt: string;
}

export type ServerMessage =
  | { type: 'ready'; storeId: string; serverTime: string }
  | { type: 'deliver'; envelope: DeliveryEnvelope }
  | { type: 'error'; deliveryId?: string; code: string; message?: string }
  | { type: 'ping'; at: string };

export type ClientMessage =
  | { type: 'ack'; ack: DeliveryAck }
  | { type: 'error'; deliveryId?: string; code: string; message?: string }
  | { type: 'pong'; at: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new DeliveryContractError('unknown_key', `${label}: unknown key ${key}`);
  }
}

function requireString(
  value: unknown,
  label: string,
  opts: { max?: number; min?: number } = {},
): string {
  if (typeof value !== 'string')
    throw new DeliveryContractError('invalid_type', `${label} must be a string`);
  if (opts.min !== undefined && value.length < opts.min)
    throw new DeliveryContractError('too_short', `${label} is shorter than ${opts.min}`);
  if (opts.max !== undefined && value.length > opts.max)
    throw new DeliveryContractError('too_long', `${label} is longer than ${opts.max}`);
  return value;
}

function requireUuid(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!UUID_RE.test(text))
    throw new DeliveryContractError('invalid_uuid', `${label} is not a UUID`);
  return text;
}

function requireIso(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!Number.isFinite(Date.parse(text)))
    throw new DeliveryContractError('invalid_time', `${label} is not a timestamp`);
  return text;
}

export function dedupKey(storeId: string, orderId: string): string {
  return `${storeId}:${orderId}`;
}

/** Redis carries wake-ups only; the key and the value are both allowed to hold ids and nothing else. */
export function wakeKey(storeId: string): string {
  return `qr:wake:${storeId}`;
}

export const WAKE_ENTRY_KEYS = ['deliveryId'] as const;

export function parseWakeEntry(raw: unknown): { deliveryId: string } {
  if (!isObject(raw))
    throw new DeliveryContractError('invalid_type', 'wake entry must be an object');
  requireKeys(raw, [...WAKE_ENTRY_KEYS], 'wake entry');
  return { deliveryId: requireUuid(raw.deliveryId, 'wake entry.deliveryId') };
}

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: DeliveryState, to: DeliveryState): void {
  if (!canTransition(from, to))
    throw new DeliveryContractError('invalid_transition', `${from} -> ${to} is not allowed`);
}

export function isTerminal(state: DeliveryState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function parseEnvelope(raw: unknown): DeliveryEnvelope {
  if (!isObject(raw)) throw new DeliveryContractError('invalid_type', 'envelope must be an object');
  requireKeys(
    raw,
    [
      'v',
      'deliveryId',
      'storeId',
      'orderId',
      'billId',
      'attempt',
      'issuedAt',
      'deadlineAt',
      'payload',
    ],
    'envelope',
  );
  if (raw.v !== PROTOCOL_VERSION)
    throw new DeliveryContractError('bad_version', 'unsupported protocol version');
  const attempt = raw.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1)
    throw new DeliveryContractError('bad_attempt', 'attempt must be an integer >= 1');
  const issuedAt = requireIso(raw.issuedAt, 'envelope.issuedAt');
  const deadlineAt = requireIso(raw.deadlineAt, 'envelope.deadlineAt');
  if (Date.parse(deadlineAt) <= Date.parse(issuedAt))
    throw new DeliveryContractError('bad_deadline', 'deadlineAt must be after issuedAt');

  const payload = parsePayload(raw.payload);
  return {
    v: PROTOCOL_VERSION,
    deliveryId: requireUuid(raw.deliveryId, 'envelope.deliveryId'),
    storeId: requireUuid(raw.storeId, 'envelope.storeId'),
    orderId: requireUuid(raw.orderId, 'envelope.orderId'),
    billId: requireUuid(raw.billId, 'envelope.billId'),
    attempt,
    issuedAt,
    deadlineAt,
    payload,
  };
}

function parsePayload(raw: unknown): DeliveryPayload {
  if (!isObject(raw)) throw new DeliveryContractError('invalid_type', 'payload must be an object');
  requireKeys(raw, ['table', 'posOrderId', 'note', 'items', 'knownPosItemIds'], 'payload');
  const table = raw.table;
  if (!isObject(table))
    throw new DeliveryContractError('invalid_type', 'payload.table must be an object');
  requireKeys(table, ['label', 'posTableId'], 'payload.table');
  if (table.label !== null) requireString(table.label, 'payload.table.label', { max: 100 });
  if (table.posTableId !== null)
    requireString(table.posTableId, 'payload.table.posTableId', { max: 64 });
  if (raw.posOrderId !== null) requireString(raw.posOrderId, 'payload.posOrderId', { max: 64 });
  if (raw.note !== null) requireString(raw.note, 'payload.note', { max: MAX_NOTE });

  if (!Array.isArray(raw.items) || raw.items.length === 0)
    throw new DeliveryContractError('bad_items', 'payload.items must be a non-empty array');
  if (raw.items.length > MAX_ITEMS)
    throw new DeliveryContractError('too_many_items', 'payload.items exceeds 30');
  const items = raw.items.map((item, index) => parseItem(item, index));

  if (!Array.isArray(raw.knownPosItemIds))
    throw new DeliveryContractError('bad_known_ids', 'knownPosItemIds must be an array');
  const known = raw.knownPosItemIds.map((id, index) =>
    requireString(id, `payload.knownPosItemIds[${index}]`, { max: 64 }),
  );

  return {
    table: {
      label: table.label as string | null,
      posTableId: table.posTableId as string | null,
    },
    posOrderId: raw.posOrderId as string | null,
    note: raw.note as string | null,
    items,
    knownPosItemIds: known,
  };
}

function parseItem(raw: unknown, index: number): DeliveryItem {
  if (!isObject(raw))
    throw new DeliveryContractError('invalid_type', `payload.items[${index}] must be an object`);
  requireKeys(raw, ['name', 'qty', 'note', 'posProductId'], `payload.items[${index}]`);
  const qty = raw.qty;
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY)
    throw new DeliveryContractError('bad_qty', `payload.items[${index}].qty must be 1..${MAX_QTY}`);
  return {
    name: requireString(raw.name, `payload.items[${index}].name`, { max: 200 }),
    qty,
    note:
      raw.note === null || raw.note === undefined
        ? null
        : requireString(raw.note, `payload.items[${index}].note`, { max: MAX_NOTE }),
    posProductId:
      raw.posProductId === null
        ? null
        : requireString(raw.posProductId, `payload.items[${index}].posProductId`, { max: 64 }),
  };
}

export function parseAck(raw: unknown): DeliveryAck {
  if (!isObject(raw)) throw new DeliveryContractError('invalid_type', 'ack must be an object');
  requireKeys(
    raw,
    [
      'v',
      'deliveryId',
      'storeId',
      'orderId',
      'ok',
      'posOrderId',
      'posItemIds',
      'code',
      'permanent',
      'ackedAt',
    ],
    'ack',
  );
  if (raw.v !== PROTOCOL_VERSION)
    throw new DeliveryContractError('bad_version', 'unsupported protocol version');
  if (typeof raw.ok !== 'boolean')
    throw new DeliveryContractError('invalid_type', 'ack.ok must be a boolean');
  if (raw.ok) {
    if (raw.posOrderId === undefined)
      throw new DeliveryContractError('missing_pos_order', 'a successful ack needs posOrderId');
    requireString(raw.posOrderId, 'ack.posOrderId', { max: 64 });
    if (raw.code !== undefined)
      throw new DeliveryContractError('unexpected_code', 'a successful ack has no error code');
  } else {
    requireString(raw.code, 'ack.code', { max: 64 });
    if (raw.posOrderId !== undefined)
      throw new DeliveryContractError('unexpected_pos_order', 'a failed ack has no posOrderId');
  }
  if (raw.posItemIds !== undefined) {
    if (!Array.isArray(raw.posItemIds))
      throw new DeliveryContractError('invalid_type', 'ack.posItemIds must be an array');
    if (raw.posItemIds.length > 200)
      throw new DeliveryContractError('too_many_ids', 'ack.posItemIds exceeds 200');
    raw.posItemIds.forEach((id, index) =>
      requireString(id, `ack.posItemIds[${index}]`, { max: 64 }),
    );
  }
  if (raw.permanent !== undefined && typeof raw.permanent !== 'boolean')
    throw new DeliveryContractError('invalid_type', 'ack.permanent must be a boolean');
  return {
    v: PROTOCOL_VERSION,
    deliveryId: requireUuid(raw.deliveryId, 'ack.deliveryId'),
    storeId: requireUuid(raw.storeId, 'ack.storeId'),
    orderId: requireUuid(raw.orderId, 'ack.orderId'),
    ok: raw.ok,
    posOrderId: raw.posOrderId as string | undefined,
    posItemIds: raw.posItemIds as string[] | undefined,
    code: raw.code as string | undefined,
    permanent: raw.permanent as boolean | undefined,
    ackedAt: requireIso(raw.ackedAt, 'ack.ackedAt'),
  };
}

/** The cloud side: an ack must belong to this envelope and arrive before its deadline plus skew. */
export function assertAckMatches(
  envelope: DeliveryEnvelope,
  ack: DeliveryAck,
  now: number = Date.now(),
): void {
  if (ack.deliveryId !== envelope.deliveryId)
    throw new DeliveryContractError('ack_delivery_mismatch', 'ack.deliveryId does not match');
  if (ack.orderId !== envelope.orderId)
    throw new DeliveryContractError('ack_order_mismatch', 'ack.orderId does not match');
  if (ack.storeId !== envelope.storeId)
    throw new DeliveryContractError('ack_store_mismatch', 'ack.storeId does not match');
  if (ack.ackedAt && Date.parse(ack.ackedAt) > now + CLOCK_SKEW_MS)
    throw new DeliveryContractError('ack_from_future', 'ack.ackedAt is in the future');
  if (now > Date.parse(envelope.deadlineAt) + CLOCK_SKEW_MS)
    throw new DeliveryContractError('ack_too_late', 'ack arrived after the deadline');
}

/** Connector side: refuse envelopes that are stale or addressed elsewhere. */
export function assertDeliverable(
  envelope: DeliveryEnvelope,
  storeId: string,
  now: number = Date.now(),
): void {
  if (envelope.storeId !== storeId)
    throw new DeliveryContractError('store_mismatch', 'envelope belongs to another store');
  if (now - Date.parse(envelope.issuedAt) > ENVELOPE_TTL_MS + CLOCK_SKEW_MS)
    throw new DeliveryContractError('envelope_expired', 'envelope is older than its ttl');
  const deadline = Date.parse(envelope.deadlineAt);
  if (Number.isFinite(deadline) && now > deadline + CLOCK_SKEW_MS)
    throw new DeliveryContractError('envelope_expired', 'envelope passed its deadline');
}

export interface DeliveryRow {
  state: DeliveryState;
  updatedAt: string;
  leaseUntil?: string | null;
}

/** Recovery scan: only rows that are stale, or whose lease expired, may be woken up again. */
export function needsRecovery(
  row: DeliveryRow,
  now: number = Date.now(),
  graceMs = 30_000,
): boolean {
  if (isTerminal(row.state)) return false;
  if (row.state === 'delivering') {
    return row.leaseUntil ? now > Date.parse(row.leaseUntil) : true;
  }
  const updated = Date.parse(row.updatedAt);
  return !Number.isFinite(updated) || now - updated > graceMs;
}
