import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { getDatabase, getSettingValue } from '../db';
import { currentGuestTableSession } from './guest-table-session';
import { readProtectedSetting, writeProtectedSetting } from '../security/protected-setting';

export const GUEST_QR_PUBLIC_URL_KEY = 'guest_qr_public_base_url';
export const GUEST_QR_TRUSTED_PROXY_KEY = 'guest_qr_trusted_proxy';
export const GUEST_QR_SECRET_KEY = 'guest_qr_secret';

const URL_MAX = 200;

/**
 * The public address printed into table QR codes when customers order from outside the shop network:
 * an https origin with an optional path, stored without a trailing slash. '' clears it.
 */
export function normalizePublicBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.length > URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** A single proxy address (IPv4 or IPv6) whose X-Forwarded-For header is believed. '' clears it. */
export function normalizeTrustedProxy(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return isIP(trimmed) ? trimmed.toLowerCase() : null;
}

export function readGuestQrNetwork(): { publicBaseUrl: string; trustedProxy: string } {
  return {
    publicBaseUrl: normalizePublicBaseUrl(getSettingValue(GUEST_QR_PUBLIC_URL_KEY) ?? '') || '',
    trustedProxy: normalizeTrustedProxy(getSettingValue(GUEST_QR_TRUSTED_PROXY_KEY) ?? '') || '',
  };
}

let relayLoopbackTrusted = false;

/** While the built-in relay tunnel runs, it reaches the Server App over loopback with the customer's address. */
export function setRelayLoopbackTrusted(trusted: boolean): void {
  relayLoopbackTrusted = trusted;
}

/** Express `trust proxy` test: only the configured proxy, so nobody else can choose their rate-limit key. */
export function isTrustedGuestProxy(address: string): boolean {
  const bare = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (relayLoopbackTrusted && (bare === '127.0.0.1' || bare === '::1')) return true;
  const proxy = readGuestQrNetwork().trustedProxy;
  return Boolean(proxy) && bare === proxy;
}

function guestQrSecret(): string {
  let secret = readProtectedSetting(GUEST_QR_SECRET_KEY);
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    writeProtectedSetting(GUEST_QR_SECRET_KEY, secret);
  }
  return secret;
}

/** The token a table session's QR carries; without it a table id alone cannot place an order. */
export function guestSessionToken(sessionId: string): string {
  return createHmac('sha256', guestQrSecret())
    .update(`session:${sessionId}`)
    .digest('base64url')
    .slice(0, 22);
}

/** True while `token` belongs to the table's open session. */
export function verifyGuestTableToken(tableId: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length !== 22) return false;
  const session = currentGuestTableSession(getDatabase(), tableId);
  if (!session) return false;
  const expected = Buffer.from(guestSessionToken(session.id));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Issues a new secret, so every table QR given out before stops working. */
export function rotateGuestQrSecret(): void {
  writeProtectedSetting(GUEST_QR_SECRET_KEY, randomBytes(32).toString('hex'));
}
