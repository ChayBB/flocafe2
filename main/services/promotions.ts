import type Database from 'better-sqlite3';
import { getCurrencyMinorUnitFactor, resolveRegionalSnapshot } from '../countries';
import { effectiveTier } from '../lib/loyalty-points';
import { TERMINAL_ITEM_STATUSES } from '../../shared/order-item-status';
import {
  evaluatePromotions,
  type EngineContext,
  type EngineResult,
  type Promotion,
  type PromotionUsage,
} from '../lib/promotion-engine';

const TERMINAL_SQL = TERMINAL_ITEM_STATUSES.map(() => '?').join(', ');
export const PROMOTION_DISCOUNT_TYPE = 'promotion';
export const PROMOTION_APPLIED_MESSAGE =
  'A promotion is applied to this order, so a manual discount cannot be added';

function settingValue(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value;
}

function storeTimezone(db: Database.Database): string {
  try {
    return resolveRegionalSnapshot({
      country: settingValue(db, 'country'),
      currency: settingValue(db, 'currency'),
      timezone: settingValue(db, 'timezone'),
    }).timezone;
  } catch {
    return 'UTC';
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadActivePromotions(db: Database.Database): Promotion[] {
  const rows = db.prepare("SELECT * FROM promotions WHERE status = 'active'").all() as any[];
  const codes = db.prepare('SELECT promotion_id, code FROM promotion_codes').all() as {
    promotion_id: string;
    code: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    priority: Number(row.priority),
    exclusiveGroup: row.exclusive_group || null,
    stackPolicy: row.stack_policy,
    conditions: parseJson(row.conditions_json, {}),
    reward: parseJson(row.reward_json, { type: 'fixed', amountMinor: 0 }),
    startsAt: row.starts_at || null,
    endsAt: row.ends_at || null,
    usageLimitPerCustomer: row.usage_limit_per_customer ?? null,
    totalUsageLimit: row.total_usage_limit ?? null,
    budgetMinor: row.budget_cents ?? null,
    codes: codes.filter((code) => code.promotion_id === row.id).map((code) => code.code),
  }));
}

/** A manual order or item discount keeps promotions off the order, and the reverse. */
export function orderHasManualDiscount(db: Database.Database, order: any): boolean {
  if (
    order.discount_type &&
    order.discount_type !== PROMOTION_DISCOUNT_TYPE &&
    Number(order.discount_amount || 0) > 0
  )
    return true;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM order_items WHERE order_id = ? AND COALESCE(discount_amount, 0) > 0
         AND COALESCE(status, '') NOT IN (${TERMINAL_SQL}) LIMIT 1`,
      )
      .get(order.id, ...TERMINAL_ITEM_STATUSES),
  );
}

export function hasActivePromotions(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM promotions WHERE status = 'active' LIMIT 1").get());
}

export function orderHasPromotions(db: Database.Database, orderId: string | number): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM order_promotions WHERE order_id = ? LIMIT 1').get(orderId),
  );
}

function usageFor(
  db: Database.Database,
  promotions: Promotion[],
  customerId: string | null,
): Record<string, PromotionUsage> {
  const usage: Record<string, PromotionUsage> = {};
  const total = db.prepare(
    'SELECT COALESCE(SUM(uses), 0) AS uses, COALESCE(SUM(discount_cents), 0) AS spent FROM promotion_redemptions WHERE promotion_id = ?',
  );
  const mine = db.prepare(
    'SELECT COALESCE(SUM(uses), 0) AS uses FROM promotion_redemptions WHERE promotion_id = ? AND customer_id = ?',
  );
  for (const promotion of promotions) {
    const all = total.get(promotion.id) as { uses: number; spent: number };
    usage[promotion.id] = {
      totalUses: Number(all.uses),
      spentMinor: Number(all.spent),
      customerUses: customerId
        ? Number((mine.get(promotion.id, customerId) as { uses: number }).uses)
        : 0,
    };
  }
  return usage;
}

function daysBetween(fromUtc: string, toUtc: string): number {
  const ms =
    Date.parse(`${toUtc.replace(' ', 'T')}Z`) - Date.parse(`${fromUtc.replace(' ', 'T')}Z`);
  return Math.floor(ms / 86_400_000);
}

export function buildOrderContext(
  db: Database.Database,
  order: any,
  promotions: Promotion[],
  currency: string,
  at: string,
): EngineContext {
  const minorFactor = getCurrencyMinorUnitFactor(currency);
  const items = (
    db
      .prepare(
        `SELECT oi.id, oi.product_id, p.category_id, oi.unit_price, oi.quantity, oi.subtotal, oi.created_at
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ? AND COALESCE(oi.status, '') NOT IN (${TERMINAL_SQL})
         ORDER BY oi.id`,
      )
      .all(order.id, ...TERMINAL_ITEM_STATUSES) as any[]
  ).map((row) => {
    const quantity = Number(row.quantity || 0);
    const subtotalMinor = Math.round(Number(row.subtotal || 0) * minorFactor);
    return {
      id: String(row.id),
      productId: String(row.product_id),
      categoryId: row.category_id ? String(row.category_id) : null,
      unitPriceMinor: quantity > 0 ? Math.round(subtotalMinor / quantity) : subtotalMinor,
      quantity,
      subtotalMinor,
      orderedAt: row.created_at || at,
    };
  });

  let customer: EngineContext['customer'] = null;
  if (order.customer_id) {
    const previous = db
      .prepare(
        `SELECT MAX(COALESCE(completed_at, created_at)) AS last, COUNT(*) AS n FROM orders
         WHERE customer_id = ? AND id != ? AND status = 'completed'`,
      )
      .get(order.customer_id, order.id) as { last: string | null; n: number };
    let tierCode: string | null = null;
    try {
      tierCode = effectiveTier(db, order.customer_id, at)?.code ?? null;
    } catch {
      tierCode = null;
    }
    customer = {
      id: String(order.customer_id),
      tierCode,
      isFirstOrder: Number(previous.n) === 0,
      daysSinceLastVisit: previous.last ? daysBetween(previous.last, at) : null,
    };
  }

  const cap = Number(settingValue(db, 'promotion_max_total_discount_cents') || 0);
  return {
    items,
    customer,
    channel: 'pos',
    at,
    timezone: storeTimezone(db),
    couponCodes: parseJson<string[]>(order.coupon_codes, []).filter(
      (code) => typeof code === 'string',
    ),
    usage: usageFor(db, promotions, customer?.id ?? null),
    maxTotalDiscountMinor: cap > 0 ? cap : null,
  };
}

/** Evaluates promotions for an order and replaces its order_promotions snapshot. */
export function evaluateAndStoreOrderPromotions(
  db: Database.Database,
  order: any,
  currency: string,
  at: string,
): EngineResult {
  const promotions = loadActivePromotions(db);
  const result = evaluatePromotions(
    promotions,
    buildOrderContext(db, order, promotions, currency, at),
  );
  db.prepare('DELETE FROM order_promotions WHERE order_id = ?').run(order.id);
  const insert = db.prepare(
    `INSERT INTO order_promotions (order_id, promotion_id, promotion_name, coupon_code, discount_cents, allocations_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const applied of result.applied)
    insert.run(
      order.id,
      applied.promotionId,
      applied.name,
      applied.couponCode,
      applied.discountMinor,
      JSON.stringify(applied.allocations),
      at,
    );
  return result;
}

