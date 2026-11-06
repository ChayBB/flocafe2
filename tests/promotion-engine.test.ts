/**
 * Promotion rule engine: every condition type, every reward type, conflict resolution
 * (priority, exclusive_group, stack_policy, max_total_discount), allocation and rule validation.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/promotion-engine.test.ts
 */
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const {
  allocateProportionally,
  evaluatePromotions,
  validatePromotionRules,
  withinSchedule,
} = require('../main/lib/promotion-engine');

const TZ = 'Asia/Bangkok';
// 2026-11-02 is a Monday. Bangkok is UTC+7, so 09:50 UTC is 16:50 local.
const MON_1650 = '2026-11-02 09:50:00';
const MON_1705 = '2026-11-02 10:05:00';
const SAT_1500 = '2026-11-07 08:00:00';

function promo(overrides: Record<string, unknown>) {
  return {
    id: 'p',
    name: 'Promo',
    kind: 'automatic',
    status: 'active',
    priority: 100,
    exclusiveGroup: null,
    stackPolicy: 'stack',
    conditions: {},
    reward: { type: 'percent', percent: 10 },
    startsAt: null,
    endsAt: null,
    usageLimitPerCustomer: null,
    totalUsageLimit: null,
    budgetMinor: null,
    codes: [],
    ...overrides,
  };
}

function item(
  id: string,
  productId: string,
  categoryId: string,
  unitPriceMinor: number,
  quantity = 1,
  orderedAt = MON_1650,
) {
  return {
    id,
    productId,
    categoryId,
    unitPriceMinor,
    quantity,
    subtotalMinor: unitPriceMinor * quantity,
    orderedAt,
  };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    items: [item('rice', 'p-rice', 'food', 30_000), item('tea', 'p-tea', 'drinks', 20_000)],
    customer: { id: 'c1', tierCode: 'gold', isFirstOrder: false, daysSinceLastVisit: 5 },
    channel: 'pos',
    at: MON_1650,
    timezone: TZ,
    couponCodes: [],
    usage: {},
    maxTotalDiscountMinor: null,
    ...overrides,
  };
}

const run = (promotions: unknown[], context = ctx()) => evaluatePromotions(promotions, context);
const reasonOf = (result: any, id = 'p') =>
  result.rejected.find((r: any) => r.promotionId === id)?.reason;

function allocation() {
  console.log('\n1. Allocation sums exactly');
  const shares = allocateProportionally(100, [1, 1, 1]);
  assertEqualOrThrow(
    shares.reduce((a: number, b: number) => a + b, 0),
    100,
    '100 split three ways sums to 100',
  );
  assertEqualOrThrow(
    shares.join(','),
    '34,33,33',
    'the remainder goes to the earliest largest fraction',
  );
  assertEqualOrThrow(allocateProportionally(0, [5, 5]).join(','), '0,0', 'nothing to split');
}

