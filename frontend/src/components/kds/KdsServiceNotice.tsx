'use client';

import { AlertTriangle, CheckCheck } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { KdsOrderItem } from '@/hooks/useKdsConnection';
import { parseDbTimestamp } from '@/lib/utils';

/**
 * Orange strip for an item service staff changed after sending, green for one they confirmed at
 * the table; null for an ordinary item.
 */
export function serviceNoticeRowClass(item: KdsOrderItem): string | null {
  if (item.service_change) {
    return 'border-(--kds-alert-line) bg-(--kds-alert-bg) border-s-4';
  }
  if (item.served_confirmed_at) {
    return 'border-(--kds-confirmed-line) bg-(--kds-confirmed-bg)';
  }
  return null;
}

/** Row styling for the KDS boards: plain rows, with a coloured box only for a service notice. */
export function noticeRowClass(item: KdsOrderItem): string {
  const notice = serviceNoticeRowClass(item);
  return notice ? `my-1 rounded-lg border ${notice}` : '';
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
 * Service staff notes on the menu line itself: a change made after sending (takeaway or
 * cancelled), and when a served item was confirmed at the table and by whom.
 */
export function KdsServiceNotice({ item }: { item: KdsOrderItem }) {
  const t = useTranslations('kds');
  return (
    <>
      {item.service_change && (
        <span
          data-testid="kds-service-notice"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-(--kds-alert-chip) px-2 py-0.5 text-xs font-bold text-(--kds-alert-text)"
        >
          <AlertTriangle size={12} aria-hidden="true" />
          {item.service_change === 'cancelled' ? t('noticeCancelled') : t('noticeTakeaway')}
        </span>
      )}
      {item.served_confirmed_at && (
        <span
          data-testid="kds-served-confirmed"
          title={t('servedConfirmedMark')}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-semibold text-(--kds-confirmed-text)"
        >
          <CheckCheck size={16} strokeWidth={2.5} aria-label={t('servedConfirmedMark')} />
          {[confirmedTime(item), item.served_confirmed_by_name].filter(Boolean).join(' · ')}
        </span>
      )}
    </>
  );
}
