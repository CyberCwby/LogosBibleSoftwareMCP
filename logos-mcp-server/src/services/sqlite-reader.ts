import Database from "better-sqlite3";
import { existsSync } from "fs";
import { getDbPaths } from "../config.js";
import { anchorsMatchReference, describeBibleAnchors } from "../utils/bible-anchors.js";
import { stripRichText } from "../utils/strip-markup.js";
import { escapeLikePattern } from "../utils/sql.js";
import type {
  HighlightResult,
  FavoriteResult,
  WorkflowTemplate,
  WorkflowInstance,
  ReadingListStatus,
  ReadingListItem,
  ReadingProgress,
} from "../types.js";

function openDb(path: string): Database.Database {
  if (!existsSync(path)) {
    throw new Error(`Database not found: ${path}`);
  }
  return new Database(path, { readonly: true, fileMustExist: true });
}

// When filtering by Bible reference we can't push the predicate into SQL, so
// scan up to this many candidate rows before applying the limit.
const REFERENCE_SCAN_LIMIT = 5000;

// Row ceiling for getPassageLists' schema-fallback path, which cannot group by
// list and so returns one synthetic list. A safety bound on an unbounded
// table scan — NOT the caller's `limit`, which counts lists, not passages.
const FALLBACK_ROW_SCAN = 5000;

// ─── Highlights ──────────────────────────────────────────────────────────────

export function getUserHighlights(options: {
  resourceId?: string;
  styleName?: string;
  reference?: string;
  limit?: number;
} = {}): HighlightResult[] {
  const db = openDb(getDbPaths().visualMarkup);
  try {
    let sql = "SELECT ResourceId, SavedTextRange, MarkupStyleName, SyncDate FROM Markup WHERE IsDeleted = 0";
    const params: unknown[] = [];

    if (options.resourceId) {
      sql += " AND ResourceId = ?";
      params.push(options.resourceId);
    }
    if (options.styleName) {
      sql += " AND MarkupStyleName = ?";
      params.push(options.styleName);
    }
    sql += " ORDER BY SyncDate DESC";
    sql += " LIMIT ?";
    params.push(options.reference ? REFERENCE_SCAN_LIMIT : options.limit ?? REFERENCE_SCAN_LIMIT);

    const rows = db.prepare(sql).all(...params) as Array<{
      ResourceId: string;
      SavedTextRange: string;
      MarkupStyleName: string;
      SyncDate: string | null;
    }>;

    let results = rows.map((r) => ({
      resourceId: r.ResourceId,
      textRange: r.SavedTextRange,
      styleName: r.MarkupStyleName,
      syncDate: r.SyncDate,
      references: describeBibleAnchors(r.SavedTextRange),
    }));

    if (options.reference) {
      const filter = options.reference;
      results = results.filter((r) => anchorsMatchReference(r.textRange, filter));
    }

    return options.limit ? results.slice(0, options.limit) : results;
  } finally {
    db.close();
  }
}

// ─── Favorites ───────────────────────────────────────────────────────────────

/**
 * Favorite ITEMS only. The inner `JOIN Items` means favorite *folders* — which
 * have no Items row — are excluded, so the returned list is flat and a folder
 * the user sees in Logos does not appear here. That is the current behaviour,
 * stated rather than left to be discovered; a `FavoriteFolder` type used to sit
 * in types.ts describing a tree this function never builds.
 */
export function getFavorites(limit?: number): FavoriteResult[] {
  const db = openDb(getDbPaths().favorites);
  try {
    let sql = `
      SELECT f.Id, f.Title, f.Rank, i.AppCommand, i.ResourceId
      FROM Favorites f
      JOIN Items i ON f.Id = i.FavoriteId
      WHERE f.IsDeleted = 0
      ORDER BY f.Rank ASC
    `;
    const params: unknown[] = [];
    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const rows = db.prepare(sql).all(...params) as Array<{
      Id: string;
      Title: string;
      Rank: number;
      AppCommand: string;
      ResourceId: string | null;
    }>;

    return rows.map((r) => ({
      id: r.Id,
      title: r.Title,
      appCommand: r.AppCommand,
      resourceId: r.ResourceId,
      rank: r.Rank,
    }));
  } finally {
    db.close();
  }
}

// ─── Workflows ───────────────────────────────────────────────────────────────

export function getWorkflowTemplates(): WorkflowTemplate[] {
  const db = openDb(getDbPaths().workflows);
  try {
    const rows = db.prepare(`
      SELECT TemplateId, ExternalId, TemplateJson, Author, CreatedDate
      FROM Templates WHERE IsDeleted = 0
    `).all() as Array<{
      TemplateId: number;
      ExternalId: string;
      TemplateJson: string | null;
      Author: string | null;
      CreatedDate: string;
    }>;

    return rows.map((r) => {
      let parsed: Record<string, unknown> | null = null;
      if (r.TemplateJson) {
        try {
          parsed = JSON.parse(r.TemplateJson);
        } catch { /* ignore parse errors */ }
      }
      return {
        templateId: r.TemplateId,
        externalId: r.ExternalId,
        title: (parsed as Record<string, string>)?.title ?? r.ExternalId,
        author: r.Author,
        templateJson: parsed,
        createdDate: r.CreatedDate,
      };
    });
  } finally {
    db.close();
  }
}

export function getWorkflowInstances(limit: number = 20): WorkflowInstance[] {
  const db = openDb(getDbPaths().workflows);
  try {
    const rows = db.prepare(`
      SELECT InstanceId, ExternalId, TemplateId, Key, Title,
             CurrentStep, CompletedStepsJson, SkippedStepsJson,
             CreatedDate, CompletedDate, ModifiedDate
      FROM Instances WHERE IsDeleted = 0
      ORDER BY ModifiedDate DESC LIMIT ?
    `).all(limit) as Array<{
      InstanceId: number;
      ExternalId: string;
      TemplateId: string;
      Key: string;
      Title: string;
      CurrentStep: string | null;
      CompletedStepsJson: string | null;
      SkippedStepsJson: string | null;
      CreatedDate: string;
      CompletedDate: string | null;
      ModifiedDate: string | null;
    }>;

    return rows.map((r) => ({
      instanceId: r.InstanceId,
      externalId: r.ExternalId,
      templateId: r.TemplateId,
      key: r.Key,
      title: r.Title,
      currentStep: r.CurrentStep,
      completedSteps: safeParseArray(r.CompletedStepsJson),
      skippedSteps: safeParseArray(r.SkippedStepsJson),
      createdDate: r.CreatedDate,
      completedDate: r.CompletedDate,
      modifiedDate: r.ModifiedDate,
    }));
  } finally {
    db.close();
  }
}

// ─── Reading Progress ────────────────────────────────────────────────────────

export function getReadingProgress(): ReadingProgress {
  const db = openDb(getDbPaths().readingLists);
  try {
    const statuses = db.prepare(`
      SELECT Title, Author, Path, Status, ModifiedDate
      FROM ReadingListStatuses WHERE IsDeleted = 0
    `).all() as Array<{
      Title: string;
      Author: string;
      Path: string;
      Status: number;
      ModifiedDate: string | null;
    }>;

    const items = db.prepare(`
      SELECT ItemId, ReadingListPathNormalized, IsRead, ModifiedDate
      FROM Items
    `).all() as Array<{
      ItemId: string;
      ReadingListPathNormalized: string;
      IsRead: number;
      ModifiedDate: string | null;
    }>;

    const totalItems = items.length;
    const completedItems = items.filter((i) => i.IsRead === 1).length;

    return {
      statuses: statuses.map((s) => ({
        title: s.Title,
        author: s.Author,
        path: s.Path,
        status: s.Status,
        modifiedDate: s.ModifiedDate,
      })),
      items: items.map((i) => ({
        itemId: i.ItemId,
        readingListPath: i.ReadingListPathNormalized,
        isRead: i.IsRead === 1,
        modifiedDate: i.ModifiedDate,
      })),
      totalItems,
      completedItems,
      percentComplete: totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0,
    };
  } finally {
    db.close();
  }
}

// ─── Notes ───────────────────────────────────────────────────────────────────

export interface NoteResult {
  noteId: number;
  externalId: string;
  content: string | null;
  createdDate: string;
  modifiedDate: string | null;
  notebookTitle: string | null;
  anchorsJson: string | null;
  tagsJson: string | null;
  references: string[];
}

