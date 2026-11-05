import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQrRasterBytes,
  renderPaymentRequestSlip,
} from '../main/printers/payment-request-slip';
import { buildPromptPayPayload, parsePromptPayAccount } from '../main/lib/promptpay';

const payload = buildPromptPayPayload(parsePromptPayAccount('0812345678')!, 802.5);

function indexOfSequence(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

test('QR raster is GS v 0 bands no taller than the band limit and fits the paper width', () => {
  const bytes = buildQrRasterBytes(payload, 576, 200);
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x1d, 0x76, 0x30, 0x00]);
  const widthBytes = bytes[4] + bytes[5] * 256;
  assert.equal(widthBytes, 72);
  const firstBandHeight = bytes[6] + bytes[7] * 256;
  assert.ok(firstBandHeight > 0 && firstBandHeight <= 200);
  assert.ok(
    bytes.slice(8).some((b) => b !== 0),
    'the bitmap has black pixels',
  );
});

test('payment request slip carries the QR bitmap, the amount and a cut after the QR', () => {
  const { lines, data } = renderPaymentRequestSlip(
    {
      businessName: 'Flo Cafe',
      businessAddress: '12 Main Road, Bangkok',
      businessPhone: '021234567',
      taxId: '0105551234567',
      orderNumber: 'ORD-1',
      tableName: 'T1',
      createdAt: '2026-10-22 18:00:00',
      amount: 802.5,
      orderTotal: 1000,
      items: [
        { name: 'Fried tofu', quantity: 2, total: 500, addons: ['Extra sauce'] },
        { name: 'Iced tea', quantity: 1, total: 500, addons: [] },
      ],
      qrPayload: payload,
    },
    {
      columns: 48,
      language: 'en',
      locale: 'en-US',
      currency: 'THB',
      useUnicode: false,
      arabicShaping: false,
      cutMode: 'full',
      widthDots: 576,
      maxBandHeight: 200,
    },
  );
  assert.ok(lines.some((line) => line.includes('PAYMENT REQUEST')));
  assert.ok(lines.some((line) => line.startsWith('{RAW_BYTES:')));
  const text = Buffer.from(data).toString('latin1');
  assert.ok(text.includes('ORD-1'));
  assert.ok(text.includes('12 Main Road, Bangkok'));
  assert.ok(text.includes('Tel: 021234567'));
  assert.ok(text.includes('Tax ID: 0105551234567'));
  assert.ok(text.includes('802.50'));
  assert.ok(text.includes('2x Fried tofu'));
  assert.ok(text.includes('+ Extra sauce'));
  assert.ok(text.includes('Iced tea'));
  assert.ok(text.includes('Pay by QR'), 'a part payment shows the QR share');
  const itemLines = lines.filter((line) => /^[0-9]x /.test(line));
  assert.equal(itemLines.length, 2);
  for (const line of itemLines) assert.equal(line.length, 48, 'item rows fill the paper width');
  const qrAt = indexOfSequence(data, [0x1d, 0x76, 0x30, 0x00]);
  const cutAt = indexOfSequence(data, [0x1d, 0x56]);
  assert.ok(qrAt > 0 && cutAt > qrAt, 'the cut comes after the QR');
});

test('payment request slip prints the account holder name under "scan to pay" only when set', () => {
  const slip = {
    businessName: 'Flo Cafe',
    businessAddress: '',
    businessPhone: '',
    taxId: '',
    orderNumber: 'ORD-2',
    tableName: '',
    createdAt: '',
    amount: 100,
    orderTotal: 100,
    items: [],
    qrPayload: payload,
  };
  const opts = {
    columns: 32,
    language: 'en',
    locale: 'en-US',
    currency: 'THB',
    useUnicode: false,
    arabicShaping: false,
    cutMode: 'full' as const,
    widthDots: 384,
    maxBandHeight: 200,
  };
  const plain = renderPaymentRequestSlip(slip, opts);
  const named = renderPaymentRequestSlip({ ...slip, accountName: 'Flo Cafe Co., Ltd.' }, opts);
  const scanAt = named.lines.findIndex((line) => line.includes('Scan to pay'));
  assert.equal(named.lines[scanAt + 1], '{CENTER}{BOLD}Flo Cafe Co., Ltd.{/BOLD}{/CENTER}');
  assert.deepEqual(
    named.lines.filter((line) => !line.includes('Flo Cafe Co., Ltd.')),
    plain.lines,
    'only the name line is added',
  );
  const longName = 'Somchai Jaidee Coffee and Bakery Company Limited';
  const wrapped = renderPaymentRequestSlip({ ...slip, accountName: longName }, opts);
  const nameLines = wrapped.lines.slice(scanAt + 1, -1);
  assert.ok(nameLines.length > 1, 'a long name wraps to the paper width');
  assert.equal(
    nameLines.map((line) => line.replace(/\{\/?(CENTER|BOLD)\}/g, '')).join(' '),
    longName,
  );
});
