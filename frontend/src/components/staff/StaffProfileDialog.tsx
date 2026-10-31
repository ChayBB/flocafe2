'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import type { Staff, Table } from '@/lib/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useFormatDate } from '@/hooks/useFormatDate';

/** A read-only summary of one staff member: account, sign-in setup and the zones they look after. */
export function StaffProfileDialog({
  member,
  roleLabel,
  canViewTables,
  onClose,
}: {
  member: Staff;
  roleLabel: string;
  canViewTables: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('staff');
  const { formatDate } = useFormatDate();
  const [tables, setTables] = useState<Table[] | null>(null);

  useEffect(() => {
    if (!canViewTables) return;
    let cancelled = false;
    api
      .get('/tables')
      .then(({ data }) => {
        if (!cancelled) setTables(data.tables || []);
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canViewTables]);

  const zones = new Map<string, string[]>();
  for (const table of tables ?? []) {
    if (!table.is_active || table.owner_user_id !== member.id) continue;
    const zone = table.floor || t('zonesNoZone');
    zones.set(zone, [...(zones.get(zone) ?? []), table.name]);
  }
  const signIn = [member.has_pin ? t('pinSet') : null, member.has_staff_code ? t('staffCodeSet') : null].filter(Boolean);
  const rows: [string, string][] = [
    [t('profileRole'), roleLabel],
    [t('profileEmail'), member.email || '—'],
    [t('profileStatus'), member.is_active ? t('profileActive') : t('profileInactive')],
    [t('profileSignIn'), signIn.length > 0 ? signIn.join(' · ') : t('profilePasswordOnly')],
    [t('profileAdded'), formatDate(member.created_at)],
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="staff-profile-dialog" aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{member.name}</DialogTitle>
        </DialogHeader>
        <dl className="divide-y divide-border text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex gap-3 py-2.5">
              <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 flex-1 break-words text-foreground">{value}</dd>
            </div>
          ))}
          {canViewTables && (
            <div className="flex gap-3 py-2.5">
              <dt className="w-32 shrink-0 text-muted-foreground">{t('tabZones')}</dt>
              <dd data-testid="staff-profile-zones" className="min-w-0 flex-1 space-y-1 text-foreground">
                {tables === null
                  ? '…'
                  : zones.size === 0
                    ? t('profileNoZone')
                    : [...zones].map(([zone, names]) => (
                        <p key={zone}>
                          <span className="font-medium">{zone}</span>
                          <span className="text-muted-foreground"> · {names.join(', ')}</span>
                        </p>
                      ))}
              </dd>
            </div>
          )}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
