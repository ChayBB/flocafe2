export type PromptPayTarget =
  | { kind: 'phone'; value: string }
  | { kind: 'national_id'; value: string }
  | { kind: 'ewallet'; value: string };

export function parsePromptPayAccount(raw: unknown): PromptPayTarget | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (/^0\d{9}$/.test(digits)) return { kind: 'phone', value: `0066${digits.slice(1)}` };
  if (/^66\d{9}$/.test(digits)) return { kind: 'phone', value: `00${digits}` };
  if (digits.length === 13) return { kind: 'national_id', value: digits };
  if (digits.length === 15) return { kind: 'ewallet', value: digits };
  return null;
}

function field(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

export function crc16Ccitt(text: string): string {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Builds the Thai PromptPay (EMVCo) payload; a positive amount makes the QR dynamic. */
export function buildPromptPayPayload(target: PromptPayTarget, amount?: number): string {
  const subTag = target.kind === 'phone' ? '01' : target.kind === 'national_id' ? '02' : '03';
  const merchant = field('29', field('00', 'A000000677010111') + field(subTag, target.value));
  const hasAmount = typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
  const body =
    field('00', '01') +
    field('01', hasAmount ? '12' : '11') +
    merchant +
    field('53', '764') +
    (hasAmount ? field('54', amount.toFixed(2)) : '') +
    field('58', 'TH');
  return body + '6304' + crc16Ccitt(body + '6304');
}
