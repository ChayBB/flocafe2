'use client';

import { useEffect, useRef, useState } from 'react';
import type { AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { Check, KeyRound, ShoppingBag, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { playKdsAlert, unlockKdsAlertSound } from '@/lib/kds-alert-sound';

const POLL_MS = 5000;

type GuestAlert =
  | {
      id: number;
      kind: 'pin_reset';
      table_name: string | null;
      session_open: boolean;
      pin: string | null;
    }
  | {
      id: number;
      kind: 'order_held';
      table_name: string | null;
      session_open: boolean;
      note: string | null;
      items: { name: string; quantity: number }[];
    };

interface Props {
  /** The POS client calls `/guest-alerts` on its `/api` base; the Server App calls `/api/guest-alerts`. */
  api: AxiosInstance | null;
  apiPrefix: '' | '/api';
  enabled: boolean;
}

/**
 * Table QR events staff act on, on the POS and the Server App: a sticker PIN that changed after
 * wrong guesses, and guest orders past the table's limit that wait for approval.
 */
export default function GuestAlerts({ api, apiPrefix, enabled }: Props) {
  const t = useTranslations('tables');
  const [alerts, setAlerts] = useState<GuestAlert[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const knownRef = useRef<Set<number> | null>(null);
  const [reloadRound, setReloadRound] = useState(0);

  useEffect(() => {
    if (!enabled || !api) return;
    window.addEventListener('pointerdown', unlockKdsAlertSound);
    window.addEventListener('keydown', unlockKdsAlertSound);
    let cancelled = false;
    const load = () => {
      api
        .get<{ alerts: GuestAlert[] }>(`${apiPrefix}/guest-alerts`)
        .then(({ data }) => {
          if (cancelled) return;
          const list = Array.isArray(data?.alerts) ? data.alerts : [];
          const known = knownRef.current;
          if (known && list.some((alert) => !known.has(alert.id))) playKdsAlert(2);
          knownRef.current = new Set(list.map((alert) => alert.id));
          setAlerts(list);
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
  }, [api, apiPrefix, enabled, reloadRound]);

  if (!enabled || !api || alerts.length === 0) return null;

  const act = async (alert: GuestAlert, action: 'approve' | 'dismiss') => {
    setBusyId(alert.id);
    try {
      await api.post(`${apiPrefix}/guest-alerts/${alert.id}/${action}`);
      if (alert.kind === 'order_held') {
        toast.success(t(action === 'approve' ? 'guestAlertApproved' : 'guestAlertRejected'));
      }
      setAlerts((list) => list.filter((item) => item.id !== alert.id));
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      toast.error(t(code === 'session_closed' ? 'guestAlertSessionClosed' : 'guestAlertFailed'));
      setReloadRound((round) => round + 1);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="fixed bottom-4 end-4 z-[55] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      data-testid="guest-alerts"
    >
      {alerts.map((alert) => (
        <div
          key={alert.id}
          role="alert"
          data-testid={`guest-alert-${alert.kind}`}
          className="rounded-xl border border-amber-300 bg-card p-3 text-foreground shadow-xl dark:border-amber-700"
        >
          <div className="flex items-start gap-2">
            {alert.kind === 'pin_reset' ? (
              <KeyRound size={18} className="mt-0.5 shrink-0 text-amber-600" />
            ) : (
              <ShoppingBag size={18} className="mt-0.5 shrink-0 text-amber-600" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {t(alert.kind === 'pin_reset' ? 'guestAlertPinTitle' : 'guestAlertHeldTitle', {
                  table: alert.table_name ?? '-',
                })}
              </p>
              {alert.kind === 'pin_reset' ? (
                <p className="text-xs text-muted-foreground">
                  {alert.pin ? t('guestAlertPinBody') : t('guestAlertSessionEnded')}
                  {alert.pin && (
                    <span className="ms-1 font-mono text-base font-bold tracking-widest text-foreground">
                      {alert.pin}
                    </span>
                  )}
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">{t('guestAlertHeldBody')}</p>
                  <ul className="mt-1 max-h-32 overflow-y-auto text-sm">
                    {alert.items.map((item, index) => (
                      <li key={index} className="flex justify-between gap-2">
                        <span className="truncate">{item.name}</span>
                        <span className="tabular-nums">×{item.quantity}</span>
                      </li>
                    ))}
                  </ul>
                  {alert.note && (
                    <p className="mt-1 text-xs italic text-muted-foreground">{alert.note}</p>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            {alert.kind === 'order_held' && alert.session_open && (
              <Button
                type="button"
                size="sm"
                disabled={busyId === alert.id}
                onClick={() => void act(alert, 'approve')}
                data-testid="guest-alert-approve"
              >
                <Check size={15} className="me-1" />
                {t('guestAlertApprove')}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyId === alert.id}
              onClick={() => void act(alert, 'dismiss')}
              data-testid="guest-alert-dismiss"
            >
              <X size={15} className="me-1" />
              {t(alert.kind === 'order_held' ? 'guestAlertReject' : 'guestAlertDismiss')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
