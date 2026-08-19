import Database from "better-sqlite3";
import { existsSync } from "fs";
import { getCatalogDbPath } from "../config.js";
import { stripXml } from "../utils/strip-markup.js";
import { escapeLikePattern } from "../utils/sql.js";
import type { CatalogResource, ResourceTypeSummary, ResourceMilestone, ResourceReferenceInfo } from "../types.js";

function openDb(path: string): Database.Database {
  if (!existsSync(path)) {
    throw new Error(`Database not found: ${path}`);
  }
  return new Database(path, { readonly: true, fileMustExist: true });
}

// ─── Human-friendly type labels ─────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  // Books & monographs
  "text.monograph": "Book",
  "text.monograph.collected-work": "Collected Work",
  "text.monograph.biography": "Biography",
  "text.monograph.autobiography": "Autobiography",
  "text.monograph.letters": "Letters",
  "text.monograph.festschrift": "Festschrift",
  "text.monograph.quotations": "Quotations",
  "text.monograph.illustrations": "Illustrations",
  "text.monograph.handbook": "Handbook",
  "text.monograph.workbook": "Workbook",
  "text.monograph.lecture": "Lecture",
  "text.monograph.prayers": "Prayers",
  // Bible & Bible-related
  "text.monograph.bible": "Bible",
  "text.bible": "Bible",
  "text.bible.interlinear": "Interlinear Bible",
  "text.monograph.bible.reference": "Bible Reference",
  "text.monograph.concordance.bible": "Concordance",
  "text.monograph.harmony.bible": "Harmony",
  "text.monograph.lectionary.bible": "Lectionary",
  "text.monograph.study.bible": "Study Bible",
  "text.monograph.notes.bible": "Bible Notes",
  "text.monograph.cross-references.bible": "Cross-References",
  "text.monograph.critical-apparatus.bible": "Critical Apparatus",
  "text.monograph.introduction.bible": "Bible Introduction",
  "text.monograph.introduction.new-testament": "NT Introduction",
  "text.monograph.survey.new-testament": "NT Survey",
  "text.monograph.bible-study": "Bible Study",
  "text.visualization.bible": "Bible Visualization",
  // Commentary
  "text.monograph.commentary.bible": "Commentary",
  "text.monograph.commentary": "Commentary",
  // Reference & dictionaries
  "text.monograph.dictionary": "Dictionary",
  "text.monograph.dictionary.bible": "Bible Dictionary",
  "text.monograph.dictionary.encyclopedia": "Encyclopedia",
  "text.monograph.dictionary.encyclopedia.bible": "Bible Encyclopedia",
  "text.monograph.dictionary.lexicon": "Lexicon",
  "text.monograph.dictionary.lexicon.greek": "Greek Lexicon",
  "text.monograph.dictionary.lexicon.hebrew": "Hebrew Lexicon",
  "text.monograph.encyclopedia": "Encyclopedia",
  "text.monograph.lexicon": "Lexicon",
  "text.monograph.glossary": "Glossary",
  "text.monograph.thesaurus": "Thesaurus",
  "text.monograph.bibliography": "Bibliography",
  // Theology
  "text.monograph.theology.systematic": "Systematic Theology",
  "text.monograph.systematic-theology": "Systematic Theology",
  "text.monograph.theology": "Theology",
  "text.monograph.biblical-theology": "Biblical Theology",
  // History & church
  "text.monograph.history": "History",
  "text.monograph.history.church": "Church History",
  "text.monograph.church-history": "Church History",
  "text.monograph.ancient-manuscript": "Ancient Manuscript",
  "text.monograph.ancient-manuscript.translation": "Ancient Text Translation",
  "text.monograph.earlyChurchFathers": "Early Church Fathers",
  // Sermons & devotional
  "text.monograph.sermons": "Sermons",
  "text.monograph.devotional": "Devotional",
  "text.monograph.hymnal": "Hymnal",
  "text.monograph.service-book": "Service Book",
  "text.monograph.catechism": "Catechism",
  "text.monograph.confessional-document": "Confessional Document",
  "text.monograph.creeds.confessions": "Creeds & Confessions",
  // Study & education
  "text.monograph.studynotes": "Study Notes",
  "text.monograph.study-guide": "Study Guide",
  "text.monograph.courseware": "Courseware",
  "text.monograph.grammar": "Grammar",
  "text.monograph.grammar.greek": "Greek Grammar",
  "text.monograph.grammar.hebrew": "Hebrew Grammar",
  "text.monograph.guide": "Guide",
  "text.monograph.atlas": "Atlas",
  "text.manual": "Manual",
  // Journals
  "text.monograph.journal": "Journal",
  "text.serial.journal": "Journal",
  // Interactive & media
  "lbx.media": "Media",
  "lbx.media.courseware": "Interactive Courseware",
  "lbx.interactive": "Interactive Resource",
  "lbx.calendar-devotional": "Daily Devotional",
  "lbx.timelines": "Timeline",
  "lbx.biblicalpeoplediagrams": "People Diagrams",
  "lbx.biblicalplacesmaps": "Place Maps",
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.split(".").pop() ?? type;
}

