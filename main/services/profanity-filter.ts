export const PROFANITY_WORDS_KEY = 'customer_display_profanity_words';
export const PROFANITY_MAX_WORDS = 200;
export const PROFANITY_MAX_WORD_LENGTH = 50;
export const PROFANITY_MASK = '***';

const normalize = (word: string) => word.normalize('NFC').trim();

/** Returns the trimmed, de-duplicated word list, or null when the payload is malformed. */
export function parseProfanityWords(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > PROFANITY_MAX_WORDS) return null;
  const seen = new Set<string>();
  const words: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const word = normalize(entry);
    if (word.length > PROFANITY_MAX_WORD_LENGTH) return null;
    const folded = word.toLocaleLowerCase();
    if (!word || seen.has(folded)) continue;
    seen.add(folded);
    words.push(word);
  }
  return words;
}

/** Parses a stored settings value, falling back to an empty list when absent or invalid. */
export function readStoredProfanityWords(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    return parseProfanityWords(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Substring match, since Thai text has no spaces between words.
export function maskProfanity(text: string, words: readonly string[]): string {
  if (!text || words.length === 0) return text;
  const pattern = [...words]
    .map(normalize)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  if (!pattern) return text;
  return text.normalize('NFC').replace(new RegExp(pattern, 'giu'), PROFANITY_MASK);
}
