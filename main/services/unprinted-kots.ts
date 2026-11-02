import { addKdsAlert } from './kds-alerts';
import { notifyKdsUpdate } from './kds';

/** A kitchen ticket that did not print, kept until it prints or staff dismiss it. */
export interface UnprintedKot {
  id: string;
  order_id: number;
  order_number: string;
  table: string | null;
  station: string;
  detail: string | null;
  created_at: string;
}

const UNPRINTED_KOT_TTL_MS = 6 * 60 * 60 * 1000;

// Kept in memory only, like kitchen display alerts; a restart starts with an empty list.
let unprinted: UnprintedKot[] = [];

const keyOf = (orderId: number, station: string) => `${orderId}:${station}`;

/** Records a failed kitchen ticket and tells every kitchen display it is missing. */
export function recordUnprintedKot(input: {
  orderId: number;
  orderNumber: string;
  table?: string | null;
  station: string;
  detail?: string | null;
}): UnprintedKot {
  const id = keyOf(input.orderId, input.station);
  const existing = listUnprintedKots().find((entry) => entry.id === id);
  if (existing) return existing;
  const entry: UnprintedKot = {
    id,
    order_id: input.orderId,
    order_number: input.orderNumber,
    table: input.table ?? null,
    station: input.station,
    detail: input.detail ?? null,
    created_at: new Date().toISOString(),
  };
  unprinted = [...unprinted, entry];
  addKdsAlert({
    kind: 'kot_unprinted',
    message: input.orderNumber,
    table: input.table ?? null,
    ref: id,
  });
  notifyKdsUpdate();
  return entry;
}

/** Clears the warning once the order's ticket for that station has printed. */
export function clearUnprintedKot(orderId: number, station: string): void {
  const id = keyOf(orderId, station);
  unprinted = unprinted.filter((entry) => entry.id !== id);
}

export function dismissUnprintedKot(id: string): boolean {
  const before = unprinted.length;
  unprinted = unprinted.filter((entry) => entry.id !== id);
  return unprinted.length !== before;
}

export function listUnprintedKots(nowMs = Date.now()): UnprintedKot[] {
  unprinted = unprinted.filter(
    (entry) => nowMs - Date.parse(entry.created_at) < UNPRINTED_KOT_TTL_MS,
  );
  return unprinted;
}

export function clearUnprintedKotsForTest(): void {
  unprinted = [];
}
