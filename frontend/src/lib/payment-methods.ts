import { Banknote, CreditCard } from 'lucide-react';

export const PAYMENT_METHODS = Object.freeze([
  { key: 'cash' as const, labelKey: 'pos.methodCash', icon: Banknote },
  { key: 'card' as const, labelKey: 'pos.methodCard', icon: CreditCard },
]);

export interface CustomPaymentMethod {
  id: number;
  name: string;
  is_active: boolean;
  sort_order: number;
  usage_count?: number;
}

export function isQrCodeMethod(name: string | null | undefined): boolean {
  return (name ?? '').trim().toLowerCase() === 'qr code';
}

const BANK_ACCOUNT_METHOD_NAMES = new Set([
  'บัญชีธนาคาร',
  'โอนเข้าบัญชี',
  'โอนเงิน',
  'bank account',
  'bank transfer',
]);

/** A custom method with one of these names collects by QR into the shop's bank account. */
export function isBankAccountMethod(name: string | null | undefined): boolean {
  return BANK_ACCOUNT_METHOD_NAMES.has((name ?? '').trim().toLowerCase());
}

/** Thai banks a bank-account payment QR can pay into (Bank of Thailand codes). */
export const THAI_BANKS: ReadonlyArray<{ code: string; short: string; name: string }> = [
  { code: '002', short: 'BBL', name: 'ธนาคารกรุงเทพ' },
  { code: '004', short: 'KBANK', name: 'ธนาคารกสิกรไทย' },
  { code: '006', short: 'KTB', name: 'ธนาคารกรุงไทย' },
  { code: '011', short: 'ttb', name: 'ธนาคารทหารไทยธนชาต' },
  { code: '014', short: 'SCB', name: 'ธนาคารไทยพาณิชย์' },
  { code: '025', short: 'BAY', name: 'ธนาคารกรุงศรีอยุธยา' },
  { code: '030', short: 'GSB', name: 'ธนาคารออมสิน' },
  { code: '033', short: 'GHB', name: 'ธนาคารอาคารสงเคราะห์' },
  { code: '034', short: 'BAAC', name: 'ธ.ก.ส.' },
  { code: '022', short: 'CIMBT', name: 'ธนาคารซีไอเอ็มบี ไทย' },
  { code: '024', short: 'UOB', name: 'ธนาคารยูโอบี' },
  { code: '066', short: 'ISBT', name: 'ธนาคารอิสลามแห่งประเทศไทย' },
  { code: '067', short: 'TISCO', name: 'ธนาคารทิสโก้' },
  { code: '069', short: 'KKP', name: 'ธนาคารเกียรตินาคินภัทร' },
  { code: '073', short: 'LH Bank', name: 'ธนาคารแลนด์ แอนด์ เฮ้าส์' },
];
