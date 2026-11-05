import * as QRCode from 'qrcode';
import { formatMoney, type CurrencyDisplay, type DigitMode } from '../countries';
import type { PrinterCutMode } from './profiles';
import type { ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import { encodeGsV0Band, type RasterBand } from '../../shared/print/raster';
import { displayCellWidth } from '../../shared/print/width';
import { buildEscPos, truncateShapedLine, wrapText, type PrintWarning } from './formatting-helpers';

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
  /** Account holder printed under the "scan to pay" line; empty prints nothing. */
  readonly accountName?: string;
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

/** The line printed under a payment QR, in the print language when it has one. */
export function paymentQrCaption(language: string): string {
  return (LABELS[language] ?? LABELS.en).scan;
}

export interface PaymentRequestSlipHtmlOptions {
  readonly language: string;
  readonly locale: string;
  readonly currency: string;
  readonly currencyDisplay?: CurrencyDisplay;
  readonly digits?: DigitMode;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The same slip as a page, for document printers (PDF, XPS) that cannot take ESC/POS. */
export async function renderPaymentRequestSlipHtml(
  slip: PaymentRequestSlipData,
  opts: PaymentRequestSlipHtmlOptions,
): Promise<string> {
  const labels = LABELS[opts.language] ?? LABELS.en;
  const money = (value: number) =>
    escapeHtml(
      formatMoney(value, opts.currency, opts.locale, {
        currencyDisplay: opts.currencyDisplay,
        digits: opts.digits,
      }),
    );
  const qr = await QRCode.toDataURL(slip.qrPayload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 480,
  });
  const row = (left: string, right: string) =>
    `<tr><td>${left}</td><td class="num">${right}</td></tr>`;
  const header = [
    slip.businessName ? `<div class="shop">${escapeHtml(slip.businessName)}</div>` : '',
    slip.businessAddress ? `<div>${escapeHtml(slip.businessAddress)}</div>` : '',
    slip.businessPhone ? `<div>${escapeHtml(`${labels.tel}: ${slip.businessPhone}`)}</div>` : '',
    slip.taxId ? `<div>${escapeHtml(`${labels.taxId}: ${slip.taxId}`)}</div>` : '',
  ].join('');
  const items = slip.items
    .map((item) =>
      row(
        escapeHtml(`${item.quantity}x ${item.name}`) +
          item.addons.map((addon) => `<div class="addon">+ ${escapeHtml(addon)}</div>`).join(''),
        money(item.total),
      ),
    )
    .join('');
  const totals =
    row(escapeHtml(labels.total), money(slip.orderTotal)) +
    (Math.abs(slip.orderTotal - slip.amount) > 0.005
      ? row(escapeHtml(labels.payByQr), money(slip.amount))
      : '');
  return `<!doctype html><html lang="${escapeHtml(opts.language)}"><head><meta charset="utf-8"><title>${escapeHtml(labels.title)}</title><style>
    body{font-family:sans-serif;font-size:12px;max-width:80mm;margin:0 auto;padding:4mm;color:#000}
    .center{text-align:center}.shop{font-size:16px;font-weight:700}
    h1{font-size:15px;margin:10px 0;text-align:center}
    table{width:100%;border-collapse:collapse}td{padding:2px 0;vertical-align:top}.num{text-align:end;white-space:nowrap}
    .addon{color:#555;font-size:11px}.totals td{border-top:1px solid #000;font-weight:700}
    .amount{font-size:22px;font-weight:700;text-align:center;margin:10px 0}.account-name{font-weight:700}img{display:block;width:60mm;max-width:100%;margin:0 auto}
  </style></head><body><div class="center">${header}</div><h1>${escapeHtml(labels.title)}</h1>
  <div>${escapeHtml(`${labels.order}: ${slip.orderNumber}`)}</div>${slip.tableName ? `<div>${escapeHtml(`${labels.table}: ${slip.tableName}`)}</div>` : ''}${slip.createdAt ? `<div>${escapeHtml(slip.createdAt)}</div>` : ''}
  <table>${items}</table><table class="totals">${totals}</table>
  <div class="amount">${money(slip.amount)}</div><img src="${qr}" alt="QR"><div class="center">${escapeHtml(labels.scan)}</div>${slip.accountName ? `<div class="center account-name">${escapeHtml(slip.accountName)}</div>` : ''}</body></html>`;
}

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
    const label = fit(
      left.length > 0 && displayCellWidth(left) > room ? truncateToWidth(left, room) : left,
    );
    const gap = Math.max(1, cols - displayCellWidth(label) - displayCellWidth(right));
    return label + ' '.repeat(gap) + right;
  };
  const lines: string[] = [];
  if (slip.businessName) lines.push('{CENTER}{BOLD}' + fit(slip.businessName) + '{/BOLD}{/CENTER}');
  for (const part of wrapText(slip.businessAddress, cols)) {
    if (part.trim()) lines.push('{CENTER}' + part + '{/CENTER}');
  }
  if (slip.businessPhone)
    lines.push('{CENTER}' + fit(`${labels.tel}: ${slip.businessPhone}`) + '{/CENTER}');
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
  lines.push(
    '{CENTER}{BOLD}{DOUBLE_HEIGHT}' + fit(amountText) + '{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}',
  );
  lines.push('');
  const qrBytes = buildQrRasterBytes(slip.qrPayload, opts.widthDots, opts.maxBandHeight);
  lines.push(`{RAW_BYTES:${Buffer.from(qrBytes).toString('base64')}}`);
  lines.push('{CENTER}' + fit(labels.scan) + '{/CENTER}');
  for (const part of wrapText(slip.accountName ?? '', cols)) {
    if (part.trim()) lines.push('{CENTER}{BOLD}' + part + '{/BOLD}{/CENTER}');
  }
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
