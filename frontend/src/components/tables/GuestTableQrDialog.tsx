'use client';

import { useEffect, useState } from 'react';
import type { AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { Loader2, Printer, RefreshCw, X, XCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { printHtmlInFrame } from '@/lib/printer/print-html-frame';
import { escapeHtml } from '@/lib/printer/web-print';
import { parseDbTimestamp } from '@/lib/utils';

interface GuestSession {
  table: { id: string; name: string };
  session: { created_at: string; expires_at: string };
  pin: string;
  url: string;
  data_url: string;
  store_timezone?: string;
  server_app_enabled: boolean;
  guest_ordering_enabled: boolean;
}

interface Props {
  tableId: string;
  /** The POS client calls `/tables/...` on its `/api` base; the Server App calls `/api/tables/...`. */
  api: AxiosInstance;
  apiPrefix: '' | '/api';
  onClose: () => void;
}

/** The ordering QR staff hand a seated party: it works until the bill is settled or the daily reset. */
export default function GuestTableQrDialog({ tableId, api, apiPrefix, onClose }: Props) {
  const t = useTranslations('tables');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const [data, setData] = useState<GuestSession | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const path = `${apiPrefix}/tables/${encodeURIComponent(tableId)}/guest-session`;

  useEffect(() => {
    let cancelled = false;
    api
      .post(path, {})
      .then((res) => {
        if (!cancelled) setData(res.data as GuestSession);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, path]);

  const renew = async () => {
    setBusy(true);
    try {
      const res = await api.post(path, { renew: true });
      setData(res.data as GuestSession);
      toast.success(t('guestQrRenewed'));
    } catch {
      toast.error(t('tableQrFailed'));
    } finally {
      setBusy(false);
    }
  };

  const validUntil = data
    ? new Intl.DateTimeFormat(locale, {
        ...(data.store_timezone ? { timeZone: data.store_timezone } : {}),
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(parseDbTimestamp(data.session.expires_at))
    : '';

  const printInBrowser = () => {
    if (!data) return;
    printHtmlInFrame(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(t('guestQrTitle'))}</title><style>
        body{font-family:sans-serif;max-width:80mm;margin:0 auto;padding:4mm;text-align:center;color:#000}
        .name{font-size:22pt;font-weight:700}img{width:60mm;max-width:100%}
      </style></head><body><div class="name">${escapeHtml(t('tableQrTable', { name: data.table.name }))}</div>
      <div>${escapeHtml(t('guestQrScan'))}</div><img src="${data.data_url}" alt="QR">
      <div>${escapeHtml(t('guestQrValidUntil', { time: validUntil }))}</div>
      <div>${escapeHtml(t('guestQrHint'))}</div></body></html>`,
    );
  };

  const print = async () => {
    setBusy(true);
    try {
      await api.post(`${path}/print`);
      toast.success(t('guestQrPrinted'));
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'no_printer' || code === 'document_printer') printInBrowser();
      else toast.error(t('guestQrPrintFailed'));
    } finally {
      setBusy(false);
    }
  };

  const closeCode = async () => {
    setBusy(true);
    try {
      await api.delete(path);
      toast.success(t('guestQrClosed'));
      onClose();
    } catch {
      toast.error(t('tableQrFailed'));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl bg-card p-6 text-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('guestQrTitle')}
        data-testid="guest-table-qr"
      >
        <div className="flex w-full items-start justify-between gap-3">
          <h2 className="text-lg font-bold">
            {data ? t('tableQrTable', { name: data.table.name }) : t('guestQrTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon('close')}
            className="touch-target rounded-full text-muted-foreground hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>
        {data && (!data.server_app_enabled || !data.guest_ordering_enabled) && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {t(data.server_app_enabled ? 'guestQrOrderingOff' : 'tableQrServerAppOff')}
          </p>
        )}
        {failed ? (
          <p className="py-6 text-center text-sm text-red-500">{t('tableQrFailed')}</p>
        ) : !data ? (
          <Loader2 size={22} className="my-10 animate-spin text-muted-foreground" />
        ) : (
          <>
            <img src={data.data_url} alt="QR" className="w-56 rounded-lg bg-white p-2" />
            <p className="text-sm font-medium" data-testid="guest-table-qr-valid-until">
              {t('guestQrValidUntil', { time: validUntil })}
            </p>
            <p className="text-center text-xs text-muted-foreground">{t('guestQrHint')}</p>
            <div className="w-full rounded-lg bg-muted/60 px-3 py-2 text-center">
              <p className="text-xs text-muted-foreground">{t('guestQrPin')}</p>
              <p
                className="font-mono text-3xl font-bold tracking-[0.3em]"
                data-testid="guest-table-qr-pin"
              >
                {data.pin}
              </p>
            </div>
          </>
        )}
        <div className="grid w-full grid-cols-3 gap-2">
          <Button type="button" size="sm" disabled={!data || busy} onClick={() => void print()}>
            <Printer size={15} className="me-1" />
            {t('tableQrPrint')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!data || busy}
            onClick={() => void renew()}
          >
            <RefreshCw size={15} className="me-1" />
            {t('guestQrRenew')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!data || busy}
            onClick={() => void closeCode()}
          >
            <XCircle size={15} className="me-1" />
            {t('guestQrClose')}
          </Button>
        </div>
      </div>
    </div>
  );
}
