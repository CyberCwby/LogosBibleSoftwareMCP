#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "url";
import { z } from "zod";
import { BIBLIA_API_KEY, SERVER_NAME, SERVER_VERSION } from "./config.js";

// Service imports
import { BibliaApiError, getBibleText, searchBible, scanReferences, comparePassages, getAvailableBibles } from "./services/biblia-api.js";
import { findCrossReferences, isCrossReferenceDataAvailable } from "./services/cross-references.js";
import { navigateToPassage, openWordStudy, openFactbook, openResource, openGuide, searchAll } from "./services/logos-app.js";
import {
  bookNumberFromName,
  canonicalizeReference,
  expandRange,
  parseReference,
  toBibleMilestone,
  toBibliaRef,
  toLogosUrlRef,
} from "./services/reference-parser.js";
import {
  getClippings,
  getFavorites,
  getHighlightSummary,
  getPassageLists,
  getReadingProgress,
  getTodaysReading,
  getUserHighlights,
  getUserNotes,
  getWorkflowInstances,
  getWorkflowTemplates,
  listNotebooks,
} from "./services/sqlite-reader.js";
import { searchCatalog, getResourceTypeSummary, typeLabel, getResourceReferenceInfo } from "./services/catalog-reader.js";
import { readResourceText } from "./services/ui-automation-reader.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true as const };
}

// Success message for UI tools, naming where the action landed (desktop app
// vs. Logos web app) plus any deep-linking caveat. `what` is the noun phrase
// for the thing launched (e.g. 'Romans 8', 'word study for "grace"') so the
// verb can reflect certainty: an unverified desktop launch (Windows rundll32
// exits 0 even for a broken protocol handler) is worded "Sent ... to Logos",
// never "Opened".
function launched(what: string, result: { target?: "desktop" | "web"; note?: string; verified?: boolean }) {
  const note = result.note ? ` ${result.note}` : "";
  if (result.target === "desktop" && result.verified === false) {
    return text(`Sent ${what} to Logos.${note}`);
  }
  const location = result.target === "web" ? "the Logos web app" : "Logos";
  return text(`Opened ${what} in ${location}.${note}`);
}

type ToolResponse = ReturnType<typeof text> | ReturnType<typeof err>;

function logToolFailure(toolName: string, error: unknown, args: Record<string, unknown> = {}) {
  const payload = {
    level: "error",
    tool: toolName,
    message: error instanceof Error ? error.message : String(error),
    // Only the argument NAMES are logged. Values can contain entire user
    // documents (scan_references) or private note-search queries, and this
    // line lands in whatever log store the MCP client keeps.
    argKeys: Object.keys(args),
  };
  console.error(JSON.stringify(payload));
}

function formatBibliaFailure(error: BibliaApiError): string {
  switch (error.code) {
    case "authentication_failed":
      return `${error.message} Biblia-backed tools require a valid BIBLIA_API_KEY.`;
    default:
      return error.message;
  }
}

function formatToolFailure(error: unknown): string {
  if (error instanceof BibliaApiError) {
    return formatBibliaFailure(error);
  }
  return error instanceof Error ? error.message : String(error);
}

// ─── Tool annotations ────────────────────────────────────────────────────────
// readOnlyHint: the tool observes state without changing it.
// openWorldHint: the tool talks to an external service (the Biblia API).

const READS_LOCAL_DATA: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const CALLS_BIBLIA_API: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const DRIVES_LOGOS_UI: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

interface ToolConfig {
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
}

// Every handler runs behind the same error boundary: failures are logged as
// structured JSON on stderr and returned as MCP tool errors instead of thrown.
function register<TArgs extends Record<string, unknown>>(
  server: McpServer,
  name: string,
  config: ToolConfig,
  handler: (args: TArgs) => Promise<ToolResponse>
) {
  server.registerTool(name, config, (async (args: TArgs) => {
    try {
      return await handler(args);
    } catch (error) {
      logToolFailure(name, error, args);
      return err(formatToolFailure(error));
    }
    // The SDK's callback typing is stricter than our closed text/err union.
  }) as never);
}

// ─── Shared input schemas ────────────────────────────────────────────────────

const bibleSchema = z.string().optional().describe("Bible version id (default: LEB; e.g. LEB, KJV, ASV, DARBY, YLT, WEB — see get_available_bibles)");

function limitSchema(description: string, max: number) {
  return z.number().int().min(1).max(max).optional().describe(description);
}

