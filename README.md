# Logos Bible Software MCP Server + Socratic Bible Study Agent

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects any MCP-compatible AI frontend to [Logos Bible Software](https://www.logos.com/), plus a custom Socratic Bible study agent for guided theological dialogue.

Works with **Claude Code**, **LM Studio**, **VS Code + GitHub Copilot**, **Claude Desktop**, **Cursor**, and [100+ other MCP clients](https://modelcontextprotocol.io/clients).

## What This Does

- **26 MCP tools** that let your AI assistant read and compare Bible text, search Scripture, look up curated cross-references, navigate Logos, access your notes/highlights/favorites/clippings/passage lists, check reading plans, explore word studies and factbook entries, search your library catalog, open commentaries and lexicons, run cross-resource searches, and read text from open resource panels
- **3 MCP prompts** (`socratic-study`, `word-study`, `passage-overview`) — guided study workflows available from any MCP client that supports prompts
- **MCP resources** exposing your Logos notebooks (`logos://notebooks/{id}`) so a whole notebook can be pulled into context at once
- **A Socratic Bible Study agent** (Claude Code only) that guides you through Scripture using questions (not lectures), welcoming any denominational background, with four questioning layers: Observation, Interpretation, Correlation, and Application

## Tool Requirements

| Tool group | Requires Logos desktop data | Requires Logos UI | Requires `BIBLIA_API_KEY` |
|------------|-----------------------------|-------------------|---------------------------|
| `navigate_passage`, `open_word_study`, `open_factbook`, `open_resource`, `open_guide`, `search_all` | No | Yes | No |
| `get_user_notes`, `get_user_highlights`, `get_favorites`, `get_clippings`, `get_passage_lists`, `get_reading_progress`, `get_todays_reading`, `get_study_workflows`, `get_library_catalog`, `get_resource_types`, `get_resource_references` | Yes | No | No |
| `get_bible_text`, `get_passage_context`, `search_bible`, `compare_passages`, `get_available_bibles`, `scan_references` | No | No | Yes |
| `get_cross_references` | No | No | Only as fallback (see [Cross-reference dataset](#cross-reference-dataset-optional)) |
| `normalize_reference` | No | No | No |
| `get_resource_text` | No | Yes | No |

> **"Requires Logos UI" tools fall back to the Logos web app.** When the desktop app isn't running (or isn't installed — including on Linux), the UI tools open the same target in [app.logos.com](https://app.logos.com/) / [ref.ly](https://ref.ly/) in your default browser instead. Control this with the `LOGOS_MODE` environment variable: `auto` (default — desktop when running, web otherwise), `desktop` (never fall back), or `web` (always use the web app). Passage navigation, resource opening, and search deep-link cleanly; Factbook, word study, and guides open the right web-app section but may need the topic re-entered there. A [Logos account](https://app.logos.com/) with the resource in your library is needed for web resource reading.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **Windows or macOS** | Both platforms supported (Linux works too: UI tools open the Logos **web app**, and Biblia-backed tools are platform-independent) |
| **Logos Bible Software** | Installed and signed in (tested with v48) — *optional*: without it, UI tools fall back to [app.logos.com](https://app.logos.com/) and local-data tools are unavailable |
| **Node.js** | v18+ (v23+ recommended for native `fetch` support) |
| **An MCP client** | Claude Code, LM Studio, VS Code + Copilot, Claude Desktop, Cursor, or any [MCP-compatible app](https://modelcontextprotocol.io/clients) |
| **Biblia API Key** | Free key from [bibliaapi.com](https://bibliaapi.com/) |

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/CyberCwby/LogosBibleSoftwareMCP.git
cd LogosBibleSoftwareMCP
```

### 2. Install dependencies and build

```bash
cd logos-mcp-server
npm install
npm run build
cd ..
```

### 3. Get a Biblia API key

1. Go to [bibliaapi.com](https://bibliaapi.com/)
2. Sign up for a free account
3. Copy your API key

### 4. Configure your MCP client

Choose your client below. Each needs the path to the built server and your Biblia API key.

> **Path note:** Claude Code and VS Code use project-relative paths (since config lives in the project). LM Studio, Claude Desktop, and Cursor use **absolute paths** (since config is global). Replace `/absolute/path/to/LogosBibleSoftwareMCP` with your actual project path.

> **Your API key goes in a file git ignores.** Every in-project config below
> (`.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`) is matched by the
> `**/mcp.json` rule in `.gitignore`, so `git add -A` cannot publish your key.
> Only `.mcp.json` used to be ignored, which made the VS Code and Cursor
> instructions a way to commit a personal key to a fork. If you would rather
> not have the key on disk at all, VS Code supports `"${input:biblia-key}"` in
> place of the literal value, and every client can read it from the
> environment instead.

<details>
<summary><strong>Claude Code</strong></summary>

Create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "logos": {
      "command": "node",
      "args": ["logos-mcp-server/dist/index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Verify: run `claude`, then type `/mcp` to check that the "logos" server appears with 26 tools.

</details>

<details>
<summary><strong>LM Studio</strong></summary>

Requires LM Studio **v0.3.17+** ([download](https://lmstudio.ai/download)).

1. Open LM Studio
2. Go to the **Program** tab in the right sidebar
3. Click **Install > Edit mcp.json**
4. Add the logos server entry:

**Windows:**

```json
{
  "mcpServers": {
    "logos": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USER\\path\\to\\LogosBibleSoftwareMCP\\logos-mcp-server\\dist\\index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**macOS:**

```json
{
  "mcpServers": {
    "logos": {
      "command": "node",
      "args": ["/Users/YOUR_USER/path/to/LogosBibleSoftwareMCP/logos-mcp-server/dist/index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

5. Save the file — LM Studio will auto-load the server
6. The 26 tools will appear when you start a chat with a tool-capable model

The `mcp.json` file lives at:
- **macOS/Linux:** `~/.lmstudio/mcp.json`
- **Windows:** `%USERPROFILE%\.lmstudio\mcp.json`

See [LM Studio MCP docs](https://lmstudio.ai/docs/app/mcp) for more details.

</details>

<details>
<summary><strong>VS Code + GitHub Copilot</strong></summary>

Create `.vscode/mcp.json` in the project root:

```json
{
  "servers": {
    "logos": {
      "command": "node",
      "args": ["logos-mcp-server/dist/index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

The tools will be available in Copilot's agent mode (Ctrl+Alt+I).

See [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) for more details.

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Edit the config file at:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add (or merge into existing config):

**Windows:**

```json
{
  "mcpServers": {
    "logos": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USER\\path\\to\\LogosBibleSoftwareMCP\\logos-mcp-server\\dist\\index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**macOS:**

```json
{
  "mcpServers": {
    "logos": {
      "command": "node",
      "args": ["/Users/YOUR_USER/path/to/LogosBibleSoftwareMCP/logos-mcp-server/dist/index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Restart Claude Desktop after editing. See [Claude Desktop MCP docs](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) for more details.

</details>

<details>
<summary><strong>Cursor</strong></summary>

Create `.cursor/mcp.json` in the project root (or `~/.cursor/mcp.json` for global access):

```json
{
  "mcpServers": {
    "logos": {
      "command": "node",
      "args": ["logos-mcp-server/dist/index.js"],
      "env": {
        "BIBLIA_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

See [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol) for more details.

</details>

### 5. Create `.env` in `logos-mcp-server/` (optional, for development)

```
BIBLIA_API_KEY=your_api_key_here
```

Only `npm run dev` (run from `logos-mcp-server/`) loads this file, via Node's
`--env-file-if-exists` flag (requires Node 22.9+). MCP clients do **not** read
it — they pass environment variables through the `env` block of their config,
as shown in the client setup sections above.

### 6. Rebuild after source changes

LM Studio, Claude Desktop, and other MCP clients launch the built server entrypoint, not the TypeScript source files.

```bash
cd logos-mcp-server
npm run build
```

If you change anything under `src/`, rebuild before retesting the MCP server in your client.

## Available Tools

### Bible Text & Reading
Tools for retrieving, reading, and comparing Bible text

| Tool | What it does |
|------|-------------|
| `get_bible_text` | Retrieves passage text (LEB default; also KJV, ASV, DARBY, YLT, WEB) — pass `bibles: ["LEB", "KJV"]` to compare translations side by side |
| `get_passage_context` | Gets a passage with surrounding verses for context |
| `compare_passages` | Compares two Bible references for overlap, subset, or ordering |
| `get_available_bibles` | Lists all Bible versions available for text retrieval |
| `normalize_reference` | Validates a reference and returns it in every format the other tools accept (canonical, Logos URL, Biblia, bible milestone) |

### Navigation & UI
Tools that open things in the Logos desktop app

| Tool | What it does |
|------|-------------|
| `navigate_passage` | Opens a passage in the Logos UI |
| `open_word_study` | Opens a word study in Logos (Greek/Hebrew/English) |
| `open_factbook` | Opens a Factbook entry for a person, place, event, or topic |
| `open_resource` | Opens a specific commentary, lexicon, or other resource in Logos — accepts normal Bible references ("Jeremiah 1:1") or Logos milestones ("page.271") |
| `open_guide` | Opens an Exegetical Guide or Passage Guide for a Bible passage |

### Search & Discovery
Tools for searching Bible text and library resources

| Tool | What it does |
|------|-------------|
| `search_bible` | Searches Bible text for words, phrases, or topics |
| `get_cross_references` | Returns curated cross-references from the openbible.info dataset (see below); falls back to Biblia keyword search |
| `scan_references` | Finds Bible references embedded in arbitrary text |
| `search_all` | Searches across ALL resources in your library (not just Bible text) |

#### Cross-reference dataset (optional)

`get_cross_references` works best with the curated [openbible.info cross-references](https://www.openbible.info/labs/cross-references/) dataset (~340,000 community-voted verse links, Creative Commons Attribution license). Download it once:

```bash
cd logos-mcp-server
npm run fetch-xrefs
```

This writes `logos-mcp-server/data/cross-references.tsv.gz` (~2 MB). With the dataset in place, cross-references are offline, instant, and need no API key. Without it, the tool falls back to keyword search through the Biblia API.

### Library & Resources
Tools for browsing your owned library catalog

| Tool | What it does |
|------|-------------|
| `get_library_catalog` | Searches your owned resources (commentaries, lexicons, etc.) by type, author, or keyword |
| `get_resource_types` | Shows a summary of resource types and counts in your library |
| `get_resource_references` | Returns the available reference/navigation types (milestones) for a resource |
| `get_resource_text` | ⚠️ **Experimental** — Reads the visible text from a resource panel open in Logos (Windows only; see note below) |

> **⚠️ `get_resource_text` is experimental.** Logos resource files are encrypted and there is no official API for reading resource text. This tool is a makeshift workaround that uses the Windows UI Automation accessibility API to scrape text from whatever is currently rendered on screen in an open Logos panel. It has significant limitations: it only captures visible/rendered text (~2,000 chars per screenful), scrolling requires bringing Logos to the foreground and sending keystrokes, text is plain with no structure, and it will not work on macOS. Use `open_resource` to navigate to the desired section first, then call this tool to read what's showing — it polls briefly for the panel to finish rendering, focuses the document panel before scrolling, and automatically merges the overlapping text between scrolled pages.

### Personal Study Data
Tools for accessing your notes, highlights, favorites, and reading progress

| Tool | What it does |
|------|-------------|
| `get_user_notes` | Reads your study notes with anchored Bible references; filter by notebook, reference (e.g., "Romans 8"), or full-text `query` |
| `get_user_highlights` | Reads your highlights as Bible references; filter by resource, style, or reference — or set `group_by` for a count summary |
| `get_favorites` | Lists your saved favorites/bookmarks |
| `get_clippings` | Reads your saved clippings (excerpts collected from resources) |
| `get_passage_lists` | Reads your passage lists (curated collections of Bible references) |
| `get_reading_progress` | Shows your reading plan status |
| `get_todays_reading` | Shows the next unread items in each active reading plan |

### Study Workflows
Tools for structured study paths

| Tool | What it does |
|------|-------------|
| `get_study_workflows` | Lists available study workflow templates and active instances |

## MCP Prompts & Resources

Beyond tools, the server exposes:

- **Prompts** — guided study workflows any prompt-capable MCP client can invoke: `socratic-study` (four-layer Socratic dialogue on a passage), `word-study` (original-language word survey), and `passage-overview` (quick orientation: text, context, cross-references, and your own study data)
- **Resources** — your Logos notebooks, listed under `logos://notebooks/{id}`; reading one returns every note in the notebook as markdown, so a whole notebook can be pulled into context in one step

## Using the Socratic Bible Study Agent (Claude Code only)

Start Claude Code in the project directory, then:

```
/agent socratic-bible-study
```

The agent will ask what you want to study and guide you through Scripture using the Socratic method. It's tradition-neutral -- it works with any denominational background and presents multiple perspectives where Christians disagree. It guides you through four layers:

1. **Observation** - "What does the text say?"
2. **Interpretation** - "What does the text mean?"
3. **Correlation** - "How does this relate to the rest of Scripture?"
4. **Application** - "What does this mean for us?"

### Example session starters

- "Let's study Romans 8:28-30"
- "I want to do a word study on 'justification'"
- "What does the Bible teach about grace?"
- "Walk me through Psalm 23"

## Project Structure

```
LogosBibleSoftwareMCP/
├── .claude/
│   └── agents/
│       └── socratic-bible-study.md    # Socratic agent definition (Claude Code)
├── .mcp.json                          # Claude Code MCP config (you create this; gitignored)
├── .vscode/
│   └── mcp.json                       # VS Code + Copilot MCP config (you create this; gitignored)
├── LICENSE
├── logos-mcp-server/
│   ├── .env                           # API key for `npm run dev` (you create this)
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                   # MCP server entry point (26 tools, prompts, resources)
│   │   ├── config.ts                  # Lazy path resolution, API config, constants
│   │   ├── types.ts                   # Shared TypeScript types
│   │   ├── services/
│   │   │   ├── reference-parser.ts    # Bible reference normalization
│   │   │   ├── biblia-api.ts          # Biblia.com REST API client
│   │   │   ├── cross-references.ts    # Curated cross-reference dataset lookup
│   │   │   ├── logos-app.ts           # Cross-platform URL scheme & process detection
│   │   │   ├── sqlite-reader.ts       # Read-only Logos SQLite access
│   │   │   ├── catalog-reader.ts      # Library catalog search (catalog.db)
│   │   │   └── ui-automation-reader.ts # Windows UI Automation text scraping (experimental)
│   │   └── utils/
│   │       ├── strip-markup.ts        # XML / rich-text stripping helpers
│   │       └── bible-anchors.ts       # Parse Bible references from note/highlight anchors
│   ├── scripts/
│   │   └── fetch-cross-references.mjs # Downloads the openbible.info dataset (npm run fetch-xrefs)
│   ├── data/                          # Generated cross-reference dataset (gitignored)
│   ├── tests/                         # Vitest unit and integration tests
│   └── dist/                          # Built output (after npm run build)
```

## How It Works

The MCP server integrates with Logos through four channels:

- **Biblia API** - Retrieves Bible text and search results via the free REST API from Faithlife (same company as Logos)
- **URL schemes** - Opens passages, word studies, and factbook entries directly in the Logos app using `logos4:///` URLs (uses `open` on macOS, `start` on Windows)
- **SQLite databases** - Reads your personal data (notes, highlights, favorites, workflows, reading plans) and library catalog directly from the Logos local database files (read-only access, never modifies your data)
- **Windows UI Automation** *(experimental)* - `get_resource_text` uses the Windows accessibility API to scrape rendered text from open resource panels. Logos resource files are proprietary and encrypted, so there is no supported way to read their content programmatically — this is a makeshift workaround with real limitations (Windows-only, visible text only, requires Logos to be in the foreground for multi-page reads)

## Logos Data Path

The server auto-detects your Logos data directory on both platforms:

| Platform | Default location |
|----------|------------------|
| **macOS** | `~/Library/Application Support/Logos4/Documents/{user-hash}/` |
| **Windows** | `%LOCALAPPDATA%\Logos\Documents\{user-hash}\` |

The user-hash folder is discovered automatically. If auto-detection cannot find a unique match or you need a custom path, set `LOGOS_DATA_DIR` and/or `LOGOS_CATALOG_DIR` in the `env` block of your MCP client's config:

```json
"env": {
  "BIBLIA_API_KEY": "your_key",
  "LOGOS_DATA_DIR": "/path/to/your/Logos/Documents/xxxx",
  "LOGOS_CATALOG_DIR": "/path/to/your/Logos/Data/xxxx"
}
```

## Troubleshooting

**"BIBLIA_API_KEY is not set"** - Make sure your MCP config has the `env` block with your API key.

**"Database not found"** - Your Logos data path may differ. The server auto-detects the user-hash folder, but if detection cannot find a unique match, find your databases manually and set `LOGOS_DATA_DIR`:
- **macOS:** `find ~/Library/Application\ Support/Logos4 -name "*.db" -maxdepth 5`
- **Windows (PowerShell):** `Get-ChildItem "$env:LOCALAPPDATA\Logos" -Recurse -Filter *.db | Select-Object FullName`

**Tools don't appear** - Restart your MCP client. MCP servers are loaded at startup from the config file. For LM Studio, re-save the `mcp.json` file to trigger a reload.

**"Logos does not appear to be running"** - In the default `auto` mode, the UI tools fall back to the Logos web app when the desktop app isn't running, so this error only appears with `LOGOS_MODE=desktop`. Start Logos Bible Software and retry, or unset `LOGOS_MODE` to allow the web fallback.

**UI tools open the browser instead of Logos** - The desktop app wasn't detected, so the tool used the web fallback. Make sure Logos is running (and set `LOGOS_MODE=desktop` if you never want the browser).

**Windows: `search_all` or `open_guide` fails with a shell syntax error** - Symptoms look like Windows interpreting part of a Logos URL query string as a command. Checks:

1. Rebuild the server with `npm run build` so your MCP client is using the latest launcher logic.
2. Confirm Logos is installed and the `logos4:` protocol is still registered on Windows.
3. Retry a simple UI tool such as `open_factbook` or `navigate_passage` to confirm the protocol handler works at all.

**Biblia-backed tools return 403 or authentication failures** - Affected tools include `get_bible_text`, `get_passage_context`, `search_bible`, `get_cross_references`, `compare_passages`, `get_available_bibles`, and `scan_references`. Checks:

1. Confirm `BIBLIA_API_KEY` is present in your MCP client configuration.
2. Restart the MCP client after editing the environment variables.
3. Verify the key is still valid at [bibliaapi.com](https://bibliaapi.com/).
4. If you hit rate limits, wait and retry instead of repeatedly sending the same request.

**`get_library_catalog` returns no matches** - The library catalog tool searches your local Logos `catalog.db` directly. Zero results do not necessarily mean Logos needs to rebuild an index. Try:

1. Broader keywords before combining multiple filters.
2. An author-only search to confirm the database is being read.
3. A type filter such as `commentary`, `lexicon`, or `dictionary`.
4. Setting `LOGOS_CATALOG_DIR` explicitly if your Logos data is installed in a non-default location.

**LM Studio: tools use too many tokens** - Some MCP tools return large responses. If you hit context overflow, try using a model with a larger context window, or ask for shorter/specific passages.

## License

MIT — see [LICENSE](LICENSE).

Cross-reference data (when downloaded via `npm run fetch-xrefs`) comes from the [openbible.info cross-references project](https://www.openbible.info/labs/cross-references/) and is used under its Creative Commons Attribution license.
