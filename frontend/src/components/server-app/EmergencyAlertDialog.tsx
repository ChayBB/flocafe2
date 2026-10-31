'use client';

import { useState } from 'react';
import type { AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toastApiError } from '@/lib/api-error';

const MESSAGE_MAX = 120;

/** Sends an emergency call to every kitchen display, with an optional note and the table in view. */
export function EmergencyAlertDialog({
  api,
  tableName,
  open,
  onClose,
}: {
  api: AxiosInstance;
  tableName: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('serverApp');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      await api.post('/api/kds-alerts', { message: message.trim(), table: tableName });
      toast.success(t('emergencySent'));
      setMessage('');
      onClose();
    } catch (error) {
      toastApiError(error, t('emergencyFailed'), (key: string) => key);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !sending && onClose()}>
      <DialogContent data-testid="server-app-emergency-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <TriangleAlert size={20} />
            {t('emergencyTitle')}
          </DialogTitle>
          <DialogDescription>
            {tableName ? t('emergencyHintTable', { name: tableName }) : t('emergencyHint')}
          </DialogDescription>
        </DialogHeader>
        <textarea
          data-testid="server-app-emergency-message"
          value={message}
          maxLength={MESSAGE_MAX}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={t('emergencyPlaceholder')}
          rows={3}
          className="w-full rounded-lg border border-border bg-background p-3 text-sm"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="min-h-11 rounded-lg border border-border px-4 text-sm font-medium disabled:opacity-50"
          >
            {t('emergencyCancel')}
          </button>
          <button
            type="button"
            data-testid="server-app-emergency-send"
            onClick={send}
            disabled={sending}
            className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {t('emergencySend')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
