import * as QRCode from 'qrcode';
import { formatMoney, type CurrencyDisplay, type DigitMode } from '../countries';
import type { PrinterCutMode } from './profiles';
import type { ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import { encodeGsV0Band, type RasterBand } from '../../shared/print/raster';
import { displayCellWidth } from '../../shared/print/width';
import {
  buildEscPos,
  truncateShapedLine,
  wrapText,
  type PrintWarning,
} from './formatting-helpers';

const QR_QUIET_MODULES = 2;
const QR_MODULE_DOTS = 7;

export interface PaymentRequestSlipItem {
  readonly name: string;
  readonly quantity: number;
  readonly total: number;
  readonly addons: readonly string[];
}

export interface PaymentRequestSlipData {
  readonly businessName: string;
  readonly businessAddress: string;
  readonly businessPhone: string;
  readonly taxId: string;
  readonly orderNumber: string;
  readonly tableName: string;
  readonly createdAt: string;
  readonly amount: number;
  readonly orderTotal: number;
  readonly items: readonly PaymentRequestSlipItem[];
  readonly qrPayload: string;
}

export interface PaymentRequestSlipOptions {
  readonly columns: number;
  readonly language: string;
  readonly locale: string;
  readonly currency: string;
  readonly currencyDisplay?: CurrencyDisplay;
  readonly digits?: DigitMode;
  readonly useUnicode: boolean;
  readonly arabicShaping: boolean;
  readonly cutMode: PrinterCutMode;
  readonly capabilities?: ThermalPrinterCapabilities;
  readonly widthDots: number;
  readonly maxBandHeight: number;
}

const LABELS: Record<
  string,
  {
    title: string;
    order: string;
    table: string;
    scan: string;
    total: string;
    payByQr: string;
    tel: string;
    taxId: string;
  }
> = {
  th: {
    title: 'ใบเรียกรับเงิน',
    order: 'ออเดอร์',
    table: 'โต๊ะ',
    scan: 'สแกนเพื่อชำระเงิน',
    total: 'ยอดรวม',
    payByQr: 'ชำระผ่าน QR',
    tel: 'โทร',
    taxId: 'เลขประจำตัวผู้เสียภาษี',
  },
  en: {
    title: 'PAYMENT REQUEST',
    order: 'Order',
    table: 'Table',
    scan: 'Scan to pay',
    total: 'Total',
    payByQr: 'Pay by QR',
    tel: 'Tel',
    taxId: 'Tax ID',
  },
};

function truncateToWidth(text: string, width: number): string {
  let out = '';
  for (const char of text) {
    if (displayCellWidth(out + char) > width) break;
    out += char;
  }
  return out;
}

/** Packs the QR modules into centered GS v 0 bands that fit the printable width. */
export function buildQrRasterBytes(
  payload: string,
  widthDots: number,
  maxBandHeight: number,
): Uint8Array {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const total = size + QR_QUIET_MODULES * 2;
  const scale = Math.max(1, Math.min(QR_MODULE_DOTS, Math.floor(widthDots / total)));
  const side = total * scale;
  const left = Math.max(0, Math.floor((widthDots - side) / 2));
  const parts: Uint8Array[] = [];
  for (let rowStart = 0; rowStart < side; rowStart += maxBandHeight) {
    const height = Math.min(maxBandHeight, side - rowStart);
    const pixels = new Uint8Array(widthDots * height);
    for (let y = 0; y < height; y++) {
      const moduleY = Math.floor((rowStart + y) / scale) - QR_QUIET_MODULES;
      if (moduleY < 0 || moduleY >= size) continue;
      for (let x = 0; x < side; x++) {
        const moduleX = Math.floor(x / scale) - QR_QUIET_MODULES;
        if (moduleX < 0 || moduleX >= size) continue;
        if (qr.modules.get(moduleY, moduleX)) pixels[y * widthDots + left + x] = 1;
      }
    }
    const band: RasterBand = { widthDots, heightDots: height, pixels };
    parts.push(encodeGsV0Band(band, maxBandHeight));
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function renderPaymentRequestSlip(
  slip: PaymentRequestSlipData,
  opts: PaymentRequestSlipOptions,
): { lines: string[]; data: Buffer; warnings: PrintWarning[] } {
  const labels = LABELS[opts.language] ?? LABELS.en;
  const cols = opts.columns;
  const fit = (text: string) =>
    truncateShapedLine(text, cols, opts.arabicShaping, opts.language, opts.capabilities);
  const amountText = formatMoney(slip.amount, opts.currency, opts.locale, {
    currencyDisplay: opts.currencyDisplay,
    digits: opts.digits,
  });
  const money = (value: number) =>
    formatMoney(value, opts.currency, opts.locale, {
      currencyDisplay: opts.currencyDisplay,
      digits: opts.digits,
    });
  const row = (left: string, right: string) => {
    const room = Math.max(1, cols - displayCellWidth(right) - 1);
    const label = fit(left.length > 0 && displayCellWidth(left) > room ? truncateToWidth(left, room) : left);
    const gap = Math.max(1, cols - displayCellWidth(label) - displayCellWidth(right));
    return label + ' '.repeat(gap) + right;
  };
  const lines: string[] = [];
  if (slip.businessName) lines.push('{CENTER}{BOLD}' + fit(slip.businessName) + '{/BOLD}{/CENTER}');
  for (const part of wrapText(slip.businessAddress, cols)) {
    if (part.trim()) lines.push('{CENTER}' + part + '{/CENTER}');
  }
  if (slip.businessPhone) lines.push('{CENTER}' + fit(`${labels.tel}: ${slip.businessPhone}`) + '{/CENTER}');
  if (slip.taxId) lines.push('{CENTER}' + fit(`${labels.taxId}: ${slip.taxId}`) + '{/CENTER}');
  lines.push('');
  lines.push('{CENTER}{BOLD}' + fit(labels.title) + '{/BOLD}{/CENTER}');
  lines.push('');
  lines.push(fit(`${labels.order}: ${slip.orderNumber}`));
  if (slip.tableName) lines.push(fit(`${labels.table}: ${slip.tableName}`));
  if (slip.createdAt) lines.push(fit(slip.createdAt));
  lines.push('');
  for (const item of slip.items) {
    lines.push(row(`${item.quantity}x ${item.name}`, money(item.total)));
    for (const addon of item.addons) lines.push(fit(`  + ${addon}`));
  }
  if (slip.items.length > 0) lines.push('-'.repeat(cols));
  lines.push(row(labels.total, money(slip.orderTotal)));
  if (Math.abs(slip.orderTotal - slip.amount) > 0.005) {
    lines.push(row(labels.payByQr, money(slip.amount)));
  }
  lines.push('');
  lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}' + fit(amountText) + '{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  lines.push('');
  const qrBytes = buildQrRasterBytes(slip.qrPayload, opts.widthDots, opts.maxBandHeight);
  lines.push(`{RAW_BYTES:${Buffer.from(qrBytes).toString('base64')}}`);
  lines.push('{CENTER}' + fit(labels.scan) + '{/CENTER}');
  lines.push('{CUT}');
  const warnings: PrintWarning[] = [];
  const data = buildEscPos(
    lines,
    opts.useUnicode,
    {
      cutMode: opts.cutMode,
      arabicShaping: opts.arabicShaping,
      columns: cols,
      language: opts.language,
      capabilities: opts.capabilities,
    },
    warnings,
  );
  return { lines, data, warnings };
}
