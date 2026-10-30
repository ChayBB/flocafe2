'use client';

import { AlertTriangle, CheckCheck, CircleCheckBig } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { KdsOrderItem } from '@/hooks/useKdsConnection';
import { parseDbTimestamp } from '@/lib/utils';

/**
 * Orange strip for an item service staff changed after sending, green for one they confirmed at
 * the table; null for an ordinary item.
 */
export function serviceNoticeRowClass(item: KdsOrderItem): string | null {
  if (item.service_change) {
    return 'border-orange-400 bg-orange-100 dark:border-orange-600 dark:bg-orange-950/60 border-s-4';
  }
  if (item.served_confirmed_at) {
    return 'border-emerald-500 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-950/50 border-s-4';
  }
  return null;
}

/** Tick on the start edge of a menu line service staff confirmed at the table; the row must be `relative`. */
export function KdsServedCheck({ item }: { item: KdsOrderItem }) {
  const t = useTranslations('kds');
  if (!item.served_confirmed_at || item.service_change) return null;
  return (
    <CircleCheckBig
      data-testid="kds-served-check"
      size={22}
      strokeWidth={2.5}
      role="img"
      aria-label={t('servedConfirmedMark')}
      className="absolute -start-2.5 top-1/2 -translate-y-1/2 rounded-full bg-card text-emerald-600 dark:text-emerald-400"
    />
  );
}

function confirmedTime(item: KdsOrderItem): string {
  if (!item.served_confirmed_at) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(item.store_timezone ? { timeZone: item.store_timezone } : {}),
    }).format(parseDbTimestamp(item.served_confirmed_at));
  } catch {
    return '';
  }
}

/**
 * Service staff notes that sit on the menu line itself: a change made after sending (takeaway or
 * cancelled), and who confirmed a served item reached the table, and when.
 */
export function KdsServiceNotice({ item }: { item: KdsOrderItem }) {
  const t = useTranslations('kds');
  return (
    <>
      {item.service_change && (
        <span
          data-testid="kds-service-notice"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-orange-200 px-2 py-0.5 text-xs font-bold text-orange-800 dark:bg-orange-900 dark:text-orange-200"
        >
          <AlertTriangle size={12} aria-hidden="true" />
          {item.service_change === 'cancelled' ? t('noticeCancelled') : t('noticeTakeaway')}
        </span>
      )}
      {item.served_confirmed_at && (
        <span
          data-testid="kds-served-confirmed"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        >
          <CheckCheck size={12} aria-hidden="true" />
          {t('servedConfirmedBy', {
            name: item.served_confirmed_by_name || '—',
            time: confirmedTime(item),
          })}
        </span>
      )}
    </>
  );
}
