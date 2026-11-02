/** Joins the parts of an item's special instructions the way the kitchen reads them. */
export const NOTE_SEPARATOR = ' | ';

export interface NamedOption {
  name: string;
  quantity?: number;
}

/** The chosen size and options, e.g. "จานเล็ก หมู", written into the item's special instructions. */
export function optionsNote(
  variantName: string | null | undefined,
  addons: NamedOption[] | null | undefined,
): string {
  const parts = [String(variantName ?? '').trim()];
  for (const addon of addons ?? []) {
    const name = addon.name.trim();
    if (name) parts.push((addon.quantity ?? 1) > 1 ? `${name} ×${addon.quantity}` : name);
  }
  return parts.filter(Boolean).join(' ');
}

/** The special instructions without a leading options note, which the item already says. */
export function withoutOptionsNote(instructions: string | null | undefined, note: string): string {
  const text = String(instructions ?? '').trim();
  if (!note || !text.startsWith(note)) return text;
  const rest = text.slice(note.length);
  if (rest === '') return '';
  return rest.startsWith(NOTE_SEPARATOR) ? rest.slice(NOTE_SEPARATOR.length).trim() : text;
}

// Zero-width, bidi and other invisible characters (often pasted in with imported names) are read
// differently by each voice, and some voices drop the word around them.
const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u3164\u2800]/g;
const ODD_SPACE = /[\u00A0\u2000-\u200A\u202F\u3000]/g;

export function cleanItemText(text: string): string {
  return text.replace(INVISIBLE, '').replace(ODD_SPACE, ' ').trim();
}

/**
 * The dish with its first choice joined on ("ข้าวต้มหมู", "Rice soup Pork"): bracketed text is dropped and a listed
 * choice such as "หมู/กุ้ง/ไก่" gives way to the chosen one.
 */
export function joinedDish(productName: string, firstChoice: string | undefined): string {
  let words = cleanItemText(productName)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (firstChoice) words = words.filter((word) => !word.includes('/'));
  const dish = words.join(' ');
  if (!firstChoice || !dish) return dish || (firstChoice ?? '');
  // Thai writes the choice onto the dish ("ข้าวต้มหมู"); other scripts keep a space.
  return THAI.test(dish.slice(-1)) && THAI.test(firstChoice[0])
    ? dish + firstChoice
    : `${dish} ${firstChoice}`;
}

const THAI = /[ก-๛]/;

/**
 * The menu name once options are chosen, as the kitchen screen shows it: the first joins the dish
 * and the rest follow ("ข้าวต้มหมู ไข่ดาว ×2"). Without options the product name is kept as is.
 */
export function dishWithOptions(
  productName: string,
  addons: NamedOption[] | null | undefined,
  timesSign = '×',
): string {
  const options = (addons ?? [])
    .map((addon) => ({
      name: cleanItemText(String(addon?.name ?? '')),
      quantity: addon?.quantity ?? 1,
    }))
    .filter((option) => option.name);
  if (options.length === 0) return productName;
  const times = (quantity: number) => (quantity > 1 ? ` ${timesSign}${quantity}` : '');
  return [
    joinedDish(productName, options[0].name) + times(options[0].quantity),
    ...options.slice(1).map((option) => option.name + times(option.quantity)),
  ].join(' ');
}

/**
 * An item's printed or displayed line, the way the kitchen screen shows it: options join the dish,
 * the size follows in brackets ("ข้าวต้มหมู (จานเล็ก)"), and the options note the order screen
 * wrote into the special instructions is left out as already said.
 */
export function itemLine(
  productName: string,
  variant: { name?: unknown; sku?: unknown } | null | undefined,
  addons: NamedOption[] | null | undefined,
  specialInstructions: string | null | undefined,
  /** Printed documents join only the options they do not list with a price, and write x for ×. */
  print?: { joined: NamedOption[] },
): { name: string; instructions: string } {
  const variantName = String(variant?.name ?? '').trim();
  const sku = String(variant?.sku ?? '').trim();
  const dish = print
    ? dishWithOptions(productName, print.joined, 'x')
    : dishWithOptions(productName, addons);
  return {
    name: variantName ? `${dish} (${variantName})${sku ? ` [${sku}]` : ''}` : dish,
    instructions: withoutOptionsNote(specialInstructions, optionsNote(variantName, addons)),
  };
}
