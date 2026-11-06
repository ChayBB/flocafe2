/**
 * Promotion rule engine. A pure function of its input (no database): it runs each promotion
 * through eligibility, conditions, reward calculation and conflict resolution, then allocates the
 * discount to order items in whole minor units. Amounts are integer minor units throughout.
 */

export type Channel = 'pos' | 'qr';
export type StackPolicy = 'stack' | 'exclusive';

export interface PromotionSchedule {
  /** 0 = Sunday … 6 = Saturday, in the store timezone. */
  days?: number[];
  /** Local `HH:MM`; the end is exclusive and may be before the start for an overnight window. */
  start?: string;
  end?: string;
}

export interface PromotionConditions {
  minSpendMinor?: number;
  productIds?: string[];
  categoryIds?: string[];
  schedule?: PromotionSchedule;
  channels?: Channel[];
  tiers?: string[];
  firstOrder?: boolean;
  inactiveDays?: number;
  branches?: string[];
}

export type PromotionReward =
  | { type: 'percent'; percent: number; maxMinor?: number }
  | { type: 'fixed'; amountMinor: number }
  | { type: 'buy_x_get_y'; buy: number; get: number; percentOff?: number }
  | { type: 'bundle'; productIds: string[]; priceMinor: number };

export interface Promotion {
  id: string;
  name: string;
  kind: 'automatic' | 'coupon';
  status: 'draft' | 'active' | 'paused' | 'ended';
  /** Lower numbers run first; each promotion sees what earlier ones left. */
  priority: number;
  exclusiveGroup: string | null;
  stackPolicy: StackPolicy;
  conditions: PromotionConditions;
  reward: PromotionReward;
  startsAt: string | null;
  endsAt: string | null;
  usageLimitPerCustomer: number | null;
  totalUsageLimit: number | null;
  budgetMinor: number | null;
  codes: string[];
}

export interface EngineItem {
  id: string;
  productId: string;
  categoryId: string | null;
  unitPriceMinor: number;
  quantity: number;
  subtotalMinor: number;
  /** UTC `YYYY-MM-DD HH:MM:SS`: when the item was ordered. Time windows lock to this. */
  orderedAt: string;
}

export interface EngineCustomer {
  id: string;
  tierCode: string | null;
  isFirstOrder: boolean;
  daysSinceLastVisit: number | null;
}

export interface PromotionUsage {
  customerUses: number;
  totalUses: number;
  spentMinor: number;
}

export interface EngineContext {
  items: EngineItem[];
  customer: EngineCustomer | null;
  channel: Channel;
  /** UTC `YYYY-MM-DD HH:MM:SS`. */
  at: string;
  timezone: string;
  couponCodes: string[];
  usage: Record<string, PromotionUsage>;
  /** 0 or null means no cap. */
  maxTotalDiscountMinor: number | null;
}

export type RejectionReason =
  | 'inactive'
  | 'not_started'
  | 'ended'
  | 'coupon_not_entered'
  | 'customer_required'
  | 'tier_not_eligible'
  | 'not_first_order'
  | 'not_inactive_long_enough'
  | 'channel_not_eligible'
  | 'branch_not_supported'
  | 'no_qualifying_items'
  | 'min_spend_not_met'
  | 'usage_limit_reached'
  | 'total_usage_limit_reached'
  | 'budget_exhausted'
  | 'no_reward'
  | 'exclusive_group_lost'
  | 'not_stackable'
  | 'blocked_by_exclusive'
  | 'max_total_discount_reached';

export interface ItemAllocation {
  itemId: string;
  discountMinor: number;
}

export interface AppliedPromotion {
  promotionId: string;
  name: string;
  couponCode: string | null;
  discountMinor: number;
  allocations: ItemAllocation[];
}

export interface EngineResult {
  applied: AppliedPromotion[];
  rejected: { promotionId: string; reason: RejectionReason; detail?: number }[];
  totalDiscountMinor: number;
  items: { itemId: string; discountMinor: number; finalMinor: number }[];
}

