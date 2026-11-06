'use client';

import { useTranslations } from 'use-intl';
import type { OrderItem } from '@/lib/types';
import { itemStatusDot } from '@/components/orders/OrderCard';

const STAGES = ['pending', 'preparing', 'ready', 'served'] as const;
export type FoodStage = (typeof STAGES)[number];

/** How far an order's food has got: one column per stage with its own bar and count; tapping a column filters the item list. */
export function OrderFoodStatusBar({
  items,
  selected,
  onSelect,
}: {
  items: OrderItem[];
  selected: FoodStage | null;
  onSelect: (stage: FoodStage | null) => void;
}) {
  const t = useTranslations('orders');
  const counts = STAGES.map((stage) => items.filter((item) => item.status === stage).length);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;

  return (
    <div
      data-testid="order-food-status"
      aria-label={t('foodStatus')}
      className="mt-1 grid grid-cols-4 gap-1.5 border-t border-border/60 pt-2.5"
    >
      {STAGES.map((stage, index) => {
        const active = counts[index] > 0;
        return (
          <button
            key={stage}
            type="button"
            data-testid={`order-food-status-${stage}`}
            aria-pressed={selected === stage}
            disabled={!active && selected !== stage}
            onClick={() => onSelect(selected === stage ? null : stage)}
            className={`flex min-h-11 min-w-0 flex-col gap-1.5 rounded-md p-1 text-start text-xs enabled:hover:bg-muted/60 ${
              selected === stage
                ? 'bg-muted font-semibold text-foreground'
                : 'text-muted-foreground'
            } ${active ? '' : 'opacity-50'}`}
          >
            {/* Colours sit at 75% so the bar reads as a hint, not a warning. */}
            <span
              aria-hidden="true"
              className={`h-1 w-full rounded-full ${active ? `opacity-75 ${itemStatusDot[stage].dot}` : 'bg-border'}`}
            />
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="truncate">{t(itemStatusDot[stage].labelKey)}</span>
              <span className="font-medium tabular-nums text-foreground/80">{counts[index]}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
