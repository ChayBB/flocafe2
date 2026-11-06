import type { Customer } from '@/lib/types';

/** Customers saved before first/last name existed only have `name`; split it at the first space. */
export function splitCustomerName(customer: Pick<Customer, 'name' | 'first_name' | 'last_name'>): {
  firstName: string;
  lastName: string;
} {
  if (customer.first_name) {
    return { firstName: customer.first_name, lastName: customer.last_name || '' };
  }
  const name = (customer.name || '').trim();
  const space = name.search(/\s/);
  if (space === -1) return { firstName: name, lastName: '' };
  return { firstName: name.slice(0, space), lastName: name.slice(space).trim() };
}
