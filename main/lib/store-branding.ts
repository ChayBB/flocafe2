import { createHash } from 'node:crypto';

export type StoreImageKind = 'logo' | 'cover';

export const STORE_IMAGE_KEYS: Record<StoreImageKind, string> = {
  logo: 'store_logo',
  cover: 'store_cover',
};

/** Data-URI length caps; the Settings page shrinks photos before upload. */
export const STORE_IMAGE_MAX_LENGTH: Record<StoreImageKind, number> = {
  logo: 300_000,
  cover: 1_500_000,
};

const DATA_URI = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export function isStoreImageKind(value: unknown): value is StoreImageKind {
  return value === 'logo' || value === 'cover';
}

/** Returns an error message, or null when the value may be stored ('' clears the image). */
export function storeImageError(kind: StoreImageKind, value: unknown): string | null {
  const key = STORE_IMAGE_KEYS[kind];
  if (typeof value !== 'string') return `${key} must be a string`;
  if (value === '') return null;
  if (value.length > STORE_IMAGE_MAX_LENGTH[kind]) return `${key} is too large`;
  if (!DATA_URI.test(value)) return `${key} must be a PNG, JPEG or WebP data URI`;
  return null;
}

export function decodeStoreImage(value: string | undefined): { type: string; body: Buffer } | null {
  const match = value ? DATA_URI.exec(value) : null;
  return match ? { type: match[1], body: Buffer.from(match[2], 'base64') } : null;
}

/** A short content hash that lets pages cache the image until it changes. */
export function storeImageVersion(value: string | undefined): string | null {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : null;
}
