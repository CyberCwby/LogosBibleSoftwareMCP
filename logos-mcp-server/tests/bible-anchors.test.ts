import { describe, expect, it } from "vitest";
import {
  anchorsMatchReference,
  describeBibleAnchors,
  parseBibleAnchors,
  referencesIntersect,
} from "../src/utils/bible-anchors.js";

describe("parseBibleAnchors", () => {
  it("parses a versioned bible datatype reference", () => {
    expect(parseBibleAnchors("bible+leb.45.8.28")).toEqual([
      { book: "Romans", chapter: 8, verse: 28 },
    ]);
  });

  it("parses an unversioned reference", () => {
    expect(parseBibleAnchors("bible.66.3.16")).toEqual([
      { book: "Revelation", chapter: 3, verse: 16 },
    ]);
  });

  it("parses references embedded in anchor JSON", () => {
    const anchorsJson = JSON.stringify([
      { reference: { raw: "bible+esv.43.3.16", resourceId: "LLS:ESV" } },
    ]);
    expect(describeBibleAnchors(anchorsJson)).toEqual(["John 3:16"]);
  });

  it("parses verse ranges that repeat the book number", () => {
    expect(parseBibleAnchors("bible+leb.45.8.28-45.8.30")).toEqual([
      { book: "Romans", chapter: 8, verse: 28, endChapter: 8, endVerse: 30 },
    ]);
  });

  it("parses chapter-level references", () => {
    expect(describeBibleAnchors("bible.19.23")).toEqual(["Psalms 23"]);
  });

  it("deduplicates repeated references", () => {
    expect(describeBibleAnchors("bible.1.1.1 and bible+kjv.1.1.1")).toEqual(["Genesis 1:1"]);
  });

  it("ignores book numbers outside the canon", () => {
    expect(parseBibleAnchors("bible.99.1.1")).toEqual([]);
  });

  it("returns empty for null or reference-free input", () => {
    expect(parseBibleAnchors(null)).toEqual([]);
    expect(parseBibleAnchors("Resource=LLS:1.0.30;Offset=1234")).toEqual([]);
  });
});

describe("referencesIntersect", () => {
  it("matches a verse inside a chapter filter", () => {
    expect(referencesIntersect(
      { book: "Romans", chapter: 8, verse: 28 },
      { book: "Romans", chapter: 8 }
    )).toBe(true);
  });

  it("matches overlapping verse ranges", () => {
    expect(referencesIntersect(
      { book: "Romans", chapter: 8, verse: 28, endChapter: 8, endVerse: 30 },
      { book: "Romans", chapter: 8, verse: 30 }
    )).toBe(true);
  });

  it("rejects different books", () => {
    expect(referencesIntersect(
      { book: "Romans", chapter: 8, verse: 28 },
      { book: "Galatians", chapter: 8, verse: 28 }
    )).toBe(false);
  });

  it("rejects non-overlapping verses in the same chapter", () => {
    expect(referencesIntersect(
      { book: "Romans", chapter: 8, verse: 28 },
      { book: "Romans", chapter: 8, verse: 1 }
    )).toBe(false);
  });

  it("rejects different chapters", () => {
    expect(referencesIntersect(
      { book: "Romans", chapter: 8, verse: 28 },
      { book: "Romans", chapter: 9 }
    )).toBe(false);
  });
});

describe("anchorsMatchReference", () => {
  it("matches raw anchors against a human-readable filter", () => {
    expect(anchorsMatchReference("bible+leb.45.8.28", "Romans 8")).toBe(true);
    expect(anchorsMatchReference("bible+leb.45.8.28", "Rom 8:28")).toBe(true);
    expect(anchorsMatchReference("bible+leb.45.8.28", "John 3")).toBe(false);
  });

  it("throws for an unparseable filter", () => {
    expect(() => anchorsMatchReference("bible.1.1.1", "Not A Book 1:1")).toThrow(/Unknown book/);
  });
});
