# Codebase Structure

**Analysis Date:** 2026-08-05

## Directory Layout

```
my-list/
├── src/                    # Cloudflare Worker source (deployed)
│   ├── index.js            # HTTP entry point, route dispatch
│   ├── config.js           # KV config storage, migration, official list defs
│   ├── routes.js           # Route handlers (manifest, catalog, status, etc.)
│   ├── dispatch.js         # GitHub Actions workflow dispatch
│   └── configure.js        # Full-page HTML config UI (inline CSS/JS)
├── data/                   # Catalog JSON files (committed, served via GitHub Pages)
│   ├── mdb_scrape_*.json   # Scraper module data files
│   └── mdboff_*.json       # Official module data files
├── scripts/                # GitHub Actions runner scripts (Node.js 22)
│   ├── scrape.mjs          # Puppeteer scraper for mdblist.com
│   ├── official.mjs        # MDBList API fetcher for official lists
│   ├── dry-test.mjs        # Local testing harness (gitignored)
│   ├── verify-ui.mjs       # UI verification script (gitignored)
│   ├── package.json        # Scripts dependencies (puppeteer-extra)
│   └── package-lock.json
├── .github/workflows/      # GitHub Actions workflow definitions
│   ├── scrape.yml          # Scraper workflow (cron + dispatch)
│   └── official.yml        # Official lists workflow (cron + dispatch)
├── wrangler.toml           # Cloudflare Workers config (KV binding, env vars)
├── .gitignore              # Excludes node_modules, .wrangler, debug, scripts/*-test
└── .planning/codebase/     # Codebase analysis documents
```

## Directory Purposes

**src/:**
- Purpose: Cloudflare Worker source code — deployed via `wrangler deploy`
- Contains: 5 JavaScript modules, no TypeScript, no build step (wrangler uses esbuild internally)
- Key files: `index.js` (entry), `config.js` (largest at 210 lines), `routes.js` (344 lines)

**data/:**
- Purpose: Static JSON catalog data files, committed to Git, served via GitHub Pages
- Contains: One JSON file per catalog. Scraper files (`mdb_scrape_*.json`), official files (`mdboff_*_*.json`)
- Key files: `mdb_scrape_1djyii3b.json` (78 KB), `mdb_scrape_cwqwfd58.json` (74 KB), `mdb_scrape_ogu4jkeo.json` (72 KB)

**scripts/:**
- Purpose: Node.js scripts run by GitHub Actions, not deployed with worker
- Contains: Scraper (`scrape.mjs`), official fetcher (`official.mjs`), test scripts (gitignored)
- Key files: `scrape.mjs` (17 KB, puppeteer), `official.mjs` (6 KB, API), `package.json` (deps)

**.github/workflows/:**
- Purpose: CI/CD workflow definitions — cron schedules and dispatch triggers
- Contains: Two workflows (scrape.yml, official.yml), both commit data back to repo

## Key File Locations

**Entry Points:**
- `src/index.js`: Worker HTTP entry — handles all incoming requests
- `scripts/scrape.mjs`: Scraper entry — invoked by `scrape.yml` workflow
- `scripts/official.mjs`: Official lists entry — invoked by `official.yml` workflow

**Configuration:**
- `wrangler.toml`: Cloudflare Worker config — KV binding (`STORE`), env vars (`GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`)
- `scripts/package.json`: Node.js dependencies for scraper scripts

**Core Logic:**
- `src/config.js`: Config storage, migration, seeded defaults, official list constants
- `src/routes.js`: All HTTP route handlers — manifest, catalog, status, save-config, trigger-refresh, runs
- `src/dispatch.js`: Single function `dispatchScraperWorkflow()` — GitHub API call
- `src/configure.js`: Full HTML page with inline CSS/JS for admin config UI

**Testing:**
- `scripts/dry-test.mjs`: Local scraper test harness (gitignored)
- `scripts/verify-ui.mjs`: UI verification script (gitignored)

