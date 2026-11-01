'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BellRing } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { KdsHeader } from '@/components/kds/KdsHeader';
import { KdsKanbanBoard } from '@/components/kds/KdsKanbanBoard';
import { KdsMessageBar } from '@/components/kds/KdsMessageBar';
import { KdsSettingsDialog } from '@/components/kds/KdsSettingsDialog';
import { KdsTabsView } from '@/components/kds/KdsTabsView';
import { useKdsView } from '@/hooks/useKdsView';
import { useKdsScreenMode } from '@/lib/kds-screen-mode';
import type { KitchenStatus, UseKdsConnectionResult } from '@/hooks/useKdsConnection';
import {
  isKdsAlertSoundLocked,
  playKdsAlert,
  playKdsReadyBell,
  readKdsReadyBell,
  readKdsReadyDelay,
  subscribeKdsAlertSound,
  unlockKdsAlertSound,
} from '@/lib/kds-alert-sound';
import {
  kdsSpeechLang,
  readKdsSoundSettings,
  queueKdsSound,
  speakKds,
  speakKdsNow,
  writeKdsSoundSettings,
  type KdsSoundSetting,
  type KdsSoundSettings,
} from '@/lib/kds-sound-settings';
import {
  addKdsMessages,
  cancelKdsTakeawayMessages,
  detectKdsBoardChanges,
  dismissKdsMessage,
  getKdsMessages,
  getServerKdsMessages,
  kdsItemPlaces,
  readSeenKdsAlerts,
  subscribeKdsMessages,
  writeSeenKdsAlerts,
  type KdsItemPlace,
  type KdsMessage,
} from '@/lib/kds-messages';
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
// A ready announcement waits this long after new items have been read out.
const AFTER_READ_ALOUD_MS = 3000;

// Items switched to take-away are still cooked, so they are read out and announced; cancelled ones are not.
function liveItems(order: UseKdsConnectionResult['orders'][number]) {
  return (order.items || []).filter(
    (item) => !TERMINAL_ITEM_STATUSES.includes(item.status || '') && item.service_change !== 'cancelled',
  );
}


