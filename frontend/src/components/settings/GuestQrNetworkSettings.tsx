'use client';

import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import { QrRelayPairing } from '@/components/settings/QrRelayPairing';

/** How customers reach table-QR ordering from outside the shop network, and retiring printed QR codes. */
export function GuestQrNetworkSettings({ disabled }: { disabled: boolean }) {
  const t = useTranslations('settings');
  const { confirm, ConfirmDialog } = useConfirm();

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

  return (
    <div data-testid="settings-qr-network" className="space-y-3 ps-7">
      <QrRelayPairing disabled={disabled} />
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => void rotate()}>
        {t('qrRotate')}
      </Button>
      {ConfirmDialog}
    </div>
  );
}