/** Counts each promotion on a paid order once, with its discount, toward limits and budget. */
export function recordOrderPromotionRedemptions(
  db: Database.Database,
  params: {
    orderId: number | string;
    billId: number | string;
    customerId: string | null;
    at: string;
  },
): void {
  const rows = db
    .prepare('SELECT promotion_id, discount_cents FROM order_promotions WHERE order_id = ?')
    .all(params.orderId) as { promotion_id: string; discount_cents: number }[];
  const already = db.prepare(
    "SELECT 1 FROM promotion_redemptions WHERE order_id = ? AND promotion_id = ? AND kind = 'redeem'",
  );
  const insert = db.prepare(
    `INSERT INTO promotion_redemptions (promotion_id, order_id, bill_id, customer_id, kind, uses, discount_cents, created_at)
     VALUES (?, ?, ?, ?, 'redeem', 1, ?, ?)`,
  );
  for (const row of rows) {
    if (already.get(params.orderId, row.promotion_id)) continue;
    insert.run(
      row.promotion_id,
      params.orderId,
      params.billId,
      params.customerId,
      row.discount_cents,
      params.at,
    );
  }
}

/** A fully refunded order gives its promotion uses and budget back, once. */
export function reverseOrderPromotionRedemptions(
  db: Database.Database,
  params: { orderId: number | string; billId: number | string; at: string },
): void {
  const redeemed = db
    .prepare(
      `SELECT promotion_id, customer_id, SUM(uses) AS uses, SUM(discount_cents) AS spent
       FROM promotion_redemptions WHERE order_id = ? GROUP BY promotion_id, customer_id`,
    )
    .all(params.orderId) as {
    promotion_id: string;
    customer_id: string | null;
    uses: number;
    spent: number;
  }[];
  const insert = db.prepare(
    `INSERT INTO promotion_redemptions (promotion_id, order_id, bill_id, customer_id, kind, uses, discount_cents, created_at)
     VALUES (?, ?, ?, ?, 'reverse', ?, ?, ?)`,
  );
  for (const row of redeemed) {
    if (Number(row.uses) <= 0 && Number(row.spent) <= 0) continue;
    insert.run(
      row.promotion_id,
      params.orderId,
      params.billId,
      row.customer_id,
      -Number(row.uses),
      -Number(row.spent),
      params.at,
    );
  }
}
