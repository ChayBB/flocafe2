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

// Zero-width, bidi and other invisible characters (often pasted in with imported names) are read
// differently by each voice, and some voices drop the word around them.
const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u3164\u2800]/g;
const ODD_SPACE = /[\u00A0\u2000-\u200A\u202F\u3000]/g;

function cleanForSpeech(text: string): string {
  return text.replace(INVISIBLE, '').replace(ODD_SPACE, ' ').trim();
}

/**
 * The menu name to read aloud, built from what was chosen rather than from the displayed name:
 * bracketed text is dropped, and once options are chosen a listed choice such as "หมู/กุ้ง/ไก่"
 * gives way to the chosen one joined onto the dish ("ข้าวต้มหมู"), followed by the size.
 */
export function spokenItemName(
  productName: string,
  variantName: string | null | undefined,
  addons: NamedOption[] | null | undefined,
): string {
  const chosen = (addons ?? []).map((addon) => cleanForSpeech(addon.name)).filter(Boolean);
  let words = cleanForSpeech(productName)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (chosen.length > 0) words = words.filter((word) => !word.includes('/'));
  const dish = words.join(' ') + (chosen[0] ?? '');
  return [dish, ...chosen.slice(1), cleanForSpeech(String(variantName ?? ''))]
    .filter(Boolean)
    .join(' ');
}
