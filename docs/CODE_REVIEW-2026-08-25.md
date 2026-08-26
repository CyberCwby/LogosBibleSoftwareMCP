# Code Review — 2026-08-25

Scope: full source review of `logos-mcp-server/` (13 files under `src/`, `scripts/fetch-cross-references.mjs`), the repo-level config (`.gitignore`, README, agent files), and a cross-check against the previous audit (`docs/reviews/code-review-and-coverage-2026-08-12.md`). Every finding below was verified by reading the current code; no dependencies were installed and no tests were run as part of this review.

## What this repository is

An MCP (Model Context Protocol) server that bridges MCP clients (Claude Code, Claude Desktop, LM Studio, VS Code + Copilot, Cursor, …) to **Logos Bible Software**. It exposes 26 tools, 3 prompts, and a notebook resource template through four channels:

- the free **Biblia REST API** for Bible text/search (`src/services/biblia-api.ts`),
- **`logos4:`/`logosres:` URL schemes** (with a Logos web-app fallback) for driving the desktop UI (`src/services/logos-app.ts`),
- **read-only SQLite access** to the user's local Logos databases — notes, highlights, favorites, clippings, passage lists, reading plans, library catalog (`src/services/sqlite-reader.ts`, `catalog-reader.ts`),
- an experimental **Windows UI Automation** scraper for reading text from open resource panels (`src/services/ui-automation-reader.ts`).

## Repo-health summary

The codebase is in good shape and clearly benefits from the 2026-08-12 audit: **all 12 findings from that review were verified as fixed in the current tree** (quote-aware XAML stripping, catalog scan window, per-invocation UIA temp scripts, "Sent … to Logos" wording for unverifiable Windows launches, `ESCAPE`d LIKE patterns, empty-Biblia-body errors, arg-key-only failure logging, notebook resource error boundary, honest chapter-only context labeling, `-TabName:<value>` binding, `--env-file-if-exists` dev loading). Security fundamentals remain right: every child process goes through `execFile` with argument vectors (no shell anywhere), all SQL values are bound parameters with dynamic identifiers quoted, databases open `readonly`, the Biblia key is added to the URL *after* the cache key is computed and never appears in any error message or log line, and every tool runs behind one error boundary returning MCP `isError` results. Test investment is substantial (~3.2k lines across 11 vitest suites vs ~3.9k lines of source). Notable gaps at repo level: **no CI workflow** (tests/typecheck run only by hand), and two configuration inconsistencies described below (M1, L5).

This pass found **no High-severity issues**, 4 Medium, and 9 Low.

---

## Findings

### Medium

#### M1. README instructs users to put the Biblia API key into files that are *not* gitignored (`.vscode/mcp.json`, `.cursor/mcp.json`)

`.gitignore:4` (`.mcp.json`), `README.md:146-166` (VS Code), `README.md:214-233` (Cursor), `README.md:373` (project-structure listing of `.vscode/mcp.json`)

The Claude Code config `.mcp.json` is ignored (`.gitignore:4`), but that pattern matches only files literally named `.mcp.json`. The VS Code and Cursor setup sections tell the user to create `.vscode/mcp.json` / `.cursor/mcp.json` **in the project root** with `"BIBLIA_API_KEY": "your_api_key_here"` inline — and neither path is ignored (verified with `git check-ignore`: only `.mcp.json` matches).

**Failure scenario:** a contributor follows the README's VS Code section, then commits ("git add -A") and pushes to their fork — their personal API key is now published. The repo's own project-structure section presents `.vscode/mcp.json` as a normal in-repo file ("you create this"), making this an expected workflow, not an accident.

**Fix:** add `.vscode/mcp.json` and `.cursor/mcp.json` to `.gitignore` (or ignore `**/mcp.json`), and/or update the README to recommend VS Code's `${input:...}`-prompted secrets or user-level config for the key.

#### M2. The XAML rich-text extractor never decodes XML entities, so notes containing `&`, `<`, `>`, or `&quot;` come back with literal escapes

