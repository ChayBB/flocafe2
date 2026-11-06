import type Database from 'better-sqlite3';

/** Loyalty points and member tiers: earning, redemption, FIFO expiry and the tier engine. */

export type LoyaltyMode = 'cashback' | 'points';

export interface PointsConfig {
  mode: LoyaltyMode;
  spendPerPoint: number;
  redeemPoints: number;
  redeemValue: number;
  minRedemption: number;
  expiryDays: number;
  graceDays: number;
}

export interface MemberTier {
  code: string;
  name: string;
  min_qualifying_cents: number;
  multiplier: number;
  benefits: string | null;
  sort_order: number;
}

export class LoyaltyPointsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

const POSITIVE_NUMBER_SETTINGS = {
  spendPerPoint: ['points_spend_per_point', 20],
  redeemPoints: ['points_redeem_points', 100],
  redeemValue: ['points_redeem_value', 20],
  minRedemption: ['points_min_redemption', 100],
  expiryDays: ['points_expiry_days', 365],
  graceDays: ['tier_grace_days', 30],
} as const;

function setting(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value;
}

export function getPointsConfig(db: Database.Database): PointsConfig {
  const read = (key: string, fallback: number, allowZero = false) => {
    const value = Number(setting(db, key));
    return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) ? value : fallback;
  };
  const p = POSITIVE_NUMBER_SETTINGS;
  return {
    mode: setting(db, 'loyalty_mode') === 'points' ? 'points' : 'cashback',
    spendPerPoint: read(p.spendPerPoint[0], p.spendPerPoint[1]),
    redeemPoints: read(p.redeemPoints[0], p.redeemPoints[1]),
    redeemValue: read(p.redeemValue[0], p.redeemValue[1]),
    minRedemption: read(p.minRedemption[0], p.minRedemption[1]),
    expiryDays: read(p.expiryDays[0], p.expiryDays[1], true),
    graceDays: read(p.graceDays[0], p.graceDays[1], true),
  };
}

export function isLoyaltyEnabled(db: Database.Database): boolean {
  const value = setting(db, 'loyalty_enabled');
  return value === 'true' || value === '1';
}

export function pointsModeActive(db: Database.Database): boolean {
  return isLoyaltyEnabled(db) && getPointsConfig(db).mode === 'points';
}

/** Base points round down per whole spend unit, then the tier multiplier rounds down again. */
export function computeEarnedPoints(
  eligibleMinor: number,
  minorFactor: number,
  spendPerPoint: number,
  multiplier: number,
): number {
  if (!(eligibleMinor > 0)) return 0;
  const base = Math.floor(eligibleMinor / Math.round(spendPerPoint * minorFactor));
  // Rounding to 1e-6 first keeps 100 × 1.15 at 115 instead of 114.999….
  return Math.max(0, Math.floor(Math.round(base * multiplier * 1e6) / 1e6));
}

/** The money value of redeeming `points`, in minor units, rounded down. */
export function redemptionValueMinor(
  points: number,
  config: PointsConfig,
  minorFactor: number,
): number {
  return Math.floor((points * config.redeemValue * minorFactor) / config.redeemPoints);
}

