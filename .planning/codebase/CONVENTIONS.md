# Coding Conventions

**Analysis Date:** 2026-08-05

## Language & Module System

**Runtime:** Cloudflare Workers (V8 isolate, `nodejs_compat` flag)
**Module format:** ES modules everywhere — `.js` for worker code (`src/`), `.mjs` for GitHub Actions scripts (`scripts/`)
**Imports:** Bare specifiers, always with `.js` extension: `import { loadConfig } from "./config.js"`
**No TypeScript:** Entire codebase is plain JavaScript

## Naming Patterns

**Files:**
- `src/`: lowercase, single-word or hyphenated: `config.js`, `configure.js`, `dispatch.js`, `routes.js`, `index.js`
- `scripts/`: lowercase, hyphenated: `dry-test.mjs`, `verify-ui.mjs`, `scrape.mjs`, `official.mjs`
- `data/`: catalog files use prefixed snake_case: `mdboff_<slug>_<type>.json`, `mdb_scrape_<id>.json`

**Functions:**
- camelCase always: `loadConfig`, `buildManifest`, `handleCatalog`, `handleSaveConfig`
- Route handlers prefixed `handle`: `handleStatus`, `handleRunsPost`, `handleExportConfig`
- Utility functions use verb-noun: `toIST`, `rowToMeta`, `rowToMetaOfficial`, `emptyConfig`
- Private/inner helpers: lowercase single words or camelCase: `json()`, `html()`, `check()`, `arg()`
- Migrations prefixed `migrate`: `migrateConfig`, `migrateOfficial`
- Seed/default functions: `seedScraperDefaults`, `officialDefaults`

**Variables:**
- camelCase: `catalogId`, `maxPages`, `officialCatalogs`, `runsKeyFor`
- Constants: UPPER_SNAKE_CASE for module-level fixed values: `CONFIG_KEY`, `RUNS_MAX`, `RANDOM_ID_CHARS`, `CATALOG_RE`, `OFFICIAL_LISTS`, `OFFICIAL_CATALOGS`
- Environment-like config: UPPER_SNAKE_CASE matches wrangler.toml: `GH_TOKEN`, `GH_REPO`, `GH_WORKFLOW`, `GITHUB_PAGES_BASE`

**Data structures:**
- Config shape: `{ scraper: { lists: [...] }, official: { lists: [...] } }`
- List shape: `{ id, name, url, type, maxPages, enabled }` (scraper), `{ slug, name, enabled }` (official)
- Run record shape: `{ id, catalog_id, started_at, finished_at, pages_scraped, movies_found, status, error_message, triggered_by }`
- IDs prefixed by module: `mdb_scrape_*` (scraper), `mdboff_*` (official)

## Code Style

**Formatting:**
- No formatter/linter configured — no `.eslintrc`, `.prettierrc`, `biome.json`, or `tsconfig.json`
- Consistent manual style: 2-space indentation, double quotes for strings, semicolons present
- Trailing commas in multiline object/array literals
- Short single-line functions where readable: `function json(body, status = 200, extraHeaders = {}) {`

**Comments:**
- `//` comments only — no JSDoc, no `/** */` blocks
- Top-of-file module docstring: brief purpose statement in 1-3 sentences
- Inline comments explain "why" not "what": `// note: read-modify-write has no lock - concurrent saves can clobber`
- Section dividers: `// ── section name ───` style with em-dash
- Comments mark intentional gaps: `ponytail:` pattern NOT used (no such comments found)

## Import Organization

**Order:**
1. Node builtins: `import { createHash } from "node:crypto"`
2. Local modules: `import { loadConfig } from "./config.js"`
3. Third-party: `import puppeteer from "puppeteer-extra"`

**No path aliases.** All imports relative with `./` or `../`.

## Error Handling

**Pattern:** try/catch with early returns or fallback values, never throw to caller from route handlers.

**Worker routes (`src/index.js`, `src/routes.js`):**
- Route handlers return `Response` objects directly — never throw
- Validation errors: `json({ error: "message" }, 400)`
- Not found: `json({ error: "Not found" }, 404)` or `json({ metas: [] }, 200)`
- Catch-all in `handleSaveConfig`: `catch (e) { return json({ error: "Save failed." }, 500) }`
- External service failures: return empty/neutral response (e.g., catalog fetch failure returns `{ metas: [] }`)
- GH dispatch failure: return 502 with reason, do NOT persist config