/** Adds new notices to the message bar; each beeps (take-away already beeps on its own) and is read out. */
function announceKdsMessages(fresh: KdsMessage[]) {
  if (fresh.length === 0) return;
  addKdsMessages(fresh);
  const emergency = fresh.some((message) => message.kind === 'emergency');
  if (fresh.some((message) => message.kind !== 'takeaway')) playKdsAlert(emergency ? 3 : 1);
  speakKds(fresh.map((message) => message.text).join('. '), kdsSpeechLang());
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
  // Table moves, merges, items switched to take-away and emergency calls wait in the message bar
  // until acknowledged.
  const messages = useSyncExternalStore(subscribeKdsMessages, getKdsMessages, getServerKdsMessages);
  const knownPlacesRef = useRef<Map<number, KdsItemPlace> | null>(null);
  useEffect(() => {
    const places = kdsItemPlaces(conn.orders, (order) =>
      order.table?.name ? t('tableLabel', { name: order.table.name }) : t('messageOrder', { number: order.order_number }),
    );
    const known = knownPlacesRef.current;
    knownPlacesRef.current = places;
    if (!known || !soundSettingsRef.current.showMessages) return;
    const at = new Date().toISOString();
    const notices = detectKdsBoardChanges(known, places).map((change) => ({
      id: `${change.key}:${at}`,
      kind: change.kind,
      at,
      text:
        'place' in change
          ? t(change.kind === 'takeaway' ? 'messageTakeaway' : 'messageCancelled', {
              place: change.place,
              item: change.item,
            })
          : t(change.kind === 'move' ? 'messageMove' : 'messageMerge', { from: change.from, to: change.to }),
    }));
    announceKdsMessages(notices.filter((notice) => notice.kind !== 'cancelled'));
    // A cancellation only updates an item's take-away notice; the card already beeps for it.
    const cancelled = cancelKdsTakeawayMessages(notices.filter((notice) => notice.kind === 'cancelled'));
    if (cancelled.length > 0) speakKds(cancelled.map((notice) => notice.text).join('. '), kdsSpeechLang());
  }, [conn.orders, t]);
  useEffect(() => {
    const seen = readSeenKdsAlerts();
    const unseen = conn.alerts.filter((alert) => !seen.includes(alert.id));
    if (unseen.length === 0) return;
    writeSeenKdsAlerts([...seen, ...unseen.map((alert) => alert.id)]);
    if (!soundSettingsRef.current.showMessages) return;
    announceKdsMessages(
      unseen.map((alert) => ({
        id: `alert:${alert.id}`,
        kind: 'emergency' as const,
        at: alert.created_at,
        text: [
          t('messageEmergency'),
          alert.table ? t('tableLabel', { name: alert.table }) : null,
          alert.message || null,
          alert.sent_by ? t('messageFrom', { name: alert.sent_by }) : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    );
  }, [conn.alerts, t]);
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

  // Items already in the kitchen when this display receives its orders are not announced, nor are items
  // already ready. Every station counts, so switching station never reads out what was already there.
  const knownItemIdsRef = useRef<Set<number> | null>(null);
  const knownStatusesRef = useRef<Map<number, string>>(new Map());
  // An order note is read with the order's new items, once per wording.
  const readOrderNotesRef = useRef<Map<number, string>>(new Map());
  const lastReadyAtRef = useRef<Map<string, number>>(new Map());
  const readAloudEndedAtRef = useRef(-Infinity);
  const readyAlertEndedAtRef = useRef(-Infinity);
  const readyChainRef = useRef<Promise<void>>(Promise.resolve());
  const ordersSynced = conn.ordersSynced;
  useEffect(() => {
    if (!ordersSynced) return;
    const allLive = conn.orders.flatMap((order) => liveItems(order));
    const itemIds = new Set(allLive.map((item) => item.id));
    const knownItems = knownItemIdsRef.current;
    const knownStatuses = knownStatusesRef.current;
    const readOrderNotes = readOrderNotesRef.current;
    if (knownItems && soundSettingsRef.current.readAloud) {
      const phrases = orders
        .map((order) => {
          const fresh = liveItems(order).filter((item) => !knownItems.has(item.id));
          if (fresh.length === 0) return null;
          const items = fresh
            .map((item) => {
              const note = item.special_instructions?.trim();
              return note
                ? t('readAloudItemNote', { name: item.product_name, quantity: item.quantity, note })
                : t('readAloudItem', { name: item.product_name, quantity: item.quantity });
            })
            .join(', ');
          const orderNote = order.special_instructions?.trim() || '';
          const withNote =
            orderNote && readOrderNotes.get(order.id) !== orderNote
              ? `${items}. ${t('readAloudOrderNote', { note: orderNote })}`
              : items;
          return order.table?.name
            ? t('readAloudTable', { table: order.table.name, items: withNote })
            : t('readAloudOrder', { number: order.order_number, items: withNote });
        })
        .filter(Boolean);
      if (phrases.length > 0) {
        const text = phrases.join('. ');
        const lang = kdsSpeechLang();
        queueKdsSound(async () => {
          await speakKdsNow(text, lang);
          readAloudEndedAtRef.current = Date.now();
        });
      }
    }
    // Any menu item that turns ready rings the bell and names its table, even while the rest of the
    // order is still cooking. A table is announced once however many items turn ready together, and
    // not again until this display's repeat delay has passed.
    const now = Date.now();
    const repeatMs = readKdsReadyDelay('repeat') * 1000;
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
      const lang = kdsSpeechLang();
      const gapMs = readKdsReadyDelay('gap') * 1000;
      // With a delay between tables each table waits its turn; without one they share a bell.
      const announcements = gapMs > 0 ? [...readyPhrases.values()] : [[...readyPhrases.values()].join('. ')];
      const sleep = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : undefined);
      for (const announcement of announcements) {
        // The wait between tables happens outside the speech queue, so new orders are still read out.
        readyChainRef.current = readyChainRef.current
          .then(async () => {
            await sleep(readyAlertEndedAtRef.current + gapMs - Date.now());
            await new Promise<void>((done) =>
              queueKdsSound(async () => {
                try {
                  await sleep(readAloudEndedAtRef.current + AFTER_READ_ALOUD_MS - Date.now());
                  const bell = readKdsReadyBell();
                  if (bell !== 'none') await playKdsReadyBell(bell);
                  await speakKdsNow(announcement, lang);
                } finally {
                  readyAlertEndedAtRef.current = Date.now();
                  done();
                }
              }),
            );
          })
          .catch(() => {});
      }
    }
    knownItemIdsRef.current = new Set([...(knownItems ?? []), ...itemIds]);
    for (const order of conn.orders) {
      const note = order.special_instructions?.trim();
      if (note) readOrderNotes.set(order.id, note);
    }
    knownStatusesRef.current = new Map(allLive.map((item) => [item.id, item.status || ''] as const));
  }, [orders, conn.orders, ordersSynced, t]);

  return (
    <div data-testid="kds-workspace" className="relative h-full flex-1 flex flex-col">
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
          className="fixed bottom-24 start-1/2 z-40 flex min-h-11 -translate-x-1/2 rtl:translate-x-1/2 items-center justify-center gap-2 rounded-full border border-amber-400 bg-amber-50 px-4 text-sm font-semibold text-amber-800 shadow-lg"
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
        screenMode={screen.mode}
        onScreenMode={screen.setMode}
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
      {(soundSettings.showMessages || soundSettings.showBell) && (
        <KdsMessageBar
          messages={messages}
          onDismiss={dismissKdsMessage}
          showMessages={soundSettings.showMessages}
          showBell={soundSettings.showBell}
        />
      )}
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
