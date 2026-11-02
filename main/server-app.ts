import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import expressRateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeServerResources,
  createShutdownCancellationError,
  getHttpRequestSignal,
  installHttpShutdownTracking,
  trackHttpRequestWork,
} from './shutdown';
import {
  DatabaseAdmissionReservation,
  createDatabaseMaintenanceHandoff,
  databaseMaintenanceMiddleware,
  getDatabase,
  isServerAppEnabled,
  isGuestQrOrderingEnabled,
  revokeDatabaseMaintenanceHandoff,
} from './db';
import { getJWTSecret } from './security/jwt-secret';
import {
  authRateLimit,
  loginAuthRateLimit,
  checkLoginRateLimit,
  incrementFailedLogin,
  resetSuccessfulLogin,
  FAILED_LOGIN_LOCKOUT_MINUTES,
  staticRouteRateLimit,
  corsOptions,
  isTokenRevoked,
  isTokenStale,
  rateLimit,
  revokeToken,
} from './middleware/security';
import { getServerPort } from './server';
import {
  getDefaultServerAppPort,
  getServerAppPort as getActiveServerAppPort,
  setServerAppPort,
} from './server-app-state';
import { API_JSON_BODY_LIMIT, GUEST_JSON_BODY_LIMIT } from './http-limits';
import { buildCspHeader } from './csp';
import { resolveContainedPath } from './lib/path-containment';
import { RegionalNotConfiguredError, resolveRegionalSnapshot } from './countries';
import { nextDailyResetEpochSeconds } from './lib/daily-session-reset';
import {
  GUEST_USER_ID,
  sanitizeGuestOrderItems,
  sanitizeGuestOrderNote,
  sanitizeGuestProduct,
} from './lib/guest-order';
import { guestMenu } from './lib/guest-menu-cache';
import {
  effectivePermissionRevision,
  hasPermission,
  resolveEffectivePermissions,
} from './services/authorization';
import { clockNow } from './lib/clock';
import { recordClockIn, recordClockOut } from './services/attendance';
import { isTrustedGuestProxy, verifyGuestTableToken } from './lib/guest-qr';
import { startQrRelay, stopQrRelay } from './services/qr-relay';

let serverApp: http.Server | null = null;
let stopPromise: Promise<void> | null = null;
let startReject: ((error: Error) => void) | null = null;
let stopping = false;
const SERVER_APP_PORT = getDefaultServerAppPort();

type ServerAppUser = {
  userId: string;
  email?: string;
  role: string;
  iat?: number;
  exp?: number;
};

function normalizeEmail(email: unknown): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

export function isServerAppRunning(): boolean {
  return serverApp !== null;
}

