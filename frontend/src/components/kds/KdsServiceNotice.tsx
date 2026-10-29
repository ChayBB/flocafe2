'use client';

import { AlertTriangle, CheckCheck } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { KdsOrderItem } from '@/hooks/useKdsConnection';

/** Orange strip for an item service staff changed after sending; null when it has no change. */
export function serviceNoticeRowClass(item: KdsOrderItem): string | null {
  return item.service_change
    ? 'border-orange-400 bg-orange-100 dark:border-orange-600 dark:bg-orange-950/60 border-s-4'
    : null;
}

/**
 * A service staff change, shown like a special instruction (changed to takeaway, or cancelled),
 * and the staff confirmation that a served item reached the table.
 */
export function KdsServiceNotice({ item }: { item: KdsOrderItem }) {
  const t = useTranslations('kds');
  return (
    <>
      {item.service_change && (
        <p
          data-testid="kds-service-notice"
          className="ms-[26px] mt-0.5 flex items-center gap-1 text-sm font-bold text-orange-700 dark:text-orange-300"
        >
          <AlertTriangle size={14} aria-hidden="true" />
          {item.service_change === 'cancelled' ? t('noticeCancelled') : t('noticeTakeaway')}
        </p>
      )}
      {item.served_confirmed_at && (
        <p
          data-testid="kds-served-confirmed"
          className="ms-[26px] mt-0.5 flex items-center gap-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300"
        >
          <CheckCheck size={14} aria-hidden="true" />
          {t('servedConfirmed')}
        </p>
      )}
    </>
  );
}
