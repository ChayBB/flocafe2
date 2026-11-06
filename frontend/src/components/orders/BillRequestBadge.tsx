'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, ReceiptText } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatDate } from '@/hooks/useFormatDate';
import { parseDbTimestamp } from '@/lib/utils';
import type { Order } from '@/lib/types';
import { isAwaitingBillPayment } from '@/lib/bill-print-flow';

export { isAwaitingBillPayment };

export interface BillRequestFields {
  bill_requested_at?: string | null;
  bill_requested_by_name?: string | null;
  bill_payment_received_at?: string | null;
}

/** Name of the staff member who received the latest payment on the order's bills. */
export function paymentReceiverName(order: Pick<Order, 'bill' | 'bills'>): string | null {
  const bills =
    order.bills && order.bills.length > 0 ? order.bills : order.bill ? [order.bill] : [];
  let latest: { name: string; at: string } | null = null;
  for (const bill of bills) {
    for (const line of bill.payment_details || []) {
      if (!line.received_by_name) continue;
      if (!latest || String(line.timestamp) >= latest.at)
        latest = { name: line.received_by_name, at: String(line.timestamp) };
    }
  }
  return latest?.name ?? null;
}

/** Current time, refreshed every second while a wait is being timed. */
export function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** `m:ss` (or `h:mm:ss`) since a stored timestamp. */
export function formatWait(fromStamp: string, toMs: number): string {
  const seconds = Math.max(0, Math.floor((toMs - parseDbTimestamp(fromStamp).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

type BadgeOrder = BillRequestFields &
  Pick<Order, 'status' | 'bill' | 'bills'> & { bill_requested_at?: string | null };

const BADGE = 'inline-flex items-center gap-1 rounded-full font-medium';

/**
 * The order's one status badge: in service until the bill prints, then awaiting payment with a
 * running wait, then received with the name of whoever took the money.
 */
export function OrderStatusBadge({
  order,
  compact = false,
  showRequester = false,
  hideInService = false,
}: {
  order: BadgeOrder;
  compact?: boolean;
  showRequester?: boolean;
  /** Leave the plain in-service state unlabelled, as the detail pane does. */
  hideInService?: boolean;
}) {
  const t = useTranslations('orders');
  const { formatTime } = useFormatDate();
  const waiting =
    !['completed', 'cancelled'].includes(order.status) && isAwaitingBillPayment(order);
  const now = useTickingNow(waiting);
  const size = compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs';
  const bills =
    order.bills && order.bills.length > 0 ? order.bills : order.bill ? [order.bill] : [];
  const paid =
    order.status === 'completed' ||
    Boolean(order.bill_payment_received_at) ||
    (bills.length > 0 && bills.every((bill) => bill.payment_status === 'paid'));

  if (order.status === 'cancelled') {
    return (
      <span
        data-testid="order-status-badge"
        className={`${BADGE} ${size} bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300`}
      >
        {t('cancelled')}
      </span>
    );
  }

  if (waiting) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          data-testid="bill-request-waiting"
          className={`${BADGE} ${size} bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300`}
        >
          <ReceiptText size={12} aria-hidden="true" />
          {t('billPrinted')}
          <Ltr className="tabular-nums">{formatWait(order.bill_requested_at!, now)}</Ltr>
        </span>
        {showRequester && order.bill_requested_by_name && (
          <span className="text-xs text-muted-foreground">
            {t('billRequestedBy', { name: order.bill_requested_by_name })}
          </span>
        )}
      </span>
    );
  }

  if (paid) {
    const name = paymentReceiverName(order);
    const receivedAt = order.bill_payment_received_at;
    return (
      <span
        data-testid="bill-request-received"
        title={
          receivedAt && order.bill_requested_at
            ? t('billPaymentReceived', {
                time: formatTime(receivedAt),
                minutes: Math.max(
                  0,
                  Math.round(
                    (parseDbTimestamp(receivedAt).getTime() -
                      parseDbTimestamp(order.bill_requested_at).getTime()) /
                      60000,
                  ),
                ),
              })
            : undefined
        }
        className={`${BADGE} ${size} bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300`}
      >
        <CheckCircle2 size={12} aria-hidden="true" />
        {name ? t('paymentReceivedBy', { name }) : t('paymentReceived')}
      </span>
    );
  }

  const partial = bills.some((bill) => bill.payment_status === 'partial');
  if (hideInService && !partial) return null;
  return (
    <span
      data-testid="order-status-badge"
      className={`${BADGE} ${size} ${
        partial
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
          : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300'
      }`}
    >
      {t(partial ? 'partiallyPaid' : 'pending')}
    </span>
  );
}
