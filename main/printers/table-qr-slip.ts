import type { PrinterCutMode } from './profiles';
import type { ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import { buildEscPos, truncateShapedLine, wrapText, type PrintWarning } from './formatting-helpers';
import { buildQrRasterBytes } from './payment-request-slip';

export interface TableQrSlipData {
  readonly businessName: string;
  readonly tableName: string;
  readonly url: string;
  /** Store-local time the code stops working, already formatted. */
  readonly validUntil: string;
}

export interface TableQrSlipOptions {
  readonly columns: number;
  readonly language: string;
  readonly useUnicode: boolean;
  readonly arabicShaping: boolean;
  readonly cutMode: PrinterCutMode;
  readonly capabilities?: ThermalPrinterCapabilities;
  readonly widthDots: number;
  readonly maxBandHeight: number;
}

const LABELS: Record<string, { table: string; scan: string; validUntil: string; once: string }> = {
  th: {
    table: 'โต๊ะ',
    scan: 'สแกนเพื่อสั่งอาหาร',
    validUntil: 'ใช้ได้ถึง',
    once: 'QR นี้ใช้ได้เฉพาะโต๊ะนี้จนกว่าจะชำระเงิน',
  },
  en: {
    table: 'Table',
    scan: 'Scan to order',
    validUntil: 'Valid until',
    once: 'This QR works for this table until the bill is paid',
  },
};

export function renderTableQrSlip(
  slip: TableQrSlipData,
  opts: TableQrSlipOptions,
): { lines: string[]; data: Buffer; warnings: PrintWarning[] } {
  const labels = LABELS[opts.language] ?? LABELS.en;
  const fit = (text: string) =>
    truncateShapedLine(text, opts.columns, opts.arabicShaping, opts.language, opts.capabilities);
  const lines: string[] = [];
  if (slip.businessName) lines.push('{CENTER}{BOLD}' + fit(slip.businessName) + '{/BOLD}{/CENTER}');
  lines.push('');
  lines.push(
    '{CENTER}{BOLD}{DOUBLE_HEIGHT}' +
      fit(`${labels.table} ${slip.tableName}`) +
      '{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}',
  );
  lines.push('{CENTER}' + fit(labels.scan) + '{/CENTER}');
  lines.push('');
  const qrBytes = buildQrRasterBytes(slip.url, opts.widthDots, opts.maxBandHeight);
  lines.push(`{RAW_BYTES:${Buffer.from(qrBytes).toString('base64')}}`);
  lines.push('');
  lines.push('{CENTER}' + fit(`${labels.validUntil} ${slip.validUntil}`) + '{/CENTER}');
  for (const part of wrapText(labels.once, opts.columns))
    lines.push('{CENTER}' + part + '{/CENTER}');
  lines.push('{CUT}');
  const warnings: PrintWarning[] = [];
  const data = buildEscPos(
    lines,
    opts.useUnicode,
    {
      cutMode: opts.cutMode,
      arabicShaping: opts.arabicShaping,
      columns: opts.columns,
      language: opts.language,
      capabilities: opts.capabilities,
    },
    warnings,
  );
  return { lines, data, warnings };
}
