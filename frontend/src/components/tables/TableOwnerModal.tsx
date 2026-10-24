'use client';

import { useEffect, useState } from 'react';
import { X, Check, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import type { Table } from '@/lib/types';

interface StaffOption {
  id: string;
  name: string;
  role: string;
  zones: string[];
}

export type OwnerScope =
  | { kind: 'table'; table: Table }
  | { kind: 'zone'; floor: string; name: string; ownerIds: string[] }
  | {
      kind: 'draft';
      floor: string;
      ownerIds: string[];
      onPick: (member: { id: string; name: string } | null, move: boolean) => void;
    };

interface Props {
  scope: OwnerScope;
  onClose: () => void;
  onSaved: () => void;
}

export default function TableOwnerModal({ scope, onClose, onSaved }: Props) {
  const t = useTranslations('tables');
  const tCommon = useTranslations('common');
  const [staff, setStaff] = useState<StaffOption[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<StaffOption | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/tables/owner-candidates')
      .then(({ data }) => {
        if (!cancelled) setStaff(data.staff || []);
      })
      .catch(() => {
        if (!cancelled) {
          setStaff([]);
          toast.error(t('tableOwnerFailed'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []); // oxlint-disable-line react-hooks/exhaustive-deps

  const tableZone = scope.kind === 'table' ? (scope.table.floor ?? '') : scope.floor;
  const heading = scope.kind === 'table' ? scope.table.name : scope.kind === 'zone' ? scope.name : scope.floor;
  const currentIds = new Set(
    scope.kind === 'table'
      ? scope.table.owner_user_id
        ? [scope.table.owner_user_id]
        : []
      : scope.ownerIds,
  );
  const otherZone = (member: StaffOption): string | null => {
    const zone = member.zones.find((candidate) => candidate !== tableZone);
    return zone === undefined ? null : zone;
  };
  const zoneLabel = (zone: string) => zone || t('tableOwnerNoZone');
  const hasArea = (member: StaffOption) => member.zones.length > 0;

  const choose = async (userId: string | null, move = false) => {
    if (savingId !== null) return;
    if (scope.kind === 'draft') {
      scope.onPick(userId === null ? null : (staff?.find((member) => member.id === userId) ?? null), move);
      onClose();
      return;
    }
    setSavingId(userId ?? '');
    try {
      const body = { user_id: userId, ...(move ? { move: true } : {}) };
      if (scope.kind === 'table') await api.put(`/tables/${scope.table.id}/owner`, body);
      else await api.put('/tables/zone-owner', { ...body, floor: scope.floor });
      toast.success(t('tableOwnerSaved'));
      onSaved();
      onClose();
    } catch (error) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      toast.error(code === 'owner_in_other_zone' ? t('tableOwnerConflict') : t('tableOwnerFailed'));
      setSavingId(null);
    }
  };

  const rowBase =
    'flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-start text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60';
  const currentRow = 'border-brand bg-[var(--color-brand-light)] font-semibold text-brand';
  const freeRow =
    'border-foreground bg-foreground font-semibold text-background hover:bg-foreground/90';
  const busyRow =
    'border-border bg-muted font-medium text-muted-foreground hover:bg-muted/70';
  const noneRow = 'border-border bg-card font-medium text-foreground hover:bg-accent';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-t-2xl bg-card p-5 shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('tableOwner')}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-foreground">{t('tableOwner')}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {scope.kind === 'table' ? `${heading} · ${zoneLabel(tableZone)}` : zoneLabel(tableZone)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon('close')}
            className="touch-target rounded-full text-muted-foreground hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        {pendingMove ? (
          <div className="space-y-3" data-testid="table-owner-move-confirm">
            <p className="text-sm text-foreground">
              {t('tableOwnerMoveConfirm', {
                name: pendingMove.name,
                from: zoneLabel(otherZone(pendingMove) ?? ''),
                to: zoneLabel(tableZone),
              })}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={savingId !== null}
                onClick={() => setPendingMove(null)}
                className="flex-1 rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground hover:bg-accent"
              >
                {tCommon('cancel')}
              </button>
              <button
                type="button"
                disabled={savingId !== null}
                onClick={() => choose(pendingMove.id, true)}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-foreground px-4 py-3 text-sm font-semibold text-background hover:bg-foreground/90 disabled:opacity-60"
              >
                {savingId !== null && <Loader2 size={14} className="animate-spin" />}
                {t('tableOwnerMove')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-sm bg-foreground" />
                {t('tableOwnerLegendFree')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-sm bg-muted-foreground/40" />
                {t('tableOwnerLegendBusy')}
              </span>
            </div>
            <div className="space-y-2 overflow-y-auto">
              {staff === null ? (
                <div className="flex justify-center py-6">
                  <Loader2 size={20} className="animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={savingId !== null}
                    onClick={() => choose(null)}
                    className={`${rowBase} ${currentIds.size > 0 ? noneRow : currentRow}`}
                  >
                    <span>{t('tableOwnerNone')}</span>
                    {currentIds.size === 0 && <Check size={16} />}
                  </button>
                  {[...staff]
                    .sort(
                      (a, b) =>
                        Number(hasArea(a)) - Number(hasArea(b)) ||
                        a.name.localeCompare(b.name),
                    )
                    .map((member) => {
                      const current = currentIds.has(member.id);
                      const busy = !current && hasArea(member);
                      const moveFrom = current ? null : otherZone(member);
                      return (
                        <button
                          key={member.id}
                          type="button"
                          disabled={savingId !== null}
                          onClick={() => (moveFrom !== null ? setPendingMove(member) : choose(member.id))}
                          className={`${rowBase} ${
                            current ? currentRow : busy ? busyRow : freeRow
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{member.name}</span>
                            {busy && (
                              <span className="block text-xs font-normal">
                                {t('tableOwnerInZone', {
                                  zone: member.zones.map(zoneLabel).join(', '),
                                })}
                              </span>
                            )}
                          </span>
                          {savingId === member.id ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            current && <Check size={16} />
                          )}
                        </button>
                      );
                    })}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
