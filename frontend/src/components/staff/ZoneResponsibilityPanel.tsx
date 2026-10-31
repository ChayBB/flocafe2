'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { MapPin } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import type { Staff, Table } from '@/lib/types';

interface Zone {
  name: string;
  owners: { id: string; name: string; tables: string[] }[];
  unowned: number;
}

function zonesOf(tables: Table[], staff: Staff[]): Zone[] {
  const names = new Map(staff.map((member) => [String(member.id), member.name]));
  const zones = new Map<string, Zone>();
  for (const table of tables) {
    if (!table.is_active) continue;
    const name = table.floor ?? '';
    const zone = zones.get(name) ?? { name, owners: [], unowned: 0 };
    zones.set(name, zone);
    if (!table.owner_user_id) {
      zone.unowned += 1;
      continue;
    }
    let owner = zone.owners.find((entry) => entry.id === table.owner_user_id);
    if (!owner) {
      owner = { id: table.owner_user_id, name: names.get(table.owner_user_id) ?? table.owner_name ?? '—', tables: [] };
      zone.owners.push(owner);
    }
    owner.tables.push(table.name);
  }
  return [...zones.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Who looks after each floor zone, as set on the floor plan. */
export function ZoneResponsibilityPanel({ staff, canManageTables }: { staff: Staff[]; canManageTables: boolean }) {
  const t = useTranslations('staff');
  const [tables, setTables] = useState<Table[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/tables')
      .then(({ data }) => {
        if (!cancelled) setTables(data.tables || []);
      })
      .catch(() => {
        if (!cancelled) {
          setTables([]);
          toast.error(t('zonesLoadFailed'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const zones = tables ? zonesOf(tables, staff) : [];
  return (
    <section data-testid="zone-panel" className="bg-card rounded-xl border border-border p-5">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-bold text-foreground">{t('tabZones')}</h2>
          <p className="text-sm text-muted-foreground">{t('zonesHint')}</p>
        </div>
        {canManageTables && (
          <Link href="/tables" className="text-sm font-medium text-brand hover:underline">
            {t('zonesManage')}
          </Link>
        )}
      </div>
      {tables === null ? null : zones.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('zonesEmpty')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {zones.map((zone) => (
            <div key={zone.name} data-testid="zone-card" className="rounded-lg border border-border p-4">
              <p className="mb-3 flex items-center gap-1.5 font-semibold text-foreground">
                <MapPin size={16} className="text-muted-foreground" />
                {zone.name || t('zonesNoZone')}
              </p>
              <ul className="space-y-2">
                {zone.owners.map((owner) => (
                  <li key={owner.id} data-testid="zone-owner" className="text-sm">
                    <span className="font-medium text-foreground">{owner.name}</span>
                    <span className="text-muted-foreground"> · {owner.tables.join(', ')}</span>
                  </li>
                ))}
                {zone.unowned > 0 && (
                  <li className="text-sm text-muted-foreground">{t('zonesUnowned', { count: zone.unowned })}</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