/** Splits `total` across `weights` in proportion, largest remainder first, summing exactly. */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] += 1;
    left -= 1;
  }
  return floors;
}

const LOCAL_PARTS_CACHE = new Map<string, Intl.DateTimeFormat>();

function localDayAndMinutes(utc: string, timezone: string): { day: number; minutes: number } {
  let format = LOCAL_PARTS_CACHE.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    LOCAL_PARTS_CACHE.set(timezone, format);
  }
  const parts = format.formatToParts(new Date(`${utc.replace(' ', 'T')}Z`));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function withinSchedule(
  utc: string,
  timezone: string,
  schedule: PromotionSchedule,
): boolean {
  const { day, minutes } = localDayAndMinutes(utc, timezone);
  const hasWindow = Boolean(schedule.start && schedule.end);
  const start = hasWindow ? toMinutes(schedule.start!) : 0;
  const end = hasWindow ? toMinutes(schedule.end!) : 0;
  const overnight = hasWindow && end <= start;
  // An overnight window's early-morning part belongs to the previous day's schedule.
  const scheduleDay = overnight && minutes < end ? (day + 6) % 7 : day;
  if (schedule.days?.length && !schedule.days.includes(scheduleDay)) return false;
  if (!hasWindow) return true;
  return overnight ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}

function qualifyingItems(promotion: Promotion, ctx: EngineContext): EngineItem[] {
  const { productIds, categoryIds, schedule } = promotion.conditions;
  return ctx.items.filter((item) => {
    const scoped = Boolean(productIds?.length || categoryIds?.length);
    if (
      scoped &&
      !productIds?.includes(item.productId) &&
      !(item.categoryId && categoryIds?.includes(item.categoryId))
    )
      return false;
    return schedule ? withinSchedule(item.orderedAt, ctx.timezone, schedule) : true;
  });
}

function eligibility(
  promotion: Promotion,
  ctx: EngineContext,
): { reason: RejectionReason; detail?: number } | { couponCode: string | null } {
  if (promotion.status !== 'active') return { reason: 'inactive' };
  if (promotion.startsAt && ctx.at < promotion.startsAt) return { reason: 'not_started' };
  if (promotion.endsAt && ctx.at >= promotion.endsAt) return { reason: 'ended' };
  let couponCode: string | null = null;
  if (promotion.kind === 'coupon') {
    const entered = new Set(ctx.couponCodes.map((code) => code.trim().toUpperCase()));
    couponCode = promotion.codes.find((code) => entered.has(code.toUpperCase())) ?? null;
    if (!couponCode) return { reason: 'coupon_not_entered' };
  }
  const c = promotion.conditions;
  const needsCustomer =
    Boolean(c.tiers?.length) ||
    c.firstOrder === true ||
    c.inactiveDays !== undefined ||
    promotion.usageLimitPerCustomer !== null;
  if (needsCustomer && !ctx.customer) return { reason: 'customer_required' };
  if (c.tiers?.length && !c.tiers.includes(ctx.customer!.tierCode ?? ''))
    return { reason: 'tier_not_eligible' };
  if (c.firstOrder && !ctx.customer!.isFirstOrder) return { reason: 'not_first_order' };
  if (c.inactiveDays !== undefined) {
    const days = ctx.customer!.daysSinceLastVisit;
    if (days === null || days < c.inactiveDays)
      return { reason: 'not_inactive_long_enough', detail: c.inactiveDays };
  }
  if (c.channels?.length && !c.channels.includes(ctx.channel))
    return { reason: 'channel_not_eligible' };
  if (c.branches?.length) return { reason: 'branch_not_supported' };
  const usage = ctx.usage[promotion.id] ?? { customerUses: 0, totalUses: 0, spentMinor: 0 };
  if (
    promotion.usageLimitPerCustomer !== null &&
    usage.customerUses >= promotion.usageLimitPerCustomer
  )
    return { reason: 'usage_limit_reached', detail: promotion.usageLimitPerCustomer };
  if (promotion.totalUsageLimit !== null && usage.totalUses >= promotion.totalUsageLimit)
    return { reason: 'total_usage_limit_reached' };
  if (promotion.budgetMinor !== null && usage.spentMinor >= promotion.budgetMinor)
    return { reason: 'budget_exhausted' };
  return { couponCode };
}

