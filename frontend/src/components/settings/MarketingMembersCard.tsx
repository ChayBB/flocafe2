'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PromotionDraftForm } from '@/components/settings/PromotionDraftForm';
import { useTranslations, type AppConfig } from 'use-intl';

type SettingsKey = keyof AppConfig['Messages']['settings'];

type PromoGroup = 'automatic' | 'codes';

interface MarketingOption {
  id: string;
  title: SettingsKey;
  hint: SettingsKey;
  href: string | null;
  group?: PromoGroup;
}

// Automatic promotions apply without a code; codes need the customer to show one or redeem points.
const PROMO_TYPES = {
  automatic: [
    'spendThreshold',
    'buyXGetY',
    'bundle',
    'happyHour',
    'memberTier',
    'birthday',
    'channel',
    'flash',
  ],
  codes: ['percent', 'fixed', 'firstVisit', 'winBack', 'branch', 'redeemPoints'],
} as const;

const OPTIONS: MarketingOption[] = [
  {
    id: 'overview',
    title: 'marketingOverview',
    hint: 'marketingOverviewHint',
    href: null,
  },
  { id: 'members', title: 'marketingMembers', hint: 'marketingMembersHint', href: '/customers' },
  {
    id: 'points',
    title: 'marketingPoints',
    hint: 'marketingPointsHint',
    href: '/settings?tab=loyalty',
  },
  {
    id: 'coupons',
    title: 'marketingCoupons',
    hint: 'marketingCouponsHint',
    href: null,
    group: 'codes',
  },
  {
    id: 'promotions',
    title: 'marketingPromotions',
    hint: 'marketingPromotionsHint',
    href: null,
    group: 'automatic',
  },
  { id: 'campaigns', title: 'marketingCampaigns', hint: 'marketingCampaignsHint', href: null },
  { id: 'vouchers', title: 'marketingVouchers', hint: 'marketingVouchersHint', href: null },
  { id: 'reports', title: 'marketingReports', hint: 'marketingReportsHint', href: null },
  {
    id: 'rules',
    title: 'marketingRules',
    hint: 'marketingRulesHint',
    href: '/settings?tab=discounts',
  },
];

/** The Marketing & Members hub: one row per marketing tool, linking to it where it exists. */
export function MarketingMembersCard() {
  const t = useTranslations('settings');
  const tDraft = useTranslations('promotionDraft');
  const [group, setGroup] = useState<PromoGroup | null>(null);
  const [creating, setCreating] = useState(false);
  if (creating) return <PromotionDraftForm onBack={() => setCreating(false)} />;
  if (group) return <PromoTypeList group={group} onBack={() => setGroup(null)} />;
  return (
    <div
      data-testid="settings-marketing-members"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
        <p className="font-semibold text-foreground">{t('marketingMembersTitle')}</p>
        <Button
          type="button"
          size="sm"
          data-testid="marketing-create-promotion"
          onClick={() => setCreating(true)}
        >
          <Plus size={15} className="me-1" />
          {tDraft('create')}
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {OPTIONS.map((option) => {
          const body = (
            <>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">{t(option.title)}</span>
                <span className="block text-sm text-muted-foreground">{t(option.hint)}</span>
              </span>
              {option.href || option.group ? (
                <ChevronRight size={18} className="shrink-0 text-muted-foreground" />
              ) : (
                <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                  {t('comingSoon')}
                </span>
              )}
            </>
          );
          return (
            <li key={option.id} data-testid={`marketing-option-${option.id}`}>
              {option.href ? (
                <Link
                  href={option.href}
                  className="flex items-center gap-3 px-6 py-4 transition-colors hover:bg-muted/60"
                >
                  {body}
                </Link>
              ) : option.group ? (
                <button
                  type="button"
                  onClick={() => setGroup(option.group ?? null)}
                  className="flex w-full items-center gap-3 px-6 py-4 text-start transition-colors hover:bg-muted/60"
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-center gap-3 px-6 py-4">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PromoTypeList({ group, onBack }: { group: PromoGroup; onBack: () => void }) {
  const t = useTranslations('settings');
  const tPromo = useTranslations('marketingPromo');
  return (
    <div
      data-testid={`marketing-promo-${group}`}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="px-6 pt-5 pb-4">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} className="rtl:rotate-180" />
          {tPromo('back')}
        </button>
        <div className="flex items-center gap-2">
          <p className="font-semibold text-foreground">
            {t(group === 'automatic' ? 'marketingPromotions' : 'marketingCoupons')}
          </p>
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
            {t('comingSoon')}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {tPromo(group === 'automatic' ? 'automaticHint' : 'codesHint')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{tPromo('notYetActive')}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs text-muted-foreground">
            <tr>
              <th className="px-6 py-2.5 text-start font-medium">{tPromo('columnType')}</th>
              <th className="px-4 py-2.5 text-start font-medium">{tPromo('columnExample')}</th>
              <th className="px-6 py-2.5 text-start font-medium">{tPromo('columnCondition')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {PROMO_TYPES[group].map((type) => (
              <tr key={type} data-testid={`marketing-promo-type-${type}`}>
                <td className="px-6 py-3 font-medium text-foreground">{tPromo(`${type}.name`)}</td>
                <td className="px-4 py-3 text-foreground">{tPromo(`${type}.example`)}</td>
                <td className="px-6 py-3 text-muted-foreground">{tPromo(`${type}.condition`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
