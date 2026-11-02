/**
 * The Guest account behind table QR ordering holds only the menu and ordering permissions, and a
 * Guest token reaches only the main API routes the Server App calls for it.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/guest-scope.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-guest-scope-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, assertEqualOrThrow, closeDatabase } = require('./helpers/test-setup');
const { requireAuth } = require('../main/server');
const { getJWTSecret } = require('../main/security/jwt-secret');
const { resolveEffectivePermissions } = require('../main/services/authorization');
const { GUEST_USER_ID, isGuestApiRoute } = require('../main/lib/guest-order');

async function main() {
  const db = initTestDb();
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, 'Guest', NULL, 'x', 'server', 1, datetime('now'), datetime('now'))`,
  ).run(GUEST_USER_ID);
  // An override someone added by hand still grants the Guest nothing more.
  db.prepare(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by)
     VALUES (?, 'orders.read', 'allow', ?)`,
  ).run(GUEST_USER_ID, GUEST_USER_ID);

  const permissions = [...resolveEffectivePermissions(GUEST_USER_ID).permissionIds].sort();
  assertEqualOrThrow(
    permissions.join(','),
    'catalog.view,orders.create,printing.execute',
    'the Guest holds only the menu, ordering and kitchen-ticket permissions',
  );

  const routes: [string, string, boolean][] = [
    ['GET', '/api/products', true],
    ['GET', '/api/categories/', true],
    ['POST', '/api/orders', true],
    ['POST', '/api/orders/42/items', true],
    ['POST', '/api/printers/print-kot', true],
    ['GET', '/api/orders', false],
    ['POST', '/api/products', false],
    ['GET', '/api/customers', false],
    ['PATCH', '/api/orders/42/status', false],
    ['POST', '/api/orders/42/items/7', false],
  ];
  for (const [method, routePath, allowed] of routes) {
    assertEqualOrThrow(
      isGuestApiRoute(method, routePath),
      allowed,
      `${method} ${routePath} is ${allowed ? 'open' : 'closed'} to a Guest token`,
    );
  }

  const app = express();
  app.use(requireAuth);
  app.use((_req, res) => res.json({ reached: true }));
  const token = jwt.sign({ userId: GUEST_USER_ID, role: 'server' }, getJWTSecret(), {
    expiresIn: '2m',
  });
  const send = (method: 'get' | 'post', routePath: string) =>
    request(app)[method](routePath).set('Authorization', `Bearer ${token}`);
  assertEqualOrThrow((await send('get', '/api/products')).status, 200, 'the menu read passes');
  const refused = await send('get', '/API/Orders');
  assertEqualOrThrow(refused.status, 403, 'any other route is refused, whatever its casing');
  assertEqualOrThrow(refused.body.code, 'guest_scope', 'with the guest_scope code');
  console.log('Guest scope tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });
