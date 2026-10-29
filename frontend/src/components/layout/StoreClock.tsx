'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'use-intl';
import { formatDateForTenant } from '@/lib/countries';

/**
 * Live store clock. It runs on the server's NTP-corrected time in the store timezone, so staff
 * read the same time that sign-ins and orders are recorded with, whatever this device's clock says.
 */
export function StoreClock({
  serverTime,
  timezone,
  country,
}: {
  serverTime: string;
  timezone: string;
  country: string;
}) {
  const locale = useLocale();
  // Measured once on mount; remount with a new `key` to resync.
  const [offsetMs] = useState(() => Date.parse(serverTime) - Date.now());
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const current = new Date(tick + offsetMs);
  return (
    <div data-testid="store-clock" className="text-center" aria-live="off">
      <time dateTime={current.toISOString()} className="block text-3xl font-bold tabular-nums text-foreground" dir="ltr">
        {formatDateForTenant(current, country, timezone, {}, { hour: '2-digit', minute: '2-digit', second: '2-digit' }, locale)}
      </time>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {formatDateForTenant(current, country, timezone, {}, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, locale)}
      </p>
    </div>
  );
}
