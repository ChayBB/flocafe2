'use client';

import { useEffect, useState } from 'react';
import { CreditCard, Plus, Save, Trash2, Merge } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import { useTranslations } from 'use-intl';
import { useFormatDate } from '@/hooks/useFormatDate';
import {
  THAI_BANKS,
  isBankAccountMethod,
  isQrCodeMethod,
  type CustomPaymentMethod,
} from '@/lib/payment-methods';

type BankQrAccount = { bank_code: string; account_number: string };
const EMPTY_BANK_ACCOUNT: BankQrAccount = { bank_code: '', account_number: '' };

interface MergeRecord {
  id: number;
  source_name: string;
  target_name: string;
  affected_payments: number;
  merged_at: string;
}

export function PaymentMethodsSettings({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const { formatDate } = useFormatDate();

  const builtInMethods = [
    { key: 'cash', labelKey: 'methodCash' },
    { key: 'card', labelKey: 'methodCard' },
    { key: 'wallet', labelKey: 'loyaltyWallet' },
  ] as const;
  const [methods, setMethods] = useState<CustomPaymentMethod[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  const [newName, setNewName] = useState('');
  const [mergeTargets, setMergeTargets] = useState<Record<number, string>>({});
  const [merges, setMerges] = useState<MergeRecord[]>([]);
  const [splitChecksEnabled, setSplitChecksEnabled] = useState(false);
  const [qrAccount, setQrAccount] = useState('');
  const [qrAccountSaved, setQrAccountSaved] = useState('');
  const [bankAccount, setBankAccount] = useState<BankQrAccount>(EMPTY_BANK_ACCOUNT);
  const [bankAccountSaved, setBankAccountSaved] = useState<BankQrAccount>(EMPTY_BANK_ACCOUNT);

  const load = async () => {
    const [methodsRes, historyRes, splitRes, qrRes, bankRes] = await Promise.all([
      api.get('/payment-methods?include_inactive=true'),
      api.get('/payment-methods/merge-history'),
      api
        .get('/settings/split_checks_enabled')
        .catch(() => ({ data: { setting: { value: 'false' } } })),
      api.get('/payment-methods/qr-account').catch(() => ({ data: { account: '' } })),
      api
        .get('/payment-methods/bank-qr-account')
        .catch(() => ({ data: { account: EMPTY_BANK_ACCOUNT } })),
    ]);
    setQrAccount(qrRes.data?.account || '');
    setQrAccountSaved(qrRes.data?.account || '');
    const savedBank = { ...EMPTY_BANK_ACCOUNT, ...(bankRes.data?.account || {}) };
    setBankAccount(savedBank);
    setBankAccountSaved(savedBank);
    const rows = methodsRes.data.payment_methods || [];
    setMethods(rows);
    setNames(Object.fromEntries(rows.map((row: CustomPaymentMethod) => [row.id, row.name])));
    setMerges(historyRes.data.merges || []);
    setSplitChecksEnabled(splitRes.data?.setting?.value === 'true');
  };

  useEffect(() => {
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    void load().catch(() => toast.error(t('loadFailed')));
  }, []); // oxlint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!newName.trim()) return;
    try {
      await api.post('/payment-methods', { name: newName });
      setNewName('');
      await load();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const update = async (method: CustomPaymentMethod, changes: Record<string, unknown>) => {
    try {
      await api.put(`/payment-methods/${method.id}`, changes);
      await load();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const saveQrAccount = async () => {
    try {
      const { data } = await api.put('/payment-methods/qr-account', { account: qrAccount });
      setQrAccount(data.account);
      setQrAccountSaved(data.account);
      toast.success(t('qrAccountSaved'));
    } catch {
      toast.error(t('qrAccountInvalid'));
    }
  };

  const saveBankAccount = async () => {
    try {
      const { data } = await api.put('/payment-methods/bank-qr-account', bankAccount);
      const saved = { ...EMPTY_BANK_ACCOUNT, ...(data.account || {}) };
      setBankAccount(saved);
      setBankAccountSaved(saved);
      toast.success(t('bankQrAccountSaved'));
    } catch {
      toast.error(t('bankQrAccountInvalid'));
    }
  };

  const remove = async (method: CustomPaymentMethod) => {
    if (!window.confirm(t('deletePaymentMethodConfirm'))) return;
    try {
      await api.delete(`/payment-methods/${method.id}`);
      await load();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const merge = async (method: CustomPaymentMethod) => {
    const target = mergeTargets[method.id];
    if (!target) return;
    if (!window.confirm(t('mergePaymentMethodConfirm'))) return;
    try {
      await api.post(
        `/payment-methods/${method.id}/merge`,
        target === 'card'
          ? { target_type: 'card' }
          : { target_type: 'custom', target_id: Number(target) },
      );
      await load();
      toast.success(t('paymentMethodMerged'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  return (
    <SettingsTabShell>
      <div className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-center gap-2 mb-2">
          <CreditCard size={20} className="text-muted-foreground" />
          <h2 className="font-semibold text-foreground">{t('paymentMethods')}</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-5">{t('paymentMethodsHint')}</p>
        <div className="rounded-lg border border-border divide-y">
          {builtInMethods.map((method) => (
            <div key={method.key} className="px-3 py-2 flex justify-between text-sm">
              <span>{tPos(method.labelKey)}</span>
              <span className="text-xs text-gray-400">{t('builtIn')}</span>
            </div>
          ))}
        </div>
        <div className="mt-5 space-y-3">
          {methods.map((method) => (
            <div key={method.id} className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex gap-2 items-center">
                <input
                  disabled={!isAdmin}
                  value={names[method.id] ?? method.name}
                  onChange={(e) => setNames((old) => ({ ...old, [method.id]: e.target.value }))}
                  className="flex-1 px-3 py-2 text-sm border rounded-lg"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!isAdmin || names[method.id] === method.name}
                  onClick={() => update(method, { name: names[method.id] })}
                >
                  <Save size={14} />
                </Button>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    disabled={!isAdmin}
                    checked={method.is_active}
                    onChange={(e) => update(method, { is_active: e.target.checked })}
                  />{' '}
                  {t('active')}
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!isAdmin || Boolean(method.usage_count)}
                  onClick={() => remove(method)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              {isQrCodeMethod(method.name) && (
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-foreground">
                    {t('qrAccountLabel')}
                  </label>
                  <div className="flex gap-2 items-center">
                    <input
                      disabled={!isAdmin}
                      inputMode="numeric"
                      value={qrAccount}
                      onChange={(e) => setQrAccount(e.target.value)}
                      placeholder={t('qrAccountPlaceholder')}
                      className="flex-1 px-3 py-2 text-sm border rounded-lg"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!isAdmin || qrAccount === qrAccountSaved}
                      onClick={saveQrAccount}
                    >
                      <Save size={14} />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('qrAccountHint')}</p>
                </div>
              )}
              {isBankAccountMethod(method.name) && (
                <div className="space-y-1" data-testid="bank-qr-account-form">
                  <label className="block text-xs font-medium text-foreground">
                    {t('bankQrAccountLabel')}
                  </label>
                  <div className="flex flex-wrap gap-2 items-center">
                    <select
                      disabled={!isAdmin}
                      value={bankAccount.bank_code}
                      onChange={(e) =>
                        setBankAccount((old) => ({ ...old, bank_code: e.target.value }))
                      }
                      aria-label={t('bankQrBankLabel')}
                      className="px-2 py-2 text-sm border rounded-lg bg-card"
                    >
                      <option value="">{t('bankQrSelectBank')}</option>
                      {THAI_BANKS.map((bank) => (
                        <option key={bank.code} value={bank.code}>
                          {bank.short} · {bank.name}
                        </option>
                      ))}
                    </select>
                    <input
                      disabled={!isAdmin}
                      inputMode="numeric"
                      value={bankAccount.account_number}
                      onChange={(e) =>
                        setBankAccount((old) => ({
                          ...old,
                          account_number: e.target.value.replace(/[^\d-]/g, '').slice(0, 20),
                        }))
                      }
                      placeholder={t('bankQrAccountNumberPlaceholder')}
                      aria-label={t('bankQrAccountNumberPlaceholder')}
                      className="flex-1 min-w-40 px-3 py-2 text-sm border rounded-lg"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t('bankQrAccountLabel')}
                      disabled={
                        !isAdmin ||
                        (bankAccount.bank_code === bankAccountSaved.bank_code &&
                          bankAccount.account_number === bankAccountSaved.account_number)
                      }
                      onClick={saveBankAccount}
                    >
                      <Save size={14} />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('bankQrAccountHint')}</p>
                </div>
              )}
              {Boolean(method.usage_count) && isAdmin && (
                <div className="flex gap-2 items-center">
                  <select
                    value={mergeTargets[method.id] || ''}
                    onChange={(e) =>
                      setMergeTargets((old) => ({ ...old, [method.id]: e.target.value }))
                    }
                    className="flex-1 px-2 py-1.5 text-xs border rounded-md bg-card"
                  >
                    <option value="">{t('mergeInto')}…</option>
                    <option value="card">{tPos('methodCard')}</option>
                    {methods
                      .filter((target) => target.id !== method.id)
                      .map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!mergeTargets[method.id]}
                    onClick={() => merge(method)}
                  >
                    <Merge size={14} className="me-1" />
                    {t('merge')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          {isAdmin && (
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add();
                }}
                placeholder={t('paymentMethodName')}
                className="flex-1 px-3 py-2 text-sm border rounded-lg"
              />
              <Button onClick={add} disabled={!newName.trim()}>
                <Plus size={14} className="me-1" />
                {tCommon('add')}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-foreground">{t('splitChecks')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('splitChecksHint')}</p>
        </div>
        <input
          type="checkbox"
          className="size-5"
          disabled={!isAdmin}
          checked={splitChecksEnabled}
          onChange={async (e) => {
            const value = e.target.checked;
            setSplitChecksEnabled(value);
            try {
              await api.put('/settings/split_checks_enabled', { value: String(value) });
            } catch {
              setSplitChecksEnabled(!value);
              toast.error(t('saveFailed'));
            }
          }}
        />
      </div>

      {merges.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-6">
          <h2 className="font-semibold text-foreground mb-3">{t('mergeHistory')}</h2>
          <div className="space-y-2 text-sm text-muted-foreground">
            {merges.map((entry) => (
              <p key={entry.id}>
                {entry.source_name} → {entry.target_name} · {entry.affected_payments} ·{' '}
                {formatDate(entry.merged_at)}
              </p>
            ))}
          </div>
        </div>
      )}
    </SettingsTabShell>
  );
}