function conditions() {
  console.log('\n2. Conditions');
  const minSpend = promo({ conditions: { minSpendMinor: 50_000 } });
  assertEqualOrThrow(
    run([minSpend]).totalDiscountMinor,
    5_000,
    'a 500-baht bill meets a 500-baht minimum',
  );
  const short = run([minSpend], ctx({ items: [item('rice', 'p-rice', 'food', 30_000)] }));
  assertEqualOrThrow(reasonOf(short), 'min_spend_not_met', 'a 300-baht bill does not');
  assertEqualOrThrow(short.rejected[0].detail, 50_000, 'the rejection says what the minimum is');

  const drinks = run([promo({ conditions: { categoryIds: ['drinks'] } })]);
  assertEqualOrThrow(
    drinks.totalDiscountMinor,
    2_000,
    'a drinks-only promotion discounts only the tea',
  );
  assertEqualOrThrow(
    drinks.items.find((i: any) => i.itemId === 'rice').discountMinor,
    0,
    'the rice is untouched',
  );
  assertEqualOrThrow(
    reasonOf(run([promo({ conditions: { productIds: ['p-coffee'] } })])),
    'no_qualifying_items',
    'a product not in the order qualifies nothing',
  );

  const happyHour = promo({
    conditions: {
      categoryIds: ['drinks'],
      schedule: { days: [1, 2, 3, 4, 5], start: '14:00', end: '17:00' },
    },
    reward: { type: 'percent', percent: 20 },
  });
  assertEqualOrThrow(
    run([happyHour]).totalDiscountMinor,
    4_000,
    'a drink ordered at 16:50 on Monday gets Happy Hour',
  );
  const late = ctx({ items: [item('tea', 'p-tea', 'drinks', 20_000, 1, MON_1705)], at: MON_1705 });
  assertEqualOrThrow(
    reasonOf(run([happyHour], late)),
    'no_qualifying_items',
    'one ordered at 17:05 does not',
  );
  const lockedIn = ctx({
    items: [item('tea', 'p-tea', 'drinks', 20_000, 1, MON_1650)],
    at: MON_1705,
  });
  assertEqualOrThrow(
    run([happyHour], lockedIn).totalDiscountMinor,
    4_000,
    'ordered at 16:50 and billed at 17:05 still counts',
  );
  const saturday = ctx({
    items: [item('tea', 'p-tea', 'drinks', 20_000, 1, SAT_1500)],
    at: SAT_1500,
  });
  assertEqualOrThrow(
    reasonOf(run([happyHour], saturday)),
    'no_qualifying_items',
    'Saturday is outside Monday–Friday',
  );
  assertOrThrow(
    withinSchedule('2026-11-02 17:30:00', TZ, { days: [1], start: '22:00', end: '02:00' }),
    'Tuesday 00:30 belongs to Monday night',
  );
  assertOrThrow(
    !withinSchedule('2026-11-02 20:00:00', TZ, { days: [1], start: '22:00', end: '02:00' }),
    'Tuesday 03:00 is after the window',
  );

  assertEqualOrThrow(
    reasonOf(run([promo({ conditions: { channels: ['qr'] } })])),
    'channel_not_eligible',
    'a QR-only promotion skips the POS',
  );
  assertEqualOrThrow(
    run([promo({ conditions: { channels: ['qr'] } })], ctx({ channel: 'qr' })).totalDiscountMinor,
    5_000,
    'and applies to QR orders',
  );

  const tier = promo({ conditions: { tiers: ['gold', 'platinum'] } });
  assertEqualOrThrow(run([tier]).totalDiscountMinor, 5_000, 'Gold qualifies');
  assertEqualOrThrow(
    reasonOf(
      run(
        [tier],
        ctx({
          customer: { id: 'c2', tierCode: 'silver', isFirstOrder: false, daysSinceLastVisit: 1 },
        }),
      ),
    ),
    'tier_not_eligible',
    'Silver does not',
  );
  assertEqualOrThrow(
    reasonOf(run([tier], ctx({ customer: null }))),
    'customer_required',
    'a tier promotion needs a customer',
  );

  assertEqualOrThrow(
    reasonOf(run([promo({ conditions: { firstOrder: true } })])),
    'not_first_order',
    'a returning customer is not a first order',
  );
  assertEqualOrThrow(
    run(
      [promo({ conditions: { firstOrder: true } })],
      ctx({ customer: { id: 'c3', tierCode: null, isFirstOrder: true, daysSinceLastVisit: null } }),
    ).totalDiscountMinor,
    5_000,
    'a first order qualifies',
  );
  const winBack = promo({ conditions: { inactiveDays: 30 } });
  assertEqualOrThrow(
    reasonOf(run([winBack])),
    'not_inactive_long_enough',
    'a visit 5 days ago is too recent',
  );
  assertEqualOrThrow(
    run(
      [winBack],
      ctx({ customer: { id: 'c4', tierCode: null, isFirstOrder: false, daysSinceLastVisit: 45 } }),
    ).totalDiscountMinor,
    5_000,
    '45 days away qualifies',
  );

  assertEqualOrThrow(
    reasonOf(run([promo({ conditions: { branches: ['b1'] } })])),
    'branch_not_supported',
    'branch conditions are refused until branches exist',
  );
}

