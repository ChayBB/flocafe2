'use client';

import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import { QrRelayPairing } from '@/components/settings/QrRelayPairing';

/** Where table QR codes point when customers order over mobile data, and the proxy in front of the POS. */
export function GuestQrNetworkSettings({ disabled }: { disabled: boolean }) {
  const t = useTranslations('settings');
  const { confirm, ConfirmDialog } = useConfirm();
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [trustedProxy, setTrustedProxy] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api
      .get('/settings/guest-qr')
      .then(({ data }) => {
        setPublicBaseUrl(data.public_base_url || '');
        setTrustedProxy(data.trusted_proxy || '');
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(load, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put('/settings/guest-qr', {
        public_base_url: publicBaseUrl,
        trusted_proxy: trustedProxy,
      });
      setPublicBaseUrl(data.public_base_url || '');
      setTrustedProxy(data.trusted_proxy || '');
      toast.success(t('qrNetworkSaved'));
    } catch (error: unknown) {
      const code = axios.isAxiosError(error) ? error.response?.data?.code : undefined;
      toast.error(
        code === 'public_base_url_invalid'
          ? t('qrPublicUrlInvalid')
          : code === 'trusted_proxy_invalid'
            ? t('qrTrustedProxyInvalid')
            : t('saveFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    const ok = await confirm(t('qrRotateConfirm'), {
      title: t('qrRotate'),
      confirmLabel: t('qrRotate'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.post('/settings/guest-qr/rotate');
      toast.success(t('qrRotated'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const inputClass =
    'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand disabled:opacity-50';
  const off = disabled || !loaded;
  return (
    <div data-testid="settings-qr-network" className="space-y-3 ps-7">
      <QrRelayPairing disabled={disabled} onChanged={load} />
      <details className="space-y-3 rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">{t('qrRelayManual')}</summary>
      <div className="mt-3 space-y-1">
        <label htmlFor="qr-public-url" className="block text-sm font-medium text-foreground">
          {t('qrPublicUrlLabel')}
        </label>
        <input
          id="qr-public-url"
          type="url"
          inputMode="url"
          placeholder="https://order.example.com"
          value={publicBaseUrl}
          disabled={off}
          onChange={(event) => setPublicBaseUrl(event.target.value)}
          className={inputClass}
        />
        <p className="text-xs text-muted-foreground">{t('qrPublicUrlHint')}</p>
      </div>
      <div className="space-y-1">
        <label htmlFor="qr-trusted-proxy" className="block text-sm font-medium text-foreground">
          {t('qrTrustedProxyLabel')}
        </label>
        <input
          id="qr-trusted-proxy"
          placeholder="10.88.0.1"
          value={trustedProxy}
          disabled={off}
          onChange={(event) => setTrustedProxy(event.target.value)}
          className={inputClass}
        />
        <p className="text-xs text-muted-foreground">{t('qrTrustedProxyHint')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={off || saving} onClick={() => void save()}>
          {t('qrNetworkSave')}
        </Button>
      </div>
      </details>
      <Button type="button" size="sm" variant="outline" disabled={off} onClick={() => void rotate()}>
        {t('qrRotate')}
      </Button>
      {ConfirmDialog}
    </div>
  );
}