/** Per-item discount for one promotion against what earlier promotions left on each item. */
function reward(
  promotion: Promotion,
  items: EngineItem[],
  remaining: Map<string, number>,
): Map<string, number> {
  const result = new Map<string, number>();
  const left = (item: EngineItem) => remaining.get(item.id) ?? 0;
  const r = promotion.reward;

  if (r.type === 'percent' || r.type === 'fixed') {
    const base = items.reduce((sum, item) => sum + left(item), 0);
    let total =
      r.type === 'percent' ? Math.floor((base * r.percent) / 100) : Math.min(base, r.amountMinor);
    if (r.type === 'percent' && r.maxMinor !== undefined) total = Math.min(total, r.maxMinor);
    const shares = allocateProportionally(total, items.map(left));
    items.forEach((item, index) => shares[index] > 0 && result.set(item.id, shares[index]));
    return result;
  }

  // Unit-level rewards work on each unit's share of what is left on its line.
  const units: { item: EngineItem; value: number }[] = [];
  for (const item of items) {
    const quantity = Math.max(0, Math.floor(item.quantity));
    if (quantity === 0) continue;
    const perUnit = allocateProportionally(left(item), Array(quantity).fill(1));
    for (const value of perUnit) units.push({ item, value });
  }
  const add = (item: EngineItem, amount: number) =>
    amount > 0 && result.set(item.id, (result.get(item.id) ?? 0) + amount);

  if (r.type === 'buy_x_get_y') {
    const group = r.buy + r.get;
    const percentOff = r.percentOff ?? 100;
    units.sort((a, b) => b.value - a.value);
    const groups = Math.floor(units.length / group);
    // The cheapest units go free: the last `get` units of each full group, most expensive first.
    for (let g = 0; g < groups; g++) {
      for (let k = 0; k < r.get; k++) {
        const unit = units[units.length - 1 - (g * r.get + k)];
        add(unit.item, Math.floor((unit.value * percentOff) / 100));
      }
    }
    return result;
  }

  // Bundle: each complete set of the listed products sells for priceMinor.
  const pools = r.productIds.map((productId) =>
    units.filter((unit) => unit.item.productId === productId).sort((a, b) => b.value - a.value),
  );
  const sets = Math.min(...pools.map((pool) => pool.length));
  for (let s = 0; s < sets; s++) {
    const members = pools.map((pool) => pool[s]);
    const setValue = members.reduce((sum, unit) => sum + unit.value, 0);
    const discount = Math.max(0, setValue - r.priceMinor);
    const shares = allocateProportionally(
      discount,
      members.map((unit) => unit.value),
    );
    members.forEach((unit, index) => add(unit.item, shares[index]));
  }
  return result;
}