function limits() {
  console.log('\n3. Usage limits, budget and lifecycle');
  const once = promo({ usageLimitPerCustomer: 1 });
  assertEqualOrThrow(
    reasonOf(run([once], ctx({ usage: { p: { customerUses: 1, totalUses: 3, spentMinor: 0 } } }))),
    'usage_limit_reached',
    'one use per member is enforced',
  );
  assertEqualOrThrow(
    reasonOf(run([once], ctx({ customer: null }))),
    'customer_required',
    'a per-member limit needs a customer',
  );
  assertEqualOrThrow(
    reasonOf(
      run(
        [promo({ totalUsageLimit: 3 })],
        ctx({ usage: { p: { customerUses: 0, totalUses: 3, spentMinor: 0 } } }),
      ),
    ),
    'total_usage_limit_reached',
    'the total limit is enforced',
  );
  const budget = promo({ budgetMinor: 1_000_000 });
  const nearlySpent = run(
    [budget],
    ctx({ usage: { p: { customerUses: 0, totalUses: 9, spentMinor: 997_000 } } }),
  );
  assertEqualOrThrow(
    nearlySpent.totalDiscountMinor,
    3_000,
    'the last 30 baht of a 10,000-baht budget caps the discount',
  );
  assertEqualOrThrow(
    reasonOf(
      run(
        [budget],
        ctx({ usage: { p: { customerUses: 0, totalUses: 9, spentMinor: 1_000_000 } } }),
      ),
    ),
    'budget_exhausted',
    'a spent budget stops the promotion',
  );
  assertEqualOrThrow(
    reasonOf(run([promo({ status: 'paused' })])),
    'inactive',
    'a paused promotion does nothing',
  );
  assertEqualOrThrow(
    reasonOf(run([promo({ startsAt: '2026-12-01 00:00:00' })])),
    'not_started',
    'a future promotion waits',
  );
  assertEqualOrThrow(
    reasonOf(run([promo({ endsAt: '2026-11-01 00:00:00' })])),
    'ended',
    'an ended promotion stops',
  );
  const coupon = promo({ kind: 'coupon', codes: ['WELCOME10'] });
  assertEqualOrThrow(reasonOf(run([coupon])), 'coupon_not_entered', 'a coupon needs its code');
  const entered = run([coupon], ctx({ couponCodes: [' welcome10 '] }));
  assertEqualOrThrow(
    entered.applied[0]?.couponCode,
    'WELCOME10',
    'codes match regardless of case and spaces',
  );
}

