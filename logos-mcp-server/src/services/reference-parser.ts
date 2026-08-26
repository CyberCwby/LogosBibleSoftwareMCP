import type { ParsedReference } from "../types.js";

// ─── Book Mapping Table ──────────────────────────────────────────────────────
// Maps canonical full book name to Logos abbreviation

const BOOK_TO_LOGOS: Record<string, string> = {
  "Genesis": "Ge",
  "Exodus": "Ex",
  "Leviticus": "Le",
  "Numbers": "Nu",
  "Deuteronomy": "Dt",
  "Joshua": "Jos",
  "Judges": "Jdg",
  "Ruth": "Ru",
  "1 Samuel": "1Sa",
  "2 Samuel": "2Sa",
  "1 Kings": "1Ki",
  "2 Kings": "2Ki",
  "1 Chronicles": "1Ch",
  "2 Chronicles": "2Ch",
  "Ezra": "Ezr",
  "Nehemiah": "Ne",
  "Esther": "Es",
  "Job": "Job",
  "Psalms": "Ps",
  "Proverbs": "Pr",
  "Ecclesiastes": "Ec",
  "Song of Solomon": "So",
  "Isaiah": "Is",
  "Jeremiah": "Je",
  "Lamentations": "La",
  "Ezekiel": "Eze",
  "Daniel": "Da",
  "Hosea": "Ho",
  "Joel": "Joe",
  "Amos": "Am",
  "Obadiah": "Ob",
  "Jonah": "Jon",
  "Micah": "Mic",
  "Nahum": "Na",
  "Habakkuk": "Hab",
  "Zephaniah": "Zep",
  "Haggai": "Hag",
  "Zechariah": "Zec",
  "Malachi": "Mal",
  "Matthew": "Mt",
  "Mark": "Mk",
  "Luke": "Lk",
  "John": "Jn",
  "Acts": "Ac",
  "Romans": "Ro",
  "1 Corinthians": "1Co",
  "2 Corinthians": "2Co",
  "Galatians": "Ga",
  "Ephesians": "Eph",
  "Philippians": "Php",
  "Colossians": "Col",
  "1 Thessalonians": "1Th",
  "2 Thessalonians": "2Th",
  "1 Timothy": "1Ti",
  "2 Timothy": "2Ti",
  "Titus": "Tt",
  "Philemon": "Phm",
  "Hebrews": "Heb",
  "James": "Jas",
  "1 Peter": "1Pe",
  "2 Peter": "2Pe",
  "1 John": "1Jn",
  "2 John": "2Jn",
  "3 John": "3Jn",
  "Jude": "Jud",
  "Revelation": "Re",
};

// Reverse mapping: Logos abbreviation -> canonical full name
const LOGOS_TO_BOOK: Record<string, string> = {};
for (const [full, abbr] of Object.entries(BOOK_TO_LOGOS)) {
  LOGOS_TO_BOOK[abbr] = full;
}

// Common abbreviation aliases -> canonical full name
const ALIAS_TO_BOOK: Record<string, string> = {
  "Song of Songs": "Song of Solomon",
  "Canticles": "Song of Solomon",
  "Eccles": "Ecclesiastes",
  "Ecc": "Ecclesiastes",
  "Gen": "Genesis",
  "Exod": "Exodus",
  "Lev": "Leviticus",
  "Num": "Numbers",
  "Deut": "Deuteronomy",
  "Josh": "Joshua",
  "Judg": "Judges",
  "1Sam": "1 Samuel",
  "2Sam": "2 Samuel",
  "1Kgs": "1 Kings",
  "2Kgs": "2 Kings",
  "1Chr": "1 Chronicles",
  "2Chr": "2 Chronicles",
  "Neh": "Nehemiah",
  "Esth": "Esther",
  "Psa": "Psalms",
  "Psalm": "Psalms",
  "Prov": "Proverbs",
  "Eccl": "Ecclesiastes",
  "Song": "Song of Solomon",
  "Isa": "Isaiah",
  "Jer": "Jeremiah",
  "Lam": "Lamentations",
  "Ezek": "Ezekiel",
  "Dan": "Daniel",
  "Hos": "Hosea",
  "Amo": "Amos",
  "Obad": "Obadiah",
  "Mic": "Micah",
  "Nah": "Nahum",
  "Hab": "Habakkuk",
  "Zeph": "Zephaniah",
  "Hag": "Haggai",
  "Zech": "Zechariah",
  "Mal": "Malachi",
  "Matt": "Matthew",
  "Mrk": "Mark",
  "Luk": "Luke",
  "Joh": "John",
  "Rom": "Romans",
  "1Cor": "1 Corinthians",
  "2Cor": "2 Corinthians",
  "Gal": "Galatians",
  "Phil": "Philippians",
  "1Thess": "1 Thessalonians",
  "2Thess": "2 Thessalonians",
  "1Tim": "1 Timothy",
  "2Tim": "2 Timothy",
  "Tit": "Titus",
  "Phlm": "Philemon",
  "Jas": "James",
  "1Pet": "1 Peter",
  "2Pet": "2 Peter",
  "Rev": "Revelation",
};