/** Runs every promotion through the pipeline and returns the final allocation. */
export function evaluatePromotions(promotions: Promotion[], ctx: EngineContext): EngineResult {
  const remaining = new Map(ctx.items.map((item) => [item.id, Math.max(0, item.subtotalMinor)]));
  const applied: AppliedPromotion[] = [];
  const rejected: EngineResult['rejected'] = [];
  const cap =
    ctx.maxTotalDiscountMinor && ctx.maxTotalDiscountMinor > 0 ? ctx.maxTotalDiscountMinor : null;
  let total = 0;
  let exclusiveApplied = false;
  const decidedGroups = new Set<string>();

  const ordered = [...promotions].sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );

  type Candidate = {
    promotion: Promotion;
    couponCode: string | null;
    discounts: Map<string, number>;
  };
  const candidate = (
    promotion: Promotion,
  ): Candidate | { reason: RejectionReason; detail?: number } => {
    const gate = eligibility(promotion, ctx);
    if ('reason' in gate) return gate;
    const items = qualifyingItems(promotion, ctx);
    if (items.length === 0) return { reason: 'no_qualifying_items' };
    const spend = items.reduce((sum, item) => sum + (remaining.get(item.id) ?? 0), 0);
    const minSpend = promotion.conditions.minSpendMinor;
    if (minSpend !== undefined && spend < minSpend)
      return { reason: 'min_spend_not_met', detail: minSpend };
    const discounts = reward(promotion, items, remaining);
    if (sum(discounts) === 0) return { reason: 'no_reward' };
    return { promotion, couponCode: gate.couponCode, discounts };
  };

  for (const promotion of ordered) {
    if (promotion.exclusiveGroup && decidedGroups.has(promotion.exclusiveGroup)) continue;
    if (exclusiveApplied) {
      rejected.push({ promotionId: promotion.id, reason: 'blocked_by_exclusive' });
      continue;
    }

    const members = promotion.exclusiveGroup
      ? ordered.filter((other) => other.exclusiveGroup === promotion.exclusiveGroup)
      : [promotion];
    if (promotion.exclusiveGroup) decidedGroups.add(promotion.exclusiveGroup);
    let pick: Candidate | null = null;
    const valid: Candidate[] = [];
    for (const member of members) {
      const result = candidate(member);
      if ('discounts' in result) {
        valid.push(result);
        if (!pick || sum(result.discounts) > sum(pick.discounts)) pick = result;
      } else {
        rejected.push({ promotionId: member.id, reason: result.reason, detail: result.detail });
      }
    }
    for (const other of valid)
      if (other !== pick)
        rejected.push({ promotionId: other.promotion.id, reason: 'exclusive_group_lost' });
    if (!pick) continue;
    const chosen = pick.promotion;
    if (chosen.stackPolicy === 'exclusive' && applied.length > 0) {
      rejected.push({ promotionId: chosen.id, reason: 'not_stackable' });
      continue;
    }
    if (cap !== null && total >= cap) {
      rejected.push({ promotionId: chosen.id, reason: 'max_total_discount_reached' });
      continue;
    }

    let discounts = pick.discounts;
    let amount = sum(discounts);
    const usage = ctx.usage[chosen.id];
    const budgetLeft =
      chosen.budgetMinor !== null ? chosen.budgetMinor - (usage?.spentMinor ?? 0) : Infinity;
    const limit = Math.min(budgetLeft, cap !== null ? cap - total : Infinity);
    if (amount > limit) discounts = scaleDown(discounts, limit);
    amount = sum(discounts);

    for (const [itemId, value] of discounts)
      remaining.set(itemId, (remaining.get(itemId) ?? 0) - value);
    total += amount;
    applied.push({
      promotionId: chosen.id,
      name: chosen.name,
      couponCode: pick.couponCode,
      discountMinor: amount,
      allocations: [...discounts].map(([itemId, discountMinor]) => ({ itemId, discountMinor })),
    });
    if (chosen.stackPolicy === 'exclusive') exclusiveApplied = true;
  }

  return {
    applied,
    rejected,
    totalDiscountMinor: total,
    items: ctx.items.map((item) => {
      const final = remaining.get(item.id) ?? 0;
      return {
        itemId: item.id,
        discountMinor: Math.max(0, item.subtotalMinor) - final,
        finalMinor: final,
      };
    }),
  };
}

