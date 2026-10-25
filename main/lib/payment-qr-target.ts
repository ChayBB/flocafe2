import { getSettingValue } from '../db';
import { parsePromptPayAccount, type PromptPayTarget } from './promptpay';

export const QR_ACCOUNT_SETTING = 'qr_payment_account';
/**
 * The PromptPay ID (phone, national/tax ID or e-wallet) registered to the shop's bank account.
 * A plain bank account number cannot be paid through a PromptPay QR: that proxy type is reserved.
 */
export const BANK_QR_ACCOUNT_SETTING = 'bank_qr_account';

export type PaymentQrKind = 'promptpay' | 'bank';

export function parsePaymentQrKind(value: unknown): PaymentQrKind {
  return value === 'bank' ? 'bank' : 'promptpay';
}

function settingFor(kind: PaymentQrKind): string {
  return kind === 'bank' ? BANK_QR_ACCOUNT_SETTING : QR_ACCOUNT_SETTING;
}

export function readPaymentQrAccount(kind: PaymentQrKind): string {
  const value = getSettingValue(settingFor(kind)) || '';
  return parsePromptPayAccount(value) ? value : '';
}

/** The PromptPay target a payment QR pays into for the "QR Code" or "Bank account" method. */
export function resolvePaymentQrTarget(kind: PaymentQrKind): PromptPayTarget | null {
  return parsePromptPayAccount(getSettingValue(settingFor(kind)));
}

export function missingQrAccountCode(kind: PaymentQrKind): string {
  return kind === 'bank' ? 'bank_qr_account_missing' : 'qr_account_missing';
}
