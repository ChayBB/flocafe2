import type { getDatabase } from '../db';
import {
  dayBoundsInTimezone,
  localDateInTimezone,
  now,
  parseDbTimestamp,
  tenantBusinessDayStartTime,
} from '../db';
import { resolveRegionalSnapshot } from '../countries';
import { clockNow } from '../lib/clock';
import { GUEST_USER_ID } from '../lib/guest-order';

type Db = ReturnType<typeof getDatabase>;

/** Where a sign-in or sign-out happened. */
export type AttendanceSource = 'pos' | 'kds' | 'server_app';

// A sign-out more than this long after the shift began is not treated as that shift's end.
const MAX_SHIFT_MS = 24 * 60 * 60 * 1000;

function setting(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined)
    ?.value;
}

export function storeTimezone(db: Db): string {
  try {
    return resolveRegionalSnapshot({
      country: setting(db, 'country'),
      currency: setting(db, 'currency'),
      timezone: setting(db, 'timezone'),
    }).timezone;
  } catch {
    return 'UTC';
  }
}

export function currentBusinessDate(db: Db): string {
  return localDateInTimezone(clockNow(), storeTimezone(db), tenantBusinessDayStartTime(db));
}

/** The first sign-in of a business day starts that day's shift; later sign-ins change nothing. */
export function recordClockIn(db: Db, userId: string, source: AttendanceSource): void {
  if (!userId || userId === GUEST_USER_ID) return;
  try {
    const stamp = now();
    db.prepare(
      `INSERT OR IGNORE INTO staff_attendance
         (user_id, business_date, clock_in_at, clock_in_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, currentBusinessDate(db), stamp, source, stamp, stamp);
  } catch (error) {
    // Attendance must never block a sign-in.
    console.error('[Attendance] Clock-in failed:', error);
  }
}

/** A sign-out ends the user's latest shift; signing out again later moves the end time. */
export function recordClockOut(db: Db, userId: string, source: AttendanceSource): void {
  if (!userId || userId === GUEST_USER_ID) return;
  try {
    const latest = db
      .prepare(
        'SELECT id, clock_in_at FROM staff_attendance WHERE user_id = ? ORDER BY clock_in_at DESC LIMIT 1',
      )
      .get(userId) as { id: number; clock_in_at: string } | undefined;
    if (!latest) return;
    const stamp = now();
    if (parseDbTimestamp(stamp).getTime() - parseDbTimestamp(latest.clock_in_at).getTime() > MAX_SHIFT_MS) {
      return;
    }
    db.prepare(
      'UPDATE staff_attendance SET clock_out_at = ?, clock_out_source = ?, updated_at = ? WHERE id = ?',
    ).run(stamp, source, stamp, latest.id);
  } catch (error) {
    console.error('[Attendance] Clock-out failed:', error);
  }
}

export interface AttendanceEntry {
  id: number;
  business_date: string;
  clock_in_at: string;
  clock_out_at: string | null;
  hours: number;
  wage: number;
  corrected: boolean;
}

export interface AttendanceStaffSummary {
  user_id: string;
  name: string;
  role: string;
  is_active: boolean;
  hourly_rate: number | null;
  total_hours: number;
  total_wage: number;
  open_shifts: number;
  entries: AttendanceEntry[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Worked hours and wages per staff member for business dates `from`..`to`, inclusive. */
export function attendanceReport(db: Db, from: string, to: string): AttendanceStaffSummary[] {
  const staff = db
    .prepare(
      `SELECT id, name, role, is_active, hourly_rate FROM users
       WHERE id != ? ORDER BY is_active DESC, name COLLATE NOCASE`,
    )
    .all(GUEST_USER_ID) as {
    id: string;
    name: string;
    role: string;
    is_active: number;
    hourly_rate: number | null;
  }[];
  const rows = db
    .prepare(
      `SELECT id, user_id, business_date, clock_in_at, clock_out_at, corrected_at
       FROM staff_attendance
       WHERE business_date >= ? AND business_date <= ?
       ORDER BY business_date, clock_in_at`,
    )
    .all(from, to) as {
    id: number;
    user_id: string;
    business_date: string;
    clock_in_at: string;
    clock_out_at: string | null;
    corrected_at: string | null;
  }[];

  return staff
    .map((member) => {
      const rate = member.hourly_rate == null ? null : Number(member.hourly_rate);
      const entries = rows
        .filter((row) => row.user_id === member.id)
        .map((row) => {
          const hours = row.clock_out_at
            ? Math.max(
                0,
                (parseDbTimestamp(row.clock_out_at).getTime() - parseDbTimestamp(row.clock_in_at).getTime()) /
                  3_600_000,
              )
            : 0;
          return {
            id: row.id,
            business_date: row.business_date,
            clock_in_at: row.clock_in_at,
            clock_out_at: row.clock_out_at,
            hours: round2(hours),
            wage: round2(hours * (rate ?? 0)),
            corrected: Boolean(row.corrected_at),
          };
        });
      return {
        user_id: member.id,
        name: member.name,
        role: member.role,
        is_active: Boolean(member.is_active),
        hourly_rate: rate,
        total_hours: round2(entries.reduce((sum, entry) => sum + entry.hours, 0)),
        total_wage: round2(entries.reduce((sum, entry) => sum + entry.wage, 0)),
        open_shifts: entries.filter((entry) => !entry.clock_out_at).length,
        entries,
      };
    })
    .filter((member) => member.is_active || member.entries.length > 0);
}

/** UTC storage timestamp for a store-local wall time `YYYY-MM-DDTHH:mm`, or null when malformed. */
export function storeLocalToUtc(db: Db, local: unknown): string | null {
  if (typeof local !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(local);
  if (!match) return null;
  // A business day that starts at the wall time begins at exactly that instant.
  return dayBoundsInTimezone(match[1], storeTimezone(db), `${match[2]}:${match[3]}`)[0];
}
