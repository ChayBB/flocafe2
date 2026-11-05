import { getSettingValue } from '../db';
import { parsePromptPayAccount, type PromptPayTarget } from './promptpay';

export const QR_ACCOUNT_SETTING = 'qr_payment_account';
/**
 * The PromptPay ID (phone, national/tax ID or e-wallet) registered to the shop's bank account.
 * A plain bank account number cannot be paid through a PromptPay QR: that proxy type is reserved.
 */
export const BANK_QR_ACCOUNT_SETTING = 'bank_qr_account';

/** Name of the PromptPay account holder, printed under the payment QR so customers see who they pay. */
export const QR_ACCOUNT_NAME_SETTING = 'qr_payment_account_name';
export const QR_ACCOUNT_NAME_MAX_LENGTH = 60;

export function normalizeQrAccountName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim().replace(/\s+/g, ' '))
    .slice(0, QR_ACCOUNT_NAME_MAX_LENGTH)
    .join('')
    .trim();
}

/** The holder name for a payment QR; only the PromptPay QR account has one. */
export function readPaymentQrAccountName(kind: PaymentQrKind = 'promptpay'): string {
  return kind === 'promptpay'
    ? normalizeQrAccountName(getSettingValue(QR_ACCOUNT_NAME_SETTING))
    : '';
}

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
