import { randomUUID } from 'crypto';

/**
 * A message every kitchen display shows: an emergency call from the Server App, or a kitchen ticket
 * the printer did not print.
 */
export interface KdsAlert {
  id: string;
  kind: 'emergency' | 'kot_unprinted';
  message: string;
  table: string | null;
  sent_by: string | null;
  created_at: string;
}

export const KDS_ALERT_MESSAGE_MAX = 120;
const KDS_ALERT_TTL_MS = 30 * 60 * 1000;
const KDS_ALERT_LIMIT = 20;

// Kept in memory only: a display that reconnects within the window still sees recent alerts.
let alerts: KdsAlert[] = [];

export function addKdsAlert(input: {
  message?: string;
  table?: string | null;
  sentBy?: string | null;
  kind?: KdsAlert['kind'];
}): KdsAlert {
  const alert: KdsAlert = {
    id: randomUUID(),
    kind: input.kind ?? 'emergency',
    message: String(input.message ?? '')
      .trim()
      .slice(0, KDS_ALERT_MESSAGE_MAX),
    table: input.table ? String(input.table).trim().slice(0, 40) || null : null,
    sent_by: input.sentBy ?? null,
    created_at: new Date().toISOString(),
  };
  alerts = [...recentKdsAlerts(), alert].slice(-KDS_ALERT_LIMIT);
  return alert;
}

export function recentKdsAlerts(nowMs = Date.now()): KdsAlert[] {
  alerts = alerts.filter((alert) => nowMs - Date.parse(alert.created_at) < KDS_ALERT_TTL_MS);
  return alerts;
}

export function clearKdsAlertsForTest(): void {
  alerts = [];
}