export function getUserNotes(options: {
  notebookTitle?: string;
  notebookExternalId?: string;
  reference?: string;
  query?: string;
  limit?: number;
} = {}): NoteResult[] {
  const db = openDb(getDbPaths().notes);
  try {
    let sql = `
      SELECT n.NoteId, n.ExternalId, n.ContentRichText, n.CreatedDate,
             n.ModifiedDate, nb.Title as NotebookTitle,
             n.AnchorsJson, n.TagsJson
      FROM Notes n
      LEFT JOIN Notebooks nb ON n.NotebookExternalId = nb.ExternalId AND nb.IsDeleted = 0
      WHERE n.IsDeleted = 0 AND n.IsTrashed = 0
    `;
    const params: unknown[] = [];

    if (options.notebookTitle) {
      sql += " AND nb.Title LIKE ? ESCAPE '\\'";
      params.push(`%${escapeLikePattern(options.notebookTitle)}%`);
    }
    if (options.notebookExternalId) {
      sql += " AND n.NotebookExternalId = ?";
      params.push(options.notebookExternalId);
    }

    sql += " ORDER BY n.ModifiedDate DESC";
    sql += " LIMIT ?";
    const needsScan = Boolean(options.reference || options.query);
    params.push(needsScan ? REFERENCE_SCAN_LIMIT : options.limit ?? REFERENCE_SCAN_LIMIT);

    const rows = db.prepare(sql).all(...params) as Array<{
      NoteId: number;
      ExternalId: string;
      ContentRichText: string | null;
      CreatedDate: string;
      ModifiedDate: string | null;
      NotebookTitle: string | null;
      AnchorsJson: string | null;
      TagsJson: string | null;
    }>;

    let results = rows
      .map((r) => ({
        noteId: r.NoteId,
        externalId: r.ExternalId,
        content: stripRichText(r.ContentRichText),
        createdDate: r.CreatedDate,
        modifiedDate: r.ModifiedDate,
        notebookTitle: r.NotebookTitle,
        anchorsJson: r.AnchorsJson,
        tagsJson: r.TagsJson,
        references: describeBibleAnchors(r.AnchorsJson),
      }))
      .filter((n) => n.content !== null);

    if (options.reference) {
      const filter = options.reference;
      results = results.filter((n) => anchorsMatchReference(n.anchorsJson, filter));
    }
    if (options.query) {
      const needle = options.query.toLowerCase();
      results = results.filter((n) => n.content !== null && n.content.toLowerCase().includes(needle));
    }

    return options.limit ? results.slice(0, options.limit) : results;
  } finally {
    db.close();
  }
}

// ─── Schema introspection helpers ────────────────────────────────────────────
// Clippings.db and PassageList.db layouts vary across Logos versions, so these
// readers discover tables/columns at runtime instead of assuming a fixed schema.