function sum(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function scaleDown(discounts: Map<string, number>, limit: number): Map<string, number> {
  const entries = [...discounts];
  const shares = allocateProportionally(
    Math.max(0, Math.floor(limit)),
    entries.map(([, v]) => v),
  );
  return new Map(
    entries
      .map(([itemId], index) => [itemId, shares[index]])
      .filter(([, v]) => (v as number) > 0) as [string, number][],
  );
}

const isPositiveInt = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
const isNonNegativeInt = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isStringList = (value: unknown) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');

/** Checks a promotion's conditions and reward before they are stored. Returns error codes. */
export function validatePromotionRules(conditions: unknown, rewardInput: unknown): string[] {
  const errors: string[] = [];
  const c = (conditions ?? {}) as Record<string, unknown>;
  if (typeof c !== 'object' || Array.isArray(c)) return ['conditions_invalid'];
  const known = [
    'minSpendMinor',
    'productIds',
    'categoryIds',
    'schedule',
    'channels',
    'tiers',
    'firstOrder',
    'inactiveDays',
    'branches',
  ];
  for (const key of Object.keys(c))
    if (!known.includes(key)) errors.push(`unknown_condition:${key}`);
  if (c.minSpendMinor !== undefined && !isNonNegativeInt(c.minSpendMinor))
    errors.push('min_spend_invalid');
  for (const key of ['productIds', 'categoryIds', 'tiers', 'branches'])
    if (c[key] !== undefined && !isStringList(c[key])) errors.push(`${key}_invalid`);
  if (
    c.channels !== undefined &&
    !(Array.isArray(c.channels) && c.channels.every((ch) => ch === 'pos' || ch === 'qr'))
  )
    errors.push('channels_invalid');
  if (c.firstOrder !== undefined && typeof c.firstOrder !== 'boolean')
    errors.push('first_order_invalid');
  if (c.inactiveDays !== undefined && !isPositiveInt(c.inactiveDays))
    errors.push('inactive_days_invalid');
  if (c.schedule !== undefined) {
    const s = c.schedule as Record<string, unknown>;
    if (typeof s !== 'object' || s === null) errors.push('schedule_invalid');
    else {
      if (
        s.days !== undefined &&
        !(Array.isArray(s.days) && s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
      )
        errors.push('schedule_days_invalid');
      const hasStart = s.start !== undefined;
      const hasEnd = s.end !== undefined;
      if (hasStart !== hasEnd) errors.push('schedule_window_incomplete');
      if (hasStart && !(typeof s.start === 'string' && HHMM.test(s.start)))
        errors.push('schedule_start_invalid');
      if (hasEnd && !(typeof s.end === 'string' && HHMM.test(s.end)))
        errors.push('schedule_end_invalid');
      if (hasStart && hasEnd && s.start === s.end) errors.push('schedule_window_empty');
    }
  }

  const r = rewardInput as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return [...errors, 'reward_invalid'];
  switch (r.type) {
    case 'percent':
      if (!(typeof r.percent === 'number' && r.percent > 0 && r.percent <= 100))
        errors.push('percent_invalid');
      if (r.maxMinor !== undefined && !isPositiveInt(r.maxMinor))
        errors.push('max_discount_invalid');
      break;
    case 'fixed':
      if (!isPositiveInt(r.amountMinor)) errors.push('amount_invalid');
      break;
    case 'buy_x_get_y':
      if (!isPositiveInt(r.buy)) errors.push('buy_invalid');
      if (!isPositiveInt(r.get)) errors.push('get_invalid');
      if (
        r.percentOff !== undefined &&
        !(typeof r.percentOff === 'number' && r.percentOff > 0 && r.percentOff <= 100)
      )
        errors.push('percent_off_invalid');
      break;
    case 'bundle':
      if (!(isStringList(r.productIds) && (r.productIds as string[]).length >= 2))
        errors.push('bundle_products_invalid');
      if (!isNonNegativeInt(r.priceMinor)) errors.push('bundle_price_invalid');
      break;
    default:
      errors.push('reward_type_invalid');
  }
  return errors;
}
