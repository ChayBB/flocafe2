import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { now } from '../db';
import { clockNow } from './clock';
import { nextDailyResetEpochSeconds } from './daily-session-reset';
import { storeTimezone } from '../services/attendance';

/** Table QR codes stop working at this store-time hour, so no code outlives the day it was given out. */
export const GUEST_SESSION_RESET_HOUR = 7;

export interface GuestTableSession {
  id: string;
  table_id: string;
  created_at: string;
  expires_at: string;
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
        `SELECT id, table_id, created_at, expires_at FROM guest_table_sessions
         WHERE table_id = ? AND closed_at IS NULL AND expires_at > ?`,
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
