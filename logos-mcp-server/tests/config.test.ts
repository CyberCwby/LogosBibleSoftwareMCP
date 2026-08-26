import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";

const readdirSyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const homedirMock = vi.hoisted(() => vi.fn());
const platformMock = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
}));

vi.mock("os", () => ({
  homedir: homedirMock,
  platform: platformMock,
}));

function dirEntry(name: string) {
  return {
    isDirectory: () => true,
    name,
  };
}

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    readdirSyncMock.mockReset();
    existsSyncMock.mockReset();
    homedirMock.mockReset();
    platformMock.mockReset();
    homedirMock.mockReturnValue("/Users/tester");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a Windows Documents and Data folder from LOCALAPPDATA", async () => {
    platformMock.mockReturnValue("win32");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\tester\\AppData\\Local");
    readdirSyncMock
      .mockReturnValueOnce([dirEntry("abc123")])
      .mockReturnValueOnce([dirEntry("xyz789")]);

    const config = await import("../src/config.js");

    expect(config.getLogosDataDir()).toBe(
      join("C:\\Users\\tester\\AppData\\Local", "Logos", "Documents", "abc123")
    );
    expect(config.getLogosCatalogDir()).toBe(
      join("C:\\Users\\tester\\AppData\\Local", "Logos", "Data", "xyz789")
    );
  });

  it("resolves a macOS folder from the home directory", async () => {
    platformMock.mockReturnValue("darwin");
    homedirMock.mockReturnValue("/Users/tester");
    readdirSyncMock
      .mockReturnValueOnce([dirEntry("docs-hash")])
      .mockReturnValueOnce([dirEntry("data-hash")]);

    const config = await import("../src/config.js");

    expect(config.getLogosDataDir()).toBe(
      join("/Users/tester", "Library", "Application Support", "Logos4", "Documents", "docs-hash")
    );
    expect(config.getLogosCatalogDir()).toBe(
      join("/Users/tester", "Library", "Application Support", "Logos4", "Data", "data-hash")
    );
  });

  it("uses explicit env var overrides instead of auto-discovery", async () => {
    platformMock.mockReturnValue("win32");
    vi.stubEnv("LOGOS_DATA_DIR", "C:\\custom\\documents\\hash");
    vi.stubEnv("LOGOS_CATALOG_DIR", "C:\\custom\\data\\hash");

    const config = await import("../src/config.js");

    expect(config.getLogosDataDir()).toBe("C:\\custom\\documents\\hash");
    expect(config.getLogosCatalogDir()).toBe("C:\\custom\\data\\hash");
    expect(readdirSyncMock).not.toHaveBeenCalled();
  });

  it("imports without error even when Logos is not installed", async () => {
    platformMock.mockReturnValue("darwin");
    readdirSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });

    const config = await import("../src/config.js");

    expect(config.SERVER_NAME).toBe("logos-bible");
    expect(readdirSyncMock).not.toHaveBeenCalled();
    expect(() => config.getLogosDataDir()).toThrow(/Is Logos Bible Software installed.*LOGOS_DATA_DIR/s);
    expect(() => config.getCatalogDbPath()).toThrow(/LOGOS_CATALOG_DIR/);
  });

  it("memoizes resolved directories across calls", async () => {
    platformMock.mockReturnValue("darwin");
    readdirSyncMock.mockReturnValue([dirEntry("only-hash")]);

    const config = await import("../src/config.js");

    config.getLogosDataDir();
    config.getLogosDataDir();

    expect(readdirSyncMock).toHaveBeenCalledTimes(1);
  });

  it("builds all Documents database paths from the resolved data dir", async () => {
    platformMock.mockReturnValue("darwin");
    readdirSyncMock.mockReturnValue([dirEntry("only-hash")]);

    const config = await import("../src/config.js");
    const paths = config.getDbPaths();
    const base = join("/Users/tester", "Library", "Application Support", "Logos4", "Documents", "only-hash");

    expect(paths.notes).toBe(join(base, "NotesToolManager", "notestool.db"));
    expect(paths.visualMarkup).toBe(join(base, "VisualMarkup", "visualmarkup.db"));
  });

  it("resolves LOGOS_MODE with a safe default for invalid values", async () => {
    platformMock.mockReturnValue("darwin");

    vi.stubEnv("LOGOS_MODE", "web");
    expect((await import("../src/config.js")).LOGOS_MODE).toBe("web");

    vi.resetModules();
    vi.stubEnv("LOGOS_MODE", "DESKTOP");
    expect((await import("../src/config.js")).LOGOS_MODE).toBe("desktop");

    vi.resetModules();
    vi.stubEnv("LOGOS_MODE", "bogus");
    expect((await import("../src/config.js")).LOGOS_MODE).toBe("auto");

    vi.resetModules();
    vi.stubEnv("LOGOS_MODE", "");
    expect((await import("../src/config.js")).LOGOS_MODE).toBe("auto");
  });

  it("throws a clear error when no Logos user folder exists", async () => {
    platformMock.mockReturnValue("win32");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\tester\\AppData\\Local");
    readdirSyncMock.mockReturnValue([]);

    const config = await import("../src/config.js");

    expect(() => config.getLogosDataDir()).toThrow(/No Logos user folders found/);
  });

  it("selects the uniquely matching Documents folder when multiple hashes exist", async () => {
    platformMock.mockReturnValue("win32");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\tester\\AppData\\Local");
    readdirSyncMock
      .mockReturnValueOnce([dirEntry("old-hash"), dirEntry("active-hash")])
      .mockReturnValueOnce([dirEntry("catalog-hash")]);
    existsSyncMock.mockImplementation((path: string) =>
      path.includes(join("active-hash", "VisualMarkup", "visualmarkup.db"))
    );

    const config = await import("../src/config.js");

    expect(config.getLogosDataDir()).toBe(
      join("C:\\Users\\tester\\AppData\\Local", "Logos", "Documents", "active-hash")
    );
  });

  it("throws when multiple matching user folders make auto-detection ambiguous", async () => {
    platformMock.mockReturnValue("win32");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\tester\\AppData\\Local");
    readdirSyncMock.mockReturnValue([dirEntry("hash-one"), dirEntry("hash-two")]);
    existsSyncMock.mockReturnValue(true);

    const config = await import("../src/config.js");

    expect(() => config.getLogosDataDir()).toThrow(/Could not uniquely determine/);
  });

  it("tells a Linux user the truth instead of naming a macOS path (L4)", async () => {
    // The non-Windows branch was unconditional, so the error read
    // "/home/them/Library/Application Support/Logos4/… not found" — a macOS
    // path that has never existed on their machine, which reads as "Logos is
    // installed wrong" rather than "Logos does not run here".
    platformMock.mockReturnValue("linux");
    homedirMock.mockReturnValue("/home/tester");

    const config = await import("../src/config.js");

    expect(() => config.getLogosDataDir()).toThrow(/require Windows or macOS/);
    expect(() => config.getLogosDataDir()).toThrow(/LOGOS_DATA_DIR/);
    expect(() => config.getLogosDataDir()).not.toThrow(/Library\/Application Support/);
    // and it never touched the filesystem looking for a folder that cannot exist
    expect(readdirSyncMock).not.toHaveBeenCalled();
  });

  it("still resolves the macOS path on darwin", async () => {
    platformMock.mockReturnValue("darwin");
    readdirSyncMock.mockReturnValue([dirEntry("mac-hash")]);
    existsSyncMock.mockReturnValue(true);

    const config = await import("../src/config.js");

    expect(config.getLogosDataDir()).toBe(
      join("/Users/tester", "Library", "Application Support", "Logos4", "Documents", "mac-hash")
    );
  });
});