// Build a case-insensitive lookup combining all name forms -> canonical name
const NAME_LOOKUP: Map<string, string> = new Map();

// Add canonical full names
for (const name of Object.keys(BOOK_TO_LOGOS)) {
  NAME_LOOKUP.set(name.toLowerCase(), name);
}

// Add common aliases
for (const [alias, canonical] of Object.entries(ALIAS_TO_BOOK)) {
  NAME_LOOKUP.set(alias.toLowerCase(), canonical);
}

// Add Logos abbreviations as aliases too
for (const [abbr, canonical] of Object.entries(LOGOS_TO_BOOK)) {
  NAME_LOOKUP.set(abbr.toLowerCase(), canonical);
}

// Single-chapter books: when user writes "Jude 4", it means chapter 1 verse 4
const SINGLE_CHAPTER_BOOKS = new Set([
  "Obadiah",
  "Philemon",
  "2 John",
  "3 John",
  "Jude",
]);

// ─── Helper: resolve book name ──────────────────────────────────────────────

function resolveBookName(input: string): string | null {
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();

  const candidates = [normalized];

  // "1 sam" -> "1sam" (aliases are stored without the space)
  const numberedMatch = normalized.match(/^([123])\s+(.+)$/);
  if (numberedMatch) {
    candidates.push(`${numberedMatch[1]}${numberedMatch[2]}`);
  }

  // "1samuel" -> "1 samuel" (canonical names are stored with the space)
  const fusedMatch = normalized.match(/^([123])([a-z].*)$/);
  if (fusedMatch) {
    candidates.push(`${fusedMatch[1]} ${fusedMatch[2]}`);
  }

  for (const candidate of candidates) {
    const resolved = NAME_LOOKUP.get(candidate);
    if (resolved) return resolved;
  }
  return null;
}

// ─── parseReference ─────────────────────────────────────────────────────────