function listTables(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function tableColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function pickColumn(columns: string[], candidates: string[]): string | null {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  for (const candidate of candidates) {
    const found = lower.get(candidate.toLowerCase());
    if (found) return found;
  }
  return null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ─── Clippings ───────────────────────────────────────────────────────────────

export interface ClippingResult {
  title: string | null;
  content: string | null;
  resourceId: string | null;
  createdDate: string | null;
  modifiedDate: string | null;
  references: string[];
}

export function getClippings(options: { limit?: number } = {}): ClippingResult[] {
  const db = openDb(getDbPaths().clippings);
  try {
    const tables = listTables(db);
    const table = tables.find((t) => t.toLowerCase() === "clippings")
      ?? tables.find((t) => /clip/i.test(t));
    if (!table) {
      throw new Error(`No clippings table found in Clippings.db (tables: ${tables.join(", ") || "none"}).`);
    }

    const columns = tableColumns(db, table);
    const contentCol = pickColumn(columns, ["ContentRichText", "Content", "Text", "ClippingText", "Excerpt", "PlainText"]);
    if (!contentCol) {
      throw new Error(`No content column found in ${table} (columns: ${columns.join(", ")}).`);
    }
    const titleCol = pickColumn(columns, ["Title"]);
    const resourceCol = pickColumn(columns, ["ResourceId", "Resource"]);
    const anchorCol = pickColumn(columns, ["AnchorsJson", "Anchor", "Reference", "TextRange", "SavedTextRange", "Position"]);
    const createdCol = pickColumn(columns, ["CreatedDate"]);
    const modifiedCol = pickColumn(columns, ["ModifiedDate"]);
    const deletedCol = pickColumn(columns, ["IsDeleted"]);

    const selected = [contentCol, titleCol, resourceCol, anchorCol, createdCol, modifiedCol]
      .filter((c): c is string => c !== null)
      .map(quoteIdent);
    let sql = `SELECT ${selected.join(", ")} FROM ${quoteIdent(table)}`;
    if (deletedCol) sql += ` WHERE ${quoteIdent(deletedCol)} = 0`;
    const orderCol = modifiedCol ?? createdCol;
    if (orderCol) sql += ` ORDER BY ${quoteIdent(orderCol)} DESC`;
    sql += " LIMIT ?";

    const rows = db.prepare(sql).all(options.limit ?? 25) as Array<Record<string, string | null>>;

    return rows.map((r) => {
      const rawContent = contentCol ? r[contentCol] : null;
      const anchor = anchorCol ? r[anchorCol] : null;
      return {
        title: titleCol ? r[titleCol] : null,
        content: stripRichText(rawContent),
        resourceId: resourceCol ? r[resourceCol] : null,
        createdDate: createdCol ? r[createdCol] : null,
        modifiedDate: modifiedCol ? r[modifiedCol] : null,
        references: describeBibleAnchors(anchor),
      };
    }).filter((c) => c.content !== null || c.title !== null);
  } finally {
    db.close();
  }
}

// ─── Passage Lists ───────────────────────────────────────────────────────────

export interface PassageListResult {
  title: string | null;
  passages: string[];
}

export function getPassageLists(options: { limit?: number } = {}): PassageListResult[] {
  const db = openDb(getDbPaths().passageLists);
  try {
    const tables = listTables(db);

    // Items table: any table with a reference-bearing column
    let itemsTable: string | null = null;
    let referenceCol: string | null = null;
    for (const table of tables) {
      const col = pickColumn(tableColumns(db, table), ["Reference", "ReferencesJson", "Passage", "Anchor", "AnchorsJson"]);
      if (col) {
        itemsTable = table;
        referenceCol = col;
        break;
      }
    }
    if (!itemsTable || !referenceCol) {
      throw new Error(`No passage table found in PassageList.db (tables: ${tables.join(", ") || "none"}).`);
    }

    // List (metadata) table: a different table carrying a Title column
    const listTable = tables.find((t) => t !== itemsTable && pickColumn(tableColumns(db, t), ["Title"]) !== null) ?? null;

    const itemColumns = tableColumns(db, itemsTable);
    const itemDeletedCol = pickColumn(itemColumns, ["IsDeleted"]);
    const listKeyCol = listTable
      ? pickColumn(itemColumns, [`${listTable.replace(/s$/, "")}Id`, "PassageListId", "ListId", "DocumentId", "ParentId"])
      : null;

    const decodePassage = (raw: string | null): string[] => {
      if (!raw) return [];
      const decoded = describeBibleAnchors(raw);
      return decoded.length > 0 ? decoded : [raw];
    };

    if (listTable && listKeyCol) {
      const listColumns = tableColumns(db, listTable);
      const listTitleCol = pickColumn(listColumns, ["Title"])!;
      const listIdCol = pickColumn(listColumns, ["Id", `${listTable.replace(/s$/, "")}Id`, "DocumentId", "ExternalId"]);
      const listDeletedCol = pickColumn(listColumns, ["IsDeleted"]);

      if (listIdCol) {
        // Select the list ID as well as its title: grouping keyed on the
        // TITLE merged two genuinely distinct lists that happen to share a
        // name (two "Sermon prep" lists became one entry), and the id was
        // already resolved right here.
        let sql = `
          SELECT l.${quoteIdent(listIdCol)} AS ListId,
                 l.${quoteIdent(listTitleCol)} AS ListTitle,
                 i.${quoteIdent(referenceCol)} AS Ref
          FROM ${quoteIdent(itemsTable)} i
          JOIN ${quoteIdent(listTable)} l ON i.${quoteIdent(listKeyCol)} = l.${quoteIdent(listIdCol)}
        `;
        const conditions: string[] = [];
        if (itemDeletedCol) conditions.push(`i.${quoteIdent(itemDeletedCol)} = 0`);
        if (listDeletedCol) conditions.push(`l.${quoteIdent(listDeletedCol)} = 0`);
        if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;

        const rows = db.prepare(sql).all() as Array<{
          ListId: string | number | null;
          ListTitle: string | null;
          Ref: string | null;
        }>;
        const grouped = new Map<string, { title: string; passages: string[] }>();
        for (const row of rows) {
          const key = String(row.ListId ?? row.ListTitle ?? "(untitled list)");
          const entry = grouped.get(key) ?? {
            title: row.ListTitle ?? "(untitled list)",
            passages: [],
          };
          entry.passages.push(...decodePassage(row.Ref));
          grouped.set(key, entry);
        }
        return Array.from(grouped.values()).slice(0, options.limit ?? 25);
      }
    }

    // Fallback: flat dump of the items table.
    //
    // NOTE: `limit` means "max passage LISTS" (its documented meaning) in the
    // join path above, and this path produces at most one synthetic list — so
    // it must not also apply `limit` as a SQL row cap, which silently
    // truncated the passages inside that single list. The row scan is bounded
    // by FALLBACK_ROW_SCAN instead, a safety ceiling rather than the caller's
    // list limit.
    let sql = `SELECT ${quoteIdent(referenceCol)} AS Ref FROM ${quoteIdent(itemsTable)}`;
    if (itemDeletedCol) sql += ` WHERE ${quoteIdent(itemDeletedCol)} = 0`;
    sql += " LIMIT ?";
    const rows = db.prepare(sql).all(FALLBACK_ROW_SCAN) as Array<{ Ref: string | null }>;
    const passages = rows.flatMap((r) => decodePassage(r.Ref));
    return passages.length > 0 ? [{ title: null, passages }] : [];
  } finally {
    db.close();
  }
}

// ─── Today's Reading ─────────────────────────────────────────────────────────

export interface TodaysReadingPlan {
  title: string;
  author: string;
  path: string;
  remainingItems: number;
  nextItems: string[];
}

export function getTodaysReading(options: { perPlanLimit?: number } = {}): TodaysReadingPlan[] {
  const db = openDb(getDbPaths().readingLists);
  try {
    const statuses = db.prepare(`
      SELECT Title, Author, Path FROM ReadingListStatuses
      WHERE IsDeleted = 0 AND Status = 1
    `).all() as Array<{ Title: string; Author: string; Path: string }>;
    if (statuses.length === 0) return [];

    const itemColumns = tableColumns(db, "Items");
    const labelCol = pickColumn(itemColumns, ["Title", "Reference", "StartReference", "Description"]);
    const orderCol = pickColumn(itemColumns, ["SortOrder", "Rank", "Position"]) ?? "rowid";

    const perPlan = options.perPlanLimit ?? 3;
    return statuses.map((status) => {
      const rows = db.prepare(`
        SELECT ItemId${labelCol ? `, ${quoteIdent(labelCol)} AS Label` : ""}
        FROM Items
        WHERE ReadingListPathNormalized = ? AND IsRead = 0
        ORDER BY ${orderCol === "rowid" ? "rowid" : quoteIdent(orderCol)} ASC
      `).all(status.Path) as Array<{ ItemId: string; Label?: string | null }>;

      return {
        title: status.Title,
        author: status.Author,
        path: status.Path,
        remainingItems: rows.length,
        nextItems: rows.slice(0, perPlan).map((r) => r.Label ?? r.ItemId),
      };
    }).filter((plan) => plan.remainingItems > 0);
  } finally {
    db.close();
  }
}

// ─── Highlight Summary ───────────────────────────────────────────────────────

export interface HighlightSummaryEntry {
  key: string;
  count: number;
  lastSyncDate: string | null;
}

export function getHighlightSummary(groupBy: "style" | "resource"): HighlightSummaryEntry[] {
  const db = openDb(getDbPaths().visualMarkup);
  try {
    const column = groupBy === "style" ? "MarkupStyleName" : "ResourceId";
    const rows = db.prepare(`
      SELECT ${column} AS Key, COUNT(*) AS Count, MAX(SyncDate) AS LastSyncDate
      FROM Markup WHERE IsDeleted = 0
      GROUP BY ${column}
      ORDER BY Count DESC, LastSyncDate DESC
    `).all() as Array<{ Key: string; Count: number; LastSyncDate: string | null }>;

    return rows.map((r) => ({ key: r.Key, count: r.Count, lastSyncDate: r.LastSyncDate }));
  } finally {
    db.close();
  }
}

// ─── Notebooks ───────────────────────────────────────────────────────────────

export interface NotebookInfo {
  externalId: string;
  title: string;
  noteCount: number;
}

export function listNotebooks(): NotebookInfo[] {
  const db = openDb(getDbPaths().notes);
  try {
    const rows = db.prepare(`
      SELECT nb.ExternalId, nb.Title,
             (SELECT COUNT(*) FROM Notes n
              WHERE n.NotebookExternalId = nb.ExternalId AND n.IsDeleted = 0 AND n.IsTrashed = 0) AS NoteCount
      FROM Notebooks nb
      WHERE nb.IsDeleted = 0
      ORDER BY nb.Title
    `).all() as Array<{ ExternalId: string; Title: string; NoteCount: number }>;

    return rows.map((r) => ({ externalId: r.ExternalId, title: r.Title, noteCount: r.NoteCount }));
  } finally {
    db.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParseArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
