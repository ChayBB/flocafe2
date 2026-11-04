'use client';

import { useTranslations } from 'use-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Ltr } from '@/components/layout/Ltr';
import { ItemStatusBadge, isCancelledItem } from '@/components/server-app/ItemStatus';

export interface GuestOrder {
  order_number: string;
  customer_name: string | null;
  items: { id: number; product_name: string; quantity: number; status: string; total: number }[];
}

/** What this table has ordered during the current visit, with each dish's kitchen status. */
export function GuestOrderHistory({
  open,
  onClose,
  order,
  loading,
  formatPrice,
}: {
  open: boolean;
  onClose: () => void;
  order: GuestOrder | null;
  loading: boolean;
  formatPrice: (amount: number) => string;
}) {
  const t = useTranslations('serverApp');
  const total =
    order?.items.reduce(
      (sum, item) => (isCancelledItem(item.status) ? sum : sum + (Number(item.total) || 0)),
      0,
    ) ?? 0;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        data-testid="server-app-guest-history"
        className="max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{t('orderHistory')}</DialogTitle>
        </DialogHeader>
        {!order || order.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {loading ? t('orderHistoryLoading') : t('orderHistoryEmpty')}
          </p>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {order.items.map((item) => (
                <li
                  key={item.id}
                  data-testid="server-app-guest-history-item"
                  className="flex items-center gap-3 py-2.5"
                >
                  <Ltr className="w-8 shrink-0 font-semibold tabular-nums">{item.quantity}×</Ltr>
                  <span className="min-w-0 flex-1 truncate text-sm">{item.product_name}</span>
                  <ItemStatusBadge status={item.status} />
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-border pt-3 font-semibold">
              <span>{t('orderHistoryTotal')}</span>
              <Ltr className="tabular-nums">{formatPrice(total)}</Ltr>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
