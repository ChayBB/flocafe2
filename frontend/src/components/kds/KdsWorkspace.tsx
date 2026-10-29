'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { KdsHeader } from '@/components/kds/KdsHeader';
import { KdsKanbanBoard } from '@/components/kds/KdsKanbanBoard';
import { KdsSettingsDialog } from '@/components/kds/KdsSettingsDialog';
import { KdsTabsView } from '@/components/kds/KdsTabsView';
import { useKdsView } from '@/hooks/useKdsView';
import type { KitchenStatus, UseKdsConnectionResult } from '@/hooks/useKdsConnection';

const INACTIVE_STAGES_KEY = 'flocafe:kds-inactive-stages';
type InactiveStages = Record<string, KitchenStatus[]>;

/** Switched-off stages per station on this display; '' is "all stations". */
function readInactiveStages(): InactiveStages {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(INACTIVE_STAGES_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const NONE_INACTIVE: KitchenStatus[] = [];

export function KdsWorkspace({ conn, serverDefault }: { conn: UseKdsConnectionResult; serverDefault: 'tabs' | 'kanban' | null }) {
  const t = useTranslations('kds');
  const { viewMode, setViewMode } = useKdsView(serverDefault);
  // Every display opens on all stations; picking one narrows the board to that category.
  const [selectedStation, setSelectedStation] = useState('');
  const stationId = conn.stations.some((station) => station.id === selectedStation) ? selectedStation : '';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inactiveStages, setInactiveStages] = useState<InactiveStages>(readInactiveStages);
  const inactiveStatuses = inactiveStages[stationId] ?? NONE_INACTIVE;
  const stationName = conn.stations.find((station) => station.id === stationId)?.name;

  const toggleStage = (status: KitchenStatus) => {
    setInactiveStages((current) => {
      const stages = current[stationId] ?? [];
      const nextStages = stages.includes(status)
        ? stages.filter((stage) => stage !== status)
        : [...stages, status];
      const next = { ...current, [stationId]: nextStages };
      try {
        window.localStorage.setItem(INACTIVE_STAGES_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const orders = useMemo(() => {
    if (!stationId) return conn.orders;
    return conn.orders
      .map((order) => ({
        ...order,
        items: (order.items || []).filter((item) => item.station_category_id === stationId),
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
        onChangeStation={setSelectedStation}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={conn.handleLogout}
      />
      <div className="flex-1 min-h-0 flex flex-col">
        {viewMode === 'kanban' ? (
          <KdsKanbanBoard
            orders={orders}
            updating={conn.updating}
            inactiveStatuses={inactiveStatuses}
            updateItemStatus={conn.updateItemStatus}
          />
        ) : (
          <KdsTabsView
            orders={orders}
            updating={conn.updating}
            inactiveStatuses={inactiveStatuses}
            updateItemStatus={conn.updateItemStatus}
          />
        )}
      </div>
      <KdsSettingsDialog
        open={settingsOpen}
        stationName={stationName ?? t('allStations')}
        inactiveStatuses={inactiveStatuses}
        onToggleStatus={toggleStage}
        onClose={() => setSettingsOpen(false)}
      />
      {conn.ConfirmDialog}
    </div>
  );
}
