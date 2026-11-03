import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { now } from '../db';
import { clockNow } from './clock';
import { nextDailyResetEpochSeconds } from './daily-session-reset';
import { storeTimezone } from '../services/attendance';

/** Table QR codes stop working at this store-time hour, so no code outlives the day it was given out. */
export const GUEST_SESSION_RESET_HOUR = 7;

/** Phones that may join one session, so a sticker photo cannot fill a bill from everywhere. */
export const GUEST_DEVICES_PER_SESSION = 20;
/** One phone waits this long between orders; a repeated send is a replay, not a new order. */
export const GUEST_ORDER_COOLDOWN_SECONDS = 5;
/** Past these, a session's orders wait for staff before they reach the bill and the kitchen. */
export const GUEST_SESSION_MAX_ORDERS = 20;
export const GUEST_SESSION_MAX_ITEMS = 150;

export interface GuestTableSession {
  id: string;
  table_id: string;
  created_at: string;
  expires_at: string;
  order_count: number;
  item_count: number;
}

export interface GuestDevice {
  id: string;
  session_id: string;
  last_order_at: string | null;
}

function sqlTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace(/\..*$/, '');
}

function closeOpen(db: Database.Database, tableId: string, reason: string): number {
  return db
    .prepare(
      'UPDATE guest_table_sessions SET closed_at = ?, closed_reason = ? WHERE table_id = ? AND closed_at IS NULL',
    )
    .run(now(), reason, tableId).changes;
}

/** The table's open session that has not passed its reset time, or null. */
export function currentGuestTableSession(
  db: Database.Database,
  tableId: string,
): GuestTableSession | null {
  return (
    (db
      .prepare(
        `SELECT id, table_id, created_at, expires_at, order_count, item_count
         FROM guest_table_sessions WHERE table_id = ? AND closed_at IS NULL AND expires_at > ?`,
      )
      .get(tableId, now()) as GuestTableSession | undefined) ?? null
  );
}

