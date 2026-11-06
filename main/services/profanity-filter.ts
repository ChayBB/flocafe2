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

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });

// Thai has no spaces, so word boundaries come from dictionary segmentation; a listed word only
// matches whole words, keeping e.g. "ชี" from masking "ชีส".
export function maskProfanity(text: string, words: readonly string[]): string {
  if (!text || words.length === 0) return text;
  const candidates = [
    ...new Set(words.map((word) => normalize(word).toLocaleLowerCase()).filter(Boolean)),
  ].sort((a, b) => b.length - a.length);
  if (candidates.length === 0) return text;
  const source = text.normalize('NFC');
  const boundaries = new Set<number>([source.length]);
  for (const { index } of segmenter.segment(source)) boundaries.add(index);

  let result = '';
  let position = 0;
  while (position < source.length) {
    const end = boundaries.has(position)
      ? candidates
          .map((word) => position + word.length)
          .find(
            (stop, i) =>
              boundaries.has(stop) &&
              source.slice(position, stop).toLocaleLowerCase() === candidates[i],
          )
      : undefined;
    if (end !== undefined) {
      result += PROFANITY_MASK;
      position = end;
    } else {
      result += source[position];
      position += 1;
    }
  }
  return result;
}
