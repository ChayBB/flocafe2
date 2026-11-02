import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import * as http from 'node:http';
import { isIP } from 'node:net';
import * as os from 'node:os';
import QRCode from 'qrcode';
import { WebSocket, type RawData } from 'ws';
import { getSettingValue, upsertSettings } from '../db';
import { getServerAppPort } from '../server-app-state';
import {
  GUEST_QR_PUBLIC_URL_KEY,
  normalizePublicBaseUrl,
  setRelayLoopbackTrusted,
} from '../lib/guest-qr';

/**
 * The QR-ordering relay: the POS pairs with a relay server by a short code, then keeps one outbound
 * WebSocket open through which the relay passes customer requests to the local Server App. Nothing
 * listens for inbound connections, no driver is installed, and the POS keeps working without it.
 */

export const QR_RELAY_SERVER_KEY = 'qr_relay_server_url';
export const QR_RELAY_PRIVATE_KEY = 'qr_relay_private_key';
export const QR_RELAY_STORE_KEY = 'qr_relay_store_id';

const REQUEST_TIMEOUT_MS = 10_000;
// Shorter than the relay's own 15-second wait, so the customer gets this POS's answer, not a relay timeout.
const LOCAL_TIMEOUT_MS = 12_000;
const PING_MS = 25_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_IN_FLIGHT = 20;
const MAX_REQUEST_BODY = 64 * 1024;
const MAX_RESPONSE_BODY = 10 * 1024 * 1024;

const GUEST_ROUTES: [string, RegExp][] = [
  ['GET', /^\/api\/guest\/(table|menu)$/],
  ['POST', /^\/api\/guest\/order$/],
  ['GET', /^\/api\/server-app\/info$/],
];
const STATIC_PATH =
  /^\/(server-standalone(\/[\w.-]*)*|_next\/static\/[\w./@-]+|favicon\.ico|icons\/[\w.-]+|fonts\/[\w.-]+|[\w.-]+\.(png|svg|ico|webmanifest|woff2?))$/;
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'if-none-match',
  'if-modified-since',
  'user-agent',
];
const RETURNED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
  'content-language',
];

/** Which method and path the tunnel may pass to the Server App; everything else is refused here. */
export function isRelayPathAllowed(method: string, pathname: string): boolean {
  if (pathname.includes('..') || pathname.includes('//')) return false;
  if (GUEST_ROUTES.some(([allowed, pattern]) => allowed === method && pattern.test(pathname)))
    return true;
  return (method === 'GET' || method === 'HEAD') && STATIC_PATH.test(pathname);
}

/** https anywhere; plain http only to this machine, for development and tests. */
export function normalizeRelayServerUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export type QrRelayErrorCode =
  | 'server_url_invalid'
  | 'relay_unreachable'
  | 'relay_bad_response'
  | 'not_pairing';

export class QrRelayError extends Error {
  constructor(public code: QrRelayErrorCode) {
    super(code);
  }
}

interface Pairing {
  serverUrl: string;
  id: string;
  code: string;
  expiresAt: string;
  qrDataUrl: string;
}

let pairing: Pairing | null = null;
let socket: WebSocket | null = null;
let connected = false;
let lastError: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let awaitingPong = false;
let reconnectDelay = RECONNECT_MIN_MS;
let running = false;
let inFlight = 0;

function privateKey(): KeyObject | null {
  const pem = getSettingValue(QR_RELAY_PRIVATE_KEY);
  return pem ? createPrivateKey(pem) : null;
}

function publicKeyOf(key: KeyObject): string {
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
}

function signText(text: string): string {
  const key = privateKey();
  if (!key) throw new QrRelayError('not_pairing');
  return sign(null, Buffer.from(text), key).toString('base64url');
}

async function relayPost(
  serverUrl: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new QrRelayError('relay_unreachable');
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !data || typeof data !== 'object')
    throw new QrRelayError('relay_bad_response');
  return data;
}

