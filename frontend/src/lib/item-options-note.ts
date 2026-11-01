/** Joins the parts of an item's special instructions the way the kitchen reads them. */
export const NOTE_SEPARATOR = ' | ';

interface NamedOption {
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

/**
 * The menu name to read aloud: bracketed text is dropped, and once options are chosen a listed
 * choice such as "หมู/กุ้ง/ไก่" gives way to the chosen ones, followed by the size.
 */
export function spokenItemName(
  productName: string,
  variantName: string | null | undefined,
  addons: NamedOption[] | null | undefined,
): string {
  const chosen = (addons ?? []).map((addon) => addon.name.trim()).filter(Boolean);
  let words = productName
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (chosen.length > 0) words = words.filter((word) => !word.includes('/'));
  return [...words, ...chosen, String(variantName ?? '').trim()].filter(Boolean).join(' ');
}
