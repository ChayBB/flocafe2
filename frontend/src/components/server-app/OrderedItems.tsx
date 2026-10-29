'use client';

import { useState } from 'react';
import { ArrowLeft, CheckCheck, ClipboardList, LogOut, MoreVertical, Plus, Printer, ShoppingBag, XCircle } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useConfirm } from '@/hooks/use-confirm';
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
  /** A change service staff made after sending: 'takeaway' or 'cancelled'. */
  service_change?: string | null;
  /** When service staff confirmed the served item reached the table. */
  served_confirmed_at?: string | null;
}

/**
 * Any item not yet served can be packed to go; only a waiting item can be cancelled; a served
 * item can be confirmed at the table once.
 */
export function itemChangeOptions(item: OrderedItem): { takeaway: boolean; cancel: boolean; confirmServed: boolean } {
  return {
    takeaway: ['pending', 'preparing', 'ready'].includes(item.status) && item.service_change !== 'takeaway',
    cancel: item.status === 'pending',
    confirmServed: item.status === 'served' && !item.served_confirmed_at,
  };
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
  onBack,
  onAddItems,
  onTakeaway,
  onCancel,
  onConfirmServed,
  onPrintBill,
}: {
  tableName: string;
  orderNumber?: string;
  items: OrderedItem[];
  timezone?: string;
  onBack: () => void;
  onAddItems: () => void;
  onTakeaway: (item: OrderedItem) => Promise<void>;
  onCancel: (item: OrderedItem) => Promise<void>;
  onConfirmServed: (item: OrderedItem) => Promise<void>;
  /** Prints the table's bill and tells the POS the table is waiting to pay. */
  onPrintBill: () => Promise<void>;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const { confirm, ConfirmDialog } = useConfirm();
  const [filter, setFilter] = useState<KitchenStage | 'all'>('all');
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [changing, setChanging] = useState<number | null>(null);
  const [printing, setPrinting] = useState(false);

  const run = async (item: OrderedItem, change: 'takeaway' | 'cancel' | 'confirmServed') => {
    setMenuFor(null);
    if (change === 'cancel') {
      const ok = await confirm(t('cancelItemConfirm', { name: item.product_name }), {
        title: t('cancelItem'),
        confirmLabel: t('cancelItem'),
        destructive: true,
      });
      if (!ok) return;
    }
    setChanging(item.id);
    try {
      await (change === 'cancel' ? onCancel(item) : change === 'confirmServed' ? onConfirmServed(item) : onTakeaway(item));
    } finally {
      setChanging(null);
    }
  };
  const live = items.filter((item) => !isCancelledItem(item.status));
  // The bill is printed once every live item has been confirmed at the table.
  const allServedConfirmed = live.length > 0 && live.every((item) => Boolean(item.served_confirmed_at));
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
        {orderNumber && allServedConfirmed && (
          <button
            type="button"
            data-testid="server-app-print-bill"
            aria-label={t('printBill')}
            title={t('printBill')}
            disabled={printing}
            onClick={async () => {
              setPrinting(true);
              try {
                await onPrintBill();
              } finally {
                setPrinting(false);
              }
            }}
            className="ms-auto flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border text-foreground disabled:opacity-50"
          >
            <Printer size={20} />
          </button>
        )}
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
          const options = itemChangeOptions(item);
          const hasOptions = options.takeaway || options.cancel || options.confirmServed;
          return (
            <li
              key={item.id}
              data-testid="server-app-ordered-item"
              className="relative flex items-center gap-3 rounded-lg border border-border bg-card p-2"
            >
              <Ltr className="w-5 shrink-0 text-center text-xs text-muted-foreground">{index + 1}</Ltr>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  <Ltr>{item.quantity}</Ltr> × {formatItemHeading(item.product_name, item.variant_selection)}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Ltr className="tabular-nums">{timeOf(item.created_at)}</Ltr>
                  {item.served_confirmed_at && (
                    <span
                      data-testid="server-app-served-confirmed-tag"
                      className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    >
                      {t('servedConfirmedTag')}
                    </span>
                  )}
                  {item.service_change === 'takeaway' && (
                    <span
                      data-testid="server-app-takeaway-tag"
                      className="rounded bg-orange-100 px-1.5 py-0.5 font-medium text-orange-700 dark:bg-orange-950 dark:text-orange-300"
                    >
                      {t('takeawayTag')}
                    </span>
                  )}
                </p>
              </div>
              <ItemStatusBadge status={item.status} />
              <button
                type="button"
                data-testid="server-app-item-menu"
                aria-label={t('itemActions')}
                aria-haspopup="menu"
                aria-expanded={menuFor === item.id}
                disabled={!hasOptions || changing === item.id}
                onClick={() => setMenuFor(menuFor === item.id ? null : item.id)}
                className="flex min-h-11 min-w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground disabled:opacity-30"
              >
                <MoreVertical size={18} />
              </button>
              {menuFor === item.id && (
                <div
                  role="menu"
                  className="absolute end-2 top-full z-10 mt-1 min-w-48 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
                >
                  {options.takeaway && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void run(item, 'takeaway')}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm hover:bg-muted"
                    >
                      <ShoppingBag size={16} className="text-orange-600" />
                      {t('changeToTakeaway')}
                    </button>
                  )}
                  {options.confirmServed && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void run(item, 'confirmServed')}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm text-emerald-700 hover:bg-muted dark:text-emerald-300"
                    >
                      <CheckCheck size={16} />
                      {t('confirmServed')}
                    </button>
                  )}
                  {options.cancel && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void run(item, 'cancel')}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm text-red-600 hover:bg-muted"
                    >
                      <XCircle size={16} />
                      {t('cancelItem')}
                    </button>
                  )}
                </div>
              )}
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
          data-testid="server-app-ordered-exit"
          onClick={onBack}
          className="flex h-12 items-center justify-center gap-1.5 rounded-lg bg-brand text-sm font-semibold text-white"
        >
          <LogOut size={17} className="rtl-flip" />
          {t('exitOrderedItems')}
        </button>
      </footer>
      {ConfirmDialog}
    </div>
  );
}
