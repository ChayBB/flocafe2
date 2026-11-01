'use client';

import { useEffect, useState } from 'react';
import { Loader2, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { printHtmlInFrame } from '@/lib/printer/print-html-frame';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

type QrState = 'loading' | 'ready' | 'missing' | 'failed';

export default function QrPaymentPanel({
  amount,
  orderId,
  kind = 'promptpay',
}: {
  amount: number;
  orderId?: number | string;
  /** `bank` pays into the shop's bank account instead of its PromptPay ID. */
  kind?: 'promptpay' | 'bank';
}) {
  const t = useTranslations('pos');
  const fmt = useFormatCurrency();
  const [state, setState] = useState<QrState>('loading');
  const [dataUrl, setDataUrl] = useState('');
  const [printing, setPrinting] = useState(false);

  const printRequest = async () => {
    if (printing || orderId === undefined) return;
    setPrinting(true);
    try {
      await api.post('/printers/print-payment-request', { orderId, amount, kind });
      toast.success(t('qrPrintSent'));
    } catch (error) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'document_printer') {
        try {
          const { data } = await api.post('/printers/print-payment-request', {
            orderId,
            amount,
            kind,
            format: 'html',
          });
          toast(t('qrPrintSystemDialog'), { icon: 'ℹ️' });
          printHtmlInFrame(data.html);
          return;
        } catch {}
      }
      toast.error(code === 'no_printer' ? t('qrPrintNoPrinter') : t('qrPrintFailed'));
    } finally {
      setPrinting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setState('loading');
      api
        .get('/payment-methods/qr-code', { params: { amount, kind } })
        .then(({ data }) => {
          if (cancelled) return;
          setDataUrl(data.data_url);
          setState('ready');
        })
        .catch((error) => {
          if (cancelled) return;
          const code = error?.response?.data?.code;
          setState(
            code === 'qr_account_missing' || code === 'bank_qr_account_missing'
              ? 'missing'
              : 'failed',
          );
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [amount, kind]);

  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-4">
      {state === 'loading' && <Loader2 size={24} className="animate-spin text-muted-foreground" />}
      {state === 'ready' && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={dataUrl} alt="QR" className="size-48 rounded-lg bg-white p-1" />
          <p className="text-sm font-semibold text-foreground">
            {t('qrScanToPay', { amount: fmt(amount) })}
          </p>
          {orderId !== undefined && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={printRequest}
              disabled={printing}
              className="mt-1"
            >
              {printing ? (
                <Loader2 size={14} className="animate-spin me-1.5" />
              ) : (
                <Printer size={14} className="me-1.5" />
              )}
              {t('qrPrintRequest')}
            </Button>
          )}
        </>
      )}
      {state === 'missing' && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          {kind === 'bank' ? t('bankQrAccountMissing') : t('qrAccountMissing')}
        </p>
      )}
      {state === 'failed' && (
        <p className="text-sm text-red-500 dark:text-red-400">{t('qrLoadFailed')}</p>
      )}
    </div>
  );
}
