#!/usr/bin/env node
// Downloads the openbible.info cross-reference dataset (CC Attribution license,
// https://www.openbible.info/labs/cross-references/) and converts it to the
// compact gzipped TSV consumed by src/services/cross-references.ts.
//
// Usage: npm run fetch-xrefs   (writes data/cross-references.tsv.gz)

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { gzipSync, inflateRawSync } from "zlib";

const DATA_URL = "https://a.openbible.info/data/cross-references.zip";

// OSIS book code -> 1-66 Protestant canon book number
const OSIS_BOOK_NUMBERS = {
  Gen: 1, Exod: 2, Lev: 3, Num: 4, Deut: 5, Josh: 6, Judg: 7, Ruth: 8,
  "1Sam": 9, "2Sam": 10, "1Kgs": 11, "2Kgs": 12, "1Chr": 13, "2Chr": 14,
  Ezra: 15, Neh: 16, Esth: 17, Job: 18, Ps: 19, Prov: 20, Eccl: 21,
  Song: 22, Isa: 23, Jer: 24, Lam: 25, Ezek: 26, Dan: 27, Hos: 28,
  Joel: 29, Amos: 30, Obad: 31, Jonah: 32, Mic: 33, Nah: 34, Hab: 35,
  Zeph: 36, Hag: 37, Zech: 38, Mal: 39, Matt: 40, Mark: 41, Luke: 42,
  John: 43, Acts: 44, Rom: 45, "1Cor": 46, "2Cor": 47, Gal: 48, Eph: 49,
  Phil: 50, Col: 51, "1Thess": 52, "2Thess": 53, "1Tim": 54, "2Tim": 55,
  Titus: 56, Phlm: 57, Heb: 58, Jas: 59, "1Pet": 60, "2Pet": 61,
  "1John": 62, "2John": 63, "3John": 64, Jude: 65, Rev: 66,
};

function toNumeric(osisRef) {
  // "Gen.1.1" -> "1.1.1"
  const match = osisRef.match(/^([1-3]?[A-Za-z]+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const book = OSIS_BOOK_NUMBERS[match[1]];
  if (!book) return null;
  return { book, chapter: Number(match[2]), verse: Number(match[3]) };
}

// Minimal single-entry ZIP extraction (the archive holds one deflated text file).
function unzipFirstEntry(buffer) {
  // End of central directory record
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("Not a ZIP archive (no end-of-central-directory record)");
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  // First central directory entry
  if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("Malformed ZIP central directory");
  const method = buffer.readUInt16LE(cdOffset + 10);
  const compressedSize = buffer.readUInt32LE(cdOffset + 20);
  const localOffset = buffer.readUInt32LE(cdOffset + 42);

  // Local file header
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Malformed ZIP local header");
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression method: ${method}`);
}

async function main() {
  console.log(`Downloading ${DATA_URL} ...`);
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const zip = Buffer.from(await response.arrayBuffer());
  const text = unzipFirstEntry(zip).toString("utf-8");

  const lines = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("From Verse")) continue;
    const [fromRaw, toRaw, votesRaw] = line.trim().split("\t");
    if (!fromRaw || !toRaw) continue;

    const from = toNumeric(fromRaw);
    if (!from) { skipped += 1; continue; }

    // Target may be a range: "John.1.1-John.1.3"
    const [toStartRaw, toEndRaw] = toRaw.split("-");
    const toStart = toNumeric(toStartRaw);
    if (!toStart) { skipped += 1; continue; }

    let target = `${toStart.book}.${toStart.chapter}.${toStart.verse}`;
    if (toEndRaw) {
      const toEnd = toNumeric(toEndRaw);
      if (toEnd && toEnd.book === toStart.book &&
          (toEnd.chapter !== toStart.chapter || toEnd.verse !== toStart.verse)) {
        target += `-${toEnd.chapter}.${toEnd.verse}`;
      }
    }

    const votes = Number(votesRaw ?? "0") || 0;
    lines.push(`${from.book}.${from.chapter}.${from.verse}\t${target}\t${votes}`);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "cross-references.tsv.gz");
  writeFileSync(outPath, gzipSync(lines.join("\n"), { level: 9 }));

  console.log(`Wrote ${lines.length} cross-references to ${outPath} (${skipped} lines skipped).`);
  console.log("Data: openbible.info cross-references, Creative Commons Attribution license.");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