function normalizeForSearch(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function matchScore(resource: CatalogResource, query?: string): number {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return 0;

  const title = normalizeForSearch(resource.title);
  const subjects = normalizeForSearch(resource.subjects);
  const description = normalizeForSearch(resource.description);

  let score = 0;
  if (title === normalizedQuery) score += 500;
  else if (title.startsWith(normalizedQuery)) score += 300;
  else if (title.includes(normalizedQuery)) score += 225;

  if (subjects.includes(normalizedQuery)) score += 175;
  if (description.includes(normalizedQuery)) score += 75;
  return score;
}

// ─── Search Catalog ─────────────────────────────────────────────────────────

export function searchCatalog(options: {
  type?: string;
  query?: string;
  author?: string;
  limit?: number;
} = {}): CatalogResource[] {
  const db = openDb(getCatalogDbPath());
  try {
    let sql = `
          SELECT ResourceId, Title, AbbreviatedTitle, Type, Authors,
            Subjects, Description, PublicationDate, UseCount
      FROM Records
      WHERE Availability >= 1 AND IsDataset = 0
    `;
    const params: unknown[] = [];

    if (options.type) {
      sql += " AND Type LIKE ? ESCAPE '\\'";
      params.push(`%${escapeLikePattern(options.type)}%`);
    }
    if (options.query) {
      sql += " AND (Title LIKE ? ESCAPE '\\' OR Description LIKE ? ESCAPE '\\' OR Subjects LIKE ? ESCAPE '\\')";
      const q = `%${escapeLikePattern(options.query)}%`;
      params.push(q, q, q);
    }
    if (options.author) {
      sql += " AND Authors LIKE ? ESCAPE '\\'";
      params.push(`%${escapeLikePattern(options.author)}%`);
    }

    const limit = options.limit ?? 25;
    sql += " ORDER BY UseCount DESC";
    sql += " LIMIT ?";
    // Relevance scoring (matchScore) runs in JS after the SQL fetch. When a
    // text query is set, scan a wider candidate window so a strong title
    // match with a low UseCount cannot be cut by the SQL LIMIT before it is
    // ever scored (same pattern as sqlite-reader's REFERENCE_SCAN_LIMIT).
    const scanLimit = options.query ? Math.max(limit * 10, 250) : limit;
    params.push(scanLimit);

    const rows = db.prepare(sql).all(...params) as Array<{
      ResourceId: string;
      Title: string;
      AbbreviatedTitle: string | null;
      Type: string;
      Authors: string | null;
      Subjects: string | null;
      Description: string | null;
      PublicationDate: string | null;
      UseCount: number;
    }>;

    return rows
      .map((r) => ({
        resource: {
          resourceId: r.ResourceId,
          title: r.Title,
          abbreviatedTitle: r.AbbreviatedTitle,
          type: r.Type,
          authors: r.Authors,
          subjects: r.Subjects,
          description: stripXml(r.Description),
          publicationDate: r.PublicationDate,
        },
        useCount: r.UseCount,
      }))
      .sort((left, right) => {
        const scoreDiff = matchScore(right.resource, options.query) - matchScore(left.resource, options.query);
        if (scoreDiff !== 0) return scoreDiff;
        const useCountDiff = right.useCount - left.useCount;
        if (useCountDiff !== 0) return useCountDiff;
        return left.resource.title.localeCompare(right.resource.title);
      })
      .slice(0, limit)
      .map((entry) => entry.resource);
  } finally {
    db.close();
  }
}

// ─── Resource Reference Info ────────────────────────────────────────────────

function parseMilestoneIndexes(raw: string | null): ResourceMilestone[] {
  if (!raw) return [];
  // Format: "Reference;bible;1000\tReference;page;1000\tHeadword;en;1000"
  return raw.split(/\t+/).filter(Boolean).map((entry) => {
    const parts = entry.trim().split(";");
    return {
      category: (parts[0] ?? "Reference") as "Reference" | "Headword",
      type: parts[1] ?? "",
      priority: parseInt(parts[2] ?? "0", 10),
    };
  });
}

export function getResourceReferenceInfo(resourceId: string): ResourceReferenceInfo | null {
  const db = openDb(getCatalogDbPath());
  try {
    const row = db.prepare(`
      SELECT ResourceId, Title, Type, MilestoneIndexes, ReferenceSupersets
      FROM Records
      WHERE ResourceId = ? AND Availability >= 1
    `).get(resourceId) as {
      ResourceId: string;
      Title: string;
      Type: string;
      MilestoneIndexes: string | null;
      ReferenceSupersets: string | null;
    } | undefined;

    if (!row) return null;

    return {
      resourceId: row.ResourceId,
      title: row.Title,
      type: row.Type,
      milestones: parseMilestoneIndexes(row.MilestoneIndexes),
      referenceSupersets: row.ReferenceSupersets,
    };
  } finally {
    db.close();
  }
}

// ─── Resource Type Summary ──────────────────────────────────────────────────

export function getResourceTypeSummary(): ResourceTypeSummary[] {
  const db = openDb(getCatalogDbPath());
  try {
    const rows = db.prepare(`
      SELECT Type, COUNT(*) as Count
      FROM Records
      WHERE Availability >= 1 AND IsDataset = 0
      GROUP BY Type
      ORDER BY Count DESC
    `).all() as Array<{
      Type: string;
      Count: number;
    }>;

    // Collapse types that share the same human-readable label
    const merged = new Map<string, number>();
    for (const r of rows) {
      const label = typeLabel(r.Type);
      merged.set(label, (merged.get(label) ?? 0) + r.Count);
    }
    return Array.from(merged.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  } finally {
    db.close();
  }
}
