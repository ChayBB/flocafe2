'use client';

import { useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  CheckCheck,
  ClipboardList,
  LogOut,
  Merge,
  MoreVertical,
  Plus,
  Printer,
  ShoppingBag,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  /** Still waiting for a weight or the kitchen's price. */
  weight_pending?: boolean | number | null;
}

/**
 * Any item not yet served can be packed to go; only a waiting item can be cancelled; a served
 * item can be confirmed at the table once.
 */
export function itemChangeOptions(item: OrderedItem): {
  takeaway: boolean;
  cancel: boolean;
  confirmServed: boolean;
} {
  return {
    takeaway:
      ['pending', 'preparing', 'ready'].includes(item.status) && item.service_change !== 'takeaway',
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
            {t(STAGE_STYLES[stage].key)}{' '}
            <Ltr className="font-bold tabular-nums">{counts[stage]}</Ltr>
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
        <span
          className="absolute end-2 top-2 h-2.5 w-2.5 rounded-full bg-orange-500"
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

/**
 * Numbered list of a table's sent items: quantity and name, time sent, kitchen status and a menu
 * of the changes service staff may make (takeaway, cancel, confirm served).
 */
export function OrderedItemList({
  items,
  timezone,
  className = '',
  emptyText,
  itemTestId = 'server-app-ordered-item',
  onTakeaway,
  onCancel,
  onConfirmServed,
}: {
  items: OrderedItem[];
  timezone?: string;
  className?: string;
  emptyText?: string;
  itemTestId?: string;
  onTakeaway: (item: OrderedItem) => Promise<void>;
  onCancel: (item: OrderedItem) => Promise<void>;
  onConfirmServed: (item: OrderedItem) => Promise<void>;
}) {
  const t = useTranslations('serverApp');
  const { confirm, ConfirmDialog } = useConfirm();
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [changing, setChanging] = useState<number | null>(null);

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
      await (change === 'cancel'
        ? onCancel(item)
        : change === 'confirmServed'
          ? onConfirmServed(item)
          : onTakeaway(item));
    } finally {
      setChanging(null);
    }
  };
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

  return (
    <>
      <ol className={`space-y-2 ${className}`}>
        {items.length === 0 && emptyText && (
          <li className="py-10 text-center text-sm text-muted-foreground">{emptyText}</li>
        )}
        {items.map((item, index) => {
          const options = itemChangeOptions(item);
          const hasOptions = options.takeaway || options.cancel || options.confirmServed;
          return (
            <li
              key={item.id}
              data-testid={itemTestId}
              className="relative flex items-center gap-3 rounded-lg border border-border bg-card p-2"
            >
              <Ltr className="w-5 shrink-0 text-center text-xs text-muted-foreground">
                {index + 1}
              </Ltr>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  <Ltr>{item.quantity}</Ltr> ×{' '}
                  {formatItemHeading(item.product_name, item.variant_selection)}
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
              {/* Rendered above the page so the footer never covers it; it opens upward near the bottom. */}
              <DropdownMenu
                modal={false}
                open={menuFor === item.id}
                onOpenChange={(open) => setMenuFor(open ? item.id : null)}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid="server-app-item-menu"
                    aria-label={t('itemActions')}
                    disabled={!hasOptions || changing === item.id}
                    className="flex min-h-11 min-w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground disabled:opacity-30"
                  >
                    <MoreVertical size={18} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  collisionPadding={8}
                  className="min-w-48 rounded-lg border-border bg-card p-0 shadow-lg"
                >
                  {options.takeaway && (
                    <DropdownMenuItem
                      onSelect={() => void run(item, 'takeaway')}
                      className="min-h-11 rounded-none px-3 text-sm"
                    >
                      <ShoppingBag size={16} className="text-orange-600" />
                      {t('changeToTakeaway')}
                    </DropdownMenuItem>
                  )}
                  {options.confirmServed && (
                    <DropdownMenuItem
                      onSelect={() => void run(item, 'confirmServed')}
                      className="min-h-11 rounded-none px-3 text-sm text-emerald-700 dark:text-emerald-300"
                    >
                      <CheckCheck size={16} />
                      {t('confirmServed')}
                    </DropdownMenuItem>
                  )}
                  {options.cancel && (
                    <DropdownMenuItem
                      onSelect={() => void run(item, 'cancel')}
                      className="min-h-11 rounded-none px-3 text-sm text-red-600 focus:text-red-600"
                    >
                      <XCircle size={16} />
                      {t('cancelItem')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ol>
      {ConfirmDialog}
    </>
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
  onMoveTable,
  onMergeTable,
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
  onMoveTable?: () => void;
  onMergeTable?: () => void;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [filter, setFilter] = useState<KitchenStage | 'all'>('all');
  const [printing, setPrinting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const tableActions = [
    onMoveTable && { key: 'move', label: t('moveTable'), icon: ArrowLeftRight, run: onMoveTable },
    onMergeTable && { key: 'merge', label: t('mergeTable'), icon: Merge, run: onMergeTable },
  ].filter((action) => Boolean(action)) as {
    key: string;
    label: string;
    icon: typeof Merge;
    run: () => void;
  }[];

  const live = items.filter((item) => !isCancelledItem(item.status));
  // The bill is printed once every live item is priced and confirmed at the table.
  const notAtTable = live.filter((item) => !item.served_confirmed_at).length;
  const awaitingPrice = live.filter((item) => item.weight_pending).length;
  const billReady = live.length > 0 && notAtTable === 0 && awaitingPrice === 0;
  const counts = stageCounts(items);
  const shown = filter === 'all' ? items : live.filter((item) => stageOf(item.status) === filter);
  const tabs: { key: KitchenStage | 'all'; count: number; className: string }[] = [
    { key: 'all', count: live.length, className: 'bg-card text-foreground' },
    ...KITCHEN_STAGES.map((stage) => ({
      key: stage,
      count: counts[stage],
      className: STAGE_STYLES[stage].className,
    })),
  ];

  return (
    <div
      data-testid="server-app-ordered-items"
      className="fixed inset-0 z-40 flex flex-col bg-background text-foreground"
    >
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
        {orderNumber && live.length > 0 && (
          <button
            type="button"
            data-testid="server-app-print-bill"
            data-ready={billReady}
            aria-label={t('printBill')}
            title={t('printBill')}
            disabled={printing}
            onClick={async () => {
              // Until every item is at the table and priced, the button says what is still missing.
              if (!billReady) {
                toast.error(
                  [
                    notAtTable > 0 && t('printBillNotAtTable', { count: notAtTable }),
                    awaitingPrice > 0 && t('printBillAwaitingPrice', { count: awaitingPrice }),
                  ]
                    .filter(Boolean)
                    .join('\n'),
                );
                return;
              }
              setPrinting(true);
              try {
                await onPrintBill();
              } finally {
                setPrinting(false);
              }
            }}
            className={`ms-auto flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border disabled:opacity-50 ${billReady ? 'text-foreground' : 'text-muted-foreground opacity-50'}`}
          >
            <Printer size={20} />
          </button>
        )}
        {orderNumber && tableActions.length > 0 && (
          <div className={`relative ${live.length > 0 ? '' : 'ms-auto'}`}>
            <button
              type="button"
              data-testid="server-app-ordered-menu"
              aria-label={t('ticketActions')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground"
            >
              <MoreVertical size={20} />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute end-0 top-full z-20 mt-1 min-w-44 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
              >
                {tableActions.map(({ key, label, icon: Icon, run }) => (
                  <button
                    key={key}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      run();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm hover:bg-muted"
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
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
            <span className="truncate">
              {tab.key === 'all' ? t('filterAll') : t(STAGE_STYLES[tab.key].key)}
            </span>
            <Ltr className="text-lg font-bold tabular-nums">{tab.count}</Ltr>
          </button>
        ))}
      </div>

      <OrderedItemList
        items={shown}
        timezone={timezone}
        className="flex-1 overflow-y-auto p-3"
        emptyText={t('noOrderedItems')}
        onTakeaway={onTakeaway}
        onCancel={onCancel}
        onConfirmServed={onConfirmServed}
      />

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
    </div>
  );
}
