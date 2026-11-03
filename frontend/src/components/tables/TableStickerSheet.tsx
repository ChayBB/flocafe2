'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Download, Loader2, Printer, RefreshCw, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { downloadBlob } from '@/lib/download';
import { useConfirm } from '@/hooks/use-confirm';
import { printHtmlInFrame } from '@/lib/printer/print-html-frame';
import { escapeHtml } from '@/lib/printer/web-print';

interface Sticker {
  id: string;
  name: string;
  url: string;
  data_url: string;
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

/** The permanent QR sticker for every table: it opens the menu, and ordering needs the party's PIN. */
export default function TableStickerSheet({ onClose }: { onClose: () => void }) {
  const t = useTranslations('tables');
  const tCommon = useTranslations('common');
  const { confirm, ConfirmDialog } = useConfirm();
  const [stickers, setStickers] = useState<Sticker[] | null>(null);
  const [serverAppEnabled, setServerAppEnabled] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .post('/tables/guest-stickers', {})
      .then(({ data }) => {
        if (cancelled) return;
        setStickers(data.stickers || []);
        setServerAppEnabled(data.server_app_enabled !== false);
      })
      .catch(() => {
        if (cancelled) return;
        setStickers([]);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const replace = async (sticker: Sticker) => {
    const ok = await confirm(t('stickerReplaceConfirm', { name: sticker.name }), {
      title: t('stickerReplace'),
      confirmLabel: t('stickerReplace'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { data } = await api.post('/tables/guest-stickers', { renew: [sticker.id] });
      setStickers(data.stickers || []);
      toast.success(t('stickerReplaced', { name: sticker.name }));
    } catch {
      toast.error(t('tableQrFailed'));
    } finally {
      setBusy(false);
    }
  };

  const printSheet = () => {
    if (!stickers || stickers.length === 0) return;
    const cards = stickers
      .map(
        (sticker) =>
          `<div class="card"><div class="name">${escapeHtml(t('tableQrTable', { name: sticker.name }))}</div><img src="${sticker.data_url}" alt="QR"><div class="menu">${escapeHtml(t('guestQrScan'))}</div><div class="pin">${escapeHtml(t('stickerScanHint'))}</div></div>`,
      )
      .join('');
    printHtmlInFrame(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(t('stickerTitle'))}</title><style>
        body{font-family:sans-serif;margin:12mm}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72mm,1fr));gap:8mm}
        .card{border:1px solid #999;border-radius:4mm;padding:4mm;text-align:center;break-inside:avoid}
        .name{font-size:28pt;font-weight:700;margin-bottom:2mm}
        .menu{font-size:20pt;font-weight:700;margin-top:1mm}
        .pin{font-size:11pt;color:#333;margin-top:1mm}
        img{width:100%;max-width:62.4mm}
      </style></head><body><div class="grid">${cards}</div></body></html>`,
    );
  };

  // One PNG holds every card: a save dialog per table would be one dialog per QR code.
  const downloadSheet = async () => {
    if (!stickers || stickers.length === 0) return;
    const images = await Promise.all(stickers.map((sticker) => loadImage(sticker.data_url)));
    const cardWidth = mm(72);
    const padding = mm(4);
    const nameSize = pt(28);
    const menuSize = pt(20);
    const pinSize = pt(11);
    const qrSize = mm(62.4);
    const cardHeight =
      padding * 2 + nameSize * 1.2 + mm(2) + qrSize + mm(1) + menuSize * 1.2 + pinSize * 1.4;
    const columns = Math.min(3, stickers.length);
    const rows = Math.ceil(stickers.length / columns);
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
    stickers.forEach((sticker, index) => {
      const x = margin + (index % columns) * (cardWidth + gap);
      const top = margin + Math.floor(index / columns) * (cardHeight + gap);
      const center = x + cardWidth / 2;
      const width = cardWidth - padding * 2;
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x, top, cardWidth, cardHeight, mm(4));
      ctx.stroke();
      ctx.fillStyle = '#000';
      let y = top + padding;
      ctx.font = `700 ${nameSize}px sans-serif`;
      ctx.fillText(t('tableQrTable', { name: sticker.name }), center, y, width);
      y += nameSize * 1.2 + mm(2);
      ctx.drawImage(images[index], center - qrSize / 2, y, qrSize, qrSize);
      y += qrSize + mm(1);
      ctx.font = `700 ${menuSize}px sans-serif`;
      ctx.fillText(t('guestQrScan'), center, y, width);
      y += menuSize * 1.2;
      ctx.fillStyle = '#333';
      ctx.font = `${pinSize}px sans-serif`;
      ctx.fillText(t('stickerScanHint'), center, y, width);
    });
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) downloadBlob(blob, 'QR-stickers.png');
  };

  const empty = !stickers || stickers.length === 0;

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
        aria-label={t('stickerTitle')}
        data-testid="table-sticker-sheet"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{t('stickerTitle')}</h2>
            <p className="text-xs text-muted-foreground">{t('stickerHint')}</p>
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
          {stickers === null ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="animate-spin text-muted-foreground" />
            </div>
          ) : failed ? (
            <p className="py-6 text-center text-sm text-red-500">{t('tableQrFailed')}</p>
          ) : stickers.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('stickerNoTables')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {stickers.map((sticker) => (
                <div
                  key={sticker.id}
                  data-testid="table-sticker"
                  className="flex flex-col items-center gap-1 rounded-xl border border-border p-3"
                >
                  <p className="text-lg leading-tight font-bold">
                    {t('tableQrTable', { name: sticker.name })}
                  </p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={sticker.data_url}
                    alt="QR"
                    className="aspect-square w-full max-w-[166px] rounded bg-white p-1"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void replace(sticker)}
                    className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground underline disabled:opacity-50"
                  >
                    <RefreshCw size={12} />
                    {t('stickerReplace')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mt-4 flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
            {tCommon('close')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={() => void downloadSheet()}
            disabled={empty}
          >
            <Download size={15} className="me-1.5" />
            {t('stickerDownload')}
          </Button>
          <Button type="button" className="flex-1" onClick={printSheet} disabled={empty}>
            <Printer size={15} className="me-1.5" />
            {t('tableQrPrint')}
          </Button>
        </div>
      </div>
      {ConfirmDialog}
    </div>
  );
}
