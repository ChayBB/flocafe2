/**
 * Staff attendance: the first sign-in of a business day starts the shift, signing out ends it,
 * and the report turns worked hours into wages at each person's hourly rate.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/attendance.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-attendance-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.JWT_SECRET = 'test-secret-attendance';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { authRoutes, getJWTSecret } = require('../main/routes/auth');
const { attendanceRoutes } = require('../main/routes/attendance');
const { recordClockIn, recordClockOut, currentBusinessDate } = require('../main/services/attendance');
const { GUEST_USER_ID } = require('../main/lib/guest-order');

function seedUser(db: any, id: string, role: string, password = 'testpass123') {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, id, email, bcrypt.hashSync(password, 10), role, now(), now());
  return {
    email,
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
    },
  };
}

async function main() {
  console.log('Staff attendance');
  console.log('='.repeat(60));
  const db = initTestDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'TH')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('timezone', 'Asia/Bangkok')").run();
  const manager = seedUser(db, 'manager-att', 'manager');
  const server = seedUser(db, 'server-att', 'server', '4821');

  const app = createApp({ '/api/auth': authRoutes, '/api/attendance': attendanceRoutes });
  const { baseUrl, server: http } = await startServer(app);
  const today = currentBusinessDate(db);
  const shiftOf = (userId: string) =>
    db.prepare('SELECT * FROM staff_attendance WHERE user_id = ? AND business_date = ?').get(userId, today) as any;

  try {
    // Sign-in starts the shift; a second sign-in the same day keeps the first time.
    const login = await api(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: server.email, password: '4821' },
    });
    assertEqualOrThrow(login.status, 200, `the server signs in (${JSON.stringify(login.data)})`);
    const first = shiftOf('server-att');
    assertOrThrow(Boolean(first), 'the first sign-in of the day starts a shift');
    assertEqualOrThrow(first.clock_in_source, 'pos', 'the shift records where it started');
    assertEqualOrThrow(first.clock_out_at, null, 'a new shift is still open');

    await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: server.email, password: '4821' } });
    assertEqualOrThrow(
      db.prepare('SELECT COUNT(*) AS n FROM staff_attendance WHERE user_id = ?').get('server-att').n,
      1,
      'signing in again the same day does not start another shift',
    );
    assertEqualOrThrow(shiftOf('server-att').clock_in_at, first.clock_in_at, 'the first sign-in time is kept');

    // A failed sign-in records nothing.
    await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: manager.email, password: 'wrong' } });
    assertOrThrow(!shiftOf('manager-att'), 'a failed sign-in does not start a shift');

    // Signing out ends the shift.
    const logout = await api(baseUrl, '/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.data.access_token}` },
    });
    assertEqualOrThrow(logout.status, 200, 'the server signs out');
    const ended = shiftOf('server-att');
    assertOrThrow(Boolean(ended.clock_out_at), 'signing out ends the shift');
    assertEqualOrThrow(ended.clock_out_source, 'pos', 'the shift records where it ended');

    // The Guest account never clocks in.
    recordClockIn(db, GUEST_USER_ID, 'server_app');
    assertOrThrow(!shiftOf(GUEST_USER_ID), 'the guest account has no attendance');

    // A sign-out long after the last shift began does not close it.
    db.prepare(
      `INSERT INTO staff_attendance (user_id, business_date, clock_in_at, created_at, updated_at)
       VALUES ('manager-att', '2020-01-01', '2020-01-01 02:00:00', ?, ?)`,
    ).run(now(), now());
    recordClockOut(db, 'manager-att', 'kds');
    assertEqualOrThrow(
      db.prepare("SELECT clock_out_at FROM staff_attendance WHERE user_id = 'manager-att'").get().clock_out_at,
      null,
      'a stale shift is not closed by a much later sign-out',
    );

    // Wages: 8.5 hours at 60 an hour.
    db.prepare("UPDATE staff_attendance SET clock_in_at = ?, clock_out_at = ? WHERE user_id = 'server-att'").run(
      `${today} 01:00:00`,
      `${today} 09:30:00`,
    );
    const rate = await api(baseUrl, '/api/attendance/rates/server-att', {
      method: 'PUT',
      headers: manager.headers,
      body: { hourly_rate: 60 },
    });
    assertEqualOrThrow(rate.status, 200, 'a manager sets the hourly rate');
    const badRate = await api(baseUrl, '/api/attendance/rates/server-att', {
      method: 'PUT',
      headers: manager.headers,
      body: { hourly_rate: -5 },
    });
    assertEqualOrThrow(badRate.status, 400, 'a negative rate is refused');

    const report = await api(baseUrl, `/api/attendance?from=${today}&to=${today}`, { headers: manager.headers });
    assertEqualOrThrow(report.status, 200, `the report loads (${JSON.stringify(report.data)})`);
    const row = report.data.staff.find((member: any) => member.user_id === 'server-att');
    assertEqualOrThrow(row.total_hours, 8.5, 'worked hours run from sign-in to sign-out');
    assertEqualOrThrow(row.hourly_rate, 60, 'the report carries the hourly rate');
    assertEqualOrThrow(row.total_wage, 510, 'the wage is hours times the hourly rate');
    assertOrThrow(
      !report.data.staff.some((member: any) => member.user_id === GUEST_USER_ID),
      'the guest account is not listed',
    );

    // A manager corrects a shift in store-local time (Bangkok is UTC+7).
    const fix = await api(baseUrl, `/api/attendance/${ended.id}`, {
      method: 'PUT',
      headers: manager.headers,
      body: { clock_in: `${today}T09:00`, clock_out: `${today}T17:00` },
    });
    assertEqualOrThrow(fix.status, 200, `a manager corrects the shift (${JSON.stringify(fix.data)})`);
    const fixed = shiftOf('server-att');
    assertEqualOrThrow(fixed.clock_in_at, `${today} 02:00:00`, 'the corrected start is stored in UTC');
    assertEqualOrThrow(fixed.clock_out_at, `${today} 10:00:00`, 'the corrected end is stored in UTC');
    assertEqualOrThrow(fixed.corrected_by, 'manager-att', 'the correction records who made it');
    const backwards = await api(baseUrl, `/api/attendance/${ended.id}`, {
      method: 'PUT',
      headers: manager.headers,
      body: { clock_in: `${today}T17:00`, clock_out: `${today}T09:00` },
    });
    assertEqualOrThrow(backwards.status, 400, 'an end before the start is refused');

    // Staff without staff permissions cannot read wages or change them.
    const denied = await api(baseUrl, '/api/attendance', { headers: server.headers });
    assertEqualOrThrow(denied.status, 403, 'a server cannot read the attendance report');
    const deniedRate = await api(baseUrl, '/api/attendance/rates/server-att', {
      method: 'PUT',
      headers: server.headers,
      body: { hourly_rate: 999 },
    });
    assertEqualOrThrow(deniedRate.status, 403, 'a server cannot change a rate');

    const badRange = await api(baseUrl, '/api/attendance?from=2026-02-01&to=2026-01-01', { headers: manager.headers });
    assertEqualOrThrow(badRange.status, 400, 'a reversed range is refused');

    console.log('\nAll attendance checks passed');
  } finally {
    http.close();
    closeDatabase();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
