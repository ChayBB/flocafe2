'use client';

import { useTranslations } from 'use-intl';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { STATUS_CONFIG, STATUS_ORDER, type KitchenStatus } from '@/hooks/useKdsConnection';
import { activeStages } from '@/lib/kds-stages';
import type { KdsSoundSetting, KdsSoundSettings } from '@/lib/kds-sound-settings';

const SOUND_ROWS = [
  { setting: 'readAloud' as KdsSoundSetting, labelKey: 'soundReadAloud' as const },
  { setting: 'statusChange' as KdsSoundSetting, labelKey: 'soundStatusChange' as const },
  { setting: 'orderReady' as KdsSoundSetting, labelKey: 'soundOrderReady' as const },
];

function Switch({
  checked,
  label,
  testId,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  testId: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onToggle}
      className="min-w-11 min-h-11 flex items-center justify-center disabled:opacity-40"
    >
      <span
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          checked ? 'bg-brand' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0.5 rtl:-translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

/** Display settings: which Kanban columns this station uses, and which sounds it plays. */
export function KdsSettingsDialog({
  open,
  stationName,
  inactiveStatuses,
  onToggleStatus,
  soundSettings,
  onToggleSound,
  onClose,
}: {
  open: boolean;
  stationName: string;
  inactiveStatuses: readonly KitchenStatus[];
  onToggleStatus: (status: KitchenStatus) => void;
  soundSettings: KdsSoundSettings;
  onToggleSound: (setting: KdsSoundSetting) => void;
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
                <Switch
                  checked={isActive}
                  label={t('stageSwitch', { status: stage })}
                  testId={`kds-stage-switch-${status}`}
                  disabled={locked}
                  onToggle={() => onToggleStatus(status)}
                />
              </div>
            );
          })}
        </div>
        <h3 className="pt-2 text-sm font-semibold text-foreground">{t('soundSettingsTitle')}</h3>
        <div className="divide-y divide-border">
          {SOUND_ROWS.map(({ setting, labelKey }) => {
            const on = soundSettings[setting];
            const label = t(labelKey);
            return (
              <div key={setting} className="flex items-center gap-3 py-3">
                <span className={`flex-1 text-sm font-medium ${on ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {label}
                </span>
                <span className="text-xs text-muted-foreground">{on ? t('stageActive') : t('stageSkipped')}</span>
                <Switch
                  checked={on}
                  label={label}
                  testId={`kds-sound-switch-${setting}`}
                  onToggle={() => onToggleSound(setting)}
                />
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
