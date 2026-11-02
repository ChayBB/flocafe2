'use client';

import { useTranslations } from 'use-intl';
import type { OrderItem } from '@/lib/types';
import { itemStatusDot } from '@/components/orders/OrderCard';

const STAGES = ['pending', 'preparing', 'ready', 'served'] as const;

/** How far an order's food has got: a thin bar split by stage and a count per stage. */
export function OrderFoodStatusBar({ items }: { items: OrderItem[] }) {
  const t = useTranslations('orders');
  const counts = STAGES.map((stage) => items.filter((item) => item.status === stage).length);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;

  return (
    <div data-testid="order-food-status" aria-label={t('foodStatus')} className="space-y-1.5">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        {STAGES.map((stage, index) =>
          counts[index] > 0 ? (
            <div
              key={stage}
              className={itemStatusDot[stage].dot}
              style={{ width: `${(counts[index] / total) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {STAGES.map((stage, index) => (
          <span
            key={stage}
            data-testid={`order-food-status-${stage}`}
            className={`inline-flex items-center gap-1 ${
              counts[index] > 0 ? 'text-foreground' : 'text-muted-foreground/60'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${itemStatusDot[stage].dot}`} />
            {t(itemStatusDot[stage].labelKey)}
            <span className="font-semibold tabular-nums">{counts[index]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