## Naming Conventions

**Files:**
- Worker source: `camelCase.js` (`config.js`, `routes.js`, `dispatch.js`, `configure.js`)
- Scripts: `camelCase.mjs` with `.mjs` extension (ESM) — `scrape.mjs`, `official.mjs`, `dry-test.mjs`
- Data files: `<module>_<catalog_id>.json` — `mdb_scrape_1djyii3b.json`, `mdboff_popular_movie.json`
- Workflows: `kebab-case.yml` — `scrape.yml`, `official.yml`

**Directories:**
- All lowercase, no hyphens: `src/`, `data/`, `scripts/`, `.github/`

**Functions:**
- `camelCase` throughout — `loadConfig()`, `buildManifest()`, `handleCatalog()`, `dispatchScraperWorkflow()`
- Route handlers prefixed with `handle` — `handleCatalog()`, `handleStatus()`, `handleSaveConfig()`

**Constants:**
- `UPPER_SNAKE_CASE` — `CONFIG_KEY`, `RUNS_MAX`, `OFFICIAL_LISTS`, `CATALOG_RE`, `GH_API`
- Exported constants in `routes.js` use `PascalCase` — `ADDON_ID`, `ADDON_NAME`, `ADDON_VERSION`

**Catalog IDs:**
- Scraper: `mdb_scrape_<8-char-hash>` — deterministic from URL SHA-256
- Official: `mdboff_<slug>_<movie|show>` — fixed, never changes

## Where to Add New Code

**New Scraper List:**
- Add to `SEED_LISTS` array in `src/config.js` (if seeded) or add via admin UI `/configure`
- Data file appears as `data/<catalog_id>.json` after next scrape run
- No code changes needed for user-defined lists — config-driven

**New Official List:**
- Add slug to `OFFICIAL_LISTS` in `src/config.js` — automatically creates movie + show catalogs
- Add API endpoint handling in `scripts/official.mjs`
- Update `OFFICIAL_CATALOGS` derivation (currently computed from `OFFICIAL_LISTS`)

**New Worker Route:**
- Add route match in `src/index.js` (pathname check chain)
- Add handler function in `src/routes.js`
- Add imports to `src/index.js` if handler is in a different module

**New Configuration Field:**
- Add to `emptyConfig()` and `migrateConfig()` in `src/config.js`
- Update `buildConfigurePage()` in `src/configure.js` to expose in UI
- Update `buildManifest()` in `src/routes.js` if field affects Stremio output

**New Scraper Feature:**
- Add to `scripts/scrape.mjs` — parsing, pagination, or data transformation
- Pass new workflow inputs via `src/dispatch.js` `payloadInputs`
- Add input to `.github/workflows/scrape.yml` workflow_dispatch

**New Script (local testing):**
- Add `scripts/<name>.mjs`
- Add to `.gitignore` (pattern: `scripts/<name>.mjs`)
- Keep dependencies in `scripts/package.json`

## Special Directories

**data/:**
- Purpose: Catalog JSON data files — each file is one catalog's full dataset
- Generated: Yes (by GitHub Actions scripts)
- Committed: Yes (via `git commit` in workflow, pushed to repo)
- Note: Files are ~23-78 KB each. Adding many catalogs increases repo size.

**.wrangler/:**
- Purpose: Cloudflare Wrangler local dev cache
- Generated: Yes (by `wrangler dev`)
- Committed: No (in `.gitignore`)

**debug/:**
- Purpose: Scraper debug output (HTML snapshots, screenshots)
- Generated: Yes (by `scrape.mjs --debug`)
- Committed: No (in `.gitignore`), uploaded as GitHub Actions artifacts (7-day retention)

**scratch/:**
- Purpose: Developer scratch files
- Generated: Ad hoc
- Committed: No (in `.gitignore`)

---

*Structure analysis: 2026-08-05*
