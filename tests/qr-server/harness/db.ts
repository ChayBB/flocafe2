/**
 * Database access for the API suites. Reuses the `postgres` client from pos-server (the harness runs
 * under Node, the API under Bun) and the production table-token helper, so the tests never re-implement
 * the signature or the SQL shape.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const posRequire = createRequire(path.join(ROOT, 'pos-server', 'package.json'));

type Sql = any;

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the api suite`);
  return value;
}

export function adminDb(): Sql {
  return posRequire('postgres')(required('ADMIN_DATABASE_URL'), { max: 2, onnotice: () => {} });
}

export function appDb(): Sql {
  return posRequire('postgres')(required('DATABASE_URL'), { max: 2, onnotice: () => {} });
}

export function posApiUrl(): string {
  return (process.env.POS_API_URL ?? 'http://127.0.0.1:3311').replace(/\/$/, '');
}

/** Mirrors pos-server/src/crypto.ts tableToken (that package is ESM, the harness runs CJS). A drift fails as a 401. */
export function tableToken(tenantId: string, tableId: string, qrVersion: number): string {
  const sig = createHmac('sha256', required('GUEST_QR_SECRET'))
    .update(`qr:${tenantId}:${tableId}:${qrVersion}`)
    .digest('base64url');
  return `${tableId}.${sig}`;
}
