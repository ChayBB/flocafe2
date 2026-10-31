'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { QrCode } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import { QrRelayPairing } from '@/components/settings/QrRelayPairing';
import TableQrSheet from '@/components/tables/TableQrSheet';

const MAX_SHEET_TABLES = 100;

/** How customers reach table-QR ordering from outside the shop network, and the table QR codes themselves. */
export function GuestQrNetworkSettings({ disabled }: { disabled: boolean }) {
  const t = useTranslations('settings');
  const { confirm, ConfirmDialog } = useConfirm();
  const [sheetTableIds, setSheetTableIds] = useState<string[] | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);

  const openTableQrs = async () => {
    setLoadingTables(true);
    try {
      const { data } = await api.get('/tables', { params: { active: 'true' } });
      const ids = ((data.tables || []) as { id: string }[]).map((table) => table.id).slice(0, MAX_SHEET_TABLES);
      if (ids.length === 0) toast.error(t('qrNoTables'));
      else setSheetTableIds(ids);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setLoadingTables(false);
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

  return (
    <div data-testid="settings-qr-network" className="space-y-3 ps-7">
      <QrRelayPairing disabled={disabled} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={disabled || loadingTables} onClick={() => void openTableQrs()}>
          <QrCode size={15} className="me-1.5" />
          {t('qrCreateTables')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => void rotate()}>
          {t('qrRotate')}
        </Button>
      </div>
      {sheetTableIds && <TableQrSheet tableIds={sheetTableIds} zoneName="" onClose={() => setSheetTableIds(null)} />}
      {ConfirmDialog}
    </div>
  );
}
