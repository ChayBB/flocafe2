'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BellRing } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { KdsHeader } from '@/components/kds/KdsHeader';
import { KdsKanbanBoard } from '@/components/kds/KdsKanbanBoard';
import { KdsSettingsDialog } from '@/components/kds/KdsSettingsDialog';
import { KdsTabsView } from '@/components/kds/KdsTabsView';
import { useKdsView } from '@/hooks/useKdsView';
import { useKdsScreenMode } from '@/lib/kds-screen-mode';
import type { KitchenStatus, UseKdsConnectionResult } from '@/hooks/useKdsConnection';
import {
  isKdsAlertSoundLocked,
  playKdsAlert,
  playKdsReadyBell,
  readKdsReadyRepeat,
  subscribeKdsAlertSound,
  unlockKdsAlertSound,
} from '@/lib/kds-alert-sound';
import {
  kdsSpeechLang,
  readKdsSoundSettings,
  speakKds,
  writeKdsSoundSettings,
  type KdsSoundSetting,
  type KdsSoundSettings,
} from '@/lib/kds-sound-settings';
import { TERMINAL_ITEM_STATUSES } from '@shared/order-item-status';

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

function liveItems(order: UseKdsConnectionResult['orders'][number]) {
  return (order.items || []).filter((item) => !TERMINAL_ITEM_STATUSES.includes(item.status || '') && !item.service_change);
}


function serviceChangesById(orders: UseKdsConnectionResult['orders']): Map<number, string | null> {
  return new Map(
    orders.flatMap((order) => (order.items || []).map((item) => [item.id, item.service_change ?? null] as const)),
  );
}

