# Code Review & Test Coverage Audit — 2026-08-12

Scope: `logos-mcp-server/` (all 13 source files under `src/` + `scripts/fetch-cross-references.mjs`), the 10 vitest suites under `tests/`, and the project docs. Reviewer: automated audit (Claude Code). The full test suite and `tsc --noEmit` were run as part of this audit.

## Summary

The codebase is in notably good shape for its size. Security fundamentals are right: every child process goes through `execFile` with argument arrays (no shell interpolation anywhere, including the PowerShell bridge, which passes user input as script parameters rather than splicing it into the script), all SQL is parameterized with dynamic identifiers quoted through a dedicated `quoteIdent`, databases are opened read-only, and the Biblia API key never appears in any error message or log line (error text is built from status codes and response bodies, never the request URL). Tool failures are uniformly caught by one error boundary and returned as MCP `isError` results rather than protocol crashes.

- **Test run:** 197/197 tests pass across 10 files (3.0s). `tsc --noEmit` clean.
- **Findings:** 1 High, 3 Medium, 8 Low/Info. No command injection, no SQL injection, no credential leakage found.
- **Top issue:** a regex bug in the XAML note-text extractor silently truncates any note/clipping at the first apostrophe — user-facing data corruption on a primary code path (`get_user_notes`, `get_clippings`, the notebooks MCP resource).

## Code Review Findings

### High

#### H1. `stripRichText` truncates note text at the first apostrophe
`src/utils/strip-markup.ts:43`

```ts
const regex = /Text=["']([^"']*)["']/g;
```

The character class `[^"']*` stops the capture at *either* quote character, but a double-quoted XML attribute may legally contain raw single quotes (and XAML writers do not escape them). Verified empirically against the actual module:

```
stripRichText('<Paragraph><Run Text="God\'s love endures forever" /></Paragraph>')
// => "God"
```

**Failure scenario:** a Logos note whose content is `God's love endures forever` is returned by `get_user_notes`, `get_clippings`, and the `logos://notebooks/{id}` resource as just `God`. Any English note containing an apostrophe — which is most of them — is silently truncated at the first one, with no error and no indication of loss. This also corrupts the `query` filter of `get_user_notes` (full-text search runs over the already-truncated content, so text after an apostrophe is unsearchable).

**Fix:** match each quote style separately, e.g. `/Text=(?:"([^"]*)"|'([^']*)')/g`, and take whichever group matched. Note `tests/strip-markup.test.ts:55` tests single-quoted attributes but not apostrophes *inside* double-quoted values — add that case.

### Medium

#### M1. `searchCatalog` applies the SQL `LIMIT` before relevance scoring, so the best match can be silently dropped
`src/services/catalog-reader.ts:164-166` and `194-200`

The SQL query orders candidates by `UseCount DESC` and applies `LIMIT ?` (default 25) **in SQL**, and only then re-sorts the surviving rows by `matchScore` (exact/prefix/substring title match) in JavaScript.

**Failure scenario:** a user owns 40+ resources matching `query = "Romans"` via `Title/Description/Subjects LIKE`. The one whose title is exactly "Romans" — the obvious intended hit — has a low `UseCount` (never opened). It is cut by the SQL `LIMIT 25` before `matchScore` ever sees it, and `get_library_catalog` returns 25 frequently-used-but-worse matches instead. The README's own troubleshooting section ("get_library_catalog returns no matches — try broader keywords") suggests this class of confusion has already been observed.

**Fix:** fetch a larger candidate window when `query` is set (e.g. `LIMIT max(limit * 10, 250)`), score, then slice to `limit` — the same pattern `sqlite-reader.ts` already uses for reference filtering (`REFERENCE_SCAN_LIMIT`).

#### M2. Concurrent `get_resource_text` calls race on a shared temp-script path
`src/services/ui-automation-reader.ts:270` and `327-329`

```ts
const scriptPath = join(tmpdir(), `logos-uia-${process.pid}.ps1`);
...
} finally {
  await unlink(scriptPath).catch(() => {});
}
```

The script path depends only on `process.pid`, which is constant for the lifetime of the server. MCP clients can and do issue tool calls concurrently.

