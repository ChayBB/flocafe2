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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfirm } from '@/hooks/use-confirm';
import { kdsItemLine } from '@/lib/item-options-note';
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
import { itemStatusDot } from '@/components/orders/OrderCard';

/** The dish as ordered, named the way the kitchen screen names it. */
export function orderedItemName(item: OrderedItem): string {
  return kdsItemLine(item).name;
}

export interface OrderedItem {
  id: number;
  product_id?: string | number;
  product_name: string;
  quantity: number;
  status: string;
  variant_selection?: unknown;
  /** Chosen options; a listed choice such as "หมู/กุ้ง" gives way to the chosen one, as on the KDS. */
  addons?: { name: string }[] | null;
  created_at?: string;
  /** A change service staff made after sending: 'takeaway' or 'cancelled'. */
  service_change?: string | null;
  /** When service staff confirmed the served item reached the table. */
  served_confirmed_at?: string | null;
  /** Still waiting for a weight or the kitchen's price. */
  weight_pending?: boolean | number | null;
}

/** A ready or served dish, or a take-away one still in the kitchen, not yet confirmed. */
function canConfirmServed(item: OrderedItem): boolean {
  if (item.served_confirmed_at) return false;
  if (item.status === 'ready' || item.status === 'served') return true;
  return item.service_change === 'takeaway' && ['pending', 'preparing'].includes(item.status);
}

/**
 * Any item not yet served can be packed to go; only a waiting item can be cancelled; a served
 * item, or a take-away one the kitchen is still packing, can be confirmed once.
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
    confirmServed: canConfirmServed(item),
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
            className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STAGE_STYLES[stage].className}`}
          >
            {t(STAGE_STYLES[stage].key)} <Ltr className="tabular-nums">{counts[stage]}</Ltr>
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
      const ok = await confirm(t('cancelItemConfirm', { name: orderedItemName(item) }), {
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
                  <Ltr>{item.quantity}</Ltr> × {orderedItemName(item)}
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

/** Dishes not yet confirmed at the table, in list order. */
export function itemsToConfirmServed(items: OrderedItem[]): OrderedItem[] {
  return items.filter(canConfirmServed);
}