function rewards() {
  console.log('\n4. Rewards');
  assertEqualOrThrow(
    run([promo({ reward: { type: 'percent', percent: 10, maxMinor: 3_000 } })]).totalDiscountMinor,
    3_000,
    '10% of 500 is capped at 30 baht',
  );
  assertEqualOrThrow(
    run([promo({ reward: { type: 'fixed', amountMinor: 80_000 } })]).totalDiscountMinor,
    50_000,
    'a fixed discount never exceeds the bill',
  );
  const spendSave = run([
    promo({ conditions: { minSpendMinor: 50_000 }, reward: { type: 'fixed', amountMinor: 8_000 } }),
  ]);
  assertEqualOrThrow(spendSave.totalDiscountMinor, 8_000, 'spend 500, save 80');
  assertEqualOrThrow(
    spendSave.items.map((i: any) => i.discountMinor).join(','),
    '4800,3200',
    'the 80 is shared in proportion to each line',
  );

  const drinks = ctx({
    items: [item('a', 'p-cola', 'drinks', 5_000, 2), item('b', 'p-tea', 'drinks', 3_000, 1)],
  });
  const b2g1 = run([promo({ reward: { type: 'buy_x_get_y', buy: 2, get: 1 } })], drinks);
  assertEqualOrThrow(b2g1.totalDiscountMinor, 3_000, 'buy 2 get 1: the cheapest unit is free');
  assertEqualOrThrow(
    b2g1.items.find((i: any) => i.itemId === 'b').discountMinor,
    3_000,
    'the free unit is the tea',
  );
  const halfOff = run(
    [promo({ reward: { type: 'buy_x_get_y', buy: 1, get: 1, percentOff: 50 } })],
    drinks,
  );
  assertEqualOrThrow(
    halfOff.totalDiscountMinor,
    1_500,
    'buy 1 get 1 half price over 3 units: one pair, the cheapest unit is half off',
  );

  const combo = promo({
    reward: { type: 'bundle', productIds: ['p-rice', 'p-tea'], priceMinor: 9_900 },
  });
  const meal = ctx({
    items: [item('rice', 'p-rice', 'food', 8_000, 2), item('tea', 'p-tea', 'drinks', 4_000, 1)],
  });
  const bundled = run([combo], meal);
  assertEqualOrThrow(
    bundled.totalDiscountMinor,
    2_100,
    'rice + drink for 99: one set, 21 baht off',
  );
  assertEqualOrThrow(
    bundled.items.find((i: any) => i.itemId === 'rice').finalMinor,
    8_000 + 6_600,
    'the second rice stays full price',
  );
  assertEqualOrThrow(
    reasonOf(
      run(
        [
          promo({
            reward: { type: 'bundle', productIds: ['p-rice', 'p-tea'], priceMinor: 99_000 },
          }),
        ],
        meal,
      ),
    ),
    'no_reward',
    'a bundle price above the items gives nothing',
  );
}

function conflicts() {
  console.log('\n5. Conflict resolution');
  const combo = promo({
    id: 'combo',
    priority: 10,
    reward: { type: 'bundle', productIds: ['p-rice', 'p-tea'], priceMinor: 40_000 },
  });
  const coupon = promo({
    id: 'coupon',
    kind: 'coupon',
    codes: ['TEN'],
    priority: 20,
    reward: { type: 'percent', percent: 10 },
  });
  const stacked = run([coupon, combo], ctx({ couponCodes: ['TEN'] }));
  assertEqualOrThrow(
    stacked.applied.map((a: any) => a.promotionId).join(','),
    'combo,coupon',
    'the combo runs before the coupon',
  );
  assertEqualOrThrow(
    stacked.applied[1].discountMinor,
    4_000,
    'the coupon takes 10% of what the combo left (400)',
  );

  const small = promo({
    id: 'small',
    exclusiveGroup: 'member',
    reward: { type: 'percent', percent: 5 },
  });
  const big = promo({
    id: 'big',
    exclusiveGroup: 'member',
    priority: 200,
    reward: { type: 'percent', percent: 15 },
  });
  const group = run([small, big]);
  assertEqualOrThrow(
    group.applied.map((a: any) => a.promotionId).join(','),
    'big',
    'one promotion per exclusive group: the larger wins',
  );
  assertEqualOrThrow(
    reasonOf(group, 'small'),
    'exclusive_group_lost',
    'the smaller one is told why',
  );

  const first = promo({ id: 'first', priority: 1 });
  const lone = promo({ id: 'lone', priority: 2, stackPolicy: 'exclusive' });
  assertEqualOrThrow(
    reasonOf(run([first, lone]), 'lone'),
    'not_stackable',
    'an exclusive promotion does not join others',
  );
  const loneFirst = promo({ id: 'lone', priority: 0, stackPolicy: 'exclusive' });
  const blocked = run([loneFirst, first]);
  assertEqualOrThrow(
    blocked.applied.map((a: any) => a.promotionId).join(','),
    'lone',
    'an exclusive promotion that applies first stands alone',
  );
  assertEqualOrThrow(reasonOf(blocked, 'first'), 'blocked_by_exclusive', 'the rest are blocked');

  const capped = run(
    [
      promo({ id: 'a', priority: 1, reward: { type: 'percent', percent: 10 } }),
      promo({ id: 'b', priority: 2, reward: { type: 'percent', percent: 10 } }),
    ],
    ctx({ maxTotalDiscountMinor: 7_000 }),
  );
  assertEqualOrThrow(
    capped.totalDiscountMinor,
    7_000,
    'max_total_discount caps the combined discount',
  );
  assertEqualOrThrow(
    capped.applied[1].discountMinor,
    2_000,
    'the second promotion is trimmed to fit',
  );
  const full = run(
    [
      promo({ id: 'a', priority: 1, reward: { type: 'fixed', amountMinor: 7_000 } }),
      promo({ id: 'b', priority: 2 }),
    ],
    ctx({ maxTotalDiscountMinor: 7_000 }),
  );
  assertEqualOrThrow(
    reasonOf(full, 'b'),
    'max_total_discount_reached',
    'once the cap is reached the rest are told why',
  );

  const many = run([combo, coupon, small, big, first], ctx({ couponCodes: ['TEN'] }));
  const perItem = many.items.reduce((s: number, i: any) => s + i.discountMinor, 0);
  assertEqualOrThrow(perItem, many.totalDiscountMinor, 'item discounts add up to the total');
  assertOrThrow(
    many.items.every((i: any) => i.finalMinor >= 0),
    'no item goes below zero',
  );
  for (const applied of many.applied) {
    const allocated = applied.allocations.reduce((s: number, a: any) => s + a.discountMinor, 0);
    assertEqualOrThrow(
      allocated,
      applied.discountMinor,
      `${applied.promotionId} allocates exactly its discount`,
    );
  }
}

