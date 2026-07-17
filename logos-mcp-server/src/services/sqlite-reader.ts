import Database from "better-sqlite3";
import { existsSync } from "fs";
import { getDbPaths } from "../config.js";
import { anchorsMatchReference, describeBibleAnchors } from "../utils/bible-anchors.js";
import { stripRichText } from "../utils/strip-markup.js";
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
  reference?: string;
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
      sql += " AND nb.Title LIKE ?";
      params.push(`%${options.notebookTitle}%`);
    }

    sql += " ORDER BY n.ModifiedDate DESC";
    sql += " LIMIT ?";
    params.push(options.reference ? REFERENCE_SCAN_LIMIT : options.limit ?? REFERENCE_SCAN_LIMIT);

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

    return options.limit ? results.slice(0, options.limit) : results;
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
