import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findCrossReferences, isCrossReferenceDataAvailable } from "../src/services/cross-references.js";

// Compact dataset format: from<TAB>to[-endCh.endV]<TAB>votes with numeric book ids.
const FIXTURE_LINES = [
  "1.1.1\t43.1.1-1.3\t51",   // Gen 1:1 -> John 1:1-3
  "1.1.1\t58.11.3\t40",      // Gen 1:1 -> Heb 11:3
  "1.1.2\t23.45.18\t20",     // Gen 1:2 -> Isa 45:18
  "45.8.28\t50.1.6\t70",     // Rom 8:28 -> Phil 1:6
  "45.8.28\t1.50.20\t65",    // Rom 8:28 -> Gen 50:20
  "45.8.29\t45.9.23\t30",    // Rom 8:29 -> Rom 9:23
  "45.8.29\t50.1.6\t10",     // Rom 8:29 -> Phil 1:6 (duplicate target, fewer votes)
];

let fixtureDir: string;
let dataPath: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "xrefs-fixture-"));
  dataPath = join(fixtureDir, "cross-references.tsv.gz");
  writeFileSync(dataPath, gzipSync(FIXTURE_LINES.join("\n")));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("findCrossReferences", () => {
  it("returns curated references for a verse sorted by votes", () => {
    expect(findCrossReferences("Romans 8:28", { dataPath })).toEqual([
      { reference: "Philippians 1:6", votes: 70 },
      { reference: "Genesis 50:20", votes: 65 },
    ]);
  });

  it("resolves abbreviated input", () => {
    expect(findCrossReferences("Rom 8:28", { dataPath })).toHaveLength(2);
  });

  it("formats range targets", () => {
    const results = findCrossReferences("Genesis 1:1", { dataPath });
    expect(results[0]).toEqual({ reference: "John 1:1-3", votes: 51 });
  });

  it("aggregates a verse range and dedupes targets by highest votes", () => {
    const results = findCrossReferences("Romans 8:28-29", { dataPath });
    expect(results).toEqual([
      { reference: "Philippians 1:6", votes: 70 },
      { reference: "Genesis 50:20", votes: 65 },
      { reference: "Romans 9:23", votes: 30 },
    ]);
  });

  it("aggregates a whole chapter", () => {
    const results = findCrossReferences("Genesis 1", { dataPath });
    expect(results.map((r) => r.reference)).toEqual(["John 1:1-3", "Hebrews 11:3", "Isaiah 45:18"]);
  });

  it("respects the limit option", () => {
    expect(findCrossReferences("Romans 8:28-29", { dataPath, limit: 1 })).toHaveLength(1);
  });

  it("returns empty for a verse with no entries", () => {
    expect(findCrossReferences("Jude 4", { dataPath })).toEqual([]);
  });

  it("throws a helpful error when the dataset is missing", () => {
    const missing = join(fixtureDir, "nope.tsv.gz");
    expect(() => findCrossReferences("Romans 8:28", { dataPath: missing })).toThrow(/fetch-xrefs/);
  });
});

describe("isCrossReferenceDataAvailable", () => {
  it("reflects dataset presence", () => {
    expect(isCrossReferenceDataAvailable(dataPath)).toBe(true);
    expect(isCrossReferenceDataAvailable(join(fixtureDir, "nope.tsv.gz"))).toBe(false);
  });
});
