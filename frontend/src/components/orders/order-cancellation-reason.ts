export function formatOrderCancellationReason(
  reason: string,
  formatMergedInto: (orderNumber: string) => string,
): string {
  const target = /^Merged into (.+)$/.exec(reason)?.[1];
  return target ? formatMergedInto(target) : reason;
}
