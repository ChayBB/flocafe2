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

/**
 * A custom method with one of these names collects by PromptPay QR into the shop's bank account,
 * using the PromptPay ID registered to that account.
 */
export function isBankAccountMethod(name: string | null | undefined): boolean {
  return BANK_ACCOUNT_METHOD_NAMES.has((name ?? '').trim().toLowerCase());
}
