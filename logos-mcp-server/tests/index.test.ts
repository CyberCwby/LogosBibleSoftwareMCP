import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const searchCatalogMock = vi.hoisted(() => vi.fn(() => [{ resourceId: "LLS:COMM", title: "Romans Commentary", abbreviatedTitle: "Rom Comm", type: "text.monograph.commentary.bible", authors: "John Murray", subjects: "Romans", description: "Classic", publicationDate: "1959" }]));
const getBibleTextMock = vi.hoisted(() => vi.fn(async (passage: string, bible?: string) => ({
  passage,
  bible: bible ?? "LEB",
  text: "Sample passage text",
})));
const searchBibleMock = vi.hoisted(() => vi.fn(async (query: string) => ({
  query,
  resultCount: 1,
  results: [{ title: "Romans 8:28", preview: "All things work together..." }],
})));

interface RegisteredTool {
  name: string;
  config: {
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const mcpState = vi.hoisted(() => ({
  instances: [] as Array<{ tools: RegisteredTool[] }>,
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class FakeMcpServer {
    tools: RegisteredTool[] = [];

    constructor(_info: unknown) {
      mcpState.instances.push(this);
    }

    registerTool(name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) {
      this.tools.push({ name, config, handler });
    }

    async connect(_transport: unknown) {
      return undefined;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class FakeTransport {},
}));

vi.mock("../src/config.js", () => ({
  BIBLIA_API_KEY: "test-key",
  SERVER_NAME: "logos-bible",
  SERVER_VERSION: "1.0.0",
}));

vi.mock("../src/services/biblia-api.js", () => ({
  BibliaApiError: class BibliaApiError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  getBibleText: getBibleTextMock,
  searchBible: searchBibleMock,
  scanReferences: vi.fn(async () => [{ passage: "John 3:16" }]),
  comparePassages: vi.fn(async () => ({
    equal: false,
    intersects: true,
    subset: false,
    superset: false,
    before: false,
    after: false,
  })),
  getAvailableBibles: vi.fn(async () => [{
    bible: "LEB",
    title: "Lexham English Bible",
    abbreviatedTitle: "LEB",
    languages: ["en"],
    publishers: ["Lexham"],
  }]),
}));

vi.mock("../src/services/logos-app.js", () => ({
  navigateToPassage: vi.fn(async () => ({ success: true, command: "logos4:///Bible/Jn3.16" })),
  openWordStudy: vi.fn(async () => ({ success: true, command: "logos4:///WordStudy?word=grace" })),
  openFactbook: vi.fn(async () => ({ success: true, command: "logos4:///Factbook?ref=Moses" })),
  openResource: vi.fn(async () => ({ success: true, command: "logosres:LLS:COMM" })),
  openGuide: vi.fn(async () => ({ success: true, command: "logos4:///Guide" })),
  searchAll: vi.fn(async () => ({ success: false, command: "logos4:///Search", launcher: "rundll32.exe", error: "Logos not running" })),
}));

vi.mock("../src/services/reference-parser.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/reference-parser.js")>(
    "../src/services/reference-parser.js"
  );
  return {
    ...actual,
    expandRange: vi.fn(() => "John 3:11-21"),
  };
});

vi.mock("../src/services/sqlite-reader.js", () => ({
  getUserHighlights: vi.fn(() => [{ resourceId: "LLS:ROM", textRange: "bible+leb.45.8.28", styleName: "Solid Colors", syncDate: "2026-03-20", references: ["Romans 8:28"] }]),
  getFavorites: vi.fn(() => [{ id: "fav-1", title: "Romans", appCommand: "logos4:///Bible/Ro8.28", resourceId: "LLS:ROM", rank: 1 }]),
  getWorkflowTemplates: vi.fn(() => [{ templateId: 1, externalId: "inductive", title: "Inductive Study", author: "Logos", templateJson: null, createdDate: "2026-01-01" }]),
  getWorkflowInstances: vi.fn(() => [{ instanceId: 1, externalId: "inst-1", templateId: "1", key: "romans", title: "Romans", currentStep: "Observe", completedSteps: ["Read"], skippedSteps: [], createdDate: "2026-03-01", completedDate: null, modifiedDate: "2026-03-20" }]),
  getReadingProgress: vi.fn(() => ({ statuses: [{ title: "Read Romans", author: "Paul", path: "/romans", status: 1, modifiedDate: "2026-03-20" }], items: [], totalItems: 4, completedItems: 2, percentComplete: 50 })),
  getUserNotes: vi.fn(() => [{ noteId: 1, externalId: "note-1", content: "Grace alone", createdDate: "2026-03-01", modifiedDate: "2026-03-20", notebookTitle: "Romans", anchorsJson: '[{"reference":{"raw":"bible+leb.45.8.28"}}]', tagsJson: "[]", references: ["Romans 8:28"] }]),
}));

vi.mock("../src/services/catalog-reader.js", () => ({
  searchCatalog: searchCatalogMock,
  getResourceTypeSummary: vi.fn(() => [{ label: "Commentary", count: 12 }]),
  typeLabel: vi.fn(() => "Commentary"),
}));

function getRegisteredTool(name: string) {
  const instance = mcpState.instances.at(-1);
  if (!instance) {
    throw new Error("No MCP server instance was created");
  }

  const tool = instance.tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Tool ${name} not registered`);
  }

  return tool;
}

describe("index MCP registration", () => {
  beforeEach(() => {
    vi.resetModules();
    mcpState.instances.length = 0;
    searchCatalogMock.mockClear();
    getBibleTextMock.mockClear();
    searchBibleMock.mockClear();
  });

  it("registers the full tool surface", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();

    const instance = mcpState.instances.at(-1);
    expect(instance?.tools).toHaveLength(22);
    expect(instance?.tools.map((tool) => tool.name)).toContain("navigate_passage");
    expect(instance?.tools.map((tool) => tool.name)).toContain("get_resource_types");
  });

  it("formats get_bible_text responses through the MCP entrypoint", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("get_bible_text");
    const result = await tool.handler({ passage: "John 3:16" });

    expect(result).toEqual({
      content: [{ type: "text", text: "**John 3:16** (LEB)\n\nSample passage text" }],
    });
  });

  it("formats successful Logos navigation responses", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("navigate_passage");
    const result = await tool.handler({ reference: "John 3:16" });

    expect(result).toEqual({
      content: [{ type: "text", text: "Opened John 3:16 in Logos." }],
    });
  });

  it("formats library catalog responses and resource labels", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("get_library_catalog");
    const result = await tool.handler({ type: "commentary" });

    expect(result).toEqual({
      content: [{
        type: "text",
        text: "Found 1 resources:\n\n- **Romans Commentary** — John Murray\n  ID: `LLS:COMM` | Type: Commentary",
      }],
    });
  });

  it("rejects get_library_catalog calls with no filters", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("get_library_catalog");
    const result = await tool.handler({ limit: 50 });

    expect(result).toEqual({
      content: [{
        type: "text",
        text: "get_library_catalog requires at least one non-empty filter: query, type, or author.",
      }],
      isError: true,
    });
    expect(searchCatalogMock).not.toHaveBeenCalled();
  });

  it("rejects get_library_catalog calls with only blank-string filters", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("get_library_catalog");
    const result = await tool.handler({ query: "   ", type: "", author: "  " });

    expect(result).toEqual({
      content: [{
        type: "text",
        text: "get_library_catalog requires at least one non-empty filter: query, type, or author.",
      }],
      isError: true,
    });
    expect(searchCatalogMock).not.toHaveBeenCalled();
  });

  it("formats tool errors through the MCP entrypoint", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("search_all");
    const result = await tool.handler({ query: "grace" });

    expect(result).toEqual({
      content: [{ type: "text", text: "Failed to open search via rundll32.exe: Logos not running" }],
      isError: true,
    });
  });

  it("formats Biblia failures as tool errors instead of throwing", async () => {
    getBibleTextMock.mockRejectedValueOnce(new Error("BIBLIA_API_KEY is not set. Configure it."));
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("get_bible_text");
    const result = await tool.handler({ passage: "John 3:16" });

    expect(result).toEqual({
      content: [{ type: "text", text: "BIBLIA_API_KEY is not set. Configure it." }],
      isError: true,
    });
  });

  it("formats resource type summaries", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("get_resource_types");
    const result = await tool.handler({});

    expect(result).toEqual({
      content: [{ type: "text", text: "Library contains 12 resources across 1 types:\n\n- **Commentary**: 12" }],
    });
  });

  it("notes truncation when search_bible returns more matches than shown", async () => {
    searchBibleMock.mockResolvedValueOnce({
      query: "love",
      resultCount: 143,
      results: [
        { title: "John 3:16", preview: "For God so loved..." },
        { title: "1 John 4:8", preview: "God is love" },
      ],
    });
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("search_bible");
    const result = (await tool.handler({ query: "love" })) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain('Found 143 results for "love" (showing first 2)');
  });

  it("excludes the source passage from cross-references even when abbreviated", async () => {
    searchBibleMock.mockResolvedValueOnce({
      query: "sample",
      resultCount: 2,
      results: [
        { title: "Romans 8:28", preview: "All things work together..." },
        { title: "Genesis 50:20", preview: "You meant evil against me..." },
      ],
    });
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("get_cross_references");
    const result = (await tool.handler({ passage: "Rom 8:28" })) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain("**Genesis 50:20**");
    expect(result.content[0].text).not.toContain("**Romans 8:28**");
  });

  it("shows anchored Bible references on notes", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("get_user_notes");
    const result = (await tool.handler({})) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain("[Romans] — Romans 8:28 (2026-03-20)");
  });

  it("shows parsed references instead of raw ranges on highlights", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("get_user_highlights");
    const result = (await tool.handler({})) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain("- **Solid Colors**: Romans 8:28 (LLS:ROM)");
  });

  it("formats Biblia failures from scan_references as tool errors", async () => {
    const bibliaApi = await import("../src/services/biblia-api.js");
    vi.mocked(bibliaApi.scanReferences).mockRejectedValueOnce(
      new bibliaApi.BibliaApiError("rate_limited" as never, "Biblia API rate limit exceeded. Wait a moment and try again.")
    );
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("scan_references");
    const result = await tool.handler({ text: "see John 3:16" });

    expect(result).toEqual({
      content: [{ type: "text", text: "Biblia API rate limit exceeded. Wait a moment and try again." }],
      isError: true,
    });
  });

  it("bounds limit parameters in the input schema", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();
    const tool = getRegisteredTool("search_bible");
    const schema = z.object(tool.config.inputSchema as z.ZodRawShape);

    expect(schema.safeParse({ query: "love", limit: 20 }).success).toBe(true);
    expect(schema.safeParse({ query: "love", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "love", limit: 500 }).success).toBe(false);
    expect(schema.safeParse({ query: "love", limit: 2.5 }).success).toBe(false);
  });

  it("declares tool annotations distinguishing read-only and UI tools", async () => {
    const indexModule = await import("../src/index.js");

    indexModule.createServer();

    expect(getRegisteredTool("get_bible_text").config.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(getRegisteredTool("get_user_notes").config.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(getRegisteredTool("navigate_passage").config.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });
});