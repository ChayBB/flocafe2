import type { Product } from '@/lib/types';

/** A product in a "kitchen sets the price" add-on group (its own or its category's) has no menu price. */
export function isKitchenPricedProduct(product: Pick<Product, 'addon_groups'>): boolean {
  return (product.addon_groups || []).some((group) => Boolean(group.kitchen_price));
}
