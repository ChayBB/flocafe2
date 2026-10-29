'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'use-intl';

export interface MoveTarget {
  id: string;
  name: string;
}

/** Picks the free table an open order moves to. */
export function MoveTableSheet({
  fromName,
  targets,
  moving,
  onPick,
  onClose,
}: {
  fromName: string;
  targets: MoveTarget[];
  moving: boolean;
  onPick: (target: MoveTarget) => void;
  onClose: () => void;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-table-title"
        data-testid="server-app-move-table"
        className="max-h-[80vh] w-full overflow-y-auto rounded-t-2xl bg-card p-4 text-foreground sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 id="move-table-title" className="text-base font-bold">
              {t('moveTable')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('moveTableFrom', { name: fromName })}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon('close')}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground"
          >
            <X size={18} />
          </button>
        </div>
        {targets.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('noFreeTables')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {targets.map((target) => (
              <button
                key={target.id}
                type="button"
                disabled={moving}
                onClick={() => onPick(target)}
                className="min-h-14 rounded-lg border border-border bg-card px-2 py-2 text-start text-sm font-semibold hover:border-brand disabled:opacity-50"
              >
                {target.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
