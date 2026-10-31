import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { getSettingValue, upsertSettings } from '../db';

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
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
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

/** Express `trust proxy` test: only the configured proxy, so nobody else can choose their rate-limit key. */
export function isTrustedGuestProxy(address: string): boolean {
  const proxy = readGuestQrNetwork().trustedProxy;
  if (!proxy) return false;
  const bare = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return bare === proxy;
}

function guestQrSecret(): string {
  let secret = getSettingValue(GUEST_QR_SECRET_KEY);
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    upsertSettings({ [GUEST_QR_SECRET_KEY]: secret });
  }
  return secret;
}

/** The token a table's QR carries; without it a table id alone cannot place an order. */
export function guestTableToken(tableId: string): string {
  return createHmac('sha256', guestQrSecret()).update(`table:${tableId}`).digest('base64url').slice(0, 22);
}

export function verifyGuestTableToken(tableId: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length !== 22) return false;
  const expected = Buffer.from(guestTableToken(tableId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Issues a new secret, so every table QR printed before stops working. */
export function rotateGuestQrSecret(): void {
  upsertSettings({ [GUEST_QR_SECRET_KEY]: randomBytes(32).toString('hex') });
}