export function parseReference(input: string): ParsedReference {
  const trimmed = input.trim();

  // Regex to capture book name (optionally with leading number) and the rest
  // Book name: optional leading digit+space, then letters (and possibly spaces for multi-word books)
  // After book name: chapter, optional :verse, optional range
  const match = trimmed.match(
    /^(\d?\s*[A-Za-z][A-Za-z\s]*?)\.?\s+(\d+)(?::(\d+))?(?:\s*[-–]\s*(\d+)(?::(\d+))?)?$/
  );

  if (!match) {
    throw new Error(`Cannot parse reference: "${input}"`);
  }

  const rawBook = match[1].trim();
  const num1 = parseInt(match[2], 10);
  const num2 = match[3] ? parseInt(match[3], 10) : undefined;
  const num3 = match[4] ? parseInt(match[4], 10) : undefined;
  const num4 = match[5] ? parseInt(match[5], 10) : undefined;

  const book = resolveBookName(rawBook);
  if (!book) {
    throw new Error(`Unknown book: "${rawBook}"`);
  }

  const isSingleChapter = SINGLE_CHAPTER_BOOKS.has(book);

  // Parse based on what was captured
  if (isSingleChapter) {
    // For single-chapter books: "Jude 4" = ch1 v4, "Jude 4-6" = ch1 v4-6
    if (num2 === undefined && num3 === undefined) {
      // "Jude 4" -> chapter 1, verse 4
      return { book, chapter: 1, verse: num1 };
    } else if (num2 !== undefined && num3 === undefined) {
      // "Jude 1:4" -> chapter 1, verse 4
      return { book, chapter: num1, verse: num2 };
    } else if (num2 === undefined && num3 !== undefined) {
      // "Jude 4-6" -> chapter 1, verse 4, endVerse 6
      return { book, chapter: 1, verse: num1, endChapter: 1, endVerse: num3 };
    } else {
      // "Jude 1:4-6" or "Jude 1:4-2:3" (unlikely for single chapter)
      if (num4 !== undefined) {
        return { book, chapter: num1, verse: num2, endChapter: num3, endVerse: num4 };
      } else {
        return { book, chapter: num1, verse: num2, endChapter: num1, endVerse: num3 };
      }
    }
  }

  // Multi-chapter books
  if (num2 === undefined && num3 === undefined) {
    // "Genesis 1" -> just chapter
    return { book, chapter: num1 };
  } else if (num2 !== undefined && num3 === undefined) {
    // "Genesis 1:1" -> chapter and verse
    return { book, chapter: num1, verse: num2 };
  } else if (num2 === undefined && num3 !== undefined) {
    // "Genesis 1-3" -> chapter range (no verses)
    return { book, chapter: num1, endChapter: num3 };
  } else if (num2 !== undefined && num3 !== undefined && num4 === undefined) {
    // "Genesis 1:1-3" -> same chapter, verse range
    return { book, chapter: num1, verse: num2, endChapter: num1, endVerse: num3 };
  } else {
    // "Genesis 1:1-2:3" -> cross-chapter range
    return { book, chapter: num1, verse: num2, endChapter: num3, endVerse: num4 };
  }
}

// ─── toLogosUrlRef ──────────────────────────────────────────────────────────

export function toLogosUrlRef(input: string): string {
  const ref = parseReference(input);
  const abbr = BOOK_TO_LOGOS[ref.book];
  if (!abbr) throw new Error(`No Logos abbreviation for: "${ref.book}"`);

  let result = `${abbr}${ref.chapter}`;

  if (ref.verse !== undefined) {
    result += `.${ref.verse}`;
  }

  if (ref.endChapter !== undefined) {
    result += `-${ref.endChapter}`;
    if (ref.endVerse !== undefined) {
      result += `.${ref.endVerse}`;
    }
  }

  return result;
}

// ─── toBibliaRef ────────────────────────────────────────────────────────────

export function toBibliaRef(input: string): string {
  const ref = parseReference(input);

  let result = ref.book.replace(/ /g, "+");
  result += `+${ref.chapter}`;

  if (ref.verse !== undefined) {
    result += `:${ref.verse}`;
  }

  if (ref.endChapter !== undefined && ref.endVerse !== undefined) {
    if (ref.endChapter !== ref.chapter) {
      result += `-${ref.endChapter}:${ref.endVerse}`;
    } else {
      result += `-${ref.endVerse}`;
    }
  } else if (ref.endChapter !== undefined) {
    result += `-${ref.endChapter}`;
  }

  return result;
}

// ─── formatReference / canonicalizeReference ────────────────────────────────

/** Format a parsed reference back into standard human-readable form. */
export function formatReference(ref: ParsedReference): string {
  let result = `${ref.book} ${ref.chapter}`;

  if (ref.verse !== undefined) {
    result += `:${ref.verse}`;
  }

  if (ref.endChapter !== undefined) {
    if (ref.endVerse !== undefined) {
      result += ref.endChapter === ref.chapter
        ? `-${ref.endVerse}`
        : `-${ref.endChapter}:${ref.endVerse}`;
    } else if (ref.endChapter !== ref.chapter) {
      result += `-${ref.endChapter}`;
    }
  }

  return result;
}

