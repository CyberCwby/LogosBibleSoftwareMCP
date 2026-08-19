import { deflateRawSync } from "zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script module without type declarations
import { toNumeric, unzipFirstEntry } from "../scripts/fetch-cross-references.mjs";

/**
 * Build a minimal single-entry ZIP archive: one local file header + payload,
 * one central directory entry, one end-of-central-directory record — the
 * exact structure the openbible.info archive uses and the script parses.
 */
function buildZip(payload: Buffer, method: number, name = "cross_references.txt"): Buffer {
  const nameBuf = Buffer.from(name, "utf-8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(method, 8); // compression method
  local.writeUInt32LE(payload.length, 18); // compressed size
  local.writeUInt32LE(payload.length, 22); // uncompressed size (unused by the parser)
  local.writeUInt16LE(nameBuf.length, 26); // file name length
  local.writeUInt16LE(4, 28); // extra field length
  const extra = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const localBlock = Buffer.concat([local, nameBuf, extra, payload]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(method, 10); // compression method
  central.writeUInt32LE(payload.length, 20); // compressed size
  central.writeUInt16LE(nameBuf.length, 28); // file name length
  central.writeUInt32LE(0, 42); // local header offset
  const centralBlock = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end-of-central-directory signature
  eocd.writeUInt32LE(localBlock.length, 16); // central directory offset
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

describe("unzipFirstEntry", () => {
  it("extracts a deflated entry (the format openbible.info actually ships)", () => {
    const text = "From Verse\tTo Verse\tVotes\nGen.1.1\tJohn.1.1-John.1.3\t50\n";
    const zip = buildZip(deflateRawSync(Buffer.from(text)), 8);

    expect(unzipFirstEntry(zip).toString("utf-8")).toBe(text);
  });

  it("extracts a stored (uncompressed) entry", () => {
    const text = "Gen.1.1\tRev.22.21\t3";
    const zip = buildZip(Buffer.from(text), 0);

    expect(unzipFirstEntry(zip).toString("utf-8")).toBe(text);
  });

  it("rejects buffers with no end-of-central-directory record", () => {
    expect(() => unzipFirstEntry(Buffer.from("this is not a zip archive at all")))
      .toThrow(/Not a ZIP archive/);
  });

  it("rejects a malformed central directory", () => {
    const zip = buildZip(Buffer.from("payload"), 0);
    // Corrupt the central directory signature the EOCD points at.
    const eocdOffset = zip.length - 22;
    const cdOffset = zip.readUInt32LE(eocdOffset + 16);
    zip.writeUInt32LE(0xdeadbeef, cdOffset);

    expect(() => unzipFirstEntry(zip)).toThrow(/Malformed ZIP central directory/);
  });

  it("rejects a malformed local header", () => {
    const zip = buildZip(Buffer.from("payload"), 0);
    zip.writeUInt32LE(0xdeadbeef, 0);

    expect(() => unzipFirstEntry(zip)).toThrow(/Malformed ZIP local header/);
  });

  it("rejects unsupported compression methods", () => {
    const zip = buildZip(Buffer.from("payload"), 12); // bzip2 — never used here

    expect(() => unzipFirstEntry(zip)).toThrow(/Unsupported ZIP compression method: 12/);
  });
});

describe("toNumeric", () => {
  it("converts OSIS references to numeric book.chapter.verse", () => {
    expect(toNumeric("Gen.1.1")).toEqual({ book: 1, chapter: 1, verse: 1 });
    expect(toNumeric("1Cor.13.4")).toEqual({ book: 46, chapter: 13, verse: 4 });
    expect(toNumeric("Rev.22.21")).toEqual({ book: 66, chapter: 22, verse: 21 });
  });

  it("returns null for unknown books and malformed references", () => {
    expect(toNumeric("Tob.1.1")).toBeNull(); // deuterocanon: not in the 66-book map
    expect(toNumeric("Gen.1")).toBeNull();
    expect(toNumeric("not-a-ref")).toBeNull();
  });
});