function getStaticDir(): string | null {
  const candidates = [
    path.join(__dirname, '../../frontend/out'),
    path.join(process.resourcesPath || '', 'frontend-out'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

let frontendBuildCache: { key: string; build: string } | null = null;

/** Identifies the exported Server App page, so open pages can tell when a new frontend was installed. */
function frontendBuild(): string | null {
  const dir = getStaticDir();
  if (!dir) return null;
  try {
    const file = path.join(dir, 'server-standalone', 'index.html');
    const stat = fs.statSync(file);
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (frontendBuildCache?.key !== key) {
      const build = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
      frontendBuildCache = { key, build };
    }
    return frontendBuildCache.build;
  } catch {
    return null;
  }
}

function rewriteNextExportPath(reqPath: string): string {
  const nextIndex = reqPath.indexOf('__next.');
  if (nextIndex === -1) return reqPath;

  const prefix = reqPath.substring(0, nextIndex + '__next.'.length);
  const rest = reqPath.substring(nextIndex + '__next.'.length);
  const lastDotIndex = rest.lastIndexOf('.');
  if (lastDotIndex === -1) return reqPath;

  return (
    prefix + rest.substring(0, lastDotIndex).replace(/\./g, '/') + rest.substring(lastDotIndex)
  );
}

function requireServerAppAuth(req: Request, res: Response, next: NextFunction) {
  if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  if (isTokenRevoked(token)) return res.status(401).json({ error: 'Invalid token' });

  try {
    const decoded = jwt.verify(token, getJWTSecret()) as any;
    const db = getDatabase();
    const user = db
      .prepare(
        'SELECT id, email, role, tokens_valid_after FROM users WHERE id = ? AND is_active = 1',
      )
      .get(decoded.userId) as any;
    if (!user || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (!hasPermission(user.id, 'server-app.use')) {
      return res.status(403).json({
        error: 'Access denied. Only server, manager, or owner accounts allowed.',
        code: 'permission_denied',
      });
    }

    (req as any).user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      iat: decoded.iat,
      exp: decoded.exp,
    } satisfies ServerAppUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function forwardToMainApi(req: Request, res: Response, targetPath: string) {
  return trackHttpRequestWork(req, forwardToMainApiImpl(req, res, targetPath));
}

async function forwardToMainApiImpl(req: Request, res: Response, targetPath: string) {
  const target = new URL(`/api${targetPath}`, `http://127.0.0.1:${getServerPort()}`);
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => target.searchParams.append(key, String(entry)));
    } else if (value !== undefined) {
      target.searchParams.set(key, String(value));
    }
  }

  const reservation = (req as any).databaseAdmissionReservation as
    | DatabaseAdmissionReservation
    | undefined;
  const handoffToken = reservation ? createDatabaseMaintenanceHandoff(reservation) : undefined;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.get('Idempotency-Key') ? { 'Idempotency-Key': req.get('Idempotency-Key')! } : {}),
        ...(handoffToken ? { 'x-flo-maintenance-handoff': handoffToken } : {}),
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      signal: getHttpRequestSignal(req),
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(buffer);
  } catch (error: any) {
    if (getHttpRequestSignal(req)?.aborted) {
      if (!res.headersSent) res.status(503).end();
      else if (!res.writableEnded) res.destroy();
      return;
    }
    console.error('[Server App] Main API forward failed:', error);
    res.status(502).json({ error: 'Could not reach the local POS API' });
  } finally {
    if (handoffToken) {
      revokeDatabaseMaintenanceHandoff(handoffToken);
    }
  }
}

function guestOrderingClosed(res: Response) {
  return res
    .status(403)
    .json({ code: 'guest_ordering_disabled', error: 'Ordering by QR code is turned off' });
}

/** The table exists but this QR's session has ended, so the guest needs a new code from staff. */
function guestQrExpired(res: Response) {
  return res.status(410).json({ code: 'qr_expired', error: 'This table QR code has expired' });
}