**Failure scenario:** two `get_resource_text` calls overlap (e.g. an agent fans out reads over two tabs). Both write the same `logos-uia-<pid>.ps1`; the first call to finish `unlink`s it in its `finally` while the second call's `powershell -File` may not have started reading it yet → the second call fails with "PowerShell execution failed" (file not found), or — since the script content is identical today — becomes a latent breakage the moment the script ever takes per-call content. The two PowerShell instances also both send `PGDN` keystrokes to the same foreground Logos window, interleaving scrolls and producing garbled page merges.

**Fix:** add a uniquifier to the filename (`crypto.randomUUID()`), and consider serializing UI-automation calls behind a simple in-module mutex since they share one physical UI.

#### M3. Windows desktop launches always "succeed", so `auto` mode can report success without opening anything and never engages the web fallback
`src/services/logos-app.ts:29-31` and `77-84`

`rundll32.exe url.dll,FileProtocolHandler <url>` exits 0 regardless of whether the protocol is registered or the URL was handled — it launches fire-and-forget. In `openInLogos`, `auto` mode falls back to the web app only when `launchUrl` *fails* (`attempt.success` false).

**Failure scenario (Windows):** Logos was detected as running (or the `tasklist` check was inconclusive, `running === null`), but the `logos4:` handler is broken/unregistered (the exact situation the README troubleshooting section describes). `rundll32` exits 0, the tool replies "Opened Romans 8 in Logos.", nothing opened, and the web fallback that exists precisely for this case never runs. On macOS this is handled correctly because `open` exits non-zero for an unregistered scheme (and `tests/logos-app.test.ts:225` covers that path) — the Windows launcher has no equivalent signal.

**Fix:** on Windows, verify the protocol registration once (e.g. `reg query HKCR\logos4` at first use) or treat `running === null/true` + rundll32 as "attempted" rather than "succeeded" in the reply wording ("Sent Romans 8 to Logos" vs "Opened").

### Low

#### L1. `stripXml` decodes `&amp;` first, double-decoding nested entities
`src/utils/strip-markup.ts:12-17`

`&amp;` is replaced before `&lt;`/`&gt;`/`&quot;`, so text that literally contains an escaped entity is decoded twice. Verified: `stripXml("use &amp;lt; to escape")` returns `"use < to escape"` (correct output is `use &lt; to escape`). Failure scenario: a catalog description or note discussing XML/HTML markup renders with spurious angle brackets, which then read as (harmless but confusing) markup in the MCP client. Fix: replace `&amp;` **last**.

#### L2. `LIKE` filter metacharacters are not escaped
`src/services/sqlite-reader.ts:281`, `src/services/catalog-reader.ts:151-161`

`notebook_title`, catalog `query`, `type`, and `author` are wrapped in `%...%` without escaping `%`/`_`. Not injection (values are bound parameters), but a user searching for a literal `100%` or `a_b` gets wildcard semantics: `_` matches any character, `%` matches anything. Failure scenario: `get_library_catalog(author: "J_")` matches every two-letter-prefixed author instead of the literal string. Fix: escape with `ESCAPE '\'`.

#### L3. Empty Biblia responses become empty "successes" in `get_bible_text`
`src/services/biblia-api.ts:211-222`, `src/index.ts:152-153`

`getBibleText` never checks that the returned text is non-empty. The Biblia `/content` endpoint returns HTTP 200 with an empty body for passages it cannot resolve (e.g. out-of-range verses such as `John 3:99`, which `parseReference` happily accepts). Failure scenario: the tool replies `**John 3:99** (LEB)` followed by nothing, and an LLM caller may conclude the verse exists but is blank. Fix: treat empty trimmed text as an error ("passage not recognized by the Biblia API").

#### L4. `logToolFailure` logs full tool arguments to stderr
`src/index.ts:56-64`

On any failure the entire `args` object is serialized into the stderr log — including the full input text of `scan_references` (arbitrary user documents) and note-search queries. Not a credential leak (the API key is never in args), but it copies potentially sensitive user study content into whatever log store the MCP client keeps. Failure scenario: a user scans a private manuscript for references while the Biblia key is misconfigured; the whole text lands in Claude Desktop/LM Studio logs. Fix: log arg *keys* or truncate values.

#### L5. Notebook resource reads have no error boundary
`src/index.ts:791-812`