/**
 * Normalize any parseable reference to canonical human-readable form
 * ("Rom 8:28" -> "Romans 8:28"). Returns null for unparseable input so
 * callers can fall back to raw-string comparison.
 */
export function canonicalizeReference(input: string): string | null {
  try {
    return formatReference(parseReference(input));
  } catch {
    return null;
  }
}

// ─── Bible datatype book numbers ────────────────────────────────────────────
// Logos "bible" datatype references number the 66-book Protestant canon in
// order (1 = Genesis ... 24 = Jeremiah ... 66 = Revelation), e.g. "bible.24.1.1".

const BOOKS_IN_ORDER = Object.keys(BOOK_TO_LOGOS);

export function bookNameFromNumber(bookNumber: number): string | null {
  return BOOKS_IN_ORDER[bookNumber - 1] ?? null;
}

export function bookNumberFromName(book: string): number | null {
  const index = BOOKS_IN_ORDER.indexOf(book);
  return index === -1 ? null : index + 1;
}

/**
 * Convert a human-readable reference to a Logos bible milestone
 * ("Jeremiah 1:1" -> "bible.24.1.1"), the format open_resource expects.
 * Chapter-only references become "bible.N.C"; ranges repeat the book number.
 */
export function toBibleMilestone(input: string): string {
  const ref = parseReference(input);
  const bookNumber = bookNumberFromName(ref.book);
  if (bookNumber === null) {
    throw new Error(`No bible milestone book number for: "${ref.book}"`);
  }

  let result = `bible.${bookNumber}.${ref.chapter}`;
  if (ref.verse !== undefined) {
    result += `.${ref.verse}`;
  }
  if (ref.endChapter !== undefined && (ref.endChapter !== ref.chapter || ref.endVerse !== undefined)) {
    result += `-${bookNumber}.${ref.endChapter}`;
    if (ref.endVerse !== undefined) {
      result += `.${ref.endVerse}`;
    }
  }
  return result;
}

// ─── toHumanReadable ────────────────────────────────────────────────────────
//
// A public utility of this module with no in-repo caller today (tests only).
// Kept rather than deleted: it is small, correct and covered, and converting a
// Logos-format reference back to a readable one is exactly what a consumer of
// this parser needs. Unlike the types removed alongside it, it does not claim
// a capability the server lacks — it IS the capability.

export function toHumanReadable(logosRef: string): string {
  const trimmed = logosRef.trim();

  // Match: optional number prefix, abbreviation letters, then chapter.verse[-endChapter.endVerse]
  const match = trimmed.match(
    /^(\d?)([A-Za-z]+)(\d+)(?:\.(\d+))?(?:-(\d+)(?:\.(\d+))?)?$/
  );

  if (!match) {
    throw new Error(`Cannot parse Logos reference: "${logosRef}"`);
  }

  const numPrefix = match[1] || "";
  const abbrLetters = match[2];
  const abbr = numPrefix + abbrLetters;

  const book = LOGOS_TO_BOOK[abbr];
  if (!book) {
    throw new Error(`Unknown Logos abbreviation: "${abbr}"`);
  }

  return formatReference({
    book,
    chapter: parseInt(match[3], 10),
    verse: match[4] ? parseInt(match[4], 10) : undefined,
    endChapter: match[5] ? parseInt(match[5], 10) : undefined,
    endVerse: match[6] ? parseInt(match[6], 10) : undefined,
  });
}

// ─── expandRange ────────────────────────────────────────────────────────────

export function expandRange(input: string, contextVerses: number = 5): string {
  const ref = parseReference(input);

  if (ref.verse === undefined) {
    // If no verse specified, return as-is
    return input;
  }

  const startVerse = Math.max(1, ref.verse - contextVerses);
  const endVerse = (ref.endVerse ?? ref.verse) + contextVerses;

  const endChapter = ref.endChapter ?? ref.chapter;

  return `${ref.book} ${ref.chapter}:${startVerse}-${endChapter === ref.chapter ? "" : `${endChapter}:`}${endVerse}`;
}