/** The table's open session, or a new one; `renew` replaces an open session so its QR stops working. */
export function openGuestTableSession(
  db: Database.Database,
  tableId: string,
  openedBy: string | null,
  options: { renew?: boolean } = {},
): GuestTableSession {
  return db.transaction(() => {
    // An open table answers every phone waiting at its sticker.
    db.prepare(
      `UPDATE guest_alerts SET status = 'approved', resolved_by = ?, resolved_at = ?
       WHERE table_id = ? AND kind = 'unlock_request' AND status = 'open'`,
    ).run(openedBy, now(), tableId);
    const current = currentGuestTableSession(db, tableId);
    if (current && !options.renew) return current;
    closeOpen(db, tableId, current ? 'renewed' : 'expired');
    const createdAt = clockNow();
    const session: GuestTableSession = {
      id: randomUUID(),
      table_id: tableId,
      created_at: sqlTimestamp(createdAt.getTime()),
      expires_at: sqlTimestamp(
        nextDailyResetEpochSeconds(createdAt, storeTimezone(db), GUEST_SESSION_RESET_HOUR) * 1000,
      ),
      order_count: 0,
      item_count: 0,
    };
    db.prepare(
      `INSERT INTO guest_table_sessions (id, table_id, opened_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(session.id, tableId, openedBy, session.created_at, session.expires_at);
    return session;
  })();
}

/** Ends the table's session, so its QR stops taking orders; false when none was open. */
export function closeGuestTableSession(db: Database.Database, tableId: string): boolean {
  return closeOpen(db, tableId, 'staff') > 0;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A new phone in the session; null once the session holds its quota of phones. */
export function addGuestDevice(
  db: Database.Database,
  sessionId: string,
  joinedBy: 'slip' | 'sticker',
): string | null {
  const count = (
    db
      .prepare('SELECT COUNT(*) AS n FROM guest_session_devices WHERE session_id = ?')
      .get(sessionId) as {
      n: number;
    }
  ).n;
  if (count >= GUEST_DEVICES_PER_SESSION) return null;
  const token = randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO guest_session_devices (id, session_id, token_hash, joined_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), sessionId, hashToken(token), joinedBy, now());
  return token;
}

/** The phone holding `token` and its session, while that session is the table's open one. */
export function findGuestDevice(
  db: Database.Database,
  tableId: string,
  token: unknown,
): { device: GuestDevice; session: GuestTableSession } | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
  const session = currentGuestTableSession(db, tableId);
  if (!session) return null;
  const device = db
    .prepare(
      'SELECT id, session_id, last_order_at FROM guest_session_devices WHERE token_hash = ? AND session_id = ?',
    )
    .get(hashToken(token), session.id) as GuestDevice | undefined;
  return device ? { device, session } : null;
}

const UNLOCK_KEY_PREFIX = 'unlock-';

/**
 * A sticker scan at a table staff have not opened. The phone's key keeps one request per phone, and
 * a table shows staff one waiting request at a time; staff unlocking the table opens its session.
 */
export function requestGuestUnlock(
  db: Database.Database,
  tableId: string,
  key: string,
): 'waiting' | 'declined' {
  return db.transaction(() => {
    const alertKey = UNLOCK_KEY_PREFIX + key;
    const own = db
      .prepare(
        `SELECT id, status FROM guest_alerts
         WHERE table_id = ? AND idempotency_key = ? AND kind = 'unlock_request'`,
      )
      .get(tableId, alertKey) as { id: number; status: string } | undefined;
    if (own?.status === 'open') return 'waiting';
    if (own && own.status !== 'approved') return 'declined';
    const waiting = db
      .prepare(
        `SELECT 1 FROM guest_alerts WHERE table_id = ? AND kind = 'unlock_request' AND status = 'open'`,
      )
      .get(tableId);
    if (own) {
      // Unlocked once, but that session has ended since: ask again.
      if (!waiting) {
        db.prepare(
          `UPDATE guest_alerts SET status = 'open', created_at = ?, resolved_by = NULL,
             resolved_at = NULL WHERE id = ?`,
        ).run(now(), own.id);
      }
      return 'waiting';
    }
    if (!waiting) {
      db.prepare(
        `INSERT INTO guest_alerts (table_id, kind, idempotency_key, created_at)
         VALUES (?, 'unlock_request', ?, ?)`,
      ).run(tableId, alertKey, now());
    }
    return 'waiting';
  })();
}

export type GuestOrderGate =
  | { kind: 'place' }
  | { kind: 'cooldown'; retryAfter: number }
  | { kind: 'held'; alertId: number; rejected: boolean };

/**
 * Decides whether a phone's order goes through now, waits out the cooldown, or waits for staff
 * because the session passed its quota; an order that goes through is counted at once.
 */
export function gateGuestOrder(
  db: Database.Database,
  found: { device: GuestDevice; session: GuestTableSession },
  order: { quantity: number; key: string; payload: unknown },
): GuestOrderGate {
  return db.transaction((): GuestOrderGate => {
    const held = db
      .prepare('SELECT id, status FROM guest_alerts WHERE table_id = ? AND idempotency_key = ?')
      .get(found.session.table_id, order.key) as { id: number; status: string } | undefined;
    if (held) return { kind: 'held', alertId: held.id, rejected: held.status === 'rejected' };
    // Read again here: two sends from one phone queue behind each other, so the copy found before
    // the queue would let both through.
    const last = (
      db
        .prepare('SELECT last_order_at FROM guest_session_devices WHERE id = ?')
        .get(found.device.id) as { last_order_at: string | null } | undefined
    )?.last_order_at;
    const nowMs = Date.parse(`${now().replace(' ', 'T')}Z`);
    const lastMs = last ? Date.parse(`${last.replace(' ', 'T')}Z`) : 0;
    const wait = Math.ceil((lastMs + GUEST_ORDER_COOLDOWN_SECONDS * 1000 - nowMs) / 1000);
    if (wait > 0) return { kind: 'cooldown', retryAfter: wait };
    db.prepare('UPDATE guest_session_devices SET last_order_at = ? WHERE id = ?').run(
      now(),
      found.device.id,
    );
    const session = db
      .prepare('SELECT order_count, item_count FROM guest_table_sessions WHERE id = ?')
      .get(found.session.id) as { order_count: number; item_count: number };
    if (
      session.order_count + 1 > GUEST_SESSION_MAX_ORDERS ||
      session.item_count + order.quantity > GUEST_SESSION_MAX_ITEMS
    ) {
      const alert = db
        .prepare(
          `INSERT INTO guest_alerts (table_id, session_id, kind, idempotency_key, payload_json, created_at)
           VALUES (?, ?, 'order_held', ?, ?, ?)`,
        )
        .run(
          found.session.table_id,
          found.session.id,
          order.key,
          JSON.stringify(order.payload),
          now(),
        );
      return { kind: 'held', alertId: Number(alert.lastInsertRowid), rejected: false };
    }
    db.prepare(
      'UPDATE guest_table_sessions SET order_count = order_count + 1, item_count = item_count + ? WHERE id = ?',
    ).run(order.quantity, found.session.id);
    return { kind: 'place' };
  })();
}

/** Gives back the quota an order took when the order then failed to go through. */
export function releaseGuestOrderQuota(
  db: Database.Database,
  sessionId: string,
  quantity: number,
): void {
  db.prepare(
    `UPDATE guest_table_sessions SET order_count = MAX(order_count - 1, 0),
       item_count = MAX(item_count - ?, 0) WHERE id = ?`,
  ).run(quantity, sessionId);
}
