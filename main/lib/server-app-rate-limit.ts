/**
 * Server App per-route API rate limit, editable from Settings.
 *
 * This is the limit the in-store connector shares: it polls one FloCafe order per open bill every
 * 1.5 s (~40 requests per bill per minute) through the same per-route limiter as staff clients. The
 * stored setting is validated here; the runtime read falls back to the environment/default when the
 * row is missing. (The separate global `/api` bucket only counts public callers; LAN and loopback are
 * exempt by the in-repo limiter.)
 */

export const SERVER_APP_API_RATE_LIMIT_KEY = 'server_app_api_rate_limit_max';
export const SERVER_APP_API_RATE_LIMIT_DEFAULT = 600;
export const SERVER_APP_API_RATE_LIMIT_MIN = 60;
export const SERVER_APP_API_RATE_LIMIT_MAX = 100_000;

function parseLimit(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Number.NaN;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** True only for a whole number inside the supported range. */
export function isValidServerAppApiRateLimit(value: unknown): boolean {
  const parsed = parseLimit(value);
  return (
    Number.isInteger(parsed) &&
    parsed >= SERVER_APP_API_RATE_LIMIT_MIN &&
    parsed <= SERVER_APP_API_RATE_LIMIT_MAX
  );
}

/** Runtime read; a corrupt row must never disable the limiter, so the caller's fallback wins. */
export function resolveServerAppApiRateLimit(stored: unknown, fallback: number): number {
  const parsed = parseLimit(stored);
  if (
    Number.isInteger(parsed) &&
    parsed >= SERVER_APP_API_RATE_LIMIT_MIN &&
    parsed <= SERVER_APP_API_RATE_LIMIT_MAX
  ) {
    return parsed;
  }
  return fallback;
}
