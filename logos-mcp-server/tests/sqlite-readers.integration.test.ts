import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbPaths = vi.hoisted(() => ({
  visualMarkup: "",
  favorites: "",
  workflows: "",
  readingLists: "",
  shortcuts: "",
  guides: "",
  notes: "",
  clippings: "",
  passageLists: "",
  catalog: "",
}));

vi.mock("../src/config.js", () => ({
  getDbPaths: () => dbPaths,
  getCatalogDbPath: () => dbPaths.catalog,
}));

function createDb(path: string, statements: string[], inserts: Array<{ sql: string; params?: unknown[] }> = []) {
  const db = new Database(path);
  try {
    for (const statement of statements) {
      db.exec(statement);
    }
    for (const insert of inserts) {
      db.prepare(insert.sql).run(...(insert.params ?? []));
    }
  } finally {
    db.close();
  }
}

describe("sqlite reader integration", () => {
  let fixtureDir: string;

  beforeEach(() => {
    vi.resetModules();
    fixtureDir = mkdtempSync(join(tmpdir(), "logos-mcp-fixture-"));

    dbPaths.visualMarkup = join(fixtureDir, "visualmarkup.db");
    dbPaths.favorites = join(fixtureDir, "favorites.db");
    dbPaths.workflows = join(fixtureDir, "workflows.db");
    dbPaths.readingLists = join(fixtureDir, "readinglists.db");
    dbPaths.shortcuts = join(fixtureDir, "shortcuts.db");
    dbPaths.guides = join(fixtureDir, "guides.db");
    dbPaths.notes = join(fixtureDir, "notestool.db");
    dbPaths.clippings = join(fixtureDir, "clippings.db");
    dbPaths.passageLists = join(fixtureDir, "passagelist.db");
    dbPaths.catalog = join(fixtureDir, "catalog.db");

    createDb(
      dbPaths.visualMarkup,
      [
        `CREATE TABLE Markup (
          ResourceId TEXT,
          SavedTextRange TEXT,
          MarkupStyleName TEXT,
          SyncDate TEXT,
          IsDeleted INTEGER
        );`,
      ],
      [
        {
          sql: "INSERT INTO Markup VALUES (?, ?, ?, ?, ?)",
          params: ["LLS:1", "bible+leb.43.3.16", "Solid Colors", "2026-03-20", 0],
        },
        {
          sql: "INSERT INTO Markup VALUES (?, ?, ?, ?, ?)",
          params: ["LLS:2", "bible+leb.45.8.28-45.8.30", "Emphasis", "2026-03-19", 0],
        },
      ]
    );

    createDb(
      dbPaths.favorites,
      [
        "CREATE TABLE Favorites (Id TEXT, Title TEXT, Rank INTEGER, IsDeleted INTEGER);",
        "CREATE TABLE Items (FavoriteId TEXT, AppCommand TEXT, ResourceId TEXT);",
      ],
      [
        {
          sql: "INSERT INTO Favorites VALUES (?, ?, ?, ?)",
          params: ["fav-1", "Romans", 2, 0],
        },
        {
          sql: "INSERT INTO Favorites VALUES (?, ?, ?, ?)",
          params: ["fav-2", "Genesis", 1, 0],
        },
        {
          sql: "INSERT INTO Items VALUES (?, ?, ?)",
          params: ["fav-1", "logos4:///Bible/Ro8.28", "LLS:ROM"],
        },
        {
          sql: "INSERT INTO Items VALUES (?, ?, ?)",
          params: ["fav-2", "logos4:///Bible/Ge1.1", "LLS:GEN"],
        },
      ]
    );

    createDb(
      dbPaths.workflows,
      [
        "CREATE TABLE Templates (TemplateId INTEGER, ExternalId TEXT, TemplateJson TEXT, Author TEXT, CreatedDate TEXT, IsDeleted INTEGER);",
        "CREATE TABLE Instances (InstanceId INTEGER, ExternalId TEXT, TemplateId TEXT, Key TEXT, Title TEXT, CurrentStep TEXT, CompletedStepsJson TEXT, SkippedStepsJson TEXT, CreatedDate TEXT, CompletedDate TEXT, ModifiedDate TEXT, IsDeleted INTEGER);",
      ],
      [
        {
          sql: "INSERT INTO Templates VALUES (?, ?, ?, ?, ?, ?)",
          params: [1, "inductive-study", '{"title":"Inductive Bible Study"}', "Logos", "2026-01-01", 0],
        },
        {
          sql: "INSERT INTO Instances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [10, "inst-10", "1", "romans-8", "Romans 8 Study", "Observe", '["Read"]', '["Optional"]', "2026-03-01", null, "2026-03-20", 0],
        },
      ]
    );

    createDb(
      dbPaths.readingLists,
      [
        "CREATE TABLE ReadingListStatuses (Title TEXT, Author TEXT, Path TEXT, Status INTEGER, ModifiedDate TEXT, IsDeleted INTEGER);",
        "CREATE TABLE Items (ItemId TEXT, ReadingListPathNormalized TEXT, Title TEXT, SortOrder INTEGER, IsRead INTEGER, ModifiedDate TEXT);",
      ],
      [
        {
          sql: "INSERT INTO ReadingListStatuses VALUES (?, ?, ?, ?, ?, ?)",
          params: ["Read Romans", "Paul", "/plans/romans", 1, "2026-03-15", 0],
        },
        {
          sql: "INSERT INTO ReadingListStatuses VALUES (?, ?, ?, ?, ?, ?)",
          params: ["Finished Plan", "John", "/plans/john", 2, "2026-03-15", 0],
        },
        {
          sql: "INSERT INTO Items VALUES (?, ?, ?, ?, ?, ?)",
          params: ["item-1", "/plans/romans", "Romans 1-2", 1, 1, "2026-03-15"],
        },
        {
          sql: "INSERT INTO Items VALUES (?, ?, ?, ?, ?, ?)",
          params: ["item-2", "/plans/romans", "Romans 3-4", 2, 0, "2026-03-16"],
        },
        {
          sql: "INSERT INTO Items VALUES (?, ?, ?, ?, ?, ?)",
          params: ["item-3", "/plans/romans", "Romans 5-6", 3, 0, "2026-03-16"],
        },
      ]
    );

    createDb(
      dbPaths.clippings,
      [
        `CREATE TABLE Clippings (
          ClippingId INTEGER,
          Title TEXT,
          ContentRichText TEXT,
          ResourceId TEXT,
          AnchorsJson TEXT,
          CreatedDate TEXT,
          ModifiedDate TEXT,
          IsDeleted INTEGER
        );`,
      ],
      [
        {
          sql: "INSERT INTO Clippings VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [1, "On grace", '<Paragraph><Run Text="Grace is unmerited favor"/></Paragraph>', "LLS:COMM1", '[{"reference":{"raw":"bible+leb.49.2.8"}}]', "2026-03-01", "2026-03-10", 0],
        },
        {
          sql: "INSERT INTO Clippings VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [2, "Deleted clipping", '<Paragraph><Run Text="Should not appear"/></Paragraph>', "LLS:COMM1", null, "2026-03-02", "2026-03-11", 1],
        },
      ]
    );

    createDb(
      dbPaths.passageLists,
      [
        "CREATE TABLE PassageLists (PassageListId INTEGER, Title TEXT, IsDeleted INTEGER);",
        "CREATE TABLE Passages (PassageListId INTEGER, Reference TEXT, IsDeleted INTEGER);",
      ],
      [
        {
          sql: "INSERT INTO PassageLists VALUES (?, ?, ?)",
          params: [1, "Promises of God", 0],
        },
        {
          sql: "INSERT INTO Passages VALUES (?, ?, ?)",
          params: [1, "bible+leb.45.8.28", 0],
        },
        {
          sql: "INSERT INTO Passages VALUES (?, ?, ?)",
          params: [1, "bible+leb.50.4.19", 0],
        },
      ]
    );

    createDb(
      dbPaths.notes,
      [
        "CREATE TABLE Notebooks (ExternalId TEXT, Title TEXT, IsDeleted INTEGER);",
        "CREATE TABLE Notes (NoteId INTEGER, ExternalId TEXT, ContentRichText TEXT, CreatedDate TEXT, ModifiedDate TEXT, NotebookExternalId TEXT, AnchorsJson TEXT, TagsJson TEXT, IsDeleted INTEGER, IsTrashed INTEGER);",
      ],
      [
        {
          sql: "INSERT INTO Notebooks VALUES (?, ?, ?)",
          params: ["nb-1", "Romans Study", 0],
        },
        {
          sql: "INSERT INTO Notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [1, "note-1", '<Paragraph><Run Text="Grace alone"/></Paragraph>', "2026-03-01", "2026-03-20", "nb-1", '[{"reference":{"raw":"bible+leb.45.8.28","resourceId":"LLS:LEB"}}]', "[]", 0, 0],
        },
        {
          sql: "INSERT INTO Notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [2, "note-2", '<Paragraph><Run Text="Born again"/></Paragraph>', "2026-03-02", "2026-03-19", "nb-1", '[{"reference":{"raw":"bible+leb.43.3.1-43.3.21","resourceId":"LLS:LEB"}}]', "[]", 0, 0],
        },
      ]
    );

    createDb(
      dbPaths.catalog,
      [
        `CREATE TABLE Records (
          ResourceId TEXT,
          Title TEXT,
          AbbreviatedTitle TEXT,
          Type TEXT,
          Authors TEXT,
          Subjects TEXT,
          Description TEXT,
          PublicationDate TEXT,
          Availability INTEGER,
          IsDataset INTEGER,
          UseCount INTEGER
        );`,
      ],
      [
        {
          sql: "INSERT INTO Records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: ["LLS:COMM1", "Romans Commentary", "Rom Comm", "text.monograph.commentary.bible", "John Murray", "Romans", "<p>Classic commentary</p>", "1959", 1, 0, 10],
        },
        {
          sql: "INSERT INTO Records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: ["LLS:COMM2", "Genesis Commentary", "Gen Comm", "text.monograph.commentary", "John Calvin", "Genesis", "<p>Reformation notes</p>", "1554", 1, 0, 7],
        },
      ]
    );
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("reads highlights and respects filters and ordering", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.getUserHighlights({ limit: 1 })).toEqual([
      {
        resourceId: "LLS:1",
        textRange: "bible+leb.43.3.16",
        styleName: "Solid Colors",
        syncDate: "2026-03-20",
        references: ["John 3:16"],
      },
    ]);

    expect(sqliteReader.getUserHighlights({ styleName: "Emphasis" })).toHaveLength(1);
  });

  it("filters highlights by Bible reference", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    const romans = sqliteReader.getUserHighlights({ reference: "Romans 8" });
    expect(romans).toHaveLength(1);
    expect(romans[0]).toMatchObject({
      styleName: "Emphasis",
      references: ["Romans 8:28-30"],
    });

    expect(sqliteReader.getUserHighlights({ reference: "Romans 8:29" })).toHaveLength(1);
    expect(sqliteReader.getUserHighlights({ reference: "Genesis 1" })).toHaveLength(0);
  });

  it("reads favorites in rank order", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.getFavorites()).toEqual([
      {
        id: "fav-2",
        title: "Genesis",
        appCommand: "logos4:///Bible/Ge1.1",
        resourceId: "LLS:GEN",
        rank: 1,
      },
      {
        id: "fav-1",
        title: "Romans",
        appCommand: "logos4:///Bible/Ro8.28",
        resourceId: "LLS:ROM",
        rank: 2,
      },
    ]);
  });

  it("reads workflow templates and instances from the fixture database", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.getWorkflowTemplates()[0]).toMatchObject({
      externalId: "inductive-study",
      title: "Inductive Bible Study",
    });

    expect(sqliteReader.getWorkflowInstances(5)[0]).toMatchObject({
      key: "romans-8",
      currentStep: "Observe",
      completedSteps: ["Read"],
      skippedSteps: ["Optional"],
    });
  });

  it("computes reading progress percentages from fixture rows", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.getReadingProgress()).toMatchObject({
      totalItems: 3,
      completedItems: 1,
      percentComplete: 33,
      statuses: expect.arrayContaining([
        expect.objectContaining({
          title: "Read Romans",
          author: "Paul",
          path: "/plans/romans",
          status: 1,
        }),
      ]),
    });
  });

  it("reads notes and strips Logos rich text", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.getUserNotes({ notebookTitle: "Romans", limit: 1 })).toEqual([
      expect.objectContaining({
        externalId: "note-1",
        notebookTitle: "Romans Study",
        content: "Grace alone",
        references: ["Romans 8:28"],
      }),
    ]);
  });

  it("searches note contents with the query filter", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    const matches = sqliteReader.getUserNotes({ query: "born AGAIN" });
    expect(matches).toHaveLength(1);
    expect(matches[0].externalId).toBe("note-2");

    expect(sqliteReader.getUserNotes({ query: "propitiation" })).toHaveLength(0);
  });

  it("reads clippings with schema discovery, skipping deleted rows", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.getClippings()).toEqual([
      {
        title: "On grace",
        content: "Grace is unmerited favor",
        resourceId: "LLS:COMM1",
        createdDate: "2026-03-01",
        modifiedDate: "2026-03-10",
        references: ["Ephesians 2:8"],
      },
    ]);
  });

  it("reads passage lists grouped by list title", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.getPassageLists()).toEqual([
      {
        title: "Promises of God",
        passages: ["Romans 8:28", "Philippians 4:19"],
      },
    ]);
  });

  it("returns next unread items per active reading plan", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.getTodaysReading({ perPlanLimit: 1 })).toEqual([
      {
        title: "Read Romans",
        author: "Paul",
        path: "/plans/romans",
        remainingItems: 2,
        nextItems: ["Romans 3-4"],
      },
    ]);
  });

  it("summarizes highlights by style", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.getHighlightSummary("style")).toEqual([
      { key: "Solid Colors", count: 1, lastSyncDate: "2026-03-20" },
      { key: "Emphasis", count: 1, lastSyncDate: "2026-03-19" },
    ]);
  });

  it("lists notebooks with note counts", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    expect(sqliteReader.listNotebooks()).toEqual([
      { externalId: "nb-1", title: "Romans Study", noteCount: 2 },
    ]);

    const notebookNotes = sqliteReader.getUserNotes({ notebookExternalId: "nb-1" });
    expect(notebookNotes).toHaveLength(2);
  });

  it("filters notes by anchored Bible reference", async () => {
    const sqliteReader = await import("../src/services/sqlite-reader.js");

    const johnNotes = sqliteReader.getUserNotes({ reference: "John 3:16" });
    expect(johnNotes).toHaveLength(1);
    expect(johnNotes[0]).toMatchObject({
      externalId: "note-2",
      references: ["John 3:1-21"],
    });

    expect(sqliteReader.getUserNotes({ reference: "Rom 8" })).toHaveLength(1);
    expect(sqliteReader.getUserNotes({ reference: "Genesis 1" })).toHaveLength(0);
  });

  it("searches catalog data and summarizes merged resource types", async () => {
    const catalogReader = await import("../src/services/catalog-reader.js");

    expect(catalogReader.searchCatalog({ type: "commentary", author: "John" })).toEqual([
      {
        resourceId: "LLS:COMM1",
        title: "Romans Commentary",
        abbreviatedTitle: "Rom Comm",
        type: "text.monograph.commentary.bible",
        authors: "John Murray",
        subjects: "Romans",
        description: "Classic commentary",
        publicationDate: "1959",
      },
      {
        resourceId: "LLS:COMM2",
        title: "Genesis Commentary",
        abbreviatedTitle: "Gen Comm",
        type: "text.monograph.commentary",
        authors: "John Calvin",
        subjects: "Genesis",
        description: "Reformation notes",
        publicationDate: "1554",
      },
    ]);

    expect(catalogReader.getResourceTypeSummary()).toEqual([
      { label: "Commentary", count: 2 },
    ]);
  });

  it("prefers exact and title-focused query matches over pure title sorting", async () => {
    createDb(
      dbPaths.catalog,
      [],
      [
        {
          sql: "INSERT INTO Records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: ["LLS:LEX1", "Romans", "Romans", "text.monograph.dictionary", "Jane Doe", "Romans, Pauline theology", "<p>Dictionary article</p>", "2001", 1, 0, 1],
        },
      ]
    );

    const catalogReader = await import("../src/services/catalog-reader.js");
    const results = catalogReader.searchCatalog({ query: "Romans" });

    expect(results[0]).toMatchObject({
      resourceId: "LLS:LEX1",
      title: "Romans",
    });
  });
});