`src/utils/strip-markup.ts:46-58` (the `Text=` attribute extraction loop pushes the raw attribute value; compare `stripXml`'s entity chain at `strip-markup.ts:11-20`, which the XAML path never reaches)

A note stored as `<Run Text="Faith &amp; Works" />` is returned as `Faith &amp; Works`; a quotation inside a note, which XAML must serialize as `&quot;…&quot;` inside a double-quoted attribute, is returned as `&quot;…&quot;`. `&` *must* be escaped in XML attribute values, so any note/clipping containing an ampersand is affected.

**Failure scenario:** `get_user_notes`, `get_clippings`, and the `logos://notebooks/{id}` resource render escaped entities to the model/user; worse, `get_user_notes`' full-text `query` filter (`src/services/sqlite-reader.ts:323-326`) runs over the *un*-decoded content, so searching for `"Faith & Works"` misses a note that literally contains that phrase.

**Fix:** run each extracted attribute value through the same entity-decoding chain `stripXml` uses (`&lt;`, `&gt;`, `&quot;`, `&#39;`/`&apos;`, then `&amp;` last) before pushing it. Add regression tests: `Text="Faith &amp; Works"` and `Text="He said &quot;go&quot;"`.

#### M3. Uncapped `Retry-After` honoring can stall a Biblia tool call arbitrarily long

`src/services/biblia-api.ts:142-147` (`const delayMs = retryAfterSeconds ? retryAfterSeconds * 1000 : …; await sleep(delayMs);`), fed by `parseRetryAfterSeconds` at `biblia-api.ts:75-84`, which accepts any non-negative number of seconds *or any future HTTP-date*.

On a 429, the retry loop sleeps for whatever the server sent — unbounded. `MAX_RETRIES = 2` means up to two such sleeps per call.

**Failure scenario:** Biblia (or any intermediary proxy/CDN answering 429) sends `Retry-After: 86400` or a date-format header pointing hours ahead. The tool call blocks inside `sleep()` for that long; MCP stdio has no built-in per-tool timeout, so the client appears hung and the user gets no rate-limit message (the informative `rate_limited` error is only thrown after the retries are exhausted). The only existing test uses `retry-after: "0"`, so the unbounded path is untested.

**Fix:** cap the honored delay (e.g. `Math.min(retryAfterSeconds, 10)` seconds); when the advertised wait exceeds the cap, skip the retry and throw the `rate_limited` error immediately — it already carries `retryAfterSeconds` for the caller.

#### M4. Concurrent `get_resource_text` calls still race on the single Logos UI

`src/services/ui-automation-reader.ts:261-342` (`readResourceText` — no serialization; each call spawns its own PowerShell)

The temp-script half of the previous audit's M2 was fixed (per-invocation `randomUUID()` filename, `ui-automation-reader.ts:274`), but the recommended mutex was not added. Two overlapping calls each run `SetForegroundWindow` + `SendKeys "{PGDN}"` (script lines at `ui-automation-reader.ts:146-170`) against the same physical Logos window.

**Failure scenario:** an agent fans out reads over two tabs (a natural pattern — the tool takes a `tab_name`). Both PowerShell processes scroll the same foreground document in interleaved order; each captures pages the other scrolled past, so `mergePages` produces garbled, gap-ridden text for *both* calls — with `success: true`. Multi-page reads are exactly the calls that take longest (per-page sleeps), maximizing the overlap window.

**Fix:** serialize `readResourceText` behind a simple module-level promise chain (`let queue = Promise.resolve(); queue = queue.then(run)`), since the underlying resource (the foreground UI) is inherently exclusive.

### Low

#### L1. Single-element `availableTabs` from PowerShell crashes the helpful "Open tabs" error path

`src/services/ui-automation-reader.ts:240-246` (normalizes only `pages` against ConvertTo-Json's single-element-array collapse) vs `ui-automation-reader.ts:319-324` (`result.availableTabs.length > 0 … availableTabs.join(", ")`)

The code's own comment documents that Windows PowerShell's `ConvertTo-Json` collapses a one-element array property to a scalar, and normalizes `pages` accordingly — but not `availableTabs`. With exactly one open tab and a non-matching `tab_name`, `availableTabs` arrives as a string: `.length > 0` is true, then `.join(", ")` throws `TypeError: availableTabs.join is not a function`, replacing the intended "No matching document found for tab filter / Open tabs: ESV" message. **Fix:** apply the same array normalization to `availableTabs`.

#### L2. `findCrossReferences` can return verses *inside* the requested range as cross-references of it

`src/services/cross-references.ts:146-148` (`best.delete(sourceKey)` removes only the exact formatted source)

For `get_cross_references("Romans 8:28-30")`, per-verse dataset entries such as 45.8.28 → 45.8.29 survive the exclusion (only the literal string `Romans 8:28-30` is deleted), so the passage's own interior verses can be listed among its "cross-references". **Fix:** filter `best` with `referencesIntersect` (already exported from `src/utils/bible-anchors.ts`) against the parsed source instead of a single string-key delete.

#### L3. `getPassageLists` merges distinct lists with the same title, and `limit` changes meaning between its two modes

`src/services/sqlite-reader.ts:484-493` (grouping keyed on `row.ListTitle`), `sqlite-reader.ts:491-493` vs `498-501` (limit = number of *lists* in the join path, number of *rows/passages* in the fallback path)

Two passage lists both titled e.g. "Sermon prep" are merged into one entry because grouping keys on the display title rather than the list id (which is already resolved as `listIdCol`). Separately, the tool schema documents `limit` as "Max passage lists to return", but the schema-fallback path applies it as a SQL row limit over individual passages. **Fix:** group by `listIdCol` value (keeping the title as display), and in the fallback path apply the limit after grouping (or document the difference).

#### L4. On Linux, path-resolution errors name a macOS directory

`src/config.ts:8-18` (`platform() === "win32"` else the `~/Library/Application Support/Logos4/...` path)

The README correctly says local-data tools are unavailable on Linux, but the error a Linux user actually sees ("Logos data folder not found at /home/user/Library/Application Support/Logos4/…") is misleading. Cosmetic; carried over from the prior audit's aside. **Fix:** branch on `darwin` explicitly and produce a "local Logos data tools require Windows or macOS; set LOGOS_DATA_DIR if you have a copy of the data" message elsewhere.

#### L5. `.gitignore` excludes `.claude/agents/` while two tracked agent files live there — new agent files will silently never be committed

`.gitignore:7` (`.claude/agents/`), tracked files `.claude/agents/socratic-bible-study.md` and `tool-tester.md` (verified: both in `git ls-files`; `git check-ignore` confirms a *new* file in that directory is ignored)

The README presents the Socratic agent as a shipped feature and the directory is actively edited (commit `11ddf4f`), but the ignore rule means any newly added agent (e.g. the planned Thompson Chain work under `docs/plans/`) would be invisible to `git add` without `-f`, an easy way to lose work or publish a broken feature. **Fix:** remove the `.gitignore` line (agents are project content here), or scope it to genuinely local files.

#### L6. `expandRange` does not clamp the end verse, so context requests near a chapter's end produce out-of-range references

`src/services/reference-parser.ts:424-438` (`endVerse = (ref.endVerse ?? ref.verse) + contextVerses`, no chapter-length data)

`get_passage_context("John 3:34")` requests `John 3:29-41` though John 3 has 36 verses. The observable outcome depends on the Biblia API's range handling: if it clamps, all is well; if it resolves the range to nothing, the (correct and deliberate) empty-body guard added in the last round (`biblia-api.ts:218-226`) turns a legitimate request into a "passage was not recognized" error. Worth a live check on the deploy host; a verse-count table for the 66 books (small, static) would remove the dependency entirely.

#### L7. Dead exports and types

`src/types.ts:13-17` (`ReferenceFormats`), `types.ts:38-41` (`BibliaParseResult`), `types.ts:82-88` (`FavoriteFolder` — folder favorites are also silently dropped by `getFavorites`' inner `JOIN Items` at `sqlite-reader.ts:84-90`, so the type is doubly unused), and `src/services/reference-parser.ts:392` (`toHumanReadable`, referenced only by tests)

None are wired to any tool. Either remove them or (for `FavoriteFolder`) implement folder listing in `get_favorites`; as-is the types suggest capabilities the server does not have.

#### L8. `get_bible_text` multi-version comparison is all-or-nothing

`src/index.ts:157-165` (`Promise.all` over `bibles`)

One invalid/unsupported version id (or one transient API failure) rejects the whole comparison, discarding the versions that succeeded. `Promise.allSettled` with per-version error sections would preserve partial results — useful since the tool exists precisely to compare across versions of uneven availability. (Duplicate ids in `bibles` are also fetched and rendered twice; harmless but easy to dedupe.)

#### L9. Catalog relevance scores are recomputed inside the sort comparator

`src/services/catalog-reader.ts:201-207` (`matchScore(...)` — which lowercases title, subjects, and description — is invoked twice per comparison, O(n log n) times over a scan window of up to 250 rows)

Correct but wasteful; precompute the score once per row into the mapped entry (which already exists for `useCount`) before sorting. Micro-issue given the row counts, listed for tidiness.

---

## Areas checked and found clean

- **Command injection:** every process launch (`launchUrl`, `isLogosRunning`, the PowerShell bridge) uses `execFile` with argument vectors; Windows protocol URLs go through `rundll32 url.dll,FileProtocolHandler` specifically to bypass `cmd.exe` parsing; the PowerShell script is a fixed string taking user input only as bound parameters, with the `-TabName:<value>` single-token form guarding leading-dash values (`logos-app.ts:56-72`, `ui-automation-reader.ts:279-290`).
- **SQL injection:** all values are bound parameters; dynamic identifiers in the schema-discovery readers go through `quoteIdent`; `getHighlightSummary`'s interpolated column comes from a closed enum; LIKE filters escape `%`/`_`/`\` and pair with `ESCAPE '\'` (`utils/sql.ts`, `sqlite-reader.ts:281`, `catalog-reader.ts:151-162`).
- **Credential handling:** the Biblia key is appended to the URL *after* the cache key is built (`biblia-api.ts:98-108`), never appears in error messages (built from status + truncated response body only), and `logToolFailure` logs argument *names* only (`index.ts:64-75`). `.mcp.json` and `.env` are gitignored (but see M1 for the VS Code/Cursor variants).
- **Resource management:** every better-sqlite3 handle is opened read-only with `fileMustExist` and closed in `finally`; the UIA temp script is unlinked in `finally`; PowerShell runs under an explicit timeout and `maxBuffer`; HTTP error bodies are consumed before retries; the response cache is TTL'd and size-bounded with insertion-order eviction (`biblia-api.ts:43-54`).
- **Error handling / MCP protocol:** one error boundary wraps every tool (`index.ts:109-124`), the notebook resource read has its own boundary returning readable markdown, failures come back as `isError` content rather than protocol faults, logging goes to stderr only (stdio framing safe), and tool annotations correctly distinguish read-only / open-world / UI-driving tools.
- **Schema correctness:** all 26 registered tools carry described zod schemas with sensible bounds (`limitSchema` min/max everywhere a limit exists); defaults in descriptions match handler defaults (spot-checked all 26); `get_resource_text`'s clamp (1–50) matches its schema.
- **`scripts/fetch-cross-references.mjs`:** hand-rolled single-entry ZIP reader is offset-checked with explicit signature validation and now has fixture tests; HTTPS download, dev-time only. (No integrity pin on the downloaded dataset — acceptable for CC-BY data fetched by an operator.)
- **Prior-audit regressions:** all High/Medium/Low items from 2026-08-12 were re-verified as fixed at their cited sites, with regression tests present (apostrophe truncation, catalog scan window, temp-script uniqueness, unverified-launch wording, LIKE escaping, empty Biblia body, arg redaction, resource-read boundary, chapter-only context labeling, `-TabName` binding, `.env` loading).

---

## Resolution (2026-08-26)

Every finding is addressed in the commit that carries this section. `tsc
--noEmit`, `npm run build` and `npm test` are green — **250 tests**, up from
237. The repo also gains the CI workflow the summary flagged as missing:
`.github/workflows/ci.yml` runs `npm ci`, typecheck, build and tests on every
PR and push to `main`, with no API key configured (the suite mocks `fetch`, and
a job needing a real key would either leak one into a fork's logs or fail every
fork PR).

| Finding | Resolution |
|---|---|
| **M1** | `.gitignore` matches `**/mcp.json`, so `.vscode/mcp.json` and `.cursor/mcp.json` are ignored alongside `.mcp.json` (verified with `git check-ignore`). The README gains a callout above the client configs saying the key lands in an ignored file, and pointing at VS Code's `${input:...}` prompt and the environment as key-free alternatives; the project-structure listing marks both files gitignored. |
| **M2** | The entity-decoding chain is factored into an exported `decodeXmlEntities` and applied to every XAML `Text=` attribute value, not just to `stripXml`'s output. `&` *must* be escaped in an XML attribute, so this affected every note containing an ampersand — and `get_user_notes`' full-text filter runs over this content, so searching for "Faith & Works" missed a note that contains exactly that. The existing test that pinned the escaped form is inverted, with new cases for `&amp;`, `&quot;`, `&lt;`/`&gt;`, `&apos;`, and the doubly-escaped `&amp;lt;` that must decode exactly once. |
| **M3** | `MAX_RETRY_AFTER_SECONDS = 10`. A larger advertised wait skips the retry and throws `rate_limited` immediately — the error already carries `retryAfterSeconds`, so the caller can decide. Tested with `Retry-After: 86400`: one request, no sleep, and the in-cap path still retries. |
| **M4** | `readResourceText` runs behind a module-level promise chain. The foreground Logos window is inherently exclusive, and two overlapping calls each ran `SetForegroundWindow` + `SendKeys "{PGDN}"` against it. The chain is attached so a rejection cannot poison it for the next caller; both properties are tested (max concurrency 1, and a failed read followed by a successful one). |
| **L1** | `parseAutomationOutput` normalizes `availableTabs` the way it already normalized `pages`. With one open tab and a non-matching filter, `.join(", ")` on a string threw a `TypeError` in the one branch that exists to be helpful. |
| **L2** | Targets are excluded by `referencesIntersect` against the parsed source, not by deleting one formatted string, so `get_cross_references("Romans 8:28-30")` no longer lists Romans 8:29 among its own cross-references. A target the parser cannot read is kept, which is what happened before. New fixture and three tests. |
| **L3** | `getPassageLists` groups on the list **id** (already resolved as `listIdCol`), keeping the title for display, so two lists named "Sermon prep" stay two lists. The schema-fallback path no longer applies the caller's `limit` — which counts *lists* — as a SQL row cap over *passages*; it uses a `FALLBACK_ROW_SCAN` safety bound instead. |
| **L4** | `getLogosBaseDir` returns `null` off Windows/macOS and the caller says "local Logos data tools require Windows or macOS — Logos does not run on linux; set LOGOS_DATA_DIR if you have a copy of the data". No filesystem call is made for a path that cannot exist. Tested in both directions. |
| **L5** | `.claude/agents/` is out of `.gitignore`, so a newly added agent is visible to `git add` rather than needing `-f`. |
| **L6** | Rather than hand-entering per-chapter verse counts (data this project would rightly refuse to type from memory), the empty-body guard gained its own error code `passage_not_found`, and `get_passage_context` catches exactly that to retry the reference as given — reporting "without added context (the N-verse window ran past the end of the chapter)". Reduced context beats a false "passage was not recognized" for a reference the user wrote correctly. A verse-count table remains the fuller fix. |
| **L7** | `ReferenceFormats`, `BibliaParseResult` and `FavoriteFolder` are deleted — they advertised capabilities the server does not have, `FavoriteFolder` doubly so. `getFavorites` now documents that its inner `JOIN Items` excludes folders, which is the user-visible fact the type was gesturing at. `toHumanReadable` is **kept** with a note: it is small, correct, covered, and it *is* a capability rather than a claim about one. |
| **L8** | `get_bible_text` uses `Promise.allSettled` and de-duplicates the version list, so a comparison survives one bad version id and reports the failures under an "Unavailable" heading. All-versions-failed still throws, because that is a failure and not an empty comparison. |
| **L9** | Catalog relevance is scored once per row into the mapped entry, beside `useCount`, instead of twice per sort comparison. |
