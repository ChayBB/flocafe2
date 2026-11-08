import { useTranslations } from 'use-intl';
import { Badge } from '@/components/ui/badge';
import type { Order } from '@/lib/types';

export function OrderTableChangeBadges({ order }: { order: Order }) {
  const t = useTranslations('kds');
  return (
    <>
      {order.moved_from_table && (
        <Badge variant="outline">{t('movedFromTable', { name: order.moved_from_table })}</Badge>
      )}
      {order.merged_from_table && (
        <Badge variant="outline">{t('mergedFromTable', { name: order.merged_from_table })}</Badge>
      )}
    </>
  );
}