**Scripts (`scripts/scrape.mjs`, `scripts/official.mjs`):**
- `main().catch((err) => { console.error("Fatal error:", err); process.exit(1); })`
- Per-list errors logged but don't abort other lists
- `process.exitCode = 1` for soft failures (e.g., run POST fails)
- `process.exit(1)` for hard failures (missing env vars, all lists failed)

**Config migration (`src/config.js`):**
- Defensive: every field validated and clamped on read
- Corrupt KV: `catch { raw = null }` — fall back to seeds, never 500
- ID validation: regex guard against path traversal: `mdb_scrape_[A-Za-z0-9_-]{1,32}`

## Input Validation

**Always at the boundary:**
- `handleSaveConfig`: checks `body.scraper` and `Array.isArray(body.scraper.lists)` before proceeding
- `handleRunsPost`: checks `Array.isArray(body.runs)` and caps at 50
- `migrateConfig`: clamps `maxPages` to `1..50`, forces `type` to `"movie"|"series"`, trims `name` to 200 chars
- Catalog ID validation via regex: no `/`, `\`, or `..` in IDs
- URL validation in `scrape.mjs`: must be `mdblist.com` with correct path prefix

**No request body size limit at the worker level** (Cloudflare Workers default applies).

## Logging

**Framework:** `console.log` / `console.warn` / `console.error` — no structured logging

**Worker:** Minimal logging — errors go to catch blocks, no request logging
**Scripts:** Bracketed prefixes: `[${list.id}]`, `[warmUp]`, `[debug]`, `[runs]`
**CI (GitHub Actions):** Uses `echo` for step summaries

## Comments

**When to comment:**
- Top of every file: purpose + architecture note
- Before non-obvious logic: the "read-modify-write has no lock" comment in `handleSaveConfig`
- When deliberately accepting a limitation: `accepted for a single-operator admin page`
- Before regex patterns: explain what they match
- In scripts: document required env vars and usage at top of file

**No JSDoc/TSDoc.** No type annotations.

## Function Design

**Size:** Most functions under 50 lines. `buildConfigurePage` is the exception at ~850 lines (entire HTML/CSS/JS template as a template literal — intentional, not a decomposition candidate given it's a self-contained page).

**Parameters:**
- Route handlers take `(env, request)` or `(env, ...specificArgs)`
- Helper functions take focused args: `buildPageUrl(sourceUrl, page)`, `writeCatalog(list, movies)`
- Destructuring used for config-like objects: `{ lists = [], action = "scrape", ... } = {}`

**Return values:**
- Route handlers: always `Response` objects via `json()` or `html()`
- Pure functions: primitives, objects, or `null`
- Async functions return promises naturally

## Module Design

**Exports:**
- Named exports only — no default exports (except `src/index.js` which exports the Cloudflare handler as `default`)
- Exported constants at module top: `ADDON_ID`, `CATALOG_RE`, `OFFICIAL_CATALOGS`
- Internal helpers not exported: `rowToMeta`, `rowToMetaOfficial`, `html`, `corsHeaders`

**Barrel files:** None

**Circular imports:** None — clear dependency tree: `index.js` → `routes.js` → `config.js`, `dispatch.js`, `configure.js`

## Anti-Patterns to Avoid

**Duplicating `corsHeaders` / `json()`:** Both `src/index.js` and `src/routes.js` define their own `corsHeaders` and `json()`. Follow the pattern in whichever file you're editing — do NOT refactor to share (the duplication is deliberate; `index.js` is a thin shim).

**Adding a build step:** The worker is plain JS bundled by Wrangler. Do not add TypeScript, Babel, or any transpilation.

**Adding dependencies to `src/`:** Worker code has zero npm dependencies. Keep it that way. Only `scripts/` has dependencies (puppeteer).

**Treating config as immutable in handler code:** Config is read from KV, modified in-memory, then written back. The read-modify-write pattern is acknowledged as non-atomic. Do not add locking — the constraint is single-operator.

---

*Convention analysis: 2026-08-05*
