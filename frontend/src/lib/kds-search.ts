import type { KdsOrder } from '@/hooks/useKdsConnection';
import { parseVariantSelection } from '@/lib/printer/item-heading';

export function normalizeKdsSearch(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase().trim();
}

/** True when the order's number, table, server or any menu item name contains the normalized query. */
export function kdsOrderMatches(order: KdsOrder, query: string): boolean {
  if (!query) return true;
  const orderNumberQuery = query.replace(/^#/, '');
  const has = (value: string | null | undefined) =>
    !!value && normalizeKdsSearch(value).includes(query);
  if (orderNumberQuery && normalizeKdsSearch(order.order_number || '').includes(orderNumberQuery))
    return true;
  if (has(order.table?.name) || has(order.server_name)) return true;
  return (order.items || []).some(
    (item) => has(item.product_name) || has(parseVariantSelection(item.variant_selection)?.name),
  );
}
