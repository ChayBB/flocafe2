'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslations } from 'use-intl';

export type TransferMode = 'move' | 'merge';

export interface TransferTable {
  id: string;
  name: string;
  /** The table has an open order. */
  occupied: boolean;
  reserved: boolean;
}

const normalize = (value: string) => value.trim().toLowerCase();

/**
 * Asks for the table number an order moves to (a free table) or merges into (a table with an
 * open order), with the eligible tables offered as shortcuts.
 */
export function TableTransferDialog({
  mode,
  fromName,
  fromId,
  tables,
  busy,
  onConfirm,
  onClose,
}: {
  mode: TransferMode;
  fromName: string;
  fromId: string;
  tables: TransferTable[];
  busy: boolean;
  onConfirm: (target: TransferTable) => void;
  onClose: () => void;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const eligible = (table: TransferTable) =>
    table.id !== fromId && (mode === 'move' ? !table.occupied && !table.reserved : table.occupied);
  const choices = tables.filter(eligible);

  const submit = () => {
    const name = value.trim();
    const target = tables.find((table) => normalize(table.name) === normalize(name));
    if (!target) return setError(t('tableNotFound', { name }));
    if (target.id === fromId) return setError(t('sameTable'));
    if (mode === 'move' && (target.occupied || target.reserved)) return setError(t('tableNotFree', { name: target.name }));
    if (mode === 'merge' && !target.occupied) return setError(t('tableHasNoOrder', { name: target.name }));
    setError('');
    onConfirm(target);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-transfer-title"
        data-testid="server-app-table-transfer"
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-card p-4 text-foreground sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h2 id="table-transfer-title" className="text-base font-bold">
              {mode === 'move' ? t('moveTable') : t('mergeTable')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {mode === 'move' ? t('moveTableFrom', { name: fromName }) : t('mergeTableFrom', { name: fromName })}
            </p>
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

        <label className="mb-1 block text-xs font-semibold text-muted-foreground" htmlFor="table-transfer-input">
          {t('targetTableLabel')}
        </label>
        <input
          id="table-transfer-input"
          data-testid="server-app-table-transfer-input"
          autoFocus
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError('');
          }}
          placeholder={t('targetTablePlaceholder')}
          className="h-12 w-full rounded-lg border border-border bg-background px-3 text-lg font-semibold outline-none focus:border-brand focus:ring-2 focus:ring-brand"
        />
        {error && (
          <p role="alert" data-testid="server-app-table-transfer-error" className="mt-1.5 text-sm text-red-600">
            {error}
          </p>
        )}

        {choices.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {choices.map((table) => (
              <button
                key={table.id}
                type="button"
                onClick={() => {
                  setValue(table.name);
                  setError('');
                }}
                className="min-h-9 rounded-full border border-border px-3 text-sm font-medium hover:border-brand"
              >
                {table.name}
              </button>
            ))}
          </div>
        )}

        <button
          type="submit"
          data-testid="server-app-table-transfer-confirm"
          disabled={busy || !value.trim()}
          className="mt-4 flex h-12 w-full items-center justify-center rounded-lg bg-brand font-semibold text-white disabled:opacity-50"
        >
          {mode === 'move' ? t('confirmMove') : t('confirmMerge')}
        </button>
      </form>
    </div>
  );
}
