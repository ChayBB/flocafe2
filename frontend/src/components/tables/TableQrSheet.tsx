'use client';

import { useEffect, useState } from 'react';
import { X, Loader2, Printer } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';

interface TableQr {
  id: string;
  name: string;
  url: string;
  data_url: string;
}

interface Props {
  tableIds: string[];
  zoneName: string;
  onClose: () => void;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export default function TableQrSheet({ tableIds, zoneName, onClose }: Props) {
  const t = useTranslations('tables');
  const tCommon = useTranslations('common');
  const [qrs, setQrs] = useState<TableQr[] | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [serverAppEnabled, setServerAppEnabled] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .post('/tables/order-qr', { table_ids: tableIds })
      .then(({ data }) => {
        if (cancelled) return;
        setQrs(data.qrs || []);
        setBaseUrl(data.base_url || '');
        setServerAppEnabled(data.server_app_enabled !== false);
      })
      .catch(() => {
        if (!cancelled) {
          setQrs([]);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []); // oxlint-disable-line react-hooks/exhaustive-deps

  const printSheet = () => {
    if (!qrs || qrs.length === 0) return;
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc) {
      frame.remove();
      return;
    }
    const cards = qrs
      .map(
        (qr) =>
          `<div class="card"><div class="name">${escapeHtml(t('tableQrTable', { name: qr.name }))}</div><img src="${qr.data_url}" alt="QR"><div class="zone">${escapeHtml(zoneName)}</div></div>`,
      )
      .join('');
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(t('tableQrTitle'))}</title><style>
        body{font-family:sans-serif;margin:12mm}
        .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}
        .card{border:1px solid #999;border-radius:4mm;padding:4mm;text-align:center;break-inside:avoid}
        .name{font-size:18pt;font-weight:700;margin-bottom:2mm}
        img{width:100%;max-width:48mm}
        .zone{font-size:10pt;color:#555}
      </style></head><body><div class="grid">${cards}</div></body></html>`,
    );
    doc.close();
    const win = frame.contentWindow;
    if (!win) {
      frame.remove();
      return;
    }
    win.onafterprint = () => frame.remove();
    win.focus();
    win.print();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-card p-6 text-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('tableQrTitle')}
        data-testid="table-qr-sheet"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{t('tableQrTitle')}</h2>
            <p className="text-xs text-muted-foreground">{t('tableQrHint')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon('close')}
            className="touch-target rounded-full text-muted-foreground hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>
        {!serverAppEnabled && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {t('tableQrServerAppOff')}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {qrs === null ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="animate-spin text-muted-foreground" />
            </div>
          ) : failed ? (
            <p className="py-6 text-center text-sm text-red-500">{t('tableQrFailed')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {qrs.map((qr) => (
                <div
                  key={qr.id}
                  className="flex flex-col items-center gap-1 rounded-xl border border-border p-3"
                >
                  <p className="text-sm font-bold">{t('tableQrTable', { name: qr.name })}</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr.data_url} alt="QR" className="size-32 rounded bg-white p-1" />
                </div>
              ))}
            </div>
          )}
        </div>
        {baseUrl && (
          <p className="mt-3 break-all text-center text-[11px] text-muted-foreground" dir="ltr">
            {baseUrl}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
            {tCommon('close')}
          </Button>
          <Button
            type="button"
            className="flex-1"
            onClick={printSheet}
            disabled={!qrs || qrs.length === 0}
          >
            <Printer size={15} className="me-1.5" />
            {t('tableQrPrint')}
          </Button>
        </div>
      </div>
    </div>
  );
}
