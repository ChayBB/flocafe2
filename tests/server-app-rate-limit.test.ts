/**
 * Server App API rate limit setting: stored values are strict, runtime reads fall back safely.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/server-app-rate-limit.test.ts
 */
import assert from 'node:assert/strict';
import {
  SERVER_APP_API_RATE_LIMIT_DEFAULT,
  SERVER_APP_API_RATE_LIMIT_KEY,
  isValidServerAppApiRateLimit,
  resolveServerAppApiRateLimit,
} from '../main/lib/server-app-rate-limit';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log('  ok   ', name);
  } catch (error) {
    failed += 1;
    console.error('  FAIL ', name, '\n        ', (error as Error).message);
  }
}

console.log('server app api rate limit');
console.log('='.repeat(60));

check('setting key and default stay stable', () => {
  assert.equal(SERVER_APP_API_RATE_LIMIT_KEY, 'server_app_api_rate_limit_max');
  assert.equal(SERVER_APP_API_RATE_LIMIT_DEFAULT, 600);
});

check('accepts whole numbers inside the range', () => {
  for (const value of [60, 150, 600, 100_000, '60', ' 240 ', '150']) {
    assert.equal(isValidServerAppApiRateLimit(value), true, String(value));
  }
});

check('rejects out-of-range and malformed values', () => {
  for (const value of [
    59,
    100_001,
    0,
    -1,
    150.5,
    '150abc',
    '59',
    '100001',
    '',
    ' ',
    null,
    undefined,
    true,
    {},
  ]) {
    assert.equal(isValidServerAppApiRateLimit(value), false, String(value));
  }
});

check('runtime resolve prefers a valid stored value', () => {
  assert.equal(resolveServerAppApiRateLimit('600', 150), 600);
  assert.equal(resolveServerAppApiRateLimit(60, 150), 60);
});

check('runtime resolve falls back when the row is missing or corrupt', () => {
  assert.equal(resolveServerAppApiRateLimit(null, 300), 300);
  assert.equal(resolveServerAppApiRateLimit('', 300), 300);
  assert.equal(resolveServerAppApiRateLimit('garbage', 300), 300);
  assert.equal(resolveServerAppApiRateLimit('90000x', 300), 300);
  assert.equal(resolveServerAppApiRateLimit(10, 300), 300);
  assert.equal(resolveServerAppApiRateLimit(1_000_000, 300), 300);
});

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exitCode = 1;