/** Starts pairing with a relay: a fresh key pair, then a short code and QR for the relay admin. */
export async function startQrRelayPairing(rawServerUrl: unknown): Promise<void> {
  const serverUrl = normalizeRelayServerUrl(rawServerUrl);
  if (!serverUrl) throw new QrRelayError('server_url_invalid');
  stopTunnel();
  const { privateKey: key } = generateKeyPairSync('ed25519');
  upsertSettings({
    [QR_RELAY_SERVER_KEY]: serverUrl,
    [QR_RELAY_PRIVATE_KEY]: key.export({ format: 'pem', type: 'pkcs8' }).toString(),
    [QR_RELAY_STORE_KEY]: '',
  });
  const data = await relayPost(serverUrl, '/api/pos/pair/start', {
    public_key: publicKeyOf(key),
    device_name: os.hostname(),
  });
  const { pairing_id: id, code, expires_at: expiresAt } = data;
  if (
    typeof id !== 'string' ||
    typeof code !== 'string' ||
    !/^\d{6}$/.test(code) ||
    typeof expiresAt !== 'string'
  ) {
    throw new QrRelayError('relay_bad_response');
  }
  const approveUrl = `${serverUrl}/admin/pair?code=${code}`;
  pairing = {
    serverUrl,
    id,
    code,
    expiresAt,
    qrDataUrl: await QRCode.toDataURL(approveUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 256,
    }),
  };
  lastError = null;
}

/** Asks the relay once whether the admin approved the code; on approval the tunnel opens. */
export async function checkQrRelayPairing(): Promise<void> {
  const current = pairing;
  if (!current) throw new QrRelayError('not_pairing');
  const data = await relayPost(current.serverUrl, '/api/pos/pair/status', {
    pairing_id: current.id,
    signature: signText(`pair:${current.id}`),
  });
  if (pairing !== current) return;
  if (data.status === 'approved') {
    const publicBaseUrl = normalizePublicBaseUrl(data.public_base_url);
    if (typeof data.store_id !== 'string' || !data.store_id || !publicBaseUrl) {
      throw new QrRelayError('relay_bad_response');
    }
    upsertSettings({
      [QR_RELAY_STORE_KEY]: data.store_id,
      [GUEST_QR_PUBLIC_URL_KEY]: publicBaseUrl,
    });
    pairing = null;
    startQrRelay();
  } else if (data.status === 'expired' || data.status === 'rejected') {
    pairing = null;
    lastError = `pairing_${data.status}`;
  }
}

export function cancelQrRelayPairing(): void {
  pairing = null;
}

/** Forgets the relay: closes the tunnel, tells the relay best-effort, and clears the keys and address. */
export async function unpairQrRelay(): Promise<void> {
  const serverUrl = getSettingValue(QR_RELAY_SERVER_KEY) || '';
  const storeId = getSettingValue(QR_RELAY_STORE_KEY) || '';
  pairing = null;
  stopQrRelay();
  if (serverUrl && storeId && privateKey()) {
    await relayPost(serverUrl, '/api/pos/unpair', {
      store_id: storeId,
      signature: signText(`unpair:${storeId}`),
    }).catch(() => undefined);
  }
  upsertSettings({
    [QR_RELAY_PRIVATE_KEY]: '',
    [QR_RELAY_STORE_KEY]: '',
    [GUEST_QR_PUBLIC_URL_KEY]: '',
  });
  lastError = null;
}

export function getQrRelayStatus() {
  const storeId = getSettingValue(QR_RELAY_STORE_KEY) || '';
  return {
    server_url: getSettingValue(QR_RELAY_SERVER_KEY) || '',
    state: pairing ? 'pairing' : storeId ? 'paired' : 'unpaired',
    connected,
    store_id: storeId,
    public_base_url: storeId ? getSettingValue(GUEST_QR_PUBLIC_URL_KEY) || '' : '',
    pairing: pairing
      ? { code: pairing.code, qr_data_url: pairing.qrDataUrl, expires_at: pairing.expiresAt }
      : null,
    last_error: lastError,
  };
}

/** Opens the tunnel when this POS is paired; safe to call at any time, never throws. */
export function startQrRelay(): void {
  const serverUrl = getSettingValue(QR_RELAY_SERVER_KEY);
  const storeId = getSettingValue(QR_RELAY_STORE_KEY);
  if (!serverUrl || !storeId || !getSettingValue(QR_RELAY_PRIVATE_KEY)) return;
  stopTunnel();
  running = true;
  reconnectDelay = RECONNECT_MIN_MS;
  setRelayLoopbackTrusted(true);
  connect();
}

export function stopQrRelay(): void {
  stopTunnel();
  setRelayLoopbackTrusted(false);
}