function addDays(timestamp: string, days: number): string {
  const date = new Date(`${timestamp.replace(' ', 'T')}Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

export function listTiers(db: Database.Database): MemberTier[] {
  return db
    .prepare('SELECT * FROM member_tiers ORDER BY min_qualifying_cents, sort_order')
    .all() as MemberTier[];
}

export function tierForQualifying(tiers: MemberTier[], qualifyingCents: number): MemberTier | null {
  let match: MemberTier | null = null;
  for (const tier of tiers) if (qualifyingCents >= tier.min_qualifying_cents) match = tier;
  return match ?? tiers[0] ?? null;
}

function rank(tiers: MemberTier[], code: string | null): number {
  return tiers.findIndex((tier) => tier.code === code);
}

interface CustomerTierRow {
  id: string;
  qualifying_cents: number;
  tier_code: string | null;
  tier_grace_until: string | null;
  tier_override_code: string | null;
  tier_override_until: string | null;
}

function customerTierRow(db: Database.Database, customerId: string): CustomerTierRow {
  const row = db
    .prepare(
      `SELECT id, qualifying_cents, tier_code, tier_grace_until, tier_override_code, tier_override_until
       FROM customers WHERE id = ?`,
    )
    .get(customerId) as CustomerTierRow | undefined;
  if (!row) throw new LoyaltyPointsError('Customer not found', 'customer_not_found');
  return row;
}

function audit(
  db: Database.Database,
  entry: {
    customerId: string;
    from: string | null;
    to: string | null;
    reason: string;
    at: string;
    overrideUntil?: string | null;
    note?: string | null;
    actorUserId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO member_tier_audit
       (customer_id, from_tier, to_tier, reason, override_until, note, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.customerId,
    entry.from,
    entry.to,
    entry.reason,
    entry.overrideUntil ?? null,
    entry.note ?? null,
    entry.actorUserId ?? null,
    entry.at,
  );
}

/**
 * Brings a customer's tier up to date: promotes at once, demotes only after the grace period,
 * and retires an expired manual override. Every change is written to member_tier_audit.
 */
export function evaluateTier(db: Database.Database, customerId: string, at: string): void {
  const tiers = listTiers(db);
  if (tiers.length === 0) return;
  const customer = customerTierRow(db, customerId);
  const earned = tierForQualifying(tiers, customer.qualifying_cents)!;
  const graceDays = getPointsConfig(db).graceDays;

  if (
    customer.tier_override_code &&
    customer.tier_override_until &&
    customer.tier_override_until <= at
  ) {
    db.prepare(
      'UPDATE customers SET tier_override_code = NULL, tier_override_until = NULL WHERE id = ?',
    ).run(customerId);
    audit(db, {
      customerId,
      from: customer.tier_override_code,
      to: customer.tier_code,
      reason: 'override_expired',
      at,
    });
  }

  const current = customer.tier_code;
  if (current === null || rank(tiers, current) < 0) {
    db.prepare('UPDATE customers SET tier_code = ?, tier_grace_until = NULL WHERE id = ?').run(
      earned.code,
      customerId,
    );
    if (rank(tiers, earned.code) > 0)
      audit(db, { customerId, from: current, to: earned.code, reason: 'promoted', at });
    return;
  }

  const earnedRank = rank(tiers, earned.code);
  const currentRank = rank(tiers, current);
  if (earnedRank > currentRank) {
    db.prepare('UPDATE customers SET tier_code = ?, tier_grace_until = NULL WHERE id = ?').run(
      earned.code,
      customerId,
    );
    audit(db, { customerId, from: current, to: earned.code, reason: 'promoted', at });
  } else if (earnedRank === currentRank) {
    if (customer.tier_grace_until) {
      db.prepare('UPDATE customers SET tier_grace_until = NULL WHERE id = ?').run(customerId);
      audit(db, { customerId, from: current, to: current, reason: 'grace_cleared', at });
    }
  } else if (!customer.tier_grace_until) {
    const until = addDays(at, graceDays);
    if (graceDays > 0) {
      db.prepare('UPDATE customers SET tier_grace_until = ? WHERE id = ?').run(until, customerId);
      audit(db, {
        customerId,
        from: current,
        to: earned.code,
        reason: 'grace_started',
        at,
        overrideUntil: until,
      });
    } else {
      db.prepare('UPDATE customers SET tier_code = ? WHERE id = ?').run(earned.code, customerId);
      audit(db, { customerId, from: current, to: earned.code, reason: 'demoted', at });
    }
  } else if (customer.tier_grace_until <= at) {
    db.prepare('UPDATE customers SET tier_code = ?, tier_grace_until = NULL WHERE id = ?').run(
      earned.code,
      customerId,
    );
    audit(db, { customerId, from: current, to: earned.code, reason: 'demoted', at });
  }
}

/** The tier that applies now: an unexpired manual override wins over the earned tier. */
export function effectiveTier(
  db: Database.Database,
  customerId: string,
  at: string,
): MemberTier | null {
  const tiers = listTiers(db);
  const customer = customerTierRow(db, customerId);
  const overrideActive =
    customer.tier_override_code &&
    (!customer.tier_override_until || customer.tier_override_until > at);
  const code = overrideActive ? customer.tier_override_code : customer.tier_code;
  return (
    tiers.find((tier) => tier.code === code) ?? tierForQualifying(tiers, customer.qualifying_cents)
  );
}

/** Sets or clears a manual tier override. A set override must expire and must give a reason. */
export function setTierOverride(
  db: Database.Database,
  params: {
    customerId: string;
    tierCode: string | null;
    until: string | null;
    note: string;
    actorUserId: string | null;
    at: string;
  },
): void {
  const note = params.note.trim();
  if (!note) throw new LoyaltyPointsError('A reason is required', 'override_reason_required');
  const customer = customerTierRow(db, params.customerId);
  if (params.tierCode === null) {
    if (!customer.tier_override_code) return;
    db.prepare(
      'UPDATE customers SET tier_override_code = NULL, tier_override_until = NULL WHERE id = ?',
    ).run(params.customerId);
    audit(db, {
      customerId: params.customerId,
      from: customer.tier_override_code,
      to: customer.tier_code,
      reason: 'override_cleared',
      note,
      actorUserId: params.actorUserId,
      at: params.at,
    });
    return;
  }
  if (!listTiers(db).some((tier) => tier.code === params.tierCode))
    throw new LoyaltyPointsError('Unknown tier', 'tier_not_found');
  if (!params.until || params.until <= params.at)
    throw new LoyaltyPointsError('An override needs a future end date', 'override_until_required');
  db.prepare(
    'UPDATE customers SET tier_override_code = ?, tier_override_until = ? WHERE id = ?',
  ).run(params.tierCode, params.until, params.customerId);
  audit(db, {
    customerId: params.customerId,
    from: customer.tier_override_code ?? customer.tier_code,
    to: params.tierCode,
    reason: 'override_set',
    overrideUntil: params.until,
    note,
    actorUserId: params.actorUserId,
    at: params.at,
  });
}

interface LedgerRow {
  id: number;
  bill_id: number | null;
  kind: string;
  points: number;
  expires_at: string | null;
}

/**
 * Writes `expire` rows for earned points past their expiry that were not spent.
 * Spending draws on the oldest earned points first; manual credits never expire.
 */
export function expireDuePoints(db: Database.Database, customerId: string, at: string): number {
  const rows = db
    .prepare(
      'SELECT id, bill_id, kind, points, expires_at FROM points_ledger WHERE customer_id = ? ORDER BY created_at, id',
    )
    .all(customerId) as LedgerRow[];
  const lots = rows
    .filter((row) => row.kind === 'earn')
    .map((row) => ({ ...row, remaining: row.points }));
  const byBill = new Map(lots.map((lot) => [lot.bill_id, lot]));
  let spent = 0;
  for (const row of rows) {
    if (row.kind === 'reverse_earn' || row.kind === 'expire') {
      const lot = byBill.get(row.bill_id);
      if (lot) lot.remaining += row.points;
      else if (row.kind === 'reverse_earn') spent -= row.points;
    } else if (row.kind === 'redeem' || row.kind === 'reverse_redeem') {
      spent -= row.points;
    } else if (row.kind === 'adjust' && row.points < 0) {
      spent -= row.points;
    }
  }
  spent = Math.max(0, spent);
  let expired = 0;
  const insert = db.prepare(
    `INSERT INTO points_ledger (customer_id, bill_id, kind, points, reason, created_at)
     VALUES (?, ?, 'expire', ?, 'Points expired', ?)`,
  );
  for (const lot of lots) {
    const take = Math.min(Math.max(0, lot.remaining), spent);
    lot.remaining -= take;
    spent -= take;
    if (lot.remaining > 0 && lot.expires_at && lot.expires_at <= at) {
      insert.run(customerId, lot.bill_id, -lot.remaining, at);
      expired += lot.remaining;
    }
  }
  return expired;
}

export function pointsBalance(db: Database.Database, customerId: string): number {
  return Number(
    (
      db
        .prepare(
          'SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger WHERE customer_id = ?',
        )
        .get(customerId) as { total: number }
    ).total,
  );
}

/** Settles expiry and tier changes that are due, then reports the customer's standing. */
export function refreshCustomerLoyalty(
  db: Database.Database,
  customerId: string,
  at: string,
): { balance: number; tier: MemberTier | null; qualifyingCents: number } {
  expireDuePoints(db, customerId, at);
  evaluateTier(db, customerId, at);
  return {
    balance: pointsBalance(db, customerId),
    tier: effectiveTier(db, customerId, at),
    qualifyingCents: customerTierRow(db, customerId).qualifying_cents,
  };
}

/**
 * Credits points for a paid bill, once per bill, and adds its net eligible amount to the
 * customer's tier qualification. `eligibleMinor` already excludes wallet- or points-funded spend.
 */
export function awardBillPoints(
  db: Database.Database,
  params: {
    billId: number;
    customerId: string | null | undefined;
    eligibleMinor: number;
    minorFactor: number;
    at: string;
    description?: string;
  },
): number {
  if (!params.customerId || !pointsModeActive(db)) return 0;
  const already = db
    .prepare("SELECT 1 FROM points_ledger WHERE bill_id = ? AND kind = 'earn'")
    .get(params.billId);
  if (already) return 0;
  const eligible = Math.max(0, Math.floor(params.eligibleMinor));
  const config = getPointsConfig(db);
  expireDuePoints(db, params.customerId, params.at);
  evaluateTier(db, params.customerId, params.at);
  const tier = effectiveTier(db, params.customerId, params.at);
  const multiplier = tier?.multiplier ?? 1;
  const points = computeEarnedPoints(
    eligible,
    params.minorFactor,
    config.spendPerPoint,
    multiplier,
  );
  db.prepare(
    `INSERT INTO points_ledger
       (customer_id, bill_id, kind, points, eligible_cents, multiplier, tier_code, expires_at, reason, created_at)
     VALUES (?, ?, 'earn', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.customerId,
    params.billId,
    points,
    eligible,
    multiplier,
    tier?.code ?? null,
    config.expiryDays > 0 ? addDays(params.at, config.expiryDays) : null,
    params.description ?? null,
    params.at,
  );
  db.prepare('UPDATE customers SET qualifying_cents = qualifying_cents + ? WHERE id = ?').run(
    eligible,
    params.customerId,
  );
  evaluateTier(db, params.customerId, params.at);
  return points;
}

/** Spends points for a bill. The balance may not go below zero and the minimum applies. */
export function redeemPoints(
  db: Database.Database,
  params: {
    customerId: string;
    points: number;
    billId: number | null;
    minorFactor: number;
    actorUserId: string | null;
    at: string;
  },
): { points: number; valueMinor: number; balance: number } {
  if (!pointsModeActive(db))
    throw new LoyaltyPointsError('Points are not enabled', 'points_disabled');
  const config = getPointsConfig(db);
  const points = params.points;
  if (!Number.isInteger(points) || points <= 0)
    throw new LoyaltyPointsError('Points must be a whole number above zero', 'points_invalid');
  if (points < config.minRedemption)
    throw new LoyaltyPointsError(
      `At least ${config.minRedemption} points are needed to redeem`,
      'points_below_minimum',
    );
  expireDuePoints(db, params.customerId, params.at);
  const balance = pointsBalance(db, params.customerId);
  if (balance < points)
    throw new LoyaltyPointsError(
      `Not enough points. Available: ${balance}, required: ${points}`,
      'points_insufficient',
    );
  const valueMinor = redemptionValueMinor(points, config, params.minorFactor);
  db.prepare(
    `INSERT INTO points_ledger (customer_id, bill_id, kind, points, actor_user_id, reason, created_at)
     VALUES (?, ?, 'redeem', ?, ?, 'Points redeemed', ?)`,
  ).run(params.customerId, params.billId, -points, params.actorUserId, params.at);
  return { points, valueMinor, balance: balance - points };
}

/**
 * Takes back points earned on a bill in proportion to how much of it has now been refunded, and
 * lowers tier qualification by the same share. Works on the cumulative refunded total, so a full
 * refund reverses exactly what was earned. The balance may go negative if the points were spent.
 */
export function reverseRefundedPoints(
  db: Database.Database,
  params: {
    billId: number;
    refundedCents: number;
    paidCents: number;
    refundId: number;
    at: string;
  },
): number {
  const earn = db
    .prepare(
      "SELECT customer_id, points, eligible_cents FROM points_ledger WHERE bill_id = ? AND kind = 'earn'",
    )
    .get(params.billId) as
    | { customer_id: string; points: number; eligible_cents: number | null }
    | undefined;
  if (!earn || params.paidCents <= 0) return 0;
  const share = Math.min(1, Math.max(0, params.refundedCents / params.paidCents));
  const already = db
    .prepare(
      `SELECT COALESCE(-SUM(points), 0) AS points, COALESCE(SUM(eligible_cents), 0) AS eligible
       FROM points_ledger WHERE bill_id = ? AND kind = 'reverse_earn'`,
    )
    .get(params.billId) as { points: number; eligible: number };
  const eligible = Number(earn.eligible_cents || 0);
  const pointsDelta = Math.max(0, Math.floor(earn.points * share) - Number(already.points));
  const eligibleDelta = Math.max(0, Math.floor(eligible * share) - Number(already.eligible));
  if (pointsDelta === 0 && eligibleDelta === 0) return 0;
  db.prepare(
    `INSERT INTO points_ledger (customer_id, bill_id, kind, points, eligible_cents, reason, created_at)
     VALUES (?, ?, 'reverse_earn', ?, ?, ?, ?)`,
  ).run(
    earn.customer_id,
    params.billId,
    -pointsDelta,
    eligibleDelta,
    `Refund ${params.refundId}`,
    params.at,
  );
  db.prepare(
    'UPDATE customers SET qualifying_cents = MAX(0, qualifying_cents - ?) WHERE id = ?',
  ).run(eligibleDelta, earn.customer_id);
  evaluateTier(db, earn.customer_id, params.at);
  return pointsDelta;
}
