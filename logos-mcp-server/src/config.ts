import { existsSync, readdirSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

// ─── Logos Data Paths ────────────────────────────────────────────────────────

function getLogosBaseDir(subdir: "Documents" | "Data"): string {
  let base: string;
  if (platform() === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    base = join(localAppData, "Logos", subdir);
  } else {
    base = join(homedir(), "Library", "Application Support", "Logos4", subdir);
  }

  return base;
}

/**
 * Resolve the platform-specific Logos base directory for Documents or Data,
 * then auto-discover the user-specific hash folder inside it.
 *
 *   macOS:   ~/Library/Application Support/Logos4/{subdir}/{hash}
 *   Windows: %LOCALAPPDATA%\Logos\{subdir}\{hash}
 */
function resolveLogosDir(
  subdir: "Documents" | "Data",
  validationPath: string,
  envVarName: "LOGOS_DATA_DIR" | "LOGOS_CATALOG_DIR"
): string {
  const base = getLogosBaseDir(subdir);

  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch {
    throw new Error(
      `Logos data folder not found at ${base}. ` +
      `Is Logos Bible Software installed on this machine? ` +
      `If it lives elsewhere, set ${envVarName} to the correct path.`
    );
  }

  if (entries.length === 0) {
    throw new Error(
      `No Logos user folders found in ${base}. Set ${envVarName} to the correct path.`
    );
  }

  if (entries.length === 1) {
    return join(base, entries[0].name);
  }

  const matches = entries.filter((entry) =>
    existsSync(join(base, entry.name, validationPath))
  );

  if (matches.length === 1) {
    return join(base, matches[0].name);
  }

  throw new Error(
    `Could not uniquely determine the Logos ${subdir} folder in ${base}. ` +
    `Set ${envVarName} to the correct path.`
  );
}

// Path resolution is lazy so the server can start (and Biblia-backed tools can
// run) on machines without Logos desktop data. Resolution errors surface
// per-tool when a database is first accessed.

let cachedDataDir: string | undefined;
let cachedCatalogDir: string | undefined;

export function getLogosDataDir(): string {
  if (cachedDataDir === undefined) {
    cachedDataDir =
      process.env.LOGOS_DATA_DIR ??
      resolveLogosDir("Documents", join("VisualMarkup", "visualmarkup.db"), "LOGOS_DATA_DIR");
  }
  return cachedDataDir;
}

// Catalog DB lives under Data/ (not Documents/)
export function getLogosCatalogDir(): string {
  if (cachedCatalogDir === undefined) {
    cachedCatalogDir =
      process.env.LOGOS_CATALOG_DIR ??
      resolveLogosDir("Data", join("LibraryCatalog", "catalog.db"), "LOGOS_CATALOG_DIR");
  }
  return cachedCatalogDir;
}

export interface DbPaths {
  visualMarkup: string;
  favorites: string;
  workflows: string;
  readingLists: string;
  shortcuts: string;
  guides: string;
  notes: string;
  clippings: string;
  passageLists: string;
}

// Documents-based databases and the catalog database resolve independently so
// a missing catalog folder does not break notes/highlights tools (and vice versa).

export function getDbPaths(): DbPaths {
  const dataDir = getLogosDataDir();
  return {
    visualMarkup: join(dataDir, "VisualMarkup", "visualmarkup.db"),
    favorites: join(dataDir, "FavoritesManager", "favorites.db"),
    workflows: join(dataDir, "Workflows", "Workflows.db"),
    readingLists: join(dataDir, "ReadingLists", "ReadingLists.db"),
    shortcuts: join(dataDir, "ShortcutsManager", "shortcuts.db"),
    guides: join(dataDir, "Guides", "guides.db"),
    notes: join(dataDir, "NotesToolManager", "notestool.db"),
    clippings: join(dataDir, "Documents", "Clippings", "Clippings.db"),
    passageLists: join(dataDir, "Documents", "PassageList", "PassageList.db"),
  };
}

export function getCatalogDbPath(): string {
  return join(getLogosCatalogDir(), "LibraryCatalog", "catalog.db");
}

// ─── Biblia API ──────────────────────────────────────────────────────────────

export const BIBLIA_API_KEY = process.env.BIBLIA_API_KEY ?? "";
export const BIBLIA_API_BASE = "https://api.biblia.com/v1/bible";
export const DEFAULT_BIBLE = "LEB";

// ─── Server Info ─────────────────────────────────────────────────────────────

export const SERVER_NAME = "logos-bible";
export const SERVER_VERSION = "1.1.0";