/** Calls the main API on behalf of the Guest account that table-QR visitors order as. */
async function callMainApiAsGuest(
  req: Request,
  method: 'GET' | 'POST',
  apiPath: string,
  options: {
    body?: unknown;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; data: any }> {
  const target = new URL(`/api${apiPath}`, `http://127.0.0.1:${getServerPort()}`);
  for (const [key, value] of Object.entries(options.query ?? {}))
    target.searchParams.set(key, value);
  const reservation = (req as any).databaseAdmissionReservation as
    | DatabaseAdmissionReservation
    | undefined;
  const handoffToken = reservation ? createDatabaseMaintenanceHandoff(reservation) : undefined;
  const guestToken = jwt.sign(
    { userId: GUEST_USER_ID, email: null, role: 'server', jti: randomUUID() },
    getJWTSecret(),
    { expiresIn: '2m' },
  );
  try {
    const upstream = await fetch(target, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestToken}`,
        ...(options.headers ?? {}),
        ...(handoffToken ? { 'x-flo-maintenance-handoff': handoffToken } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
      signal: getHttpRequestSignal(req),
    });
    const text = await upstream.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: upstream.status, data };
  } finally {
    if (handoffToken) revokeDatabaseMaintenanceHandoff(handoffToken);
  }
}

const guestOrderQueues = new Map<string, Promise<unknown>>();

/** Guest orders for one table run one at a time, so two phones ordering at once never open two bills. */
function oneGuestOrderAtATime<T>(tableId: string, work: () => Promise<T>): Promise<T> {
  const previous = guestOrderQueues.get(tableId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.catch(() => undefined);
  guestOrderQueues.set(tableId, settled);
  void settled.then(() => {
    if (guestOrderQueues.get(tableId) === settled) guestOrderQueues.delete(tableId);
  });
  return run;
}

/** The Guest account exists only for audit attribution: it has no usable password and no staff code. */
function ensureGuestUser(): void {
  const db = getDatabase();
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(GUEST_USER_ID)) return;
  const bcrypt = require('bcryptjs');
  const unusablePassword = bcrypt.hashSync(randomUUID() + randomUUID(), 10);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, 'Guest', NULL, ?, 'server', 1, ?, ?)`,
  ).run(GUEST_USER_ID, unusablePassword, stamp, stamp);
}

export function startServerApp(): Promise<void> {
  stopPromise = null;
  stopping = false;
  return new Promise((resolve, reject) => {
    startReject = reject;
    const app: Express = express();
    // Behind the QR-ordering proxy, req.ip (and so every rate limit) becomes the customer's address.
    app.set('trust proxy', (address: string) => isTrustedGuestProxy(address));

    app.use(cors(corsOptions));
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', buildCspHeader(req));
      // The table token rides in the page URL (?t=), so no request may carry it on as a Referer.
      res.setHeader('Referrer-Policy', 'no-referrer');
      next();
    });
    // Guests send a few order lines; parsed first, so the larger staff limit never applies to them.
    app.use('/api/guest', express.json({ limit: GUEST_JSON_BODY_LIMIT }));
    app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
    app.use((error: any, req: Request, res: Response, next: NextFunction) => {
      if (error?.type === 'entity.too.large' && req.path.startsWith('/api/guest')) {
        res.status(413).json({ error: 'The order is too large', code: 'body_too_large' });
        return;
      }
      if (error?.type === 'entity.too.large') {
        res.status(413).json({
          error: `Request body is too large. JSON imports are limited to ${API_JSON_BODY_LIMIT}; use Backup/Restore for full database migration.`,
        });
        return;
      }
      next(error);
    });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.body === undefined) req.body = {};
      next();
    });
    app.use(databaseMaintenanceMiddleware);
    app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 150 }));

    app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'Flo Server App',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      });
    });

    const configuredApiLimit = Number.parseInt(
      process.env.FLO_SERVER_APP_API_RATE_LIMIT_MAX || '',
      10,
    );
    const serverAppApiRateLimit = expressRateLimit({
      windowMs: 60 * 1000,
      limit:
        Number.isFinite(configuredApiLimit) && configuredApiLimit > 0 ? configuredApiLimit : 600,
      standardHeaders: true,
      legacyHeaders: false,
    });

    app.get('/api/server-app/info', serverAppApiRateLimit, (_req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      const rows = getDatabase().prepare('SELECT key, value FROM settings').all() as {
        key: string;
        value: string;
      }[];
      const settings: Record<string, string> = {};
      for (const row of rows) settings[row.key] = row.value;
      let snapshot;
      try {
        snapshot = resolveRegionalSnapshot(settings);
      } catch (error) {
        if (error instanceof RegionalNotConfiguredError)
          return res.status(409).json({ error: 'regional_not_configured' });
        throw error;
      }
      res.json({
        language: settings.language || null,
        country: snapshot.country,
        currency: snapshot.currency,
        currency_symbol: snapshot.currencySymbol,
        currency_position: snapshot.currencyPosition,
        currency_fraction_digits: snapshot.currencyFractionDigits,
        kds_enabled: settings.kds_enabled !== 'false',
        timezone: snapshot.timezone,
        server_time: clockNow().toISOString(),
        frontend_build: frontendBuild(),
      });
    });

    app.post('/api/auth/login', loginAuthRateLimit(), (req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      try {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const loginLimiter = checkLoginRateLimit(ip);
        if (!loginLimiter.allowed) {
          return res.status(429).json({
            error: `Too many failed attempts. Try again in ${loginLimiter.waitMinutes} minutes.`,
          });
        }

        const identifier = String(req.body?.identifier ?? req.body?.email ?? '').trim();
        const password = req.body?.password;
        if (!identifier || !password)
          return res
            .status(400)
            .json({ error: 'Staff name or email and code or password required' });
        const secret = String(password);

        const db = getDatabase();
        const bcrypt = require('bcryptjs');
        const email = normalizeEmail(identifier);
        const candidates = db
          .prepare(
            'SELECT * FROM users WHERE is_active = 1 AND (name = ? COLLATE NOCASE OR email = ?)',
          )
          .all(identifier, email) as any[];
        const compare = (plain: string, hash: unknown) => {
          try {
            return typeof hash === 'string' && bcrypt.compareSync(plain, hash);
          } catch {
            return false;
          }
        };
        const matches = candidates.filter(
          (candidate) =>
            compare(secret, candidate.staff_code_hash) ||
            compare(secret, candidate.pin_hash) ||
            compare(secret, candidate.password),
        );
        if (matches.length > 1) {
          incrementFailedLogin(ip);
          return res.status(401).json({
            error: 'More than one staff member matches. Ask a manager to change the code.',
            code: 'ambiguous_credentials',
          });
        }
        const user = matches[0];
        if (!user) {
          const attemptsRemaining = incrementFailedLogin(ip);
          return res.status(401).json({
            error: 'Invalid credentials',
            attempts_remaining: attemptsRemaining,
            lockout_minutes: attemptsRemaining === 0 ? FAILED_LOGIN_LOCKOUT_MINUTES : undefined,
          });
        }

        if (!hasPermission(user.id, 'server-app.use')) {
          return res.status(403).json({
            error: 'Access denied. Only server, manager, or owner accounts allowed.',
            code: 'permission_denied',
          });
        }

        resetSuccessfulLogin(ip);

        const settingsRows = db.prepare('SELECT key, value FROM settings').all() as {
          key: string;
          value: string;
        }[];
        const storeSettings: Record<string, string> = {};
        for (const row of settingsRows) storeSettings[row.key] = row.value;
        let sessionTimeZone: string;
        try {
          sessionTimeZone = resolveRegionalSnapshot(storeSettings).timezone;
        } catch (error) {
          if (error instanceof RegionalNotConfiguredError)
            return res.status(409).json({ error: 'regional_not_configured' });
          throw error;
        }
        const token = jwt.sign(
          {
            userId: user.id,
            email: user.email,
            role: user.role,
            jti: randomUUID(),
            exp: nextDailyResetEpochSeconds(new Date(), sessionTimeZone),
          },
          getJWTSecret(),
        );

        recordClockIn(db, user.id, 'server_app');
        res.json({
          access_token: token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            permission_ids: [...(resolveEffectivePermissions(user.id)?.permissionIds ?? [])],
            authorization_revision: effectivePermissionRevision(user.id),
          },
        });
      } catch (error: any) {
        console.error('[Server App] Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.get(
      '/api/auth/me',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req: Request, res: Response) => {
        const user = (req as any).user as ServerAppUser;
        const row = getDatabase()
          .prepare('SELECT id, name, email, role FROM users WHERE id = ? AND is_active = 1')
          .get(user.userId) as any;
        if (!row) return res.status(401).json({ error: 'Invalid token' });
        res.json({
          user: {
            ...row,
            permission_ids: [...(resolveEffectivePermissions(row.id)?.permissionIds ?? [])],
            authorization_revision: effectivePermissionRevision(row.id),
          },
        });
      },
    );

    app.post(
      '/api/auth/logout',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req: Request, res: Response) => {
        const token = req.headers.authorization?.split(' ')[1];
        const user = (req as Request & { user: ServerAppUser }).user;
        if (token) revokeToken(token, typeof user.exp === 'number' ? user.exp * 1000 : undefined);
        recordClockOut(getDatabase(), user.userId, 'server_app');
        res.json({ success: true });
      },
    );

    // Guest access for a table QR: read the menu and the one table, and place orders for that table.
    const guestOrderRateLimit = expressRateLimit({
      windowMs: 10 * 60 * 1000,
      limit: 12,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many orders from this device. Please ask a staff member.' },
    });

    app.get('/api/guest/table', serverAppApiRateLimit, (req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      if (!isGuestQrOrderingEnabled()) return guestOrderingClosed(res);
      const tableId = typeof req.query.table_id === 'string' ? req.query.table_id : '';
      const table = getDatabase()
        .prepare('SELECT id, number FROM tables WHERE id = ? AND is_active = 1')
        .get(tableId) as { id: string; number: string } | undefined;
      if (!table) return res.status(404).json({ error: 'Table not found' });
      if (!verifyGuestTableToken(tableId, req.query.t)) return guestQrExpired(res);
      res.json({ table: { id: table.id, name: table.number } });
    });

    app.get('/api/guest/menu', serverAppApiRateLimit, async (req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      if (!isGuestQrOrderingEnabled()) return guestOrderingClosed(res);
      try {
        const menu = await guestMenu(async () => {
          ensureGuestUser();
          const [categories, products] = await trackHttpRequestWork(
            req,
            Promise.all([
              callMainApiAsGuest(req, 'GET', '/categories', { query: { active: 'true' } }),
              callMainApiAsGuest(req, 'GET', '/products', { query: { active: 'true' } }),
            ]),
          );
          if (categories.status >= 400 || products.status >= 400) return null;
          return {
            categories: categories.data?.categories ?? [],
            products: (products.data?.products ?? []).map(sanitizeGuestProduct),
          };
        });
        if (!menu) return res.status(502).json({ error: 'Could not load the menu' });
        res.json(menu);
      } catch (error: any) {
        if (getHttpRequestSignal(req)?.aborted) return res.status(503).end();
        console.error('[Server App] Guest menu failed:', error);
        res.status(502).json({ error: 'Could not load the menu' });
      }
    });

    app.post(
      '/api/guest/order',
      serverAppApiRateLimit,
      guestOrderRateLimit,
      async (req: Request, res: Response) => {
        if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
        if (!isGuestQrOrderingEnabled()) return guestOrderingClosed(res);
        try {
          const db = getDatabase();
          const tableId = typeof req.body?.table_id === 'string' ? req.body.table_id : '';
          const table = db
            .prepare('SELECT id FROM tables WHERE id = ? AND is_active = 1')
            .get(tableId);
          if (!table) return res.status(404).json({ error: 'Table not found' });
          if (!verifyGuestTableToken(tableId, req.body?.table_token)) return guestQrExpired(res);

          const sanitized = sanitizeGuestOrderItems(db, req.body?.items);
          if (!sanitized.ok) return res.status(400).json({ error: sanitized.error });
          const note = sanitizeGuestOrderNote(req.body?.special_instructions);
          if (note === false) return res.status(400).json({ error: 'The order note is too long' });

          // The page keeps one key until the order goes through, so a retry after a lost answer is a replay.
          const key = req.body?.idempotency_key;
          if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
            return res
              .status(400)
              .json({ error: 'An order key is required', code: 'idempotency_key_required' });
          }
          const headers = { 'Idempotency-Key': `guest-${tableId}-${key}` };

          ensureGuestUser();
          const { result, existingItemIds, replayed } = await oneGuestOrderAtATime(
            tableId,
            async () => {
              // A retry whose first try went through answers from the stored result: the bill it opened
              // would now send the retry down the add-items route, where the same key reads as a new request.
              const stored = db
                .prepare(
                  'SELECT response_json FROM order_idempotency WHERE user_id = ? AND idempotency_key = ?',
                )
                .get(GUEST_USER_ID, headers['Idempotency-Key']) as
                | { response_json: string }
                | undefined;
              if (stored) {
                return {
                  result: { status: 201, data: JSON.parse(stored.response_json) },
                  existingItemIds: new Set<number>(),
                  replayed: true,
                };
              }
              const open = db
                .prepare(
                  `SELECT id FROM orders WHERE table_id = ? AND type = 'dine_in'
                 AND status IN ('pending', 'preparing', 'ready') ORDER BY id DESC LIMIT 1`,
                )
                .get(tableId) as { id: number } | undefined;
              const existingItemIds = new Set(
                open
                  ? (
                      db.prepare('SELECT id FROM order_items WHERE order_id = ?').all(open.id) as {
                        id: number;
                      }[]
                    ).map((row) => row.id)
                  : [],
              );
              const result = await trackHttpRequestWork(
                req,
                open
                  ? callMainApiAsGuest(req, 'POST', `/orders/${open.id}/items`, {
                      body: { items: sanitized.items, special_instructions: note ?? undefined },
                      headers,
                    })
                  : callMainApiAsGuest(req, 'POST', '/orders', {
                      body: {
                        table_id: tableId,
                        type: 'dine_in',
                        special_instructions: note ?? undefined,
                        items: sanitized.items,
                      },
                      headers,
                    }),
              );
              return { result, existingItemIds, replayed: false };
            },
          );
          if (result.status >= 400 || !result.data?.order) {
            return res
              .status(result.status >= 400 ? result.status : 502)
              .json({ error: result.data?.error || 'Could not send the order' });
          }

          const order = result.data.order;
          if (replayed) {
            return res
              .status(201)
              .json({ success: true, order_number: order.order_number ?? null });
          }
          const newItems = (order.items || []).filter(
            (item: { id: number }) => !existingItemIds.has(item.id),
          );
          // The kitchen ticket is printed here because a guest has no print permission of their own.
          void callMainApiAsGuest(req, 'POST', '/printers/print-kot', {
            body: { orderId: order.id, items: newItems },
          }).catch(() => undefined);

          res.status(201).json({ success: true, order_number: order.order_number ?? null });
        } catch (error: any) {
          if (getHttpRequestSignal(req)?.aborted) return res.status(503).end();
          console.error('[Server App] Guest order failed:', error);
          res.status(502).json({ error: 'Could not send the order' });
        }
      },
    );

    app.get('/api/categories', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/categories'),
    );
    app.get('/api/products', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/products'),
    );
    app.get('/api/products/popular', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/products/popular'),
    );
    app.get('/api/products/:id/image', serverAppApiRateLimit, (req, res) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      return forwardToMainApi(
        req,
        res,
        `/products/${encodeURIComponent(String(req.params.id))}/image`,
      );
    });
    app.get('/api/tables', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/tables'),
    );
    app.get('/api/orders', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/orders'),
    );
    app.post('/api/orders', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/orders'),
    );
    app.post('/api/orders/:id/items', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, `/orders/${encodeURIComponent(String(req.params.id))}/items`),
    );
    for (const suffix of ['guest-session', 'guest-session/print']) {
      app.post(
        `/api/tables/:id/${suffix}`,
        serverAppApiRateLimit,
        requireServerAppAuth,
        (req, res) =>
          forwardToMainApi(
            req,
            res,
            `/tables/${encodeURIComponent(String(req.params.id))}/${suffix}`,
          ),
      );
    }
    app.delete(
      '/api/tables/:id/guest-session',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req, res) =>
        forwardToMainApi(
          req,
          res,
          `/tables/${encodeURIComponent(String(req.params.id))}/guest-session`,
        ),
    );
    app.post(
      '/api/tables/:id/move-order',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req, res) =>
        forwardToMainApi(
          req,
          res,
          `/tables/${encodeURIComponent(String(req.params.id))}/move-order`,
        ),
    );
    app.post(
      '/api/orders/:id/merge-table',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req, res) =>
        forwardToMainApi(
          req,
          res,
          `/orders/${encodeURIComponent(String(req.params.id))}/merge-table`,
        ),
    );
    app.post('/api/kds-alerts', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/kds-alerts'),
    );
    app.post(
      '/api/orders/:id/bill-request',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req, res) =>
        forwardToMainApi(
          req,
          res,
          `/orders/${encodeURIComponent(String(req.params.id))}/bill-request`,
        ),
    );
    app.post(
      '/api/orders/:id/items/confirm-served',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req, res) =>
        forwardToMainApi(
          req,
          res,
          `/orders/${encodeURIComponent(String(req.params.id))}/items/confirm-served`,
        ),
    );
    for (const action of ['cancel', 'takeaway', 'confirm-served'] as const) {
      app.patch(
        `/api/orders/:id/items/:itemId/${action}`,
        serverAppApiRateLimit,
        requireServerAppAuth,
        (req, res) =>
          forwardToMainApi(
            req,
            res,
            `/orders/${encodeURIComponent(String(req.params.id))}/items/${encodeURIComponent(String(req.params.itemId))}/${action}`,
          ),
      );
    }
    app.get('/api/customers-search', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/customers-search'),
    );
    app.get('/api/crm/lookup', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/crm/lookup'),
    );
    const customerWriteRateLimit = expressRateLimit({
      windowMs: 60 * 1000,
      limit: 150,
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.post('/api/customers', customerWriteRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/customers'),
    );
    const printForwardRateLimit = expressRateLimit({
      windowMs: 60 * 1000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.post('/api/printers/print-kot', printForwardRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/printers/print-kot'),
    );
    app.post('/api/printers/print-bill', printForwardRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/printers/print-bill'),
    );

    const staticDir = getStaticDir();
    if (staticDir) {
      console.log(`[Server App] Serving static files from: ${staticDir}`);
      if (process.platform === 'win32') {
        app.use(staticRouteRateLimit(), (req: Request, _res: Response, next: NextFunction) => {
          if (req.path.includes('__next.')) {
            const rewritten = rewriteNextExportPath(req.path);
            if (rewritten !== req.path) {
              const fullPath = resolveContainedPath(staticDir, rewritten);
              if (fullPath && fs.existsSync(fullPath)) {
                req.url = rewritten;
              }
            }
          }
          next();
        });
      }
      // Hidden files in the build output (.env, editor leftovers) are never served.
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.path.split('/').some((segment) => segment.startsWith('.'))) {
          res.status(404).end();
          return;
        }
        next();
      });
      app.use(express.static(staticDir, { dotfiles: 'ignore', index: false }));
      app.get('/', (_req: Request, res: Response) => res.redirect('/server-standalone'));
      app.get('/*splat', staticRouteRateLimit(), (req: Request, res: Response) => {
        const routePath = resolveContainedPath(staticDir, `.${req.path}`, 'index.html');
        if (routePath && fs.existsSync(routePath)) {
          res.sendFile(routePath, { dotfiles: 'allow' });
        } else {
          res.sendFile(path.join(staticDir, 'server-standalone', 'index.html'), {
            dotfiles: 'allow',
          });
        }
      });
    } else {
      console.warn('[Server App] Static build not found. Run `npm run build:frontend` first.');
      app.get('/', (_req: Request, res: Response) => {
        res.send(`
          <html><body style="font-family:sans-serif;padding:2rem">
            <h2>Flo Server App - Build not found</h2>
            <p>Run <code>npm run build:frontend</code> then restart the app.</p>
          </body></html>
        `);
      });
    }

    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[Server App] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    const baseServerAppPort = parseInt(process.env.SERVER_APP_PORT || String(SERVER_APP_PORT), 10);
    let currentPort = baseServerAppPort;
    let attempts = 0;
    const listeningServer = http.createServer(app);
    serverApp = listeningServer;
    installHttpShutdownTracking(listeningServer);

    const tryListen = () => {
      const attemptedPort = currentPort;
      const onListening = () => {
        if (stopping) {
          try {
            listeningServer.close();
          } catch {
            return;
          }
          return;
        }
        startReject = null;
        listeningServer.off('error', onError);
        setServerAppPort(attemptedPort);
        console.log(
          `[Server App] HTTP server running on http://localhost:${getActiveServerAppPort()}`,
        );
        resolve();
        // Optional: the QR-ordering tunnel opens only on a paired POS and retries on its own.
        startQrRelay();
      };
      const onError = (err: NodeJS.ErrnoException) => {
        if (stopping) return;
        listeningServer.off('listening', onListening);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          attempts++;
          if (attempts >= 10) {
            const errorMsg = `[Server App] Failed to bind to any port after 10 attempts starting from ${baseServerAppPort}`;
            console.error(errorMsg);
            reject(new Error(errorMsg));
            return;
          }
          currentPort++;
          console.log(
            `[Server App] Port ${attemptedPort} in use (${err.code}), trying ${currentPort}`,
          );
          tryListen();
          return;
        }
        reject(err);
      };

      listeningServer.once('listening', onListening);
      listeningServer.once('error', onError);
      listeningServer.listen(attemptedPort, '0.0.0.0');
    };

    tryListen();
  });
}

export function stopServerApp(): Promise<void> {
  if (stopPromise) return stopPromise;

  stopping = true;
  stopQrRelay();
  const rejectStart = startReject;
  startReject = null;
  rejectStart?.(createShutdownCancellationError('Server App'));
  const serverToClose = serverApp;
  // Mark the server unavailable immediately while active requests drain.
  serverApp = null;

  stopPromise = closeServerResources(serverToClose, null, 'Server App').then(() => {
    console.log('[Server App] HTTP server stopped');
  });
  return stopPromise;
}

export function getServerAppPort(): number {
  return getActiveServerAppPort();
}
