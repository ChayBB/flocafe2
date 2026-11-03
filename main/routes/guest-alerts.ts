import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';
import { requirePermission } from '../services/authorization';
import { placeGuestOrder } from '../lib/guest-order-placement';
import { currentGuestTableSession, openGuestTableSession } from '../lib/guest-table-session';
import type { GuestOrderItem } from '../lib/guest-order';
import { getHttpRequestSignal } from '../shutdown';

const router = Router();

interface AlertRow {
  id: number;
  table_id: string;
  session_id: string | null;
  kind: 'unlock_request' | 'order_held';
  idempotency_key: string | null;
  payload_json: string | null;
  created_at: string;
  table_name: string | null;
}

interface HeldPayload {
  items: GuestOrderItem[];
  note: string | null;
}

const userId = (req: Request) => (req as Request & { user?: { userId?: string } }).user?.userId;

// GET /api/guest-alerts — table QR events staff must act on: a sticker scanned at a table they have
// not opened, and orders past the session quota that wait for approval.
router.get('/', requirePermission('orders.create'), (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT a.id, a.table_id, a.session_id, a.kind, a.idempotency_key, a.payload_json,
                a.created_at, t.number AS table_name
         FROM guest_alerts a LEFT JOIN tables t ON t.id = a.table_id
         WHERE a.status = 'open' ORDER BY a.created_at, a.id`,
      )
      .all() as AlertRow[];
    const productName = db.prepare('SELECT name FROM products WHERE id = ?');
    const alerts = rows.map((row) => {
      const session = currentGuestTableSession(db, row.table_id);
      const base = {
        id: row.id,
        kind: row.kind,
        table_id: row.table_id,
        table_name: row.table_name,
        created_at: row.created_at,
        session_open: !!session && session.id === row.session_id,
      };
      if (row.kind === 'unlock_request') return base;
      const payload = JSON.parse(row.payload_json || '{}') as Partial<HeldPayload>;
      return {
        ...base,
        note: payload.note ?? null,
        items: (payload.items ?? []).map((item) => ({
          name:
            (productName.get(item.product_id) as { name: string } | undefined)?.name ??
            item.product_id,
          quantity: item.quantity,
        })),
      };
    });
    res.json({ alerts });
  } catch (error) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/guest-alerts/:id/approve — opens the table for phones waiting at its sticker, or sends
// a held order to the bill and the kitchen.
router.post(
  '/:id/approve',
  requirePermission('orders.create'),
  async (req: Request, res: Response) => {
    const db = getDatabase();
    const id = Number(req.params.id);
    try {
      const alert = db.prepare('SELECT * FROM guest_alerts WHERE id = ?').get(id) as
        | (AlertRow & { status: string })
        | undefined;
      if (!alert) return res.status(404).json({ error: 'Alert not found' });
      if (alert.kind === 'unlock_request') {
        if (alert.status !== 'open') {
          return res.status(409).json({ code: 'resolved', error: 'Already handled' });
        }
        const table = db
          .prepare('SELECT 1 FROM tables WHERE id = ? AND is_active = 1')
          .get(alert.table_id);
        if (!table) return res.status(404).json({ error: 'Table not found' });
        openGuestTableSession(db, alert.table_id, userId(req) ?? null, { unlock: true });
        return res.json({ success: true });
      }
      const session = currentGuestTableSession(db, alert.table_id);
      if (!session || session.id !== alert.session_id) {
        return res
          .status(409)
          .json({ code: 'session_closed', error: 'This table is no longer ordering by QR' });
      }
      const claimed = db
        .prepare(
          `UPDATE guest_alerts SET status = 'approved', resolved_by = ?, resolved_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(userId(req) ?? null, now(), id).changes;
      if (!claimed) return res.status(409).json({ code: 'resolved', error: 'Already handled' });
      const payload = JSON.parse(alert.payload_json || '{}') as HeldPayload;
      const outcome = await placeGuestOrder(req, {
        tableId: alert.table_id,
        items: payload.items,
        note: payload.note,
        key: alert.idempotency_key ?? '',
      });
      if (outcome.kind !== 'placed') {
        db.prepare(
          `UPDATE guest_alerts SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?`,
        ).run(id);
        const error = outcome.kind === 'failed' ? outcome.error : 'Could not send the order';
        return res.status(outcome.status >= 400 ? outcome.status : 502).json({ error });
      }
      if (!outcome.replayed) {
        const quantity = payload.items.reduce((sum, item) => sum + item.quantity, 0);
        db.prepare(
          'UPDATE guest_table_sessions SET order_count = order_count + 1, item_count = item_count + ? WHERE id = ?',
        ).run(quantity, session.id);
      }
      res.json({ success: true, order_number: outcome.orderNumber });
    } catch (error) {
      if (getHttpRequestSignal(req)?.aborted) return res.status(503).end();
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// POST /api/guest-alerts/:id/dismiss — turns down a held order or a request to open the table.
router.post('/:id/dismiss', requirePermission('orders.create'), (req: Request, res: Response) => {
  try {
    const changes = getDatabase()
      .prepare(
        `UPDATE guest_alerts
         SET status = CASE kind WHEN 'order_held' THEN 'rejected' ELSE 'dismissed' END,
             resolved_by = ?, resolved_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(userId(req) ?? null, now(), Number(req.params.id)).changes;
    if (!changes) return res.status(404).json({ error: 'Alert not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as guestAlertRoutes };
