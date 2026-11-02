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
    <div
      data-testid="order-food-status"
      aria-label={t('foodStatus')}
      className="mt-1 space-y-2 border-t border-border/60 pt-2.5"
    >
      {/* Colours sit at 75% so the bar reads as a hint, not a warning. */}
      <div className="flex h-1 gap-0.5">
        {STAGES.map((stage, index) =>
          counts[index] > 0 ? (
            <div
              key={stage}
              className={`rounded-full opacity-75 ${itemStatusDot[stage].dot}`}
              style={{ flexGrow: counts[index], flexBasis: 0 }}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
        {STAGES.map((stage, index) => (
          <span
            key={stage}
            data-testid={`order-food-status-${stage}`}
            className={`inline-flex items-center gap-1.5 ${counts[index] > 0 ? '' : 'opacity-50'}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full opacity-75 ${itemStatusDot[stage].dot}`} />
            {t(itemStatusDot[stage].labelKey)}
            <span className="font-medium tabular-nums text-foreground/80">{counts[index]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
