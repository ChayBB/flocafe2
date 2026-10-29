import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';

const router = Router();

// GET /api/bill-requests — tables waiting for the cashier to receive their payment.
router.get(
  '/',
  requirePermission('payments.take'),
  (_req: Request, res: Response) => {
    try {
      const requests = getDatabase()
        .prepare(
          `SELECT o.id, o.order_number, o.total, o.bill_requested_at, o.bill_requested_by_name,
                  t.number AS table_name
           FROM orders o
           LEFT JOIN tables t ON t.id = o.table_id
           WHERE o.bill_requested_at IS NOT NULL
             AND o.bill_payment_received_at IS NULL
             AND o.status NOT IN ('completed', 'cancelled')
           ORDER BY o.bill_requested_at`,
        )
        .all();
      res.json({ requests });
    } catch (error) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as billRequestRoutes };