Unlike every tool (wrapped by `register`'s try/catch) and the resource `list` callback (which catches and returns `[]`), the resource **read** callback lets exceptions propagate raw. Failure scenario: a client that cached a notebook URI reads it on a machine where Logos data is missing (or `LOGOS_DATA_DIR` is wrong) and receives a generic JSON-RPC internal error with a filesystem path in the message, instead of the friendly guidance the tools produce. Fix: wrap the read callback and return a markdown body explaining the situation, or rethrow as an MCP error with the same message the tools use.

#### L6. `get_passage_context` silently adds no context for chapter-only references
`src/services/reference-parser.ts:427-430`

`expandRange` returns the input unchanged when `ref.verse` is undefined. Failure scenario: `get_passage_context(passage: "Romans 8", context_verses: 5)` returns exactly Romans 8 while labeling it "context around Romans 8" — misleading but harmless. Fix: either expand to adjacent chapters or say "reference is a whole chapter; returned as-is".

#### L7. A `tab_name` beginning with `-` breaks PowerShell parameter binding
`src/services/ui-automation-reader.ts:281-284`

Arguments after `-File script.ps1` are bound to the script's `param()` block; a `tab_name` like `"-MaxPages"` or any leading-dash string is interpreted as a parameter name, failing the invocation with a confusing binding error. Edge case, Windows-only, cosmetic failure mode. Fix: prefix-match defensively or pass via `-TabName:<value>` form / validate input.

#### L8. README documents a `.env` file that nothing loads
`README.md` step 5 vs `package.json` / `src/config.ts:132`

There is no `dotenv` dependency and no `--env-file` flag anywhere; `BIBLIA_API_KEY` is read straight from `process.env` at module load. Failure scenario: a developer follows step 5, creates `.env`, runs `npm run dev`, and gets "BIBLIA_API_KEY is not set". (Related cosmetic issue: on Linux, `config.ts:14` falls through to the macOS path, so the error message names `~/Library/Application Support/Logos4/...` on a Linux host.) Fix: add `--env-file=.env` to the `dev` script (Node ≥20) or drop the README step.

### Explicitly checked, no finding

- **Command injection:** all launches use `execFile` with arg vectors; Windows URLs go through `rundll32 url.dll,FileProtocolHandler` specifically to avoid `cmd.exe` query-string parsing (regression-tested in `tests/logos-app.test.ts:60`). The PowerShell script is a fixed string; user input enters only as `-TabName`/`-MaxPages` arguments.
- **SQL injection:** all values are bound parameters; dynamic table/column names (schema-discovery paths in `getClippings`/`getPassageLists`/`getTodaysReading`) are escaped via `quoteIdent`; `getHighlightSummary`'s interpolated column comes from a closed two-value enum.
- **Credential leakage:** the Biblia key travels only as a URL query parameter inside `bibliaFetch`; no error message, cache key log, or `logToolFailure` payload includes the URL. `BibliaApiError` messages are built from status + response body only.
- **MCP protocol:** failures are returned as `isError` content (not thrown), annotations distinguish read-only/openWorld/UI tools, stderr (never stdout) is used for logging so stdio framing is safe, and the resource template's `list` callback degrades to an empty list on machines without Logos data.

## Test Coverage Audit

**Run result: 197 tests, 10 files, all passing (3.0s); `tsc --noEmit` clean.** Dependencies installed cleanly via `npm ci`.

### Module → test map

| Source module | Test file | Coverage quality |
|---|---|---|
| `config.ts` | `config.test.ts` (10 tests) | Good — platform matrix, env overrides, ambiguity errors, memoization, LOGOS_MODE parsing |
| `index.ts` | `index.test.ts` (26 tests) | Good on the tools it touches (see gaps below) — registration counts, formatting, error boundary, annotations, schema bounds, prompts, notebook resource |
| `services/biblia-api.ts` | `biblia-api.test.ts` (6 tests) | Partial — `getBibleText` (cache, 403, 429-retry, network failure) and `normalizeBibleId` only |
| `services/reference-parser.ts` | `reference-parser.test.ts` (~60 tests) | Strong — parse forms, aliases, single-chapter books, all output formats, ranges |
| `services/cross-references.ts` | `cross-references.test.ts` (9 tests) | Good — fixture-driven lookup, ranges, chapters, dedupe, votes ordering, availability |
| `services/logos-app.ts` | `logos-app.test.ts` (15 tests) | Strong — per-platform launchers, LOGOS_MODE matrix, process detection, web fallbacks, double-failure |
| `services/sqlite-reader.ts` | `sqlite-readers.integration.test.ts` (15 tests, real SQLite fixtures) | Good — highlights, favorites, workflows, reading progress/today, notes (+filters), clippings, passage lists, summary, notebooks |
| `services/catalog-reader.ts` | `sqlite-readers.integration.test.ts` | Partial — `searchCatalog`, `getResourceTypeSummary`; **not** `getResourceReferenceInfo` / `parseMilestoneIndexes` / `typeLabel` |
| `services/ui-automation-reader.ts` | `ui-automation-reader.test.ts` (14 tests) | Good for the pure parts — `mergePages`, `parseAutomationOutput`, `readResourceText` argument/error paths (execFile mocked; the PowerShell script itself is untestable off-Windows by nature) |
| `utils/strip-markup.ts` | `strip-markup.test.ts` (12 tests) | Partial — happy paths; misses the apostrophe-in-double-quoted-attribute case (finding H1) and nested entities (L1) |
| `utils/bible-anchors.ts` | `bible-anchors.test.ts` (15 tests) | Good — pattern extraction, ranges, dedupe, intersection semantics |
| `types.ts` | n/a | Types only |
| `scripts/fetch-cross-references.mjs` | **none** | Untested |

### Prioritized gaps

1. **`get_resource_references` tool handler is completely untested — and demonstrably outside the harness.** The `catalog-reader` mock in `index.test.ts:163-167` doesn't even stub `getResourceReferenceInfo`; if any existing test invoked that handler it would crash. The underlying `getResourceReferenceInfo`/`parseMilestoneIndexes` (tab-separated `Reference;bible;1000` parsing, `catalog-reader.ts:209-249`) are also uncovered by the integration suite. This is the only tool whose full stack has zero coverage besides `get_resource_text`'s Windows-only script.
2. **Biblia API surface beyond `getBibleText`:** `searchBible`, `scanReferences`, `comparePassages`, and `getAvailableBibles` (`biblia-api.ts:224-293`) have no direct tests — including their defaulting behavior on malformed payloads (`data.results ?? []` etc.) and `searchBible`'s `mode`/`limit` parameter passing. They are exercised only through `index.test.ts` with the whole module mocked out.
3. **`strip-markup` edge cases that hide real bugs:** the two confirmed findings (H1 apostrophe truncation, L1 entity double-decode) both live exactly in the untested gap of an otherwise-tested module. Regression tests for `Text="...'..."` and `&amp;lt;` should land with the fixes.
4. **Untested tool handlers in `index.ts`:** `get_passage_context` (its `expandRange` is mocked to a constant), `compare_passages`, `get_available_bibles`, `get_favorites`, `get_reading_progress`, `get_study_workflows`, `open_word_study`, `open_guide`, `get_resource_text`. Most are thin formatters over tested services, so these are lower priority than 1-3 — but `compare_passages`' six-relation formatting and `get_study_workflows`' two-section assembly have enough logic to merit one test each.
5. **`scripts/fetch-cross-references.mjs`:** the hand-rolled ZIP extraction and OSIS→numeric conversion have no tests. It's dev-time tooling against a fixed URL, so risk is low, but `unzipFirstEntry` (raw offset arithmetic) would fail obscurely if openbible.info ever restructures its archive; a fixture ZIP test would make that failure legible.
6. **Concurrency:** no test covers parallel tool invocations (relevant to finding M2 and the shared Biblia response cache).

## Recommendations

1. **Fix H1 now** (one-line regex change + two regression tests). It corrupts the highest-value data this server exposes — the user's own notes.
2. **Fix M1** with the existing scan-window pattern from `sqlite-reader.ts`; add an integration test where the exact-title match has the lowest `UseCount` among >limit matches.
3. **Fix M2** with `randomUUID()` in the temp filename (one line) and consider a per-module mutex for UI automation.
4. **Reword Windows launch success or verify protocol registration** (M3) so `auto` mode's web fallback can actually trigger on broken `logos4:` handlers.
5. Batch the Low findings (L1-L3, L5) into one cleanup PR — all are small, local fixes.
6. Close test gaps in priority order 1→3 above; they are cheap (existing fixture/mock infrastructure covers all of them) and gap 1 currently means a whole tool could break without any test noticing.
7. Either wire up `.env` loading (`node --env-file`) or remove README step 5 to stop a guaranteed first-run stumble for contributors.
