'use client';

import { useMemo, useState } from 'react';
import { KdsHeader } from '@/components/kds/KdsHeader';
import { KdsKanbanBoard } from '@/components/kds/KdsKanbanBoard';
import { KdsTabsView } from '@/components/kds/KdsTabsView';
import { useKdsView } from '@/hooks/useKdsView';
import type { UseKdsConnectionResult } from '@/hooks/useKdsConnection';

const STATION_KEY = 'flocafe:kds-station';

/** The station this display last showed; null until one is picked, '' for all stations. */
function readStoredStation(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STATION_KEY);
  } catch {
    return null;
  }
}

export function KdsWorkspace({ conn, serverDefault }: { conn: UseKdsConnectionResult; serverDefault: 'tabs' | 'kanban' | null }) {
  const { viewMode, setViewMode } = useKdsView(serverDefault);
  const [storedStation, setStoredStation] = useState(readStoredStation);
  const preferred = storedStation ?? conn.assignedStationIds[0] ?? '';
  const stationId = conn.stations.some((station) => station.id === preferred) ? preferred : '';

  const changeStation = (next: string) => {
    setStoredStation(next);
    try {
      window.localStorage.setItem(STATION_KEY, next);
    } catch {}
  };

  const orders = useMemo(() => {
    if (!stationId) return conn.orders;
    return conn.orders
      .map((order) => ({
        ...order,
        items: (order.items || []).filter((item) => item.station_ids?.includes(stationId)),
      }))
      .filter((order) => order.items.length > 0);
  }, [conn.orders, stationId]);

  return (
    <div data-testid="kds-workspace" className="h-full flex flex-col">
      <KdsHeader
        userName={conn.user!.name}
        userRole={conn.user!.role}
        connected={conn.connected}
        connectionMode={conn.connectionMode}
        viewMode={viewMode}
        onChangeView={setViewMode}
        stations={conn.stations}
        stationId={stationId}
        onChangeStation={changeStation}
        onLogout={conn.handleLogout}
      />
      <div className="flex-1 min-h-0 flex flex-col">
        {viewMode === 'kanban' ? (
          <KdsKanbanBoard orders={orders} updating={conn.updating} updateItemStatus={conn.updateItemStatus} />
        ) : (
          <KdsTabsView
            orders={orders}
            updating={conn.updating}
            updateItemStatus={conn.updateItemStatus}
          />
        )}
      </div>
      {conn.ConfirmDialog}
    </div>
  );
}
