'use client';

import { useId, useState } from 'react';
import { ArrowLeft, CircleAlert, Copy, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const PROMOTION_KINDS = ['coupon', 'automatic', 'member', 'bundle'] as const;
type PromotionKind = (typeof PROMOTION_KINDS)[number];

const KIND_LABEL = {
  coupon: 'kindCoupon',
  automatic: 'kindAutomatic',
  member: 'kindMember',
  bundle: 'kindBundle',
} as const;

interface Draft {
  kind: PromotionKind;
  code: string;
  minSpend: string;
  percent: string;
  maxDiscount: string;
  usesPerMember: string;
  combinable: boolean;
}

const EXAMPLE: Draft = {
  kind: 'coupon',
  code: 'WELCOME10',
  minSpend: '300',
  percent: '10',
  maxDiscount: '100',
  usesPerMember: '1',
  combinable: false,
};

const toNumber = (value: string) => (value.trim() === '' ? null : Number(value));

/** A preview-only promotion form: it checks the values and copies them as config, but saves nothing. */
export function PromotionDraftForm({ onBack }: { onBack: () => void }) {
  const t = useTranslations('promotionDraft');
  const id = useId();
  const [draft, setDraft] = useState<Draft>(EXAMPLE);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const minSpend = toNumber(draft.minSpend);
  const percent = toNumber(draft.percent);
  const maxDiscount = toNumber(draft.maxDiscount);
  const usesPerMember = toNumber(draft.usesPerMember);

  const errors: string[] = [];
  if (!draft.code.trim()) errors.push(t('errorName'));
  if (percent === null || !(percent > 0 && percent <= 100)) errors.push(t('errorPercent'));
  if (minSpend !== null && !(minSpend >= 0)) errors.push(t('errorMinSpend'));
  if (maxDiscount !== null && !(maxDiscount > 0)) errors.push(t('errorMaxDiscount'));
  if (usesPerMember !== null && !(Number.isInteger(usesPerMember) && usesPerMember > 0)) {
    errors.push(t('errorUses'));
  }

  const config = {
    type: draft.kind,
    code: draft.code.trim(),
    min_spend: minSpend,
    discount_percent: percent,
    max_discount: maxDiscount,
    uses_per_member: usesPerMember,
    combinable: draft.combinable,
  };

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  const field = (key: 'minSpend' | 'percent' | 'maxDiscount' | 'usesPerMember', label: string) => (
    <div>
      <label htmlFor={`${id}-${key}`} className="mb-1 block text-sm text-muted-foreground">
        {label}
      </label>
      <Input
        id={`${id}-${key}`}
        type="number"
        inputMode="decimal"
        min={0}
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        className="rounded-full"
      />
    </div>
  );

  return (
    <div
      data-testid="promotion-draft-form"
      className="space-y-4 rounded-xl border border-border bg-card p-6"
    >
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} className="rtl:rotate-180" />
        {t('back')}
      </button>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
          {t('draft')}
        </span>
      </div>

      <fieldset className="space-y-2.5">
        <legend className="mb-2 text-sm text-muted-foreground">{t('kind')}</legend>
        {PROMOTION_KINDS.map((kind) => (
          <label key={kind} className="flex cursor-pointer items-center gap-3 text-foreground">
            <input
              type="radio"
              name={`${id}-kind`}
              value={kind}
              checked={draft.kind === kind}
              onChange={() => set({ kind })}
              className="size-5 accent-neutral-900"
            />
            {t(KIND_LABEL[kind])}
          </label>
        ))}
      </fieldset>

      <div>
        <label htmlFor={`${id}-code`} className="mb-1 block text-sm text-muted-foreground">
          {t('name')}
        </label>
        <Input
          id={`${id}-code`}
          value={draft.code}
          onChange={(e) => set({ code: e.target.value })}
          className="rounded-full"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {field('minSpend', t('minSpend'))}
        {field('percent', t('percent'))}
        {field('maxDiscount', t('maxDiscount'))}
        {field('usesPerMember', t('usesPerMember'))}
      </div>

      <label className="flex cursor-pointer items-center gap-3 text-foreground">
        <input
          type="checkbox"
          checked={draft.combinable}
          onChange={(e) => set({ combinable: e.target.checked })}
          className="size-5 accent-neutral-900"
        />
        {t('combinable')}
      </label>

      <div data-testid="promotion-draft-preview" className="space-y-1.5 px-2 text-sm">
        <p className="flex items-center gap-2 font-semibold text-foreground">
          {errors.length ? (
            <CircleAlert size={16} className="text-red-600" />
          ) : (
            <ShieldCheck size={16} className="text-green-600" />
          )}
          {t('previewTitle')}
        </p>
        {errors.length ? (
          errors.map((error) => (
            <p key={error} className="text-red-600">
              {error}
            </p>
          ))
        ) : (
          <>
            <p>{t('previewMinSpend', { amount: minSpend ?? 0 })}</p>
            <p>
              {maxDiscount === null
                ? t('previewPercent', { percent: percent ?? 0 })
                : t('previewPercentCapped', { percent: percent ?? 0, max: maxDiscount })}
            </p>
            {usesPerMember !== null && <p>{t('previewUses', { count: usesPerMember })}</p>}
            <p>{draft.combinable ? t('previewCombinable') : t('previewNotCombinable')}</p>
          </>
        )}
      </div>

      <Button
        type="button"
        onClick={() => void copyConfig()}
        disabled={errors.length > 0}
        className="w-full rounded-full"
      >
        <Copy size={16} className="me-1.5" />
        {t('copyConfig')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('notSaved')}</p>
    </div>
  );
}
