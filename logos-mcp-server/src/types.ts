// Shared types for Logos MCP Server

// ─── Bible Reference Types ───────────────────────────────────────────────────

export interface ParsedReference {
  book: string;
  chapter: number;
  verse?: number;
  endChapter?: number;
  endVerse?: number;
}

export interface ReferenceFormats {
  logos: string;     // e.g., "Ge1.1"
  biblia: string;    // e.g., "Genesis1.1"
  human: string;     // e.g., "Genesis 1:1"
}

// ─── Biblia API Types ────────────────────────────────────────────────────────

export interface BibleTextResult {
  passage: string;
  text: string;
  bible: string;
}

export interface BibleSearchResult {
  query: string;
  resultCount: number;
  results: BibleSearchHit[];
}

export interface BibleSearchHit {
  title: string;
  preview: string;
}

export interface BibliaParseResult {
  passage: string;
  passages: string[];
}

// ─── Logos App Types ─────────────────────────────────────────────────────────

export interface LogosCommandResult {
  success: boolean;
  command: string;
  launcher?: string;
  /** Where the action landed: the installed desktop app or the Logos web app */
  target?: "desktop" | "web";
  /**
   * Whether the launcher's exit status actually confirms the launch.
   * false on Windows desktop launches: rundll32's FileProtocolHandler exits 0
   * even when the logos4:/logosres: protocol handler is broken, so "success"
   * only means the URL was handed to the OS.
   */
  verified?: boolean;
  /** Caveat about web-app deep-linking limits, when applicable */
  note?: string;
  error?: string;
}

// ─── SQLite / User Data Types ────────────────────────────────────────────────

export interface HighlightResult {
  resourceId: string;
  textRange: string;
  styleName: string;
  syncDate: string | null;
  /** Human-readable Bible references parsed from the highlight range, when available */
  references: string[];
}

export interface FavoriteResult {
  id: string;
  title: string;
  appCommand: string;
  resourceId: string | null;
  rank: number;
}

export interface FavoriteFolder {
  id: string;
  title: string;
  rank: number;
  parentId: string | null;
  children: (FavoriteResult | FavoriteFolder)[];
}

export interface WorkflowTemplate {
  templateId: number;
  externalId: string;
  title: string;
  author: string | null;
  templateJson: Record<string, unknown> | null;
  createdDate: string;
}

export interface WorkflowInstance {
  instanceId: number;
  externalId: string;
  templateId: string;
  key: string;
  title: string;
  currentStep: string | null;
  completedSteps: string[];
  skippedSteps: string[];
  createdDate: string;
  completedDate: string | null;
  modifiedDate: string | null;
}

export interface ReadingListItem {
  itemId: string;
  readingListPath: string;
  isRead: boolean;
  modifiedDate: string | null;
}

export interface ReadingListStatus {
  title: string;
  author: string;
  path: string;
  status: number;
  modifiedDate: string | null;
}

export interface ReadingProgress {
  statuses: ReadingListStatus[];
  items: ReadingListItem[];
  totalItems: number;
  completedItems: number;
  percentComplete: number;
}

// ─── Catalog Types ──────────────────────────────────────────────────────────

export interface CatalogResource {
  resourceId: string;
  title: string;
  abbreviatedTitle: string | null;
  type: string;
  authors: string | null;
  subjects: string | null;
  description: string | null;
  publicationDate: string | null;
}

export interface ResourceTypeSummary {
  label: string;
  count: number;
}

export interface ResourceMilestone {
  category: "Reference" | "Headword";
  type: string;       // e.g., "bible", "bible+esv", "page", "vnp", "dayofyear", "en"
  priority: number;
}

export interface ResourceReferenceInfo {
  resourceId: string;
  title: string;
  type: string;
  milestones: ResourceMilestone[];
  referenceSupersets: string | null;  // e.g., "bible.1.1.1-3.27.34"
}

// ─── Biblia Scan / Compare / Find Types ─────────────────────────────────────

export interface ScanResult {
  passage: string;
}

export interface CompareResult {
  equal: boolean;
  intersects: boolean;
  subset: boolean;
  superset: boolean;
  before: boolean;
  after: boolean;
}

export interface BibleInfo {
  bible: string;
  title: string;
  abbreviatedTitle: string;
  languages: string[];
  publishers: string[];
}