function stopTunnel(): void {
  running = false;
  connected = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  const current = socket;
  socket = null;
  current?.removeAllListeners();
  current?.on('error', () => undefined);
  current?.terminate();
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer) return;
  const delay = reconnectDelay + Math.floor(Math.random() * 500);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (!running) return;
  const serverUrl = getSettingValue(QR_RELAY_SERVER_KEY) || '';
  const storeId = getSettingValue(QR_RELAY_STORE_KEY) || '';
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${serverUrl.replace(/^http/, 'ws')}/api/pos/tunnel`, {
      headers: { 'X-Flo-Store': storeId },
      handshakeTimeout: REQUEST_TIMEOUT_MS,
      maxPayload: MAX_REQUEST_BODY * 2,
    });
  } catch (error) {
    lastError = 'relay_unreachable';
    console.warn('[QR relay] connect failed:', (error as Error).message);
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.on('message', (data: RawData) => onMessage(ws, storeId, data));
  ws.on('pong', () => {
    awaitingPong = false;
  });
  ws.on('close', () => {
    if (socket !== ws) return;
    socket = null;
    connected = false;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    scheduleReconnect();
  });
  ws.on('error', (error) => {
    lastError = 'relay_unreachable';
    console.warn('[QR relay] tunnel error:', error.message);
  });
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function onMessage(ws: WebSocket, storeId: string, data: RawData): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (message.type === 'challenge' && typeof message.nonce === 'string') {
    send(ws, { type: 'auth', store_id: storeId, signature: signText(`tunnel:${message.nonce}`) });
  } else if (message.type === 'ready') {
    connected = true;
    lastError = null;
    reconnectDelay = RECONNECT_MIN_MS;
    awaitingPong = false;
    pingTimer = setInterval(() => {
      if (awaitingPong) {
        ws.terminate();
        return;
      }
      awaitingPong = true;
      ws.ping();
    }, PING_MS);
  } else if (message.type === 'error') {
    lastError = typeof message.code === 'string' ? message.code : 'relay_refused';
    // A relay that no longer knows this store will not start knowing it by retrying.
    if (message.code === 'unknown_store') stopQrRelay();
  } else if (message.type === 'request' && typeof message.id === 'string') {
    void forward(ws, message.id, message);
  }
}

async function forward(ws: WebSocket, id: string, message: Record<string, unknown>): Promise<void> {
  const reply = (
    status: number,
    headers: Record<string, string> = {},
    body: Buffer = Buffer.alloc(0),
  ) => send(ws, { type: 'response', id, status, headers, body: body.toString('base64') });
  const method = typeof message.method === 'string' ? message.method.toUpperCase() : '';
  let target: URL;
  try {
    target = new URL(typeof message.path === 'string' ? message.path : '', 'http://relay.invalid');
  } catch {
    return reply(400);
  }
  if (target.host !== 'relay.invalid' || !isRelayPathAllowed(method, target.pathname))
    return reply(404);
  // Without the customer's address every guest would share loopback's rate limits, and loopback skips some.
  const clientIp = typeof message.client_ip === 'string' ? message.client_ip : '';
  if (!isIP(clientIp)) return reply(400);
  const body =
    typeof message.body === 'string' ? Buffer.from(message.body, 'base64') : Buffer.alloc(0);
  if (body.length > MAX_REQUEST_BODY) return reply(413);
  if (inFlight >= MAX_IN_FLIGHT) return reply(503);

  const given = (
    message.headers && typeof message.headers === 'object' ? message.headers : {}
  ) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (typeof given[name] === 'string') headers[name] = given[name] as string;
  }
  headers['x-forwarded-for'] = clientIp;
  if (body.length > 0) headers['content-length'] = String(body.length);

  inFlight += 1;
  try {
    const result = await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: getServerAppPort(),
          method,
          path: `${target.pathname}${target.search}`,
          headers,
          timeout: LOCAL_TIMEOUT_MS,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BODY) {
              request.destroy(new Error('response too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const returned: Record<string, string> = {};
            for (const name of RETURNED_RESPONSE_HEADERS) {
              const value = response.headers[name];
              if (typeof value === 'string') returned[name] = value;
            }
            resolve({
              status: response.statusCode || 502,
              headers: returned,
              body: Buffer.concat(chunks),
            });
          });
          response.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', reject);
      request.end(body.length > 0 ? body : undefined);
    });
    reply(result.status, result.headers, result.body);
  } catch {
    reply(502);
  } finally {
    inFlight -= 1;
  }
}
