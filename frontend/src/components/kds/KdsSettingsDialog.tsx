'use client';

import { useTranslations } from 'use-intl';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { STATUS_CONFIG, STATUS_ORDER, type KitchenStatus } from '@/hooks/useKdsConnection';
import { activeStages } from '@/lib/kds-stages';

/** Display settings: which Kanban columns this station uses. */
export function KdsSettingsDialog({
  open,
  stationName,
  inactiveStatuses,
  onToggleStatus,
  onClose,
}: {
  open: boolean;
  stationName: string;
  inactiveStatuses: readonly KitchenStatus[];
  onToggleStatus: (status: KitchenStatus) => void;
  onClose: () => void;
}) {
  const t = useTranslations('kds');
  const active = activeStages(inactiveStatuses);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="kds-settings-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settingsTitle')}</DialogTitle>
          <DialogDescription>{t('settingsColumnsHint', { station: stationName })}</DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border">
          {STATUS_ORDER.map((status) => {
            const config = STATUS_CONFIG[status];
            const isActive = active.includes(status);
            // The last active column cannot be switched off.
            const locked = isActive && active.length === 1;
            const stage = t(config.labelKey);
            return (
              <div key={status} className="flex items-center gap-3 py-3">
                <span className={`w-2.5 h-2.5 rounded-full ${config.color}`} />
                <span className={`flex-1 text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {stage}
                </span>
                <span className="text-xs text-muted-foreground">
                  {isActive ? t('stageActive') : t('stageSkipped')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isActive}
                  aria-label={t('stageSwitch', { status: stage })}
                  data-testid={`kds-stage-switch-${status}`}
                  disabled={locked}
                  onClick={() => onToggleStatus(status)}
                  className="min-w-11 min-h-11 flex items-center justify-center disabled:opacity-40"
                >
                  <span
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      isActive ? 'bg-brand' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                        isActive ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0.5 rtl:-translate-x-0.5'
                      }`}
                    />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
