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

/**
 * The table asked for its bill: while the cashier has not received the money the wait counts up;
 * once paid it shows when, and how long the table waited.
 */
export function BillRequestBadge({
  order,
  showRequester = false,
}: {
  order: BillRequestFields;
  showRequester?: boolean;
}) {
  const t = useTranslations('orders');
  const { formatTime } = useFormatDate();
  const waiting = isAwaitingBillPayment(order);
  const now = useTickingNow(waiting);
  if (!order.bill_requested_at) return null;

  if (waiting) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          data-testid="bill-request-waiting"
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
        >
          <ReceiptText size={12} aria-hidden="true" />
          {t('billAwaitingPayment')}
          <Ltr className="tabular-nums">{formatWait(order.bill_requested_at, now)}</Ltr>
        </span>
        {showRequester && order.bill_requested_by_name && (
          <span className="text-xs text-muted-foreground">
            {t('billRequestedBy', { name: order.bill_requested_by_name })}
          </span>
        )}
      </span>
    );
  }

  const minutes = Math.max(
    0,
    Math.round(
      (parseDbTimestamp(order.bill_payment_received_at!).getTime() -
        parseDbTimestamp(order.bill_requested_at).getTime()) /
        60000,
    ),
  );
  return (
    <span
      data-testid="bill-request-received"
      className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800 dark:bg-green-950/50 dark:text-green-300"
    >
      <CheckCircle2 size={12} aria-hidden="true" />
      {t('billPaymentReceived', { time: formatTime(order.bill_payment_received_at!), minutes })}
    </span>
  );
}