function validation() {
  console.log('\n6. Rule validation');
  assertEqualOrThrow(
    validatePromotionRules(
      { minSpendMinor: 50_000, schedule: { days: [1, 5], start: '14:00', end: '17:00' } },
      { type: 'percent', percent: 20 },
    ).length,
    0,
    'a valid Happy Hour passes',
  );
  assertOrThrow(
    validatePromotionRules({}, { type: 'percent', percent: 120 }).includes('percent_invalid'),
    'over 100% is refused',
  );
  assertOrThrow(
    validatePromotionRules(
      { schedule: { start: '14:00' } },
      { type: 'fixed', amountMinor: 100 },
    ).includes('schedule_window_incomplete'),
    'a window needs both ends',
  );
  assertOrThrow(
    validatePromotionRules(
      { schedule: { start: '25:00', end: '17:00' } },
      { type: 'fixed', amountMinor: 100 },
    ).includes('schedule_start_invalid'),
    'an impossible time is refused',
  );
  assertOrThrow(
    validatePromotionRules({ colour: 'red' }, { type: 'fixed', amountMinor: 100 }).includes(
      'unknown_condition:colour',
    ),
    'unknown conditions are refused',
  );
  assertOrThrow(
    validatePromotionRules({ channels: ['web'] }, { type: 'fixed', amountMinor: 100 }).includes(
      'channels_invalid',
    ),
    'unknown channels are refused',
  );
  assertOrThrow(
    validatePromotionRules(
      {},
      { type: 'bundle', productIds: ['only-one'], priceMinor: 100 },
    ).includes('bundle_products_invalid'),
    'a bundle needs two products',
  );
  assertOrThrow(
    validatePromotionRules({}, { type: 'cashback' }).includes('reward_type_invalid'),
    'unknown rewards are refused',
  );
}

try {
  console.log('Promotion rule engine');
  console.log('='.repeat(60));
  allocation();
  conditions();
  limits();
  rewards();
  conflicts();
  validation();
  console.log('\nAll promotion engine checks passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}