export function KdsWorkspace({ conn, serverDefault }: { conn: UseKdsConnectionResult; serverDefault: 'tabs' | 'kanban' | null }) {
  const t = useTranslations('kds');
  const { viewMode, setViewMode } = useKdsView(serverDefault);
  const screen = useKdsScreenMode();

  // Sound needs one tap per page in a browser; any tap on the display unlocks it. The prompt floats,
  // so it disappearing on that tap never shifts the board under the finger.
  const soundLocked = useSyncExternalStore(subscribeKdsAlertSound, isKdsAlertSoundLocked, () => false);
  useEffect(() => {
    window.addEventListener('pointerdown', unlockKdsAlertSound);
    window.addEventListener('keydown', unlockKdsAlertSound);
    return () => {
      window.removeEventListener('pointerdown', unlockKdsAlertSound);
      window.removeEventListener('keydown', unlockKdsAlertSound);
    };
  }, []);
  const flashRef = useRef<HTMLDivElement>(null);
  const [soundSettings, setSoundSettings] = useState<KdsSoundSettings>(readKdsSoundSettings);
  const soundSettingsRef = useRef(soundSettings);
  useEffect(() => {
    soundSettingsRef.current = soundSettings;
  }, [soundSettings]);
  const toggleSound = (setting: KdsSoundSetting) => {
    setSoundSettings((current) => {
      const next = { ...current, [setting]: !current[setting] };
      writeKdsSoundSettings(next);
      return next;
    });
  };

  // Alert when an item already on this display gains a service change; items seen for the first time do not.
  // While sound is blocked the screen flashes orange instead.
  const knownChangesRef = useRef<Map<number, string | null>>(new Map());
  useEffect(() => {
    const current = serviceChangesById(conn.orders);
    const known = knownChangesRef.current;
    let changed = false;
    for (const [id, change] of current) {
      if (change && known.has(id) && known.get(id) !== change) changed = true;
    }
    if (changed && !playKdsAlert()) {
      flashRef.current?.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }], {
        duration: 700,
        iterations: 4,
      });
    }
    knownChangesRef.current = new Map([...known, ...current]);
  }, [conn.orders]);
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

  // Items already on this display when it opens are not announced again, nor are items already ready.
  const knownItemIdsRef = useRef<Set<number> | null>(null);
  const knownStatusesRef = useRef<Map<number, string>>(new Map());
  const lastReadyAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const itemIds = new Set(orders.flatMap((order) => liveItems(order).map((item) => item.id)));
    const knownItems = knownItemIdsRef.current;
    const knownStatuses = knownStatusesRef.current;
    if (knownItems && soundSettingsRef.current.readAloud) {
      const phrases = orders
        .map((order) => {
          const fresh = liveItems(order).filter((item) => !knownItems.has(item.id));
          if (fresh.length === 0) return null;
          const items = fresh
            .map((item) => t('readAloudItem', { name: item.product_name, quantity: item.quantity }))
            .join(', ');
          return order.table?.name
            ? t('readAloudTable', { table: order.table.name, items })
            : t('readAloudOrder', { number: order.order_number, items });
        })
        .filter(Boolean);
      if (phrases.length > 0) speakKds(phrases.join('. '), kdsSpeechLang());
    }
    // Any menu item that turns ready rings the bell and names its table, even while the rest of the
    // order is still cooking. A table is announced once however many items turn ready together, and
    // not again until this display's repeat delay has passed.
    const now = Date.now();
    const repeatMs = readKdsReadyRepeat() * 1000;
    const lastReadyAt = lastReadyAtRef.current;
    const readyPhrases = new Map<string, string>();
    for (const order of orders) {
      const turnedReady = liveItems(order).some(
        (item) => item.status === 'ready' && knownStatuses.has(item.id) && knownStatuses.get(item.id) !== 'ready',
      );
      if (!turnedReady) continue;
      const key = order.table?.name ? `table:${order.table.name}` : `order:${order.id}`;
      if (readyPhrases.has(key) || now - (lastReadyAt.get(key) ?? -Infinity) < repeatMs) continue;
      readyPhrases.set(
        key,
        order.table?.name
          ? t('readyToServeTable', { table: order.table.name })
          : t('readyToServeOrder', { number: order.order_number }),
      );
    }
    if (readyPhrases.size > 0 && soundSettingsRef.current.orderReady) {
      for (const key of readyPhrases.keys()) lastReadyAt.set(key, now);
      const announcement = [...readyPhrases.values()].join('. ');
      void playKdsReadyBell().then(() => speakKds(announcement, kdsSpeechLang()));
    }
    knownItemIdsRef.current = new Set([...(knownItems ?? []), ...itemIds]);
    knownStatusesRef.current = new Map(
      orders.flatMap((order) => liveItems(order).map((item) => [item.id, item.status || ''] as const)),
    );
  }, [orders, t]);

  return (
    <div data-testid="kds-workspace" className="relative h-full flex flex-col">
      {/* Dims the board but not the settings dialog, so brightness can always be turned back up. */}
      {screen.brightness < 100 && (
        <div
          data-testid="kds-dimmer"
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[45] bg-black"
          style={{ opacity: (100 - screen.brightness) / 100 }}
        />
      )}
      <div
        ref={flashRef}
        data-testid="kds-change-flash"
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-50 border-[12px] border-orange-500 bg-orange-400/30 opacity-0"
      />
      {soundLocked && (
        <button
          type="button"
          data-testid="kds-sound-banner"
          onClick={unlockKdsAlertSound}
          className="fixed bottom-4 start-1/2 z-40 flex min-h-11 -translate-x-1/2 rtl:translate-x-1/2 items-center justify-center gap-2 rounded-full border border-amber-400 bg-amber-50 px-4 text-sm font-semibold text-amber-800 shadow-lg"
        >
          <BellRing size={18} />
          {t('enableAlertSound')}
        </button>
      )}
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
        soundSettings={soundSettings}
        onToggleSound={toggleSound}
        screenMode={screen.mode}
        onScreenMode={screen.setMode}
        brightness={screen.brightness}
        onBrightness={screen.setBrightness}
        onClose={() => setSettingsOpen(false)}
      />
      {conn.ConfirmDialog}
    </div>
  );
}
