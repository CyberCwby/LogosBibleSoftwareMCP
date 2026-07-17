import { bookNameFromNumber, formatReference, parseReference } from "../services/reference-parser.js";
import type { ParsedReference } from "../types.js";

// Logos stores note anchors and highlight ranges using "bible" datatype
// references such as "bible+leb.45.8.28" or "bible.66.3.16-66.3.18"
// (book.chapter[.verse], numbered 1-66 in Protestant canon order). The exact
// JSON envelope varies across Logos versions, so we scan the raw text for
// datatype references instead of relying on a fixed schema.
const BIBLE_REF_PATTERN =
  /bible(?:\+[a-z0-9]+)?\.(\d{1,2})\.(\d{1,3})(?:\.(\d{1,3}))?(?:-(\d{1,2})\.(\d{1,3})(?:\.(\d{1,3}))?)?/gi;

/**
 * Extract all Bible references from raw anchor data (AnchorsJson, SavedTextRange,
 * or any other text containing Logos bible datatype references). Returns
 * deduplicated parsed references.
 */
export function parseBibleAnchors(raw: string | null | undefined): ParsedReference[] {
  if (!raw) return [];

  const refs: ParsedReference[] = [];
  const seen = new Set<string>();

  for (const match of raw.matchAll(BIBLE_REF_PATTERN)) {
    const book = bookNameFromNumber(parseInt(match[1], 10));
    if (!book) continue;

    const ref: ParsedReference = {
      book,
      chapter: parseInt(match[2], 10),
      verse: match[3] ? parseInt(match[3], 10) : undefined,
    };

    // Range end repeats the book number ("bible.45.8.28-45.8.30"); ignore the
    // end when it points at a different book (rare and not representable here).
    if (match[4] && parseInt(match[4], 10) === parseInt(match[1], 10)) {
      ref.endChapter = parseInt(match[5], 10);
      if (match[6]) ref.endVerse = parseInt(match[6], 10);
    }

    const key = formatReference(ref);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }

  return refs;
}

/** Human-readable labels for the given anchor data, e.g. ["Romans 8:28-30"]. */
export function describeBibleAnchors(raw: string | null | undefined): string[] {
  return parseBibleAnchors(raw).map(formatReference);
}

type VersePoint = number;

// Encode chapter:verse as a single comparable number. A missing verse spans
// the whole chapter.
function rangeOf(ref: ParsedReference): [VersePoint, VersePoint] {
  const startChapter = ref.chapter;
  const endChapter = ref.endChapter ?? ref.chapter;
  const start = startChapter * 1000 + (ref.verse ?? 0);
  const end = ref.endVerse !== undefined
    ? endChapter * 1000 + ref.endVerse
    : ref.verse !== undefined && ref.endChapter === undefined
      ? startChapter * 1000 + ref.verse
      : endChapter * 1000 + 999;
  return [start, end];
}

/** True when two references share the same book and their ranges overlap. */
export function referencesIntersect(a: ParsedReference, b: ParsedReference): boolean {
  if (a.book !== b.book) return false;
  const [startA, endA] = rangeOf(a);
  const [startB, endB] = rangeOf(b);
  return startA <= endB && startB <= endA;
}

/**
 * True when the raw anchor data contains at least one reference intersecting
 * the given filter (e.g. filter "Romans 8" matches an anchor of Romans 8:28).
 * Throws if the filter reference cannot be parsed.
 */
export function anchorsMatchReference(raw: string | null | undefined, referenceFilter: string): boolean {
  const filter = parseReference(referenceFilter);
  return parseBibleAnchors(raw).some((anchor) => referencesIntersect(anchor, filter));
}
