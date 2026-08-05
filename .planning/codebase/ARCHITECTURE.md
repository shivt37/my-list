<!-- refreshed: 2026-08-05 -->
# Architecture

**Analysis Date:** 2026-08-05

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                    Stremio Client / Admin UI                 │
└───────────┬──────────────────────────────┬──────────────────┘
            │ HTTP (fetch)                 │ HTTP (POST/GET)
            ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Worker  (src/index.js)               │
│  Thin HTTP router → config from KV, catalogs from Pages     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ config.js│  │ routes.js│  │dispatch.js│  │configure.js│  │
│  │ KV store │  │ handlers │  │ GH API   │  │ HTML UI    │  │
│  └──────────┘  └──────────┘  └────┬─────┘  └────────────┘  │
└───────────────────────────────────┼─────────────────────────┘
                                    │ POST (dispatch workflow)
                                    ▼
┌─────────────────────────────────────────────────────────────┐
│              GitHub Actions  (.github/workflows/)            │
│  scrape.yml (puppeteer)  │  official.yml (API)              │
│  Scripts: scripts/*.mjs                                    │
└───────────┬──────────────────────────────┬──────────────────┘
            │ git commit (data/*.json)     │ POST /runs
            ▼                              ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│  GitHub Pages (data/)    │  │  Worker KV (STORE binding)   │
│  Static JSON catalog     │  │  config + run history         │
│  files served to Stremio │  │                               │
└──────────────────────────┘  └──────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| HTTP Router | Route dispatch, CORS, top-level entry | `src/index.js` |
| Config Store | KV read/write, migration, seeded defaults, official list defs | `src/config.js` |
| Route Handlers | Manifest, catalog, status, save, export, trigger, runs | `src/routes.js` |
| Workflow Dispatch | Trigger GitHub Actions via REST API | `src/dispatch.js` |
| Configure UI | Full-page HTML/JS config app (inline, no framework) | `src/configure.js` |
| Scraper Script | Headless Chromium scraping of mdblist.com | `scripts/scrape.mjs` |
| Official Lists | MDBList API fetcher for official lists | `scripts/official.mjs` |
| Dry Test | Local testing harness (gitignored) | `scripts/dry-test.mjs` |
| UI Verify | UI verification script (gitignored) | `scripts/verify-ui.mjs` |
| Scrape Workflow | Cron + dispatch, puppeteer scrape, commit data | `.github/workflows/scrape.yml` |
| Official Workflow | Cron + dispatch, API fetch, commit data | `.github/workflows/official.yml` |

## Pattern Overview

**Overall:** Serverless API Gateway + Static Catalog + Scheduled Scraper

**Key Characteristics:**
- Cloudflare Worker is stateless (no databases, no D1) — config lives in KV, catalog data lives in GitHub Pages (static JSON committed to repo)
- Scraping runs entirely in GitHub Actions, not the worker — worker never touches puppeteer or Chromium
- Two modules: **Scraper** (user-defined mdblist.com URLs) and **Official** (3 fixed MDBList official lists)
- Config save triggers GitHub Actions dispatch — worker validates config, dispatches workflow, rejects save if dispatch fails
- Catalog IDs are deterministic and permanent — seeded from URL hash, never regenerated

## Layers

**Cloudflare Worker (src/):**
- Purpose: HTTP API for Stremio + admin configuration UI
- Location: `src/`
- Contains: Router (`index.js`), config logic (`config.js`), route handlers (`routes.js`), workflow dispatch (`dispatch.js`), HTML UI (`configure.js`)
- Depends on: Cloudflare KV (STORE binding), GitHub API (for dispatch), GitHub Pages (for catalog data)
- Used by: Stremio clients, admin browser, GitHub Actions scripts (via `/export-config` and `/runs`)

**GitHub Actions Scraper (scripts/scrape.mjs):**
- Purpose: Headless Chromium scraping of mdblist.com listing pages
- Location: `scripts/scrape.mjs`
- Contains: Puppeteer + stealth plugin, DOM parsing, pagination, data file writes, run record POST
- Depends on: Node.js 22, puppeteer-extra, worker `/export-config` endpoint, GitHub repo (write access)
- Used by: `.github/workflows/scrape.yml`

**GitHub Actions Official (scripts/official.mjs):**
- Purpose: Fetch 3 official MDBList lists via API (no scraping)
- Location: `scripts/official.mjs`
- Contains: MDBList API client, data file writes, run record POST
- Depends on: Node.js 22, MDBLIST_API_KEY secret, worker `/runs` endpoint
- Used by: `.github/workflows/official.yml`

**GitHub Pages (data/):**
- Purpose: Static JSON catalog data served to Stremio
- Location: `data/`
- Contains: One JSON file per catalog (scraper: `mdb_scrape_*.json`, official: `mdboff_*_*.json`)
- Depends on: Written by GitHub Actions, read by worker via fetch

## Data Flow

### Primary Catalog Request (Stremio → Data)

1. Stremio fetches `/manifest.json` — worker reads config from KV, returns enabled catalogs (`src/routes.js:66-92`)
2. Stremio fetches `/catalog/<type>/<id>/skip=N.json` — worker fetches from GitHub Pages (`src/routes.js:120-143`)
3. Worker slices rows (100 at a time), maps to Stremio meta format, returns JSON

### Config Save Flow (Admin → KV → GitHub Actions)

1. Admin POSTs to `/save-config` with new config body (`src/routes.js:168-242`)
2. Worker diffs current vs incoming config (added/changed/removed lists)
3. Worker calls `dispatchScraperWorkflow()` if any enabled lists changed or were removed (`src/dispatch.js:10-36`)
4. If dispatch fails, save is rejected (no stale config persisted)
5. If dispatch succeeds, config is saved to KV

### Scraper Pipeline (GitHub Actions → Worker → GitHub Pages)

1. Workflow dispatches `scrape.yml` (cron every 12h or manual trigger)
2. `scrape.mjs` GETs `/export-config` from worker to learn enabled lists
3. For each list: launches puppeteer, paginates mdblist.com, extracts rows
4. Writes `data/<catalog_id>.json`, commits to repo
5. POSTs run records to worker `/runs` endpoint

### Official List Pipeline

1. Workflow dispatches `official.yml` (cron every 12h or manual trigger)
2. `official.mjs` fetches from MDBList API (3 slugs × 2 types)
3. Writes `data/mdboff_<slug>_<movie|show>.json`, commits to repo
4. POSTs run records to worker `/runs` endpoint

**State Management:**
- Cloudflare KV stores config (key: `config`) and run history (keys: `runs:scraper`, `runs:official`, capped at 30 per module)
- No in-memory state across requests — worker is fully stateless
- Config migration (`migrateConfig`) runs on every read, normalizing shapes

## Key Abstractions

**Catalog ID:**
- Purpose: Permanent identifier for each catalog, determines data file name and Stremio catalog ID
- Examples: `mdb_scrape_1djyii3b` (scraper), `mdboff_popular_movie` (official)
- Pattern: Seed-derived from URL hash (scraper) or fixed slug (official)

**Config Shape:**
- Purpose: Single source of truth for all catalogs
- Pattern: `{ scraper: { lists: [...] }, official: { lists: [...] } }` — always migrated on load

**Content Hash:**
- Purpose: Determines whether a list config change warrants re-scraping
- Pattern: SHA-256 of `[url, maxPages, enabled]` — name/type changes do NOT trigger re-scrape

**Run Record:**
- Purpose: Tracks scrape/fetch execution history for status page
- Pattern: `{ id, catalog_id, started_at, finished_at, pages_scraped, movies_found, status, error_message, triggered_by }`

## Entry Points

**Worker HTTP Entry:**
- Location: `src/index.js`
- Triggers: Any HTTP request to Cloudflare Worker domain
- Responsibilities: Route to handler based on pathname

**Scraper Script Entry:**
- Location: `scripts/scrape.mjs`
- Triggers: GitHub Actions workflow (`scrape.yml`)
- Responsibilities: Scrape all enabled lists, write data files, report runs

**Official Script Entry:**
- Location: `scripts/official.mjs`
- Triggers: GitHub Actions workflow (`official.yml`)
- Responsibilities: Fetch official lists via API, write data files, report runs

## Architectural Constraints

- **No D1/database:** All persistence is KV (small key-value) + Git (data files). KV is not suitable for complex queries — config is always loaded in full.
- **No scheduled worker handler:** Scheduling lives in GitHub Actions cron lines, not worker `scheduled` handler. Worker has no cron.
- **No concurrent save lock:** `/save-config` has read-modify-write without locking. Acceptable for single-operator admin page (`src/routes.js:175`).
- **Data files committed to Git:** Catalog data lives in the repo. Large catalogs increase repo size. Scraped data JSON files are 23-78 KB each.
- **Worker never scrapes:** All headless browser work is in GitHub Actions. Worker stays lightweight (Cloudflare Workers limits).

## Anti-Patterns

### Dispatch Fail Blocking Config Save

**What happens:** If GitHub Actions dispatch fails (network error, invalid token, rate limit), the config save is rejected entirely (`src/routes.js:215-219`).
**Why it's wrong:** Admin loses the ability to make any config changes (including non-scrape-related toggles) if GitHub is temporarily unavailable.
**Do this instead:** Decouple save from dispatch. Save config first, queue a retry for failed dispatches. Accept that data files may temporarily be stale.

### Inline HTML in Worker

**What happens:** `src/configure.js` contains a full HTML page with inline CSS and JS (~700 lines).
**Why it's wrong:** Hard to test, no syntax highlighting, no hot reload, increases worker bundle size.
**Do this instead:** Build configure UI separately (Vite/ESBuild), serve as a static asset, or use a dedicated frontend repo.

## Error Handling

**Strategy:** Fail-safe with empty responses — unknown/disabled catalogs return `metas: []` (200), not errors. Stremio must not break on stale requests.

**Patterns:**
- KV read failure → fall back to seed defaults (`src/config.js:141-142`)
- Catalog fetch failure → return empty array (`src/routes.js:137-138`)
- Dispatch failure → reject config save with 502 (`src/routes.js:215-219`)
- Invalid config body → 400 with descriptive error (`src/routes.js:170-173`)
- Corrupt KV → silently migrate/clean (`src/config.js:108-124`)

## Cross-Cutting Concerns

**Logging:** No logging framework. Errors are swallowed silently (corrupt KV) or returned as JSON error responses.
**Validation:** `migrateConfig` normalizes every field on every read — URL limits, maxPages clamped to 1-50, ID format regex checked (`src/config.js:108-124`).
**Authentication:** None on the worker. Config save/status/trigger-refresh are unauthenticated (single-operator assumption). GitHub dispatch uses `GH_TOKEN` secret.
**Security:** Content-Security-Policy header on configure page (`src/routes.js:34`). ID format regex prevents path traversal (`src/config.js:116`).

---

*Architecture analysis: 2026-08-05*
