'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ReceiptText } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Ltr } from '@/components/layout/Ltr';
import { formatWait, useTickingNow } from '@/components/orders/BillRequestBadge';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { playKdsAlert, unlockKdsAlertSound } from '@/lib/kds-alert-sound';

interface BillRequest {
  id: number;
  order_number: string;
  total: number;
  table_name: string | null;
  bill_requested_at: string;
  bill_requested_by_name: string | null;
}

const POLL_MS = 5000;

/**
 * POS-wide bar for tables waiting for the cashier to take their payment, with a two-beep alert
 * whenever a new table asks for its bill. Shown to staff who take payments.
 */
export default function BillRequestAlerts() {
  const t = useTranslations('orders');
  const money = useFormatCurrency();
  const currentTenant = useAuthStore((s) => s.currentTenant);
  const canTakePayments = tenantCan(currentTenant, 'payments.take');
  const [requests, setRequests] = useState<BillRequest[]>([]);
  const knownRef = useRef<Set<number> | null>(null);
  const now = useTickingNow(requests.length > 0);

  useEffect(() => {
    if (!canTakePayments) return;
    window.addEventListener('pointerdown', unlockKdsAlertSound);
    window.addEventListener('keydown', unlockKdsAlertSound);
    let cancelled = false;
    const load = () => {
      api
        .get<{ requests: BillRequest[] }>('/bill-requests')
        .then(({ data }) => {
          if (cancelled) return;
          const list = Array.isArray(data?.requests) ? data.requests : [];
          const known = knownRef.current;
          // The first load only records what is already waiting; later requests beep.
          if (known && list.some((request) => !known.has(request.id))) playKdsAlert(2);
          knownRef.current = new Set(list.map((request) => request.id));
          setRequests(list);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('pointerdown', unlockKdsAlertSound);
      window.removeEventListener('keydown', unlockKdsAlertSound);
    };
  }, [canTakePayments]);

  if (!canTakePayments || requests.length === 0) return null;
  return (
    <div data-testid="bill-request-alerts" className="shrink-0 border-b border-amber-200 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-950/40">
      {requests.map((request) => (
        <div key={request.id} data-testid="bill-request-alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
          <ReceiptText size={18} className="shrink-0 text-amber-600" aria-hidden="true" />
          <span className="font-semibold text-amber-900 dark:text-amber-200">
            {t('billRequestBar', { table: request.table_name ?? request.order_number })}
          </span>
          <Ltr className="font-mono font-bold tabular-nums text-amber-900 dark:text-amber-200">
            {formatWait(request.bill_requested_at, now)}
          </Ltr>
          {request.bill_requested_by_name && (
            <span className="text-amber-800/80 dark:text-amber-300/80">
              {t('billRequestedBy', { name: request.bill_requested_by_name })}
            </span>
          )}
          <Ltr className="font-semibold text-amber-900 dark:text-amber-200">{money(request.total)}</Ltr>
          <Link
            href="/orders"
            className="ms-auto rounded-lg bg-amber-500 px-3 py-1 text-xs font-bold text-white hover:bg-amber-600"
          >
            {t('goCollectPayment')}
          </Link>
        </div>
      ))}
    </div>
  );
}
