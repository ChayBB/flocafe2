import { getSettingValue } from '../db';
import { parseBankAccount, parsePromptPayAccount, type PromptPayTarget } from './promptpay';

export const QR_ACCOUNT_SETTING = 'qr_payment_account';
export const BANK_QR_ACCOUNT_SETTING = 'bank_qr_account';

export type PaymentQrKind = 'promptpay' | 'bank';

export interface BankQrAccount {
  bank_code: string;
  account_number: string;
}

export function parsePaymentQrKind(value: unknown): PaymentQrKind {
  return value === 'bank' ? 'bank' : 'promptpay';
}

export function readBankQrAccount(): BankQrAccount | null {
  const raw = getSettingValue(BANK_QR_ACCOUNT_SETTING);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BankQrAccount>;
    if (typeof parsed.bank_code !== 'string' || typeof parsed.account_number !== 'string') return null;
    return { bank_code: parsed.bank_code, account_number: parsed.account_number };
  } catch {
    return null;
  }
}

/** The account a payment QR pays into: the PromptPay ID, or the bank account for bank transfers. */
export function resolvePaymentQrTarget(kind: PaymentQrKind): PromptPayTarget | null {
  if (kind === 'bank') {
    const account = readBankQrAccount();
    return account ? parseBankAccount(account.bank_code, account.account_number) : null;
  }
  return parsePromptPayAccount(getSettingValue(QR_ACCOUNT_SETTING));
}

export function missingQrAccountCode(kind: PaymentQrKind): string {
  return kind === 'bank' ? 'bank_qr_account_missing' : 'qr_account_missing';
}
