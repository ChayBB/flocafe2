'use client';

import { BellRing } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { playKdsReadyBell, readKdsReadyBell, unlockKdsAlertSound } from '@/lib/kds-alert-sound';

/** Rings this display's ready bell on demand; a display set to no bell rings the hotel bell. */
export function KdsBellButton() {
  const t = useTranslations('kds');
  const ring = () => {
    unlockKdsAlertSound();
    const bell = readKdsReadyBell();
    void playKdsReadyBell(bell === 'none' ? 'hotel' : bell);
  };
  return (
    <button
      type="button"
      data-testid="kds-bell-button"
      onClick={ring}
      className="flex min-h-14 shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-card px-6 text-base font-medium text-foreground hover:bg-muted active:scale-[0.98] transition"
    >
      <BellRing size={22} className="text-(--kds-pending)" />
      {t('ringBell')}
    </button>
  );
}