export function registerTools(server: McpServer) {

  // ── 1. navigate_passage ──────────────────────────────────────────────────
  register(server, "navigate_passage", {
    description: "Open a Bible passage in the Logos Bible Software UI",
    inputSchema: { reference: z.string().describe("Bible reference (e.g., 'Genesis 1:1', 'Romans 8:28-30')") },
    annotations: DRIVES_LOGOS_UI,
  }, async ({ reference }: { reference: string }) => {
    const result = await navigateToPassage(reference);
    return result.success
      ? launched(reference, result)
      : err(`Failed to open passage: ${result.error}`);
  });

  // ── 2. get_bible_text ────────────────────────────────────────────────────
  register(server, "get_bible_text", {
    description: "Retrieve the text of a Bible passage (LEB default). Pass multiple versions in `bibles` to compare translations side by side.",
    inputSchema: {
      passage: z.string().describe("Bible reference (e.g., 'Genesis 1:1-5', 'John 3:16')"),
      bible: bibleSchema,
      bibles: z.array(z.string()).min(2).max(5).optional().describe("Compare 2-5 versions side by side (e.g., [\"LEB\", \"KJV\"]). Overrides `bible`."),
    },
    annotations: CALLS_BIBLIA_API,
  }, async ({ passage, bible, bibles }: { passage: string; bible?: string; bibles?: string[] }) => {
    if (bibles && bibles.length > 0) {
      const results = await Promise.all(bibles.map((version) => getBibleText(passage, version)));
      const sections = results.map((r) => `## ${r.bible}\n\n${r.text}`);
      return text(`**${passage}** in ${results.length} versions:\n\n${sections.join("\n\n")}`);
    }
    const result = await getBibleText(passage, bible);
    return text(`**${result.passage}** (${result.bible})\n\n${result.text}`);
  });

  // ── 3. get_passage_context ───────────────────────────────────────────────
  register(server, "get_passage_context", {
    description: "Get a Bible passage with surrounding verses for context",
    inputSchema: {
      passage: z.string().describe("Bible reference to center on"),
      context_verses: limitSchema("Verses before/after to include (default: 5)", 50),
      bible: bibleSchema,
    },
    annotations: CALLS_BIBLIA_API,
  }, async ({ passage, context_verses, bible }: { passage: string; context_verses?: number; bible?: string }) => {
    // expandRange only widens verse-level references; say so for chapter-only
    // input rather than labeling the unchanged chapter "context around ...".
    const parsed = parseReference(passage);
    if (parsed.verse === undefined) {
      const result = await getBibleText(passage, bible);
      return text(
        `**${result.passage}** (${result.bible}) — ${passage} is a whole chapter; returned as-is (no verse context added)\n\n${result.text}`
      );
    }
    const expanded = expandRange(passage, context_verses ?? 5);
    const result = await getBibleText(expanded, bible);
    return text(`**${result.passage}** (${result.bible}) — context around ${passage}\n\n${result.text}`);
  });

  // ── 4. search_bible ──────────────────────────────────────────────────────
  register(server, "search_bible", {
    description: "Search the Bible for a word, phrase, or topic",
    inputSchema: {
      query: z.string().describe("Search terms (e.g., 'justification by faith')"),
      limit: limitSchema("Max results (default: 20)", 100),
      bible: bibleSchema,
    },
    annotations: CALLS_BIBLIA_API,
  }, async ({ query, limit, bible }: { query: string; limit?: number; bible?: string }) => {
    const result = await searchBible(query, { limit, bible });
    if (result.resultCount === 0) return text(`No results for "${query}".`);
    const lines = result.results.map((r) => `**${r.title}**: ${r.preview}`);
    const heading = result.resultCount > result.results.length
      ? `Found ${result.resultCount} results for "${query}" (showing first ${result.results.length})`
      : `Found ${result.resultCount} results for "${query}"`;
    return text(`${heading}:\n\n${lines.join("\n\n")}`);
  });

  // ── 5. get_cross_references ──────────────────────────────────────────────
  register(server, "get_cross_references", {
    description: "Find cross-references and parallel passages for a Bible verse. Uses the curated openbible.info cross-reference dataset when available (run `npm run fetch-xrefs` once to download it); otherwise falls back to keyword search via the Biblia API.",
    inputSchema: {
      passage: z.string().describe("Bible reference (e.g., 'Romans 8:28')"),
      key_terms: z.string().optional().describe("Search these terms via the Biblia API instead of using the curated dataset"),
      limit: limitSchema("Max cross-references to return (default: 15)", 50),
    },
    annotations: CALLS_BIBLIA_API,
  }, async ({ passage, key_terms, limit }: { passage: string; key_terms?: string; limit?: number }) => {
    // Preferred path: curated verse-to-verse links, offline and no API key needed.
    if (!key_terms && isCrossReferenceDataAvailable()) {
      const refs = findCrossReferences(passage, { limit: limit ?? 15 });
      if (refs.length === 0) return text(`No cross-references found for ${passage}.`);
      const lines = refs.map((r) => `- **${r.reference}**`);
      return text(
        `Cross-references for **${passage}** (curated, most relevant first):\n\n${lines.join("\n")}\n\n` +
        `Use get_bible_text to read any of these.`
      );
    }

    // Fallback: keyword search through the Biblia API.
    let searchQuery: string;
    if (key_terms) {
      searchQuery = key_terms;
    } else {
      const passageResult = await getBibleText(passage);
      const stopWords = new Set([
        "the","a","an","and","or","but","in","on","at","to","for","of","with",
        "by","from","is","are","was","were","be","been","have","has","had","do",
        "does","did","will","would","could","should","may","might","shall","that",
        "this","these","those","it","its","he","she","they","them","his","her",
        "their","not","no","nor","as","if","then","than","so","all","who","which",
        "what","when","where","how","i","me","my","we","us","you","your","him",
        "up","out","into","upon",
      ]);
      const words = passageResult.text
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !stopWords.has(w.toLowerCase()))
        .slice(0, 5);
      searchQuery = words.join(" ");
    }
    const results = await searchBible(searchQuery, { limit: limit ?? 15 });
    // Compare canonical forms so "Rom 8:28" excludes the result "Romans 8:28".
    const canonicalSource = (canonicalizeReference(passage) ?? passage).toLowerCase();
    const filtered = results.results.filter(
      (r) => (canonicalizeReference(r.title) ?? r.title).toLowerCase() !== canonicalSource
    );
    if (filtered.length === 0) return text(`No cross-references found for ${passage}.`);
    const lines = filtered.map((r) => `**${r.title}**: ${r.preview}`);
    const note = key_terms ? "" : "\n\n(Keyword-based results. Run `npm run fetch-xrefs` in logos-mcp-server/ to enable curated cross-references.)";
    return text(`Cross-references for **${passage}**:\n\n${lines.join("\n\n")}${note}`);
  });

  // ── 6. get_user_notes ────────────────────────────────────────────────────
  register(server, "get_user_notes", {
    description: "Read the user's study notes from Logos Bible Software",
    inputSchema: {
      notebook_title: z.string().optional().describe("Filter by notebook title (partial match)"),
      reference: z.string().optional().describe("Filter by Bible reference the note is anchored to (e.g., 'Romans 8' or 'Romans 8:28')"),
      query: z.string().optional().describe("Full-text search within note contents (case-insensitive)"),
      limit: limitSchema("Max notes to return (default: 20)", 200),
    },
    annotations: READS_LOCAL_DATA,
  }, async ({ notebook_title, reference, query, limit }: { notebook_title?: string; reference?: string; query?: string; limit?: number }) => {
    const notes = getUserNotes({ notebookTitle: notebook_title, reference, query, limit: limit ?? 20 });
    if (notes.length === 0) {
      const filters = [reference ? `anchored to ${reference}` : null, query ? `matching "${query}"` : null]
        .filter(Boolean).join(" and ");
      return text(filters ? `No notes found ${filters}.` : "No notes found.");
    }
    const lines = notes.map((n) => {
      const header = n.notebookTitle ? `[${n.notebookTitle}]` : "[No notebook]";
      const refs = n.references.length > 0 ? ` — ${n.references.join("; ")}` : "";
      const date = n.modifiedDate ?? n.createdDate;
      return `${header}${refs} (${date})\n${n.content}`;
    });
    return text(`Found ${notes.length} notes:\n\n${lines.join("\n\n---\n\n")}`);
  });

  // ── 7. get_user_highlights ───────────────────────────────────────────────
  register(server, "get_user_highlights", {
    description: "Read the user's highlights and visual markup from Logos. Set group_by for a summary of counts by style or resource instead of a flat list.",
    inputSchema: {
      resource_id: z.string().optional().describe("Filter by resource ID"),
      style_name: z.string().optional().describe("Filter by highlight style name"),
      reference: z.string().optional().describe("Filter by Bible reference the highlight covers (e.g., 'John 3' or 'John 3:16')"),
      group_by: z.enum(["style", "resource"]).optional().describe("Return a count summary grouped by highlight style or resource instead of individual highlights (other filters are ignored)"),
      limit: limitSchema("Max highlights to return (default: 50)", 200),
    },
    annotations: READS_LOCAL_DATA,
  }, async ({ resource_id, style_name, reference, group_by, limit }: { resource_id?: string; style_name?: string; reference?: string; group_by?: "style" | "resource"; limit?: number }) => {
    if (group_by) {
      const summary = getHighlightSummary(group_by);
      if (summary.length === 0) return text("No highlights found.");
      const total = summary.reduce((sum, s) => sum + s.count, 0);
      const lines = summary.map((s) => `- **${s.key}**: ${s.count}${s.lastSyncDate ? ` (last: ${s.lastSyncDate})` : ""}`);
      return text(`${total} highlights across ${summary.length} ${group_by === "style" ? "styles" : "resources"}:\n\n${lines.join("\n")}`);
    }
    const highlights = getUserHighlights({
      resourceId: resource_id,
      styleName: style_name,
      reference,
      limit: limit ?? 50,
    });
    if (highlights.length === 0) {
      return text(reference ? `No highlights found covering ${reference}.` : "No highlights found.");
    }
    const lines = highlights.map((h) => {
      const location = h.references.length > 0 ? h.references.join("; ") : h.textRange;
      return `- **${h.styleName}**: ${location} (${h.resourceId})`;
    });
    return text(`Found ${highlights.length} highlights:\n\n${lines.join("\n")}`);
  });

  // ── 8. get_favorites ─────────────────────────────────────────────────────
  register(server, "get_favorites", {
    description: "List the user's saved favorites/bookmarks in Logos",
    inputSchema: {
      limit: limitSchema("Max favorites to return (default: 30)", 200),
    },
    annotations: READS_LOCAL_DATA,
  }, async ({ limit }: { limit?: number }) => {
    const favorites = getFavorites(limit ?? 30);
    if (favorites.length === 0) return text("No favorites found.");
    const lines = favorites.map((f) => `- **${f.title}** → ${f.appCommand}`);
    return text(`Found ${favorites.length} favorites:\n\n${lines.join("\n")}`);
  });

  // ── 9. get_reading_progress ──────────────────────────────────────────────
  register(server, "get_reading_progress", {
    description: "Show the user's reading plan progress from Logos",
    inputSchema: {},
    annotations: READS_LOCAL_DATA,
  }, async () => {
    const progress = getReadingProgress();
    const sections: string[] = [];
    sections.push(`**Overall**: ${progress.completedItems}/${progress.totalItems} items (${progress.percentComplete}%)`);
    if (progress.statuses.length > 0) {
      const statusLines = progress.statuses.map((s) => {
        const label = s.status === 1 ? "Active" : s.status === 2 ? "Completed" : `Status ${s.status}`;
        return `- **${s.title}** by ${s.author} — ${label}`;
      });
      sections.push(`## Reading Plans\n\n${statusLines.join("\n")}`);
    }
    return text(sections.join("\n\n"));
  });

  // ── 10. open_word_study ──────────────────────────────────────────────────
  register(server, "open_word_study", {
    description: "Open a word study in Logos for a Greek, Hebrew, or English word",
    inputSchema: { word: z.string().describe("The word to study (e.g., 'agape', 'hesed', 'justification')") },
    annotations: DRIVES_LOGOS_UI,
  }, async ({ word }: { word: string }) => {
    const result = await openWordStudy(word);
    return result.success
      ? launched(`word study for "${word}"`, result)
      : err(`Failed to open word study: ${result.error}`);
  });

  // ── 11. open_factbook ────────────────────────────────────────────────────
  register(server, "open_factbook", {
    description: "Open the Logos Factbook for a person, place, event, or topic",
    inputSchema: { topic: z.string().describe("The topic to look up (e.g., 'Moses', 'Jerusalem', 'Passover')") },
    annotations: DRIVES_LOGOS_UI,
  }, async ({ topic }: { topic: string }) => {
    const result = await openFactbook(topic);
    return result.success
      ? launched(`Factbook entry for "${topic}"`, result)
      : err(`Failed to open Factbook: ${result.error}`);
  });

  // ── 12. get_study_workflows ──────────────────────────────────────────────
  register(server, "get_study_workflows", {
    description: "List available study workflow templates and active instances from Logos",
    inputSchema: {
      include_instances: z.boolean().optional().describe("Also show active workflow instances (default: true)"),
      instance_limit: limitSchema("Max active instances to return (default: 10)", 100),
    },
    annotations: READS_LOCAL_DATA,
  }, async ({ include_instances, instance_limit }: { include_instances?: boolean; instance_limit?: number }) => {
    const templates = getWorkflowTemplates();
    const sections: string[] = [];
    if (templates.length > 0) {
      const tLines = templates.map((t) => `- **${t.title}** (${t.externalId})`);
      sections.push(`## Workflow Templates\n\n${tLines.join("\n")}`);
    } else {
      sections.push("No workflow templates found.");
    }
    if (include_instances !== false) {
      const instances = getWorkflowInstances(instance_limit ?? 10);
      if (instances.length > 0) {
        const iLines = instances.map((i) => {
          const status = i.completedDate ? "Completed" : `Step: ${i.currentStep ?? "unknown"}`;
          return `- **${i.title}** (${i.key}) — ${status}, ${i.completedSteps.length} steps done`;
        });
        sections.push(`## Active Instances\n\n${iLines.join("\n")}`);
      }
    }
    return text(sections.join("\n\n"));
  });

  // ── 13. get_library_catalog ─────────────────────────────────────────────
  register(server, "get_library_catalog", {
    description: "Search the user's Logos library catalog for owned resources by type, author, or keyword. At least one of query, type, or author is required.",
    inputSchema: {
      type: z.string().optional().describe("Filter by resource type (e.g., 'commentary', 'lexicon', 'theology', 'dictionary'). Provide at least one of type, query, or author."),
      query: z.string().optional().describe("Search titles, descriptions, and subjects. Provide at least one of query, type, or author."),
      author: z.string().optional().describe("Filter by author name. Provide at least one of author, query, or type."),
      limit: limitSchema("Max results to return (default: 25)", 200),
    },
    annotations: READS_LOCAL_DATA,
  }, async ({ type, query, author, limit }: { type?: string; query?: string; author?: string; limit?: number }) => {
    const normalizedType = type?.trim() || undefined;
    const normalizedQuery = query?.trim() || undefined;
    const normalizedAuthor = author?.trim() || undefined;

    if (!normalizedType && !normalizedQuery && !normalizedAuthor) {
      return err("get_library_catalog requires at least one non-empty filter: query, type, or author.");
    }

    const resources = searchCatalog({
      type: normalizedType,
      query: normalizedQuery,
      author: normalizedAuthor,
      limit: limit ?? 25,
    });
    if (resources.length === 0) {
      const activeFilters = [
        normalizedQuery ? `query="${normalizedQuery}"` : null,
        normalizedType ? `type="${normalizedType}"` : null,
        normalizedAuthor ? `author="${normalizedAuthor}"` : null,
      ].filter(Boolean).join(", ");
      return text(
        `No matching resources found in library catalog for ${activeFilters}. Try broader keywords, a shorter author filter, or a resource type like commentary or lexicon.`
      );
    }
    const lines = resources.map((r) => {
      const authorStr = r.authors ? ` — ${r.authors}` : "";
      const label = typeLabel(r.type);
      return `- **${r.title}**${authorStr}\n  ID: \`${r.resourceId}\` | Type: ${label}`;
    });
    return text(`Found ${resources.length} resources:\n\n${lines.join("\n\n")}`);
  });

  // ── 14. open_resource ─────────────────────────────────────────────────────
  register(server, "open_resource", {
    description: "Open a specific resource (commentary, lexicon, etc.) in Logos, optionally at a reference. Accepts a normal Bible reference ('Jeremiah 1:1') or a Logos milestone ('bible.24.1.1', 'page.271', 'vnp.144.575.253'). Use get_resource_references to discover which milestone types a resource supports.",
    inputSchema: {
      resource_id: z.string().describe("Resource ID from the library catalog (e.g., 'LLS:CLVNCOMM')"),
      reference: z.string().optional().describe("Bible reference (e.g., 'Jeremiah 1:1') or Logos milestone (e.g., 'bible.24.1.1', 'page.271')"),
    },
    annotations: DRIVES_LOGOS_UI,
  }, async ({ resource_id, reference }: { resource_id: string; reference?: string }) => {
    // Human-readable Bible references are converted to bible milestones;
    // milestone-format input ("page.271", "bible.24.1.1") passes through as-is.
    let milestone = reference;
    if (reference && !/^[a-z][a-z0-9+]*\.\d/i.test(reference.trim())) {
      try {
        milestone = toBibleMilestone(reference);
      } catch {
        // Not parseable as a Bible reference either — let Logos try the raw value.
      }
    }
    const result = await openResource(resource_id, milestone);
    const refStr = reference ? ` at ${milestone}` : "";
    return result.success
      ? launched(`resource \`${resource_id}\`${refStr}`, result)
      : err(`Failed to open resource: ${result.error}`);
  });

  // ── 15. open_guide ────────────────────────────────────────────────────────
  register(server, "open_guide", {
    description: "Open an Exegetical Guide, Passage Guide, or other guide type in Logos for a Bible passage",
    inputSchema: {
      guide_type: z.string().describe("Guide template name (e.g., 'Exegetical Guide', 'Passage Guide')"),
      reference: z.string().describe("Bible reference (e.g., 'Romans 12:1', 'John 3:16')"),
    },
    annotations: DRIVES_LOGOS_UI,
  }, async ({ guide_type, reference }: { guide_type: string; reference: string }) => {
    const result = await openGuide(guide_type, reference);
    return result.success
      ? launched(`${guide_type} for ${reference}`, result)
      : err(`Failed to open guide: ${result.error}`);
  });

  // ── 16. search_all ────────────────────────────────────────────────────────
  register(server, "search_all", {
    description: "Search across ALL resources in the Logos library (not just Bible text)",
    inputSchema: {
      query: z.string().describe("Search query (e.g., 'justification by faith', 'baptism')"),
    },
    annotations: DRIVES_LOGOS_UI,
  }, async ({ query }: { query: string }) => {
    const result = await searchAll(query);
    return result.success
      ? launched(`search for "${query}" across all resources`, result)
      : err(`Failed to open search via ${result.launcher ?? "the platform launcher"}: ${result.error}`);
  });

  // ── 17. scan_references ───────────────────────────────────────────────────
  register(server, "scan_references", {
    description: "Find Bible references in arbitrary text (e.g., extract all references from a paragraph)",
    inputSchema: {
      text: z.string().describe("Text to scan for Bible references"),
      tag_chapters: z.boolean().optional().describe("Tag chapter-level references too (default: true)"),
    },
    annotations: CALLS_BIBLIA_API,
  }, async ({ text: inputText, tag_chapters }: { text: string; tag_chapters?: boolean }) => {
    const results = await scanReferences(inputText, tag_chapters ?? true);
    if (results.length === 0) return text("No Bible references found in the text.");
    const lines = results.map((r) => `- **${r.passage}**`);
    return text(`Found ${results.length} Bible references:\n\n${lines.join("\n")}`);
  });

  // ── 18. compare_passages ──────────────────────────────────────────────────
  register(server, "compare_passages", {
    description: "Compare two Bible references for overlap, subset, ordering",
    inputSchema: {
      first: z.string().describe("First Bible reference (e.g., 'Romans 8:28-30')"),
      second: z.string().describe("Second Bible reference (e.g., 'Romans 8:29')"),
    },
    annotations: CALLS_BIBLIA_API,
  }, async ({ first, second }: { first: string; second: string }) => {
    const result = await comparePassages(first, second);
    const relations: string[] = [];
    if (result.equal) relations.push("equal");
    if (result.intersects) relations.push("intersects");
    if (result.subset) relations.push("first is subset of second");
    if (result.superset) relations.push("first is superset of second");
    if (result.before) relations.push("first comes before second");
    if (result.after) relations.push("first comes after second");
    return text(`**${first}** vs **${second}**:\n${relations.join(", ") || "no relationship detected"}`);
  });

  // ── 19. get_available_bibles ──────────────────────────────────────────────
  register(server, "get_available_bibles", {
    description: "List all Bible versions available for text retrieval via the Biblia API",
    inputSchema: {
      query: z.string().optional().describe("Optional search query to filter Bible versions"),
    },
    annotations: CALLS_BIBLIA_API,
  }, async ({ query }: { query?: string }) => {
    const bibles = await getAvailableBibles(query);
    if (bibles.length === 0) return text("No Bible versions found.");
    const lines = bibles.map((b) => {
      const langs = b.languages?.length ? ` [${b.languages.join(", ")}]` : "";
      return `- **${b.title}** (\`${b.bible}\`)${langs}`;
    });
    return text(`Found ${bibles.length} Bible versions:\n\n${lines.join("\n")}`);
  });

  // ── 20. get_resource_types ────────────────────────────────────────────────
  register(server, "get_resource_types", {
    description: "Get a summary of resource types and counts in the user's Logos library",
    inputSchema: {},
    annotations: READS_LOCAL_DATA,
  }, async () => {
    const summary = getResourceTypeSummary();
    if (summary.length === 0) return text("No resources found in library catalog.");
    const total = summary.reduce((sum, s) => sum + s.count, 0);
    const lines = summary.map((s) => `- **${s.label}**: ${s.count}`);
    return text(`Library contains ${total} resources across ${summary.length} types:\n\n${lines.join("\n")}`);
  });

  // ── 21. get_resource_references ──────────────────────────────────────────────
  register(server, "get_resource_references", {
    description: "Get the available reference/navigation types for a Logos resource. Returns the milestone indexes (e.g., bible, page, vnp) that the resource supports, so you know how to format references when opening it with open_resource.",
    inputSchema: {
      resource_id: z.string().describe("Resource ID (e.g., 'LLS:NICOT24GOLDINGAY')"),
    },
    annotations: READS_LOCAL_DATA,
  }, async ({ resource_id }: { resource_id: string }) => {
    const info = getResourceReferenceInfo(resource_id);
    if (!info) return err(`Resource not found: ${resource_id}`);

    const sections: string[] = [];
    sections.push(`**${info.title}** (\`${info.resourceId}\`)\nType: ${typeLabel(info.type)}`);

    if (info.milestones.length > 0) {
      const refMilestones = info.milestones.filter((m) => m.category === "Reference");
      const headwordMilestones = info.milestones.filter((m) => m.category === "Headword");

      if (refMilestones.length > 0) {
        sections.push("## Reference Types\n" + refMilestones.map((m) => {
          let desc = `- **${m.type}** (priority: ${m.priority})`;
          if (m.type.startsWith("bible")) desc += " — Bible verse references (e.g., bible.24.1.1 for Jeremiah 1:1)";
          else if (m.type === "page") desc += " — Page numbers (e.g., page.271)";
          else if (m.type === "vnp") desc += " — Volume/Number/Page (e.g., vnp.31.4.410)";
          else if (m.type === "vp") desc += " — Volume/Page (e.g., vp.26.384)";
          else if (m.type === "dayofyear") desc += " — Day of year (e.g., dayofyear.3.15.1 for March 15)";
          else if (m.type === "biblio") desc += " — Bibliographic references";
          else if (m.type.startsWith("au+")) desc += ` — Author-work references (e.g., ${m.type}.XXXX.XXX.X)`;
          return desc;
        }).join("\n"));
      }

      if (headwordMilestones.length > 0) {
        sections.push("## Headword Indexes\n" + headwordMilestones.map(
          (m) => `- **${m.type}** (priority: ${m.priority})`
        ).join("\n"));
      }
    } else {
      sections.push("This resource has no indexed reference types.");
    }

    if (info.referenceSupersets) {
      sections.push(`## Coverage\n\`${info.referenceSupersets}\``);
    }

    sections.push("## Usage\nUse the reference type as a prefix when calling open_resource, e.g.:\n" +
      "`open_resource(resource_id, 'page.271')` or `open_resource(resource_id, 'bible.24.1.1')`");

    return text(sections.join("\n\n"));
  });

  // ── 22. get_resource_text ────────────────────────────────────────────────
  register(server, "get_resource_text", {
    description: "[EXPERIMENTAL] Read the visible text from a resource panel open in Logos Bible Software (Windows only). " +
      "This is a makeshift workaround: Logos resource files are encrypted and there is no official API for reading resource content, so this tool uses the Windows UI Automation accessibility API to scrape whatever text is currently rendered on screen. " +
      "Limitations: Windows only, captures only visible/rendered text (~2000 chars per page), scrolling brings Logos to the foreground and sends keystrokes, no text structure or formatting is preserved. " +
      "Usage: first call open_resource to navigate to the desired section, then call this tool to read the text (it waits briefly for the panel to render). " +
      "Set max_pages > 1 to scroll through additional pages; overlapping content between pages is merged automatically.",
    inputSchema: {
      tab_name: z.string().optional().describe("Partial tab/resource name to match (e.g., 'Guide for the Perplexed'). If omitted, reads the first available document panel."),
      max_pages: limitSchema("Number of pages to read (default: 1 = visible text only, max: 50). Values > 1 will bring Logos to the foreground and scroll through the document.", 50),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ tab_name, max_pages }: { tab_name?: string; max_pages?: number }) => {
    const result = await readResourceText(tab_name, max_pages);
    const header = `**${result.tabName}** (${result.charCount} chars, ${result.pageCount} page${result.pageCount === 1 ? "" : "s"})`;
    return text(`${header}\n\n${result.text}`);
  });

  // ── 23. normalize_reference ──────────────────────────────────────────────
  register(server, "normalize_reference", {
    description: "Validate and normalize a Bible reference, returning it in every format the other tools accept: canonical human-readable, Logos URL form, Biblia form, and Logos bible milestone.",
    inputSchema: {
      reference: z.string().describe("Bible reference in any common form (e.g., '1 Cor 13:4-7', 'Jn 3:16', 'Song of Songs 2')"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  }, async ({ reference }: { reference: string }) => {
    const parsed = parseReference(reference);
    const canonical = canonicalizeReference(reference)!;
    const lines = [
      `**${canonical}**`,
      "",
      `- Canonical: \`${canonical}\``,
      `- Logos URL form: \`${toLogosUrlRef(reference)}\` (used by navigate_passage)`,
      `- Biblia form: \`${toBibliaRef(reference)}\``,
      `- Bible milestone: \`${toBibleMilestone(reference)}\` (used by open_resource)`,
      `- Book: ${parsed.book} (book ${bookNumberFromName(parsed.book)}), chapter ${parsed.chapter}` +
        (parsed.verse !== undefined ? `, verse ${parsed.verse}` : ""),
    ];
    return text(lines.join("\n"));
  });

  // ── 24. get_clippings ────────────────────────────────────────────────────
  register(server, "get_clippings", {
    description: "Read the user's saved clippings (excerpts collected from resources) from Logos",
    inputSchema: {
      limit: limitSchema("Max clippings to return (default: 25)", 200),
    },
    annotations: READS_LOCAL_DATA,
  }, async ({ limit }: { limit?: number }) => {
    const clippings = getClippings({ limit: limit ?? 25 });
    if (clippings.length === 0) return text("No clippings found.");
    const lines = clippings.map((c) => {
      const title = c.title ? `**${c.title}**` : "**(untitled clipping)**";
      const refs = c.references.length > 0 ? ` — ${c.references.join("; ")}` : "";
      const source = c.resourceId ? ` [${c.resourceId}]` : "";
      const date = c.modifiedDate ?? c.createdDate;
      const body = c.content ?? "(no text)";
      return `${title}${refs}${source}${date ? ` (${date})` : ""}\n${body}`;
    });
    return text(`Found ${clippings.length} clippings:\n\n${lines.join("\n\n---\n\n")}`);
  });

  // ── 25. get_passage_lists ────────────────────────────────────────────────
  register(server, "get_passage_lists", {
    description: "Read the user's passage lists (curated collections of Bible references) from Logos",
    inputSchema: {
      limit: limitSchema("Max passage lists to return (default: 25)", 200),
    },
    annotations: READS_LOCAL_DATA,
  }, async ({ limit }: { limit?: number }) => {
    const lists = getPassageLists({ limit: limit ?? 25 });
    if (lists.length === 0) return text("No passage lists found.");
    const sections = lists.map((l) => {
      const title = l.title ?? "(untitled list)";
      const passages = l.passages.length > 0
        ? l.passages.map((p) => `- ${p}`).join("\n")
        : "(empty)";
      return `## ${title}\n\n${passages}`;
    });
    return text(sections.join("\n\n"));
  });

  // ── 26. get_todays_reading ───────────────────────────────────────────────
  register(server, "get_todays_reading", {
    description: "Show the next unread items in each active Logos reading plan — 'what should I read today?'",
    inputSchema: {
      per_plan_limit: limitSchema("Next unread items to show per plan (default: 3)", 20),
    },
    annotations: READS_LOCAL_DATA,
  }, async ({ per_plan_limit }: { per_plan_limit?: number }) => {
    const plans = getTodaysReading({ perPlanLimit: per_plan_limit ?? 3 });
    if (plans.length === 0) return text("No active reading plans with unread items found.");
    const sections = plans.map((plan) => {
      const items = plan.nextItems.map((item) => `- ${item}`).join("\n");
      return `## ${plan.title}${plan.author ? ` (${plan.author})` : ""}\n${plan.remainingItems} items remaining. Up next:\n${items}`;
    });
    return text(sections.join("\n\n"));
  });
}

// ─── Prompts ─────────────────────────────────────────────────────────────────
// Guided study workflows exposed via MCP prompts so any client (LM Studio,
// Cursor, Claude Desktop, ...) can run them — not just the Claude Code agent.

function promptMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer) {
  server.registerPrompt("socratic-study", {
    description: "Guided Socratic Bible study of a passage: observation, interpretation, correlation, application",
    argsSchema: { passage: z.string().describe("The passage to study (e.g., 'Romans 8:28-30')") },
  }, ({ passage }) => promptMessage(
    `Guide me through a Socratic study of ${passage}. ` +
    `Use the Logos tools to ground the discussion: retrieve the text with get_bible_text, ` +
    `pull cross-references with get_cross_references, and check my own notes and highlights ` +
    `for this passage with get_user_notes and get_user_highlights.\n\n` +
    `Lead with questions rather than lectures, one layer at a time:\n` +
    `1. Observation — what does the text say? (words, structure, repetition, context)\n` +
    `2. Interpretation — what does the text mean? (authorial intent, original audience)\n` +
    `3. Correlation — how does this relate to the rest of Scripture? (use cross-references)\n` +
    `4. Application — what does this mean for us today?\n\n` +
    `Stay tradition-neutral: where Christians disagree, present the major views fairly. ` +
    `Ask one question at a time and wait for my answer before moving on.`
  ));

  server.registerPrompt("word-study", {
    description: "Structured word study using Logos tools: usage survey, semantic range, key passages",
    argsSchema: { word: z.string().describe("The word to study (e.g., 'agape', 'hesed', 'justification')") },
  }, ({ word }) => promptMessage(
    `Help me do a word study on "${word}". ` +
    `Open the Logos word study panel with open_word_study, survey usage with search_bible, ` +
    `and read key passages with get_bible_text (compare translations with the bibles parameter ` +
    `where renderings differ).\n\n` +
    `Cover: (1) the original-language term(s) behind the English word and their semantic range, ` +
    `(2) representative passages across different authors and genres, ` +
    `(3) how context shifts the meaning, and (4) common word-study fallacies to avoid ` +
    `(root fallacy, illegitimate totality transfer). Summarize with the passages that best ` +
    `illustrate each distinct sense.`
  ));

  server.registerPrompt("passage-overview", {
    description: "Quick orientation to a passage: text, context, cross-references, and your own study data",
    argsSchema: { passage: z.string().describe("The passage to survey (e.g., 'Psalm 23')") },
  }, ({ passage }) => promptMessage(
    `Give me an overview of ${passage}. ` +
    `Retrieve the text with get_bible_text and the surrounding context with get_passage_context. ` +
    `List the strongest cross-references via get_cross_references. ` +
    `Check whether I have notes or highlights on it with get_user_notes and get_user_highlights, ` +
    `and mention relevant commentaries I own via get_library_catalog.\n\n` +
    `Structure the overview as: literary context, structure of the passage, key observations, ` +
    `main interpretive questions, and suggested next steps for deeper study in Logos.`
  ));
}

