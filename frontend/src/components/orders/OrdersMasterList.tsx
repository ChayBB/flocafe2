'use client';

import { OrderStatusBadge } from '@/components/orders/BillRequestBadge';
import { Utensils, ShoppingBag, Truck, Globe, Clock, UserRound } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { Order } from '@/lib/types';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { parseDbTimestamp, cn } from '@/lib/utils';
import { orderAwaitingWeight, orderPendingLabelKey, ORDER_TYPE_KEYS } from './OrderCard';

function OrderTypeIcon({ type }: { type: Order['type'] }) {
  const cls = 'shrink-0 text-muted-foreground';
  switch (type) {
    case 'dine_in':
      return <Utensils size={13} className={cls} />;
    case 'delivery':
      return <Truck size={13} className={cls} />;
    case 'online':
      return <Globe size={13} className={cls} />;
    default:
      return <ShoppingBag size={13} className={cls} />;
  }
}

/** Left pane of the Orders master/detail layout: one compact row per order for
 * rapid triage. Full order details live in the detail pane. */
export function OrdersMasterList({
  orders,
  selectedOrderId,
  onSelect,
  now,
  leavingOrderIds,
}: {
  orders: Order[];
  selectedOrderId: number | null;
  onSelect: (orderId: number) => void;
  now: number;
  /** Orders just paid: they flash green and fold away before leaving the list. */
  leavingOrderIds?: ReadonlySet<number>;
}) {
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const fmt = useFormatCurrency();

  const getTimeSince = (createdAt: string) => {
    const minutes = Math.floor((now - parseDbTimestamp(createdAt).getTime()) / 60000);
    if (minutes < 1) return tCommon('justNow');
    if (minutes < 60) return tCommon('timeMinutesAgo', { m: minutes });
    return tCommon('timeHoursMinutesAgo', { h: Math.floor(minutes / 60), m: minutes % 60 });
  };

  return (
    <ul className="flex-1 min-h-0 overflow-y-auto divide-y divide-border">
      {orders.map((order) => {
        const awaitingWeight = orderAwaitingWeight(order);
        const awaitingPayment = Boolean(order.bill_requested_at) && !order.bill_payment_received_at;
        const active = order.status !== 'cancelled';
        const itemCount = (order.items || []).filter(
          (i) => !['cancelled', 'voided', 'void_adjustment'].includes(i.status),
        ).length;
        return (
          <li
            key={order.id}
            data-order-leaving={leavingOrderIds?.has(order.id) || undefined}
            className={leavingOrderIds?.has(order.id) ? 'animate-order-paid-leave' : undefined}
          >
            <button
              type="button"
              onClick={() => onSelect(order.id)}
              aria-current={selectedOrderId === order.id}
              data-bill-awaiting={awaitingPayment || undefined}
              className={cn(
                'w-full text-start px-3 py-2.5 flex flex-col gap-1 transition-colors touch-manipulation',
                selectedOrderId === order.id
                  ? 'bg-brand/10 ring-1 ring-inset ring-brand'
                  : 'bg-card hover:bg-muted/60',
                awaitingWeight &&
                  'bg-orange-50 dark:bg-orange-950/30 border-s-4 border-orange-500 hover:bg-orange-100 dark:hover:bg-orange-950/50',
                !active && 'opacity-80',
                awaitingPayment &&
                  'animate-bill-awaiting bg-pink-50 hover:bg-pink-100 dark:bg-pink-950/50 dark:hover:bg-pink-900/50',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-sm text-foreground tracking-tight">
                  #<Ltr>{order.order_number}</Ltr>
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  {awaitingWeight && (
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300">
                      {tPos(orderPendingLabelKey(order))}
                    </span>
                  )}
                  <OrderStatusBadge order={order} compact />
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                <span className="inline-flex items-center gap-1 font-medium text-foreground shrink-0">
                  <OrderTypeIcon type={order.type} />
                  {tOrders(ORDER_TYPE_KEYS[order.type])}
                </span>
                {order.table && (
                  <span className="font-medium text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40 px-1.5 py-0.5 rounded-md truncate">
                    {order.table.name}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 ms-auto shrink-0">
                  <Clock size={12} />
                  {getTimeSince(order.created_at)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0">{tOrders('itemCount', { count: itemCount })}</span>
                  {(order.user_name || order.table_owner_name) && (
                    <span
                      data-testid="order-staff-name"
                      className="inline-flex min-w-0 items-center gap-1"
                    >
                      <UserRound size={12} className="shrink-0" />
                      <span className="truncate">{order.user_name || order.table_owner_name}</span>
                    </span>
                  )}
                </span>
                <span className="text-sm font-bold text-foreground">
                  {awaitingWeight ? 'XXXX' : fmt(Number(order.bill?.total ?? order.total))}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
