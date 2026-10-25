import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromptPayPayload,
  crc16Ccitt,
  parseBankAccount,
  parsePromptPayAccount,
} from '../main/lib/promptpay';

test('crc16Ccitt matches the CCITT-FALSE check value', () => {
  assert.equal(crc16Ccitt('123456789'), '29B1');
});

test('parsePromptPayAccount classifies phone, national id and e-wallet', () => {
  assert.deepEqual(parsePromptPayAccount('081-234-5678'), { kind: 'phone', value: '0066812345678' });
  assert.deepEqual(parsePromptPayAccount('1234567890123'), { kind: 'national_id', value: '1234567890123' });
  assert.deepEqual(parsePromptPayAccount('004999000000001'), { kind: 'ewallet', value: '004999000000001' });
  assert.equal(parsePromptPayAccount('12345'), null);
  assert.equal(parsePromptPayAccount('abc'), null);
  assert.equal(parsePromptPayAccount(undefined), null);
});

test('static payload has no amount and a valid checksum', () => {
  const target = parsePromptPayAccount('0812345678')!;
  const payload = buildPromptPayPayload(target);
  assert.ok(payload.startsWith('000201010211'));
  assert.ok(payload.includes('0016A00000067701011101130066812345678530376458'.slice(0, 44)));
  assert.ok(payload.includes('01130066812345678'));
  assert.ok(!payload.includes('5404'));
  assert.equal(payload.slice(-4), crc16Ccitt(payload.slice(0, -4)));
});

test('dynamic payload carries the bill amount to two decimals', () => {
  const target = parsePromptPayAccount('0812345678')!;
  const payload = buildPromptPayPayload(target, 267.5);
  assert.ok(payload.startsWith('000201010212'));
  assert.ok(payload.includes('5303764'));
  assert.ok(payload.includes('5406267.50'));
  assert.ok(payload.includes('5802TH'));
  assert.equal(payload.slice(-4), crc16Ccitt(payload.slice(0, -4)));
});

test('parseBankAccount takes a known Thai bank code and a 10-15 digit account number', () => {
  assert.deepEqual(parseBankAccount('004', '123-4-56789-0'), {
    kind: 'bank_account',
    value: '0041234567890',
  });
  assert.deepEqual(parseBankAccount('014', '123456789012345'), {
    kind: 'bank_account',
    value: '014123456789012345',
  });
  assert.equal(parseBankAccount('999', '1234567890'), null, 'unknown bank code');
  assert.equal(parseBankAccount('004', '123456789'), null, 'too short');
  assert.equal(parseBankAccount('004', '1234567890123456'), null, 'too long');
  assert.equal(parseBankAccount('004', '12345abc90'), null, 'not digits');
  assert.equal(parseBankAccount(undefined, '1234567890'), null);
});

test('bank-account payload uses PromptPay sub-tag 04 with the bank code and account', () => {
  const target = parseBankAccount('004', '1234567890')!;
  const payload = buildPromptPayPayload(target, 100);
  assert.ok(payload.startsWith('000201010212'));
  assert.ok(payload.includes('29370016A00000067701011104130041234567890'));
  assert.ok(payload.includes('5406100.00'));
  assert.equal(payload.slice(-4), crc16Ccitt(payload.slice(0, -4)));
});
