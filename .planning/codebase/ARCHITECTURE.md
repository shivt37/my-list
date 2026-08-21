<!-- refreshed: 2026-08-21 -->
# Architecture

**Analysis Date:** 2026-08-21

## System Overview

Stremio addon split across two runtimes connected by GitHub Actions dispatch + GitHub Pages data files:

```text
┌────────────────────────────────────────────────────────────────────┐
│                    Consumers / Operators                            │
│   Stremio clients          Browser (admin)                          │
│   (manifest + catalogs)    (configure page)                         │
└────────┬───────────────────────────┬─────────────────────────────────┘
         │                           │
         ▼                           ▼
┌────────────────────────────────────────────────────────────────────┐
│              Cloudflare Worker  (src/index.js)                      │
│  Thin fetch-handler router, no scheduled handler                   │
├──────────────┬───────────────┬──────────────┬──────────────────────┤
│ routes.js    │ config.js     │ dispatch.js  │ configure.js         │
│ manifest/    │ KV load/      │ GH Actions   │ 1773-line single-    │
│ catalog/     │ migrate/      │ workflow     │ file admin UI        │
│ status/runs  │ hashes/runs   │ dispatch     │ (HTML+CSS+JS string) │
└──────────────┴───────┬───────┴──────┬───────┴──────────────────────┘
                       │              │
            ┌──────────▼───┐   ┌──────▼───────────────────┐
            │ KV (STORE)   │   │ GitHub Actions dispatch  │
            │ config,      │   │ (api.github.com)         │
            │ runs:*       │   └──────┬───────────────────┘
            └──────────────┘          │
                                      ▼
┌────────────────────────────────────────────────────────────────────┐
│           GitHub Actions scrapers  (scripts/*.mjs, Node 22)        │
│  4 independent modules, all in concurrency group `my-list-scrape`  │
├───────────────┬───────────────┬───────────────┬───────────────────┤
│ scrape.mjs    │ official.mjs  │ simkl.mjs     │ tmdb.mjs          │
│ puppeteer DOM │ MDBList API   │ SIMKL v2      │ TMDB /discover    │
│ of mdblist.com│ (official)    │ calendar API  │ (+ live preview   │
│               │               │               │  proxy in worker) │
└───────┬───────┴───────┬───────┴───────┬───────┴─────────┬─────────┘
        │  write data/<catalog_id>.json │                 │
        │  POST /runs back to worker    │                 │
        ▼                               ▼                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Git repo data/ dir → bot commit ("[skip ci]",                     │
│  git pull --rebase -X theirs) → GitHub Pages                       │
│  (GITHUB_PAGES_BASE = https://shivt37.github.io/my-list)           │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
                               ▼
              Worker fetches {GITHUB_PAGES_BASE}/data/<id>.json
              at request time to serve Stremio catalogs
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Worker entry/router | Match pathname/method to handler, CORS preflight, root info text | `src/index.js` |
| Route handlers | Manifest build, catalog serving, status, save/export-config, trigger-refresh, /runs ingest, TMDB search + preview proxies | `src/routes.js` |
| Config store | KV read/migrate/normalize per module, seed defaults, id generation, content hashes, run history (last 30/module) | `src/config.js` |
| Workflow dispatcher | Single function that POSTs `workflow_dispatch` to api.github.com; workflow filename allowlist | `src/dispatch.js` |
| Admin UI | Full configure SPA as one template-literal HTML page: scraper/official/simkl/tmdb tabs, save diffing client-side, refresh buttons, TMDB preview | `src/configure.js` |
| MDBList DOM scraper | Headless Chromium (puppeteer-extra + stealth) scraping mdblist.com listing URLs into `data/mdb_scrape_*.json` | `scripts/scrape.mjs` |
| Official lists fetcher | MDBList API cursor pagination into `data/mdboff_<slug>_<movie\|show>.json` | `scripts/official.mjs` |
| SIMKL arriving-today | SIMKL v2 calendar filter/sort into `data/simkl_arriving_today_<kind>.json` | `scripts/simkl.mjs` |
| TMDB discover generator | Multi-source AND/OR discover queries into `data/tmdb_discover_*.json`, sourceHash skip support | `scripts/tmdb.mjs` |
| Workflows | Cron schedules (01:30/13:30 UTC), input sanitization, bot commit step | `.github/workflows/{scrape,official,simkl,tmdb}.yml` |
| Dry-run integration tests | Every worker route vs fake KV + stubbed GH fetch/Pages fetch | `scripts/dry-test.mjs` |
| Module self-checks | TMDB additions, UI smoke via JSDOM | `scripts/verify-tmdb.mjs`, `scripts/verify-ui.mjs` |

## Pattern Overview

**Overall:** Decoupled producer/consumer pipeline. The worker is stateless-per-request (KV-backed config only) and never touches upstream data sources; scrapers are stateless batch jobs whose output is committed as static JSON files and served through GitHub Pages. Control plane (worker → GitHub dispatch API) is fully separated from data plane (scrapers → git → Pages → worker fetch).

**Key Characteristics:**
- No bundler/build step anywhere — plain ESM on both sides (worker uses `nodejs_compat` flag for `node:crypto`)
- Catalog identity = filename: every module writes `data/<catalog_id>.json`; worker's `CATALOG_RE` in `src/routes.js` maps `/catalog/<type>/<id>/skip=N.json` straight to a Pages fetch of that id
- Four fixed modules (scraper / official / simkl / tmdb), each with its own config section, KV runs key, workflow file, and manifest naming rules
- All cross-runtime mutation flows through one chokepoint: `dispatchScraperWorkflow()` in `src/dispatch.js`
- Defensive normalization at every trust boundary: workflow inputs sanitized in bash (`tr -cd` whitelists), CLI args regex-whitelisted in scripts, KV values re-normalized on every `loadConfig()`

## Layers

**Router layer:**
- Purpose: URL/method dispatch only, zero business logic
- Location: `src/index.js`
- Contains: pathname matching incl. `CATALOG_RE`, CORS OPTIONS handling
- Depends on: `routes.js` handlers
- Used by: Cloudflare runtime (`wrangler.toml` `main = "src/index.js"`)

**Handler layer:**
- Purpose: Stremio-facing endpoints + admin endpoints + run-record ingestion
- Location: `src/routes.js`
- Contains: `buildManifest`, `handleCatalog`, `handleStatus`, `handleSaveConfig`, `handleExportConfig`, `handleTriggerRefresh`, `handleRunsPost`, `handleTmdbSearch`, `handleTmdbPreviewDiscover`, per-module row→meta mappers
- Depends on: `config.js`, `dispatch.js`, `configure.js`
- Used by: `index.js`

**Config/state layer:**
- Purpose: single source of truth in KV key `config`; also stores `runs:scraper|official|simkl|tmdb` (max 30 each) and one-shot `healed` marker
- Location: `src/config.js`
- Contains: `loadConfig`/`saveConfig`, `migrateConfig` (+ per-module migrators), seed constants (`SEED_LISTS`, `OFFICIAL_LISTS`, `SIMKL_LISTS`), id generators, `listContentHash`/`tmdbContentHash`, `addRun`/`getRuns`
- Depends on: `node:crypto` only
- Used by: `routes.js`, imported directly by `scripts/dry-test.mjs`

**Dispatch layer:**
- Purpose: fire-and-forget GitHub Actions triggers; returns `{ dispatched, reason }`, never throws
- Location: `src/dispatch.js`
- Depends on: env `GH_TOKEN`, `GH_REPO`, `GH_REF`; optional `env.GH_FETCH` injection point used by tests
- Used by: `routes.js` (save-config, trigger-refresh)

**Presentation layer (worker-rendered):**
- Purpose: admin SPA served at `/configure`
- Location: `src/configure.js` — `buildConfigurePage(origin, config)` returns one HTML string with inline CSS + JS; client JS calls back into worker endpoints (`/save-config`, `/trigger-refresh`, `/tmdb/search-*`, `/tmdb/preview-discover`)
- Used by: `routes.js` via `configureResponse()`

**Batch-job layer:**
- Purpose: regenerate catalog data files on cron or manual dispatch
- Location: `scripts/{scrape,official,simkl,tmdb}.mjs`
- Contains: each module exports injectable `main({ fetchCfg, write, recordRuns, ... })` so `dry-test.mjs` can drive them without network; shared shape = fetch config from `${WORKER_ORIGIN}/export-config` → hit upstream → write `data/<id>.json` → POST runs to `${WORKER_ORIGIN}/runs`
- Depends on: worker HTTP API; puppeteer (scrape only)
- Used by: GitHub Actions workflows

**Orchestration layer:**
- Purpose: schedule, sanitize inputs, commit data
- Location: `.github/workflows/*.yml`
- Contains: identical commit recipe in all four: `git add -f 'data/*.json'` under `if: always()`, bot identity `my-list-bot`, `git pull --rebase -X theirs`, `git push`

## Data Flow

### Primary request path (Stremio catalog)

1. Stremio requests `/catalog/movie/mdboff_popular_movie/skip=100.json` — matched by `CATALOG_RE` (`src/routes.js:46`) in `src/index.js:46-52`
2. `handleCatalog` loads config from KV, resolves which module owns the catalog id, picks the matching `rowToMeta{,_Official,_Simkl,_Tmdb}` mapper (`src/routes.js:169-194`)
3. Fetches `{env.GITHUB_PAGES_BASE}/data/<catalogId>.json`; any failure or unknown id returns `{ metas: [] }` with 200 (a stale request must not break the chain)
4. Slices `skip..skip+100`, returns Stremio `{ metas }`

### Save/configure flow

1. Browser tab in `src/configure.js` collects edits, POSTs full config to `/save-config`
2. `handleSaveConfig` (`src/routes.js:235`) diffs incoming vs current: scraper lists via `listContentHash`, simkl via enabled+filter compare, tmdb via `tmdbContentHash`; computes adds/removes/dispatches
3. Dispatch order is deliberate — simkl first, scraper last, tmdb last (`src/routes.js:302-344`): the scraper can be destructive (`scrape_delete`), so it stays adjacent to the persist; any dispatch failure returns 502 **before** `saveConfig()` writes KV (no partial state)
4. On all dispatches accepted → `saveConfig()` persists; response reports changed/added/removed per module

### Refresh/regeneration flow (control plane)

1. Cron line in workflow YAML or operator button → `POST /trigger-refresh` (page-scoped variants for official/simkl/tmdb) or direct `workflow_dispatch`
2. `dispatchScraperWorkflow` (`src/dispatch.js`) POSTs to `repos/{GH_REPO}/actions/workflows/<file>/dispatches`, expects 204; workflow filename validated against `/^[a-zA-Z0-9_.-]+\.yml$/`
3. Workflow sanitizes inputs in bash (`tr -cd` char-class whitelists) before passing to the Node script
4. Script pulls its own config live from `${WORKER_ORIGIN}/export-config` (worker is source of truth for enabled lists, filters, renamed names)
5. Scrapes/fetches upstream → writes `data/<catalog_id>.json` (empty-result guard: do NOT overwrite last good file with empty — except `simkl.mjs` where an empty airing-day is legitimate)
6. POSTs run records (chunks of ≤50) to `/runs` → `runsKeyFor()` (`src/config.js:18`) routes by id prefix (`mdboff_`/`simkl_`/`tmdb_`/other) to the right KV runs key
7. Commit step (`if: always()`): force-add data, `[skip ci]` message, `git pull --rebase -X theirs` (regenerated throwaway data wins conflicts), push → GitHub Pages updates

### Status/readback flow

1. `/status?page=official|simkl|tmdb` reads corresponding `runs:*` KV list, resolves display names through current config so operator renames show up (`src/routes.js:196-233`)
2. Timestamps rendered IST via `toIST()`

### TMDB preview flow (live, bypasses regeneration)

1. Configure page calls `/tmdb/search-keyword|company|collection` or POSTs `/tmdb/preview-discover`
2. Worker proxies api.themoviedb.org directly with `TMDB_READ_ACCESS_TOKEN`, replicating the exact source plan of `buildDiscoverSources` in `scripts/tmdb.mjs` (`sortPreviewItems` mirrors `sortItems`), capped at 25 pages × 20 items

**State Management:**
- Config: single KV key `config` (JSON), normalized through `migrateConfig` on every read; seeds written back on first-ever load; one-shot id healing gated by `healed` key
- Run history: four append-front KV lists capped at 30 (`RUNS_MAX`)
- Client UI: plain module-level variables + `window.moduleState`, re-rendered per tab; accent color and active module persisted in localStorage (`mylist_accent`, `mylist_active_module`)

## Key Abstractions

**Catalog id namespaces** (identity = data filename):
- `mdb_scrape_<8 chars>` — seeded ids pinned forever; derived from first 8 hex of sha256(url) via `randomScraperId` (`src/config.js:43`)
- `mdboff_<slug>_<movie|show>` — 6 fixed official catalogs (`OFFICIAL_CATALOGS`, `src/config.js:132`)
- `simkl_arriving_today_<series|anime>` — 2 fixed kinds (`SIMKL_CATALOGS`, `src/config.js:100`)
- `tmdb_discover_<movie|series>_<8 base36>` — one list = one catalog, media type baked into id (`randomTmdbListId`, `src/config.js:32`)

**Module record shapes** (all under one config object `{ scraper, official, simkl, tmdb: { lists: [] } }`):
- scraper: `{ id, name, url, type, maxPages, enabled }`
- official: `{ slug, name, enabled }` (fixed slugs, toggle-only)
- simkl: `{ slug, name, enabled, filter: { rating_source, rating_filter_enabled, exclude_genres, include_countries, exclude_countries, rating_tiers[] } }`
- tmdb: `{ discoverListId, name, mediaType, sort, enabled, includeModes{genre,keyword,company,collection}, include*/exclude* id arrays + parallel *Names arrays (UI-only) }`

**Injectable main():** every script's `main({...})` takes its IO functions as parameters (`fetchCfg`, `write`, `recordRuns`, `fetchApi`, ...) — the seam `scripts/dry-test.mjs` and self-checks use. `isMain` guards differ per file (`resolve(argv[1])` vs `pathToFileURL` comparison in `tmdb.mjs`).

**Content hashes:** `listContentHash` (scraper) and `tmdbContentHash` deliberately exclude `name` — renaming a list changes only the manifest, never triggers a re-scrape/regenerate. `computeSourceHash` in `scripts/tmdb.mjs` mirrors `tmdbContentHash` field-for-field so stored data files carry the fingerprint.

## Entry Points

**Cloudflare Worker fetch handler:**
- Location: `src/index.js` (`export default { fetch }`), configured by `wrangler.toml`
- Triggers: Stremio clients, browser admin page, scraper scripts (config + run posts)
- Responsibilities: routing, CORS, nothing else

**GitHub Actions workflows (schedule + workflow_dispatch):**
- Locations: `.github/workflows/scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml`
- Triggers: cron `30 1,13 * * * UTC` (tmdb currently has 13:30 commented out), manual dispatch from worker or GitHub UI
- Responsibilities: input sanitization, secret injection, running the script, committing data

**CLI (local/testing):**
- `node scripts/scrape.mjs --lists=a,b --action=scrape_delete --delete-ids=c --debug`
- `node scripts/official.mjs --slugs=...`, `node scripts/simkl.mjs --kinds=...`, `node scripts/tmdb.mjs --ids=... --action=generate|delete`
- Tests: `node scripts/dry-test.mjs`, `node scripts/verify-tmdb.mjs`, `node scripts/verify-ui.mjs`

## Architectural Constraints

- **Threading:** Worker is single-threaded per-request (standard Workers model). Scripts are sequential per target list with `sleep` jitter between pages/lists; only TMDB collection fetches use `Promise.allSettled`.
- **Global state:** None in the worker beyond KV. Scripts keep module-level constants only. Test seam: `env.GH_FETCH` is consulted nowhere in production code — `scripts/dry-test.mjs` temporarily swaps global `fetch` around dispatch calls instead (see its `withFetch` helper).
- **Workflow serialization:** All four workflows share concurrency group `my-list-scrape`, `cancel-in-progress: false`, `queue: max` — required because they race on (a) the KV read-modify-write in `addRun` and (b) the same `data/` directory in git.
- **Commit conflict policy:** `git pull --rebase -X theirs` everywhere — data files are treated as disposable regenerated artifacts, never hand-edited; newest regeneration wins.
- **KV consistency:** `handleSaveConfig` read-modify-write has no lock — concurrent saves can clobber; explicitly accepted for a single-operator admin page (comment at `src/routes.js:244`).
- **No scheduled worker handler:** cron lives solely in workflow YAML lines, edited on github.com.
- **Path traversal defense in depth:** id regexes in `migrateConfig` (`/^mdb_scrape_[A-Za-z0-9_-]{1,32}$/`, `src/config.js:247`), per-script arg whitelists (`ID_RE`, `SANE_SLUG`, `SANE_KIND`), and bash `tr -cd` sanitization before args ever reach Node.
- **Runtime compat:** worker needs `compatibility_flags = ["nodejs_compat"]` (`wrangler.toml`) for `node:crypto`.

## Anti-Patterns

### Monolithic generated-UI file

**What happens:** `src/configure.js` is a single 1773-line file mixing CSS tokens, layout CSS, HTML shell, and ~1100 lines of vanilla-JS tab logic inside nested template literals.
**Why it's a problem here:** any edit risks breaking string interpolation/escaping (note the `<` hard-escaping at line 14 and duplicated `escapeAttr` definitions at lines 7 and 656 — outer server copy and inner client copy).
**Do this instead:** follow existing convention when extending — add a new `renderXxx()` tab function and register it in `rerenderActive()` (`src/configure.js:861`); do not extract files (no bundler exists to recombine them).

### Duplicated logic across worker and scripts

**What happens:** TMDB source-plan/sort logic exists twice (`handleTmdbPreviewDiscover` in `src/routes.js:587` vs `buildDiscoverSources`/`sortItems` in `scripts/tmdb.mjs`); hash logic mirrored (`tmdbContentHash` vs `computeSourceHash`); simkl default filters duplicated verbatim in `src/config.js` (`simklDefaults`) and `scripts/simkl.mjs` (`DEFAULT_FILTERS`).
**Why it's a problem here:** the two sides cannot import each other (different runtimes/deps), so drift risk is real; comments explicitly call out "mirrors" obligations.
**Do this instead:** when changing any of these, update BOTH copies in the same change and run `node scripts/verify-tmdb.mjs` / `dry-test.mjs`.

### Silent-failure JSON APIs returning 200-empty

**What happens:** `handleCatalog` swallows Pages fetch errors and unknown ids into `{ metas: [] }` 200s.
**Why intentional:** a stale catalog request after a disable must not break Stremio rendering.
**Do this instead:** keep this behavior for catalog routes; debug via `/status` run history, not error surfaces.

## Error Handling

**Strategy:** fail soft on reads (empty results, never 500 to Stremio), fail loud and early on writes (save rejected with 502 before any persist if a dispatch fails), per-item try/catch in batch jobs with run-record capture.

**Patterns:**
- Dispatch result object pattern: `{ dispatched: bool, reason?: string }` — callers map failures to 501/502 with the reason embedded (`src/routes.js:317,328,342,474`)
- Batch job run record: every list produces a run entry even on failure (`status`, `error_message` sliced to 500 chars) posted to `/runs`; process exit code 1 if anything failed
- Empty-output guard: scrapers refuse to overwrite a good data file with an empty scrape (all except simkl, documented exception)
- KV corrupt value tolerated: `loadConfig` catches parse errors and falls back to seeds (`src/config.js:359`)
- Worker-wide catch-alls return generic messages (`"Save failed."`, `"Failed to record runs."`) to avoid leaking internals

## Cross-Cutting Concerns

**Logging:** `console.log/warn/error` in scripts (GitHub Actions log stream); worker has none (responses are the log). Debug dumps (HTML + screenshots) behind `--debug` flag in `scrape.mjs`, uploaded as artifacts.

**Validation:** layered — bash char-class sanitize → script arg regex allowlist → `migrateConfig`/`normalizeSimklList`/`normalizeTmdbList` field coercion on KV load → upstream URL sanity checks before scraping (`scrape.mjs:425-437`).

**Authentication:** none on worker endpoints (single-operator assumption; CORS `*`). GitHub token (`GH_TOKEN` secret) gates dispatches; workflow `permissions: contents: write` gates commits; upstream API keys arrive as repo secrets (`MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`, `TMDB_READ_ACCESS_TOKEN`, `WORKER_ORIGIN`). `MDBLIST_API_KEY` is currently unused by `scrape.mjs` (DOM-based scraping) but still wired through the workflow.

---

*Architecture analysis: 2026-08-21*
