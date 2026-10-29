'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { STATUS_CONFIG, STATUS_ORDER, type KitchenStatus } from '@/hooks/useKdsConnection';

export function nextKitchenStatus(status: KitchenStatus): KitchenStatus | null {
  const index = STATUS_ORDER.indexOf(status as (typeof STATUS_ORDER)[number]);
  return index >= 0 && index < STATUS_ORDER.length - 1 ? STATUS_ORDER[index + 1] : null;
}

/** One-tap advance of an item to its next kitchen stage. */
export function KdsStatusToggle({
  status,
  disabled,
  onAdvance,
}: {
  status: KitchenStatus;
  disabled?: boolean;
  onAdvance: (next: KitchenStatus) => void;
}) {
  const t = useTranslations('kds');
  const next = nextKitchenStatus(status);
  if (!next) return null;
  const nextConfig = STATUS_CONFIG[next];
  const label = t('advanceTo', { status: t(nextConfig.labelKey) });

  return (
    <button
      type="button"
      data-testid="kds-status-toggle"
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onAdvance(next);
      }}
      className="shrink-0 min-w-11 min-h-11 flex items-center justify-center disabled:opacity-50"
    >
      <span
        className={`flex items-center gap-1 h-8 ps-1 pe-1.5 rounded-full border-2 ${nextConfig.border} bg-card shadow-sm active:scale-95 transition`}
      >
        <span className={`w-5 h-5 rounded-full ${nextConfig.color}`} />
        <ChevronRight size={16} className={`${nextConfig.text} rtl-flip`} />
      </span>
    </button>
  );
}
