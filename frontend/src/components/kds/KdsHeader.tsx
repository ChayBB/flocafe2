'use client';

import { ChefHat, LogOut, Moon, Settings, Sun, Wifi, WifiOff } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { ConnectionMode, KdsStation } from '@/hooks/useKdsConnection';
import type { KdsViewMode } from '@/hooks/useKdsView';
import type { KdsScreenMode } from '@/lib/kds-screen-mode';

export interface KdsHeaderProps {
  userName: string;
  userRole: string;
  connected: boolean;
  connectionMode: ConnectionMode;
  viewMode: KdsViewMode;
  onChangeView: (mode: KdsViewMode) => void;
  stations: KdsStation[];
  stationId: string;
  onChangeStation: (stationId: string) => void;
  screenMode: KdsScreenMode;
  onScreenMode: (mode: KdsScreenMode) => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export function KdsHeader({
  userName,
  userRole,
  connected,
  connectionMode,
  viewMode,
  onChangeView,
  stations,
  stationId,
  onChangeStation,
  screenMode,
  onScreenMode,
  onOpenSettings,
  onLogout,
}: KdsHeaderProps) {
  const t = useTranslations('kds');
  const tNav = useTranslations('nav');

  return (
    <div className="shrink-0 mb-4">
      <div className="flex items-center gap-3 mb-3">
        <ChefHat size={24} className="text-muted-foreground" />
        <div>
          <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-xs text-muted-foreground">
            {userName} ({userRole})
          </p>
        </div>
        <div className="ms-auto flex items-center gap-2">
          {connectionMode === 'websocket' ? (
            <span title={t('wsConnected')}>
              <Wifi size={16} className="text-green-500" />
            </span>
          ) : connectionMode === 'rest' ? (
            <span title={t('restPolling')}>
              <WifiOff size={16} className="text-amber-500" />
            </span>
          ) : null}
          <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs text-gray-400">
            {connected
              ? connectionMode === 'websocket'
                ? t('connectionLive')
                : t('connectionPolling')
              : t('connectionConnecting')}
          </span>

          <select
            data-testid="kds-station-select"
            aria-label={t('stationFilter')}
            title={t('stationFilter')}
            value={stationId}
            disabled={stations.length === 0}
            onChange={(e) => onChangeStation(e.target.value)}
            className="min-h-11 ms-2 px-2.5 text-xs font-medium rounded-lg border border-border bg-card text-foreground disabled:opacity-60"
          >
            <option value="">{stations.length === 0 ? t('noStations') : t('allStations')}</option>
            {stations.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </select>

          <div className="flex items-center bg-muted rounded-lg p-0.5 ms-2" role="tablist">
            <button
              onClick={() => onChangeView('tabs')}
              aria-pressed={viewMode === 'tabs'}
              className={`min-w-11 min-h-11 px-2.5 py-1 text-xs font-medium rounded-md transition ${
                viewMode === 'tabs'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('viewTabs')}
            </button>
            <button
              onClick={() => onChangeView('kanban')}
              aria-pressed={viewMode === 'kanban'}
              className={`min-w-11 min-h-11 px-2.5 py-1 text-xs font-medium rounded-md transition ${
                viewMode === 'kanban'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('viewKanban')}
            </button>
          </div>

          <button
            type="button"
            data-testid="kds-screen-mode-toggle"
            onClick={() => onScreenMode(screenMode === 'night' ? 'day' : 'night')}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-muted-foreground ms-2"
            title={screenMode === 'night' ? t('screenModeToDay') : t('screenModeToNight')}
            aria-label={screenMode === 'night' ? t('screenModeToDay') : t('screenModeToNight')}
          >
            {screenMode === 'night' ? <Sun size={20} /> : <Moon size={20} />}
          </button>

          <button
            type="button"
            data-testid="kds-settings-button"
            onClick={onOpenSettings}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-muted-foreground ms-2"
            title={t('settingsTitle')}
            aria-label={t('settingsTitle')}
          >
            <Settings size={20} />
          </button>

          <button
            onClick={onLogout}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-muted-foreground ms-2"
            title={tNav('logout')}
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
