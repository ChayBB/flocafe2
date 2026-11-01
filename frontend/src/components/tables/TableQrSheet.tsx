'use client';

import { useEffect, useState } from 'react';
import { X, Loader2, Printer, Download } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { downloadBlob } from '@/lib/download';
import { printHtmlInFrame } from '@/lib/printer/print-html-frame';

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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

// Pixels per millimetre of the printed card, so the downloaded image matches the print layout.
const PX_PER_MM = 600 / 72;
const mm = (value: number) => Math.round(value * PX_PER_MM);
const pt = (value: number) => mm((value * 25.4) / 72);

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
    const cards = qrs
      .map(
        (qr) =>
          `<div class="card"><div class="name">${escapeHtml(qr.name)}</div><img src="${qr.data_url}" alt="QR"><div class="menu">${escapeHtml(t('tableQrMenu'))}</div>${zoneName ? `<div class="zone">${escapeHtml(zoneName)}</div>` : ''}</div>`,
      )
      .join('');
    printHtmlInFrame(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(t('tableQrTitle'))}</title><style>
        body{font-family:sans-serif;margin:12mm}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72mm,1fr));gap:8mm}
        .card{border:1px solid #999;border-radius:4mm;padding:4mm;text-align:center;break-inside:avoid}
        .name{font-size:30.4pt;font-weight:700;margin-bottom:2mm}
        .menu{font-size:27.3pt;font-weight:700;margin-top:1mm}
        img{width:100%;max-width:62.4mm}
        .zone{font-size:10pt;color:#555}
      </style></head><body><div class="grid">${cards}</div></body></html>`,
    );
  };

  // One PNG holds every card: a save dialog per table would be one dialog per QR code.
  const downloadSheet = async () => {
    if (!qrs || qrs.length === 0) return;
    const images = await Promise.all(qrs.map((qr) => loadImage(qr.data_url)));
    const cardWidth = mm(72);
    const padding = mm(4);
    const nameSize = pt(30.4);
    const menuSize = pt(27.3);
    const zoneSize = pt(10);
    const qrSize = mm(62.4);
    const cardHeight =
      padding * 2 +
      nameSize * 1.2 +
      mm(2) +
      qrSize +
      mm(1) +
      menuSize * 1.2 +
      (zoneName ? zoneSize * 1.4 : 0);
    const columns = Math.min(3, qrs.length);
    const rows = Math.ceil(qrs.length / columns);
    const margin = mm(12);
    const gap = mm(8);
    const canvas = document.createElement('canvas');
    canvas.width = margin * 2 + columns * cardWidth + (columns - 1) * gap;
    canvas.height = Math.ceil(margin * 2 + rows * cardHeight + (rows - 1) * gap);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    qrs.forEach((qr, index) => {
      const x = margin + (index % columns) * (cardWidth + gap);
      const top = margin + Math.floor(index / columns) * (cardHeight + gap);
      const center = x + cardWidth / 2;
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x, top, cardWidth, cardHeight, mm(4));
      ctx.stroke();
      ctx.fillStyle = '#000';
      let y = top + padding;
      ctx.font = `700 ${nameSize}px sans-serif`;
      ctx.fillText(qr.name, center, y, cardWidth - padding * 2);
      y += nameSize * 1.2 + mm(2);
      ctx.drawImage(images[index], center - qrSize / 2, y, qrSize, qrSize);
      y += qrSize + mm(1);
      ctx.font = `700 ${menuSize}px sans-serif`;
      ctx.fillText(t('tableQrMenu'), center, y, cardWidth - padding * 2);
      if (zoneName) {
        y += menuSize * 1.2;
        ctx.fillStyle = '#555';
        ctx.font = `${zoneSize}px sans-serif`;
        ctx.fillText(zoneName, center, y, cardWidth - padding * 2);
      }
    });
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const label = (qrs.length === 1 ? qrs[0].name : zoneName) || t('tableQrTitle');
    downloadBlob(blob, `QR-${label.replace(/[\\/:*?"<>|]+/g, '-')}.png`);
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
                  <p className="text-[23.4px] leading-tight font-bold">{qr.name}</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qr.data_url}
                    alt="QR"
                    className="aspect-square w-full max-w-[166px] rounded bg-white p-1"
                  />
                  <p className="text-[20.8px] leading-tight font-bold">{t('tableQrMenu')}</p>
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
            variant="outline"
            className="flex-1"
            onClick={() => void downloadSheet()}
            disabled={!qrs || qrs.length === 0}
          >
            <Download size={15} className="me-1.5" />
            {t('tableQrDownload')}
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
