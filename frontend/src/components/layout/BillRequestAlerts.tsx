'use client';

import { useEffect, useRef } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { playKdsAlert, unlockKdsAlertSound } from '@/lib/kds-alert-sound';

const POLL_MS = 5000;

/**
 * POS-wide two-beep alert whenever a table asks for its bill, for staff who take payments.
 * The waiting tables themselves are highlighted on the orders list.
 */
export default function BillRequestAlerts() {
  const currentTenant = useAuthStore((s) => s.currentTenant);
  const canTakePayments = tenantCan(currentTenant, 'payments.take');
  const knownRef = useRef<Set<number> | null>(null);

  useEffect(() => {
    if (!canTakePayments) return;
    window.addEventListener('pointerdown', unlockKdsAlertSound);
    window.addEventListener('keydown', unlockKdsAlertSound);
    let cancelled = false;
    const load = () => {
      api
        .get<{ requests: { id: number }[] }>('/bill-requests')
        .then(({ data }) => {
          if (cancelled) return;
          const list = Array.isArray(data?.requests) ? data.requests : [];
          const known = knownRef.current;
          // The first load only records what is already waiting; later requests beep.
          if (known && list.some((request) => !known.has(request.id))) playKdsAlert(2);
          knownRef.current = new Set(list.map((request) => request.id));
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('pointerdown', unlockKdsAlertSound);
      window.removeEventListener('keydown', unlockKdsAlertSound);
    };
  }, [canTakePayments]);

  return null;
}
