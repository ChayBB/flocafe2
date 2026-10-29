import { Router, Request, Response } from 'express';
import { getDatabase, now, parseDbTimestamp } from '../db';
import { requirePermission } from '../services/authorization';
import {
  attendanceReport,
  currentBusinessDate,
  storeLocalToUtc,
  storeTimezone,
} from '../services/attendance';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const MAX_SHIFT_MS = 24 * 60 * 60 * 1000;
const MAX_HOURLY_RATE = 1_000_000;

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD — hours and wages per staff member.
router.get('/', requirePermission('staff.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = currentBusinessDate(db);
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : today;
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : `${today.slice(0, 8)}01`;
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD dates' });
    }
    if (daysBetween(from, to) < 0) return res.status(400).json({ error: 'from must not be after to' });
    if (daysBetween(from, to) > MAX_RANGE_DAYS) {
      return res.status(400).json({ error: `The range cannot exceed ${MAX_RANGE_DAYS} days` });
    }
    res.json({ from, to, today, timezone: storeTimezone(db), staff: attendanceReport(db, from, to) });
  } catch (error) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/attendance/rates/:userId — hourly rate used for the wage.
router.put('/rates/:userId', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    const raw = req.body?.hourly_rate;
    const rate = raw === null || raw === '' ? null : Number(raw);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > MAX_HOURLY_RATE)) {
      return res.status(400).json({ error: 'hourly_rate must be a number from 0 or empty' });
    }
    const db = getDatabase();
    const result = db
      .prepare('UPDATE users SET hourly_rate = ?, updated_at = ? WHERE id = ?')
      .run(rate === null ? null : Math.round(rate * 100) / 100, now(), String(req.params.userId));
    if (result.changes === 0) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/attendance/:id — corrects a shift's start and end, as store-local `YYYY-MM-DDTHH:mm` times.
router.put('/:id', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const shift = db.prepare('SELECT id FROM staff_attendance WHERE id = ?').get(Number(req.params.id));
    if (!shift) return res.status(404).json({ error: 'Attendance record not found' });

    const clockIn = storeLocalToUtc(db, req.body?.clock_in);
    if (!clockIn) return res.status(400).json({ error: 'clock_in must be a YYYY-MM-DDTHH:mm time' });
    const rawOut = req.body?.clock_out;
    const clockOut = rawOut === null || rawOut === '' || rawOut === undefined ? null : storeLocalToUtc(db, rawOut);
    if (rawOut && !clockOut) return res.status(400).json({ error: 'clock_out must be a YYYY-MM-DDTHH:mm time' });
    if (clockOut) {
      const span = parseDbTimestamp(clockOut).getTime() - parseDbTimestamp(clockIn).getTime();
      if (span <= 0) return res.status(400).json({ error: 'clock_out must be after clock_in' });
      if (span > MAX_SHIFT_MS) return res.status(400).json({ error: 'A shift cannot be longer than 24 hours' });
    }

    const stamp = now();
    db.prepare(
      `UPDATE staff_attendance
       SET clock_in_at = ?, clock_out_at = ?, corrected_by = ?, corrected_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(clockIn, clockOut, (req as any).user.userId, stamp, stamp, Number(req.params.id));
    res.json({ success: true });
  } catch (error) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as attendanceRoutes };
