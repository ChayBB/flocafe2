import { STATUS_ORDER, type KitchenStatus } from '@/hooks/useKdsConnection';

/** The four board stages; 'voided' is read-only and never a column. */
export type BoardStatus = (typeof STATUS_ORDER)[number];

/** Stages left on the board, in order; a display always keeps at least one. */
export function activeStages(inactive: readonly KitchenStatus[]): BoardStatus[] {
  const active = STATUS_ORDER.filter((stage) => !inactive.includes(stage));
  return active.length > 0 ? active : [...STATUS_ORDER];
}

/**
 * The column an item shows in. An item in a switched-off stage waits in the nearest earlier
 * active column (or the next one when none is earlier); served items vanish with their column.
 */
export function boardColumnFor(
  status: KitchenStatus,
  inactive: readonly KitchenStatus[],
): BoardStatus | null {
  const index = STATUS_ORDER.indexOf(status as BoardStatus);
  if (index < 0) return null;
  const active = activeStages(inactive);
  if (active.includes(status as BoardStatus)) return status as BoardStatus;
  if (status === 'served') return null;
  const earlier = active.filter((stage) => STATUS_ORDER.indexOf(stage) < index);
  if (earlier.length > 0) return earlier[earlier.length - 1];
  return active.find((stage) => STATUS_ORDER.indexOf(stage) > index) ?? null;
}

/** Where the one-tap toggle sends an item from a column: the next active stage, else served. */
export function nextKitchenStatus(
  column: KitchenStatus,
  inactive: readonly KitchenStatus[] = [],
): KitchenStatus | null {
  const index = STATUS_ORDER.indexOf(column as BoardStatus);
  if (index < 0 || column === 'served') return null;
  return activeStages(inactive).find((stage) => STATUS_ORDER.indexOf(stage) > index) ?? 'served';
}

/** True when a move from one column to another passes over an active column. */
export function skipsActiveStage(
  from: KitchenStatus,
  to: KitchenStatus,
  inactive: readonly KitchenStatus[],
): boolean {
  const fromIndex = STATUS_ORDER.indexOf(from as BoardStatus);
  const toIndex = STATUS_ORDER.indexOf(to as BoardStatus);
  if (fromIndex < 0 || toIndex <= fromIndex + 1) return false;
  return activeStages(inactive).some((stage) => {
    const index = STATUS_ORDER.indexOf(stage);
    return index > fromIndex && index < toIndex;
  });
}
