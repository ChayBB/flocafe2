import type { Request, Response } from 'express';
import { printOrderKot } from '../routes/printers';
import { getHttpRequestSignal } from '../shutdown';
import { dismissUnprintedKot, listUnprintedKots } from './unprinted-kots';

/** A kitchen display prints a missing ticket again, only for the station that missed it. */
export async function handleKdsReprintKot(req: Request, res: Response) {
  try {
    const entry = listUnprintedKots().find((item) => item.id === String(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Unprinted ticket not found' });
    const outcome = await printOrderKot(
      { orderId: entry.order_id, retryStation: entry.station },
      getHttpRequestSignal(req),
    );
    // Items the kitchen already started have nothing left to print, so the warning is done either way.
    if (outcome.status === 200) dismissUnprintedKot(entry.id);
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    console.error('[KDS] Reprint kitchen ticket failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** A kitchen display drops a missing-ticket warning without printing it. */
export function handleKdsDismissKot(req: Request, res: Response) {
  if (!dismissUnprintedKot(String(req.params.id))) {
    return res.status(404).json({ error: 'Unprinted ticket not found' });
  }
  res.json({ success: true });
}
