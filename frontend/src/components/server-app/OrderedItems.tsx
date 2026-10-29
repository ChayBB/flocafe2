'use client';

import { useState } from 'react';
import { ArrowLeft, ClipboardList, Plus, Send } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { nameToColor } from '@/lib/image-utils';
import { formatItemHeading } from '@/lib/printer/item-heading';
import { parseDbTimestamp } from '@/lib/utils';
import {
  ItemStatusBadge,
  KITCHEN_STAGES,
  STAGE_STYLES,
  isCancelledItem,
  stageCounts,
  stageOf,
  type KitchenStage,
} from '@/components/server-app/ItemStatus';

export interface OrderedItem {
  id: number;
  product_id?: string | number;
  product_name: string;
  quantity: number;
  status: string;
  variant_selection?: unknown;
  created_at?: string;
}

/** Per-stage chips for a table's order, with the orange button that opens its item list. */
export function TableKitchenSummary({
  items,
  onOpenDetails,
}: {
  items: OrderedItem[];
  onOpenDetails: () => void;
}) {
  const t = useTranslations('serverApp');
  const counts = stageCounts(items);
  return (
    <div data-testid="server-app-kitchen-summary" className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {KITCHEN_STAGES.map((stage) => (
          <span
            key={stage}
            data-testid={`server-app-stage-${stage}`}
            className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_STYLES[stage].className}`}
          >
            {t(STAGE_STYLES[stage].key)} <Ltr className="font-bold tabular-nums">{counts[stage]}</Ltr>
          </span>
        ))}
      </div>
      <button
        type="button"
        data-testid="server-app-ordered-items-button"
        onClick={onOpenDetails}
        aria-label={t('orderedItemsTitle')}
        title={t('orderedItemsTitle')}
        className="relative flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground"
      >
        <ClipboardList size={20} />
        <span className="absolute end-2 top-2 h-2.5 w-2.5 rounded-full bg-orange-500" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Full-screen list of what a table has ordered and where each item stands in the kitchen. */
export function OrderedItemsScreen({
  tableName,
  orderNumber,
  items,
  timezone,
  imageFor,
  canSend,
  sending,
  onBack,
  onAddItems,
  onSend,
}: {
  tableName: string;
  orderNumber?: string;
  items: OrderedItem[];
  timezone?: string;
  imageFor: (item: OrderedItem) => string | null;
  canSend: boolean;
  sending: boolean;
  onBack: () => void;
  onAddItems: () => void;
  onSend: () => void;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [filter, setFilter] = useState<KitchenStage | 'all'>('all');
  const live = items.filter((item) => !isCancelledItem(item.status));
  const counts = stageCounts(items);
  const shown = filter === 'all' ? items : live.filter((item) => stageOf(item.status) === filter);
  const timeOf = (stamp?: string) => {
    if (!stamp) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        ...(timezone ? { timeZone: timezone } : {}),
      }).format(parseDbTimestamp(stamp));
    } catch {
      return '';
    }
  };

  const tabs: { key: KitchenStage | 'all'; count: number; className: string }[] = [
    { key: 'all', count: live.length, className: 'bg-card text-foreground' },
    ...KITCHEN_STAGES.map((stage) => ({ key: stage, count: counts[stage], className: STAGE_STYLES[stage].className })),
  ];

  return (
    <div data-testid="server-app-ordered-items" className="fixed inset-0 z-40 flex flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={tCommon('back')}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-foreground"
        >
          <ArrowLeft size={20} className="rtl-flip" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold">{t('orderedItemsTitle')}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {t('tableLabel', { name: tableName })}
            {orderNumber && (
              <>
                {' · '}
                <Ltr>{orderNumber}</Ltr>
              </>
            )}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-5 gap-1.5 px-3 pt-3">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            data-testid={`server-app-ordered-tab-${tab.key}`}
            aria-pressed={filter === tab.key}
            onClick={() => setFilter(tab.key)}
            className={`flex min-h-14 flex-col items-center justify-center rounded-lg border px-1 py-1 text-xs font-medium ${tab.className} ${
              filter === tab.key ? 'border-brand ring-2 ring-brand/30' : 'border-border'
            }`}
          >
            <span className="truncate">{tab.key === 'all' ? t('filterAll') : t(STAGE_STYLES[tab.key].key)}</span>
            <Ltr className="text-lg font-bold tabular-nums">{tab.count}</Ltr>
          </button>
        ))}
      </div>

      <ol className="flex-1 space-y-2 overflow-y-auto p-3">
        {shown.length === 0 && (
          <li className="py-10 text-center text-sm text-muted-foreground">{t('noOrderedItems')}</li>
        )}
        {shown.map((item, index) => {
          const image = imageFor(item);
          return (
            <li
              key={item.id}
              data-testid="server-app-ordered-item"
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-2"
            >
              <Ltr className="w-5 shrink-0 text-center text-xs text-muted-foreground">{index + 1}</Ltr>
              <div
                className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg"
                style={{ backgroundColor: nameToColor(item.product_name) }}
              >
                <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-white/80">
                  {item.product_name.substring(0, 2).toUpperCase()}
                </span>
                {image && (
                  <img
                    src={image}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                    onError={(event) => {
                      (event.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  <Ltr>{item.quantity}</Ltr> × {formatItemHeading(item.product_name, item.variant_selection)}
                </p>
                <Ltr className="text-xs text-muted-foreground tabular-nums">{timeOf(item.created_at)}</Ltr>
              </div>
              <ItemStatusBadge status={item.status} />
            </li>
          );
        })}
      </ol>

      <footer className="grid grid-cols-2 gap-2 border-t border-border bg-card p-3">
        <button
          type="button"
          data-testid="server-app-ordered-add"
          onClick={onAddItems}
          className="flex h-12 items-center justify-center gap-1.5 rounded-lg border border-brand text-sm font-semibold text-brand"
        >
          <Plus size={17} />
          {t('addFoodItems')}
        </button>
        <button
          type="button"
          data-testid="server-app-ordered-send"
          onClick={onSend}
          disabled={!canSend || sending}
          className="flex h-12 items-center justify-center gap-1.5 rounded-lg bg-brand text-sm font-semibold text-white disabled:opacity-50"
        >
          <Send size={17} />
          {sending ? t('sending') : t('sendMoreItems')}
        </button>
      </footer>
    </div>
  );
}