/** Every dish starts ticked; untick any that has not reached the table, then confirm them together. */
function ConfirmServedDialog({
  items,
  onClose,
  onConfirm,
}: {
  items: OrderedItem[];
  onClose: () => void;
  onConfirm: (items: OrderedItem[]) => Promise<boolean>;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const chosen = items.filter((item) => !unticked.has(item.id));
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        data-testid="server-app-confirm-served-dialog"
        className="flex max-h-[85svh] flex-col gap-3 p-4 sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t('confirmServedManyTitle')}</DialogTitle>
        </DialogHeader>
        <ul className="-mx-1 flex-1 overflow-y-auto">
          {items.map((item) => {
            const ticked = !unticked.has(item.id);
            return (
              <li key={item.id}>
                <label
                  data-testid="server-app-confirm-served-row"
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-1 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={ticked}
                    disabled={saving}
                    onChange={() =>
                      setUnticked((current) => {
                        const next = new Set(current);
                        if (ticked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                    className="h-5 w-5 shrink-0 accent-emerald-600"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <Ltr className="font-semibold tabular-nums">{item.quantity}</Ltr>
                    {' × '}
                    {orderedItemName(item)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="h-12 rounded-lg border border-border text-sm font-semibold"
          >
            {tCommon('cancel')}
          </button>
          <button
            type="button"
            data-testid="server-app-confirm-served-submit"
            disabled={saving || chosen.length === 0}
            onClick={async () => {
              setSaving(true);
              const done = await onConfirm(chosen);
              setSaving(false);
              if (done) onClose();
            }}
            className="flex h-12 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-sm font-semibold text-white disabled:opacity-50"
          >
            <CheckCheck size={17} />
            {t('confirmServedManySubmit', { count: chosen.length })}
          </button>
        </div>
      </DialogContent>
    </Dialog>
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
  addItemsLocked = false,
  onTakeaway,
  onCancel,
  onConfirmServed,
  onConfirmServedMany,
  onPrintBill,
  onMoveTable,
  onMergeTable,
  serveConfirmRequested = false,
}: {
  tableName: string;
  orderNumber?: string;
  items: OrderedItem[];
  timezone?: string;
  onBack: () => void;
  onAddItems: () => void;
  /** The bill is out, so the table takes no more food until it is paid. */
  addItemsLocked?: boolean;
  onTakeaway: (item: OrderedItem) => Promise<void>;
  onCancel: (item: OrderedItem) => Promise<void>;
  onConfirmServed: (item: OrderedItem) => Promise<void>;
  /** Confirms several dishes reached the table in one go; resolves false when it failed. */
  onConfirmServedMany: (items: OrderedItem[]) => Promise<boolean>;
  /** Prints the table's bill and tells the POS the table is waiting to pay. */
  onPrintBill: () => Promise<void>;
  onMoveTable?: () => void;
  onMergeTable?: () => void;
  /** The cashier is waiting to print this table's bill. */
  serveConfirmRequested?: boolean;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [filter, setFilter] = useState<KitchenStage | 'all'>('all');
  const [printing, setPrinting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingMany, setConfirmingMany] = useState(false);
  const [confirmingOne, setConfirmingOne] = useState(false);
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
  const toConfirm = itemsToConfirmServed(live);
  const shown = filter === 'all' ? items : live.filter((item) => stageOf(item.status) === filter);
  const tabs: { key: KitchenStage | 'all'; count: number }[] = [
    { key: 'all', count: live.length },
    ...KITCHEN_STAGES.map((stage) => ({ key: stage, count: counts[stage] })),
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

      {/* The same thin stage bar as the POS order header; each label filters the list. */}
      <div data-testid="server-app-ordered-stages" className="space-y-1 px-3 pt-3">
        <div className="flex h-1 gap-0.5">
          {KITCHEN_STAGES.map((stage) =>
            counts[stage] > 0 ? (
              <div
                key={stage}
                className={`rounded-full opacity-75 ${itemStatusDot[stage].dot}`}
                style={{ flexGrow: counts[stage], flexBasis: 0 }}
              />
            ) : null,
          )}
        </div>
        <div className="-mx-1 flex items-center justify-between overflow-x-auto whitespace-nowrap text-xs text-muted-foreground">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              data-testid={`server-app-ordered-tab-${tab.key}`}
              aria-pressed={filter === tab.key}
              onClick={() => setFilter(tab.key)}
              className={`inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-1.5 ${
                filter === tab.key ? 'bg-muted font-semibold text-foreground' : ''
              } ${tab.count > 0 || tab.key === 'all' ? '' : 'opacity-50'}`}
            >
              {tab.key !== 'all' && (
                <span
                  className={`h-1.5 w-1.5 rounded-full opacity-75 ${itemStatusDot[tab.key].dot}`}
                />
              )}
              {tab.key === 'all' ? t('filterAll') : t(STAGE_STYLES[tab.key].key)}
              <Ltr className="font-medium tabular-nums text-foreground/80">{tab.count}</Ltr>
            </button>
          ))}
        </div>
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
        {toConfirm.length > 0 && (
          <button
            type="button"
            data-testid="server-app-confirm-served-many"
            disabled={confirmingOne}
            onClick={async () => {
              // A single dish needs no checklist: confirm it straight away.
              if (toConfirm.length > 1) {
                setConfirmingMany(true);
                return;
              }
              setConfirmingOne(true);
              try {
                await onConfirmServedMany(toConfirm);
              } finally {
                setConfirmingOne(false);
              }
            }}
            className={`col-span-2 flex h-12 disabled:opacity-60 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-sm font-semibold text-white ${serveConfirmRequested ? 'animate-pulse ring-2 ring-red-500' : ''}`}
          >
            <CheckCheck size={17} />
            {t('confirmServedMany', { count: toConfirm.length })}
          </button>
        )}
        <button
          type="button"
          data-testid="server-app-ordered-add"
          onClick={onAddItems}
          disabled={addItemsLocked}
          className="flex h-12 items-center justify-center gap-1.5 rounded-lg border border-brand text-sm font-semibold text-brand disabled:opacity-40"
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
      {confirmingMany && (
        <ConfirmServedDialog
          items={toConfirm}
          onClose={() => setConfirmingMany(false)}
          onConfirm={onConfirmServedMany}
        />
      )}
    </div>
  );
}
