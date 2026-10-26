import type { Request, Response, NextFunction } from 'express';
import { getDatabase } from '../db';
import { TERMINAL_ITEM_STATUSES } from '../../shared/order-item-status';

type Db = ReturnType<typeof getDatabase>;

export const WEIGHT_PRICED_GROUP_NAME = 'ราคาตามน้ำหนัก';
export const WEIGHT_PENDING_NOTE = 'รอระบุน้ำหนัก';
export const WEIGHT_PENDING_ERROR = 'Enter the weight of every weight-priced item first';

/**
 * A product is priced after the order when one of its add-on groups is the weight-priced group
 * or is flagged "awaiting price"; both use the same weighing flow.
 */
export function isWeightPricedProduct(
  db: Db,
  product: { id: string; category_id?: string | null },
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM addon_groups g
       WHERE (TRIM(g.name) = ? OR g.price_pending = 1)
         AND (g.id IN (SELECT addon_group_id FROM addon_group_product WHERE product_id = ?)
           OR g.id IN (SELECT addon_group_id FROM category_addon_groups WHERE category_id = ?))
       LIMIT 1`,
    )
    .get(WEIGHT_PRICED_GROUP_NAME, product.id, product.category_id ?? null);
  return Boolean(row);
}

/** Prepends the kitchen marker to a line's note unless it is already there. */
export function withWeightPendingNote(note: string | null | undefined): string {
  const current = (note ?? '').trim();
  if (current.includes(WEIGHT_PENDING_NOTE)) return current;
  return current ? `${WEIGHT_PENDING_NOTE} | ${current}` : WEIGHT_PENDING_NOTE;
}

export function orderHasWeightPending(db: Db, orderId: unknown): boolean {
  if (orderId == null) return false;
  const placeholders = TERMINAL_ITEM_STATUSES.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT 1 FROM order_items
       WHERE order_id = ? AND weight_pending = 1 AND status NOT IN (${placeholders})
       LIMIT 1`,
    )
    .get(orderId, ...TERMINAL_ITEM_STATUSES);
  return Boolean(row);
}

export function billHasWeightPending(db: Db, billId: unknown): boolean {
  if (billId == null) return false;
  const bill = db.prepare('SELECT order_id FROM bills WHERE id = ?').get(billId) as
    | { order_id: number | string }
    | undefined;
  return bill ? orderHasWeightPending(db, bill.order_id) : false;
}

export function sendWeightPendingError(res: Response): Response {
  return res.status(409).json({ error: WEIGHT_PENDING_ERROR, code: 'weight_pending' });
}

/** Route guard for `/:id` bill routes that take payment or produce a receipt. */
export function rejectBillWhileWeightPending(req: Request, res: Response, next: NextFunction) {
  if (billHasWeightPending(getDatabase(), req.params.id)) return sendWeightPendingError(res);
  return next();
}