// ─── Resources ───────────────────────────────────────────────────────────────
// Notebooks are exposed as browsable MCP resources so a client can pull an
// entire notebook into context deliberately instead of via repeated tool calls.

export function registerResources(server: McpServer) {
  server.registerResource(
    "notebooks",
    new ResourceTemplate("logos://notebooks/{notebookId}", {
      list: async () => {
        try {
          return {
            resources: listNotebooks().map((nb) => ({
              uri: `logos://notebooks/${encodeURIComponent(nb.externalId)}`,
              name: nb.title,
              description: `${nb.noteCount} note${nb.noteCount === 1 ? "" : "s"}`,
              mimeType: "text/markdown",
            })),
          };
        } catch {
          // No Logos data on this machine — expose an empty list rather than failing.
          return { resources: [] };
        }
      },
    }),
    {
      title: "Logos Notebooks",
      description: "The user's Logos notebooks; each resource contains every note in the notebook as markdown",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      // Same error boundary the tools get: a read on a machine without Logos
      // data (or with a stale cached URI) must produce readable guidance, not
      // a raw JSON-RPC internal error leaking a filesystem path.
      try {
        const notebookId = decodeURIComponent(String(variables.notebookId));
        const notes = getUserNotes({ notebookExternalId: notebookId, limit: 500 });
        const notebook = listNotebooks().find((nb) => nb.externalId === notebookId);
        const title = notebook?.title ?? notebookId;

        const body = notes.length === 0
          ? "_No notes in this notebook._"
          : notes.map((n) => {
              const refs = n.references.length > 0 ? ` — ${n.references.join("; ")}` : "";
              const date = n.modifiedDate ?? n.createdDate;
              return `## Note${refs} (${date})\n\n${n.content}`;
            }).join("\n\n");

        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/markdown",
            text: `# ${title}\n\n${body}`,
          }],
        };
      } catch (error) {
        logToolFailure("resource:notebooks", error);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/markdown",
            text: `# Notebook unavailable\n\nCould not read this notebook: ${formatToolFailure(error)}\n\n` +
              "Verify that Logos Bible Software is installed on this machine and that " +
              "LOGOS_DATA_DIR points at its data directory if it lives in a non-default location.",
          }],
        };
      }
    }
  );
}

export function createServer(): McpServer {
  if (!BIBLIA_API_KEY) {
    console.warn(
      "Biblia-backed tools are disabled until BIBLIA_API_KEY is configured. Local Logos tools will still work."
    );
  }
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server);
  registerPrompts(server);
  registerResources(server);
  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
