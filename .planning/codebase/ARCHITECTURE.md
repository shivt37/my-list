<!-- refreshed: 2026-09-15 -->
# Architecture

**Analysis Date:** 2026-09-15

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Worker (Stremio addon)               │
├──────────────────┬──────────────────┬───────────────────────┤
│  Public surface  │  Admin surface   │  Live proxy helpers   │
│  `src/index.js`  │  `src/index.js`  │  `src/routes.js`      │
│  + `src/routes.js` + `src/configure.js` + TMDB/MDBList proxies │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Config + history layer (KV-backed)              │
│         `src/config.js` (`STORE` KV: config, runs:*)        │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Data plane: GitHub Actions → data/*.json → GitHub Pages    │
│  `scripts/scrape.mjs`, `scripts/official.mjs`,              │
│  `scripts/simkl.mjs`, `scripts/tmdb.mjs`                    │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Router | Endpoint dispatch, CORS/OPTIONS, auth gate, catalog regex + skip parse | `src/index.js` |
| Stremio + control API | Manifest, catalog proxy, save/export config, trigger-refresh, runs ingest, TMDB/MDBList live proxies | `src/routes.js` |
| Config store | Normalize/migrate/seed config, content hashes, run-history window, KV read/write | `src/config.js` |
| Auth gate | PIN login, HMAC session cookie, public/admin path lists, KV login rate limit | `src/auth.js` |
| Dispatch | GitHub `workflow_dispatch` POST, stub mode, timeout + structured failure | `src/dispatch.js` |
| Admin SPA | `/configure` single-file app: 4 module tabs, pickers, preview, dirty/save dispatch UI | `src/configure.js` |
| Status page | Server-rendered 4-tab run-history dashboard (`?format=json` raw feed) | `src/status.js` |
| Generators | Headless scrape / API pulls → `data/*.json` + POST `/runs` | `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs` |

## Pattern Overview

**Overall:** Thin-worker + fat-pipeline. Worker never fetches source data (except small live picker/preview proxies). All bulk data produced off-request in GitHub Actions, stored as static JSON, served through worker proxy with pagination.

**Key Characteristics:**
- Config in KV (`STORE`), data in git (`data/*.json` via GitHub Pages). Config changes apply without redeploy.
- Four independent modules (scraper / official / simkl / tmdb) share one config blob, separate run-history keys, separate workflows, separate catalog-id schemes.
- Save path is dispatch-before-persist: every regeneration dispatch must be accepted before config write lands.
- Manifest gates discovery; direct catalog URLs stay stable across enable/disable.

## Layers

**Edge / router (`src/index.js`):**
- Purpose: Single `fetch` handler mapping pathname+method to handler.
- Location: `src/index.js`
- Contains: Auth-route bypass (`/configure/login`, `/configure/logout`), auth gate, route table, `CATALOG_RE` skip extraction.
- Depends on: `src/config.js` (`loadConfig`), `src/routes.js` (all handlers), `src/status.js` (`statusPageResponse`), `src/auth.js` (gate).
- Used by: Cloudflare runtime (`main = "src/index.js"` in `wrangler.toml`).

**Control + serving API (`src/routes.js`):**
- Purpose: All business logic for Stremio surface and admin control plane.
- Location: `src/routes.js`
- Contains: `buildManifest`, `handleCatalog`, `handleSaveConfig`, `handleExportConfig`, `handleTriggerRefresh`, `handleRunsPost`, `handleStatus`, TMDB search/preview/network handlers, MDBList official-catalog proxy, `html`/`json` response helpers with CSP.
- Depends on: `src/config.js`, `src/dispatch.js`, `src/auth.js` (`isAuthEnabled`), `src/configure.js` (`buildConfigurePage`).
- Used by: `src/index.js`, `src/status.js`.

**State / config (`src/config.js`):**
- Purpose: Single source of truth for config shape, ids, hashes, history.
- Location: `src/config.js`
- Contains: `migrateConfig`, `loadConfig`, `saveConfig`, `normalizeTmdbList` / `normalizeSimklList` / `migrateOfficial`, `listContentHash` / `tmdbContentHash` / `configVersion`, `addRun` / `addRuns` / `capRuns` / `getRuns`, `runsKeyFor`, `officialCatalogsFor`, seed constants (`SEED_LISTS`, `OFFICIAL_LISTS`, `SIMKL_LISTS`).
- Depends on: `node:crypto` only.
- Used by: `src/routes.js`, `src/status.js`, `src/index.js`, `scripts/tmdb.mjs` (imports `tmdbContentHash`).

**Auth (`src/auth.js`):**
- Purpose: Login gate.
- Location: `src/auth.js`
- Contains: `isPublic`, `isAdminPath`, `isAuthEnabled`, `checkSession`, `issueSession`, `handleLogin`, `handleLogout`, `loginPageHtml`, `rateLimitLogin`.
- Depends on: WebCrypto, KV `STORE` (rate-limit counters only).
- Used by: `src/index.js`.

**Dispatch (`src/dispatch.js`):**
- Purpose: Sole bridge Worker → GitHub Actions.
- Location: `src/dispatch.js`
- Contains: `dispatchScraperWorkflow` with `GH_DISPATCH_STUB` short-circuit, `AbortSignal.timeout(15000)`, structured `{ dispatched, reason }` results.
- Depends on: `env.GH_TOKEN`, `env.GH_REPO`, workflow filename.
- Used by: `src/routes.js` (`handleSaveConfig`, `handleTriggerRefresh`).

**Presentation (`src/configure.js`, `src/status.js`):**
- Purpose: Server-rendered HTML shells with embedded client JS.
- Location: `src/configure.js` (`buildConfigurePage`), `src/status.js` (`statusPageResponse`).
- Contains: Configure SPA (shared shell + per-module render fn: `renderScraper`, `renderOfficial`, `renderSimkl`, `renderTmdb`, preview/picker/dirty logic); status dashboard (`renderModule`, `renderRow`, `renderSummary`, tab/filter client JS).
- Depends on: `src/routes.js` (`html` helper, `handleStatus`), `src/config.js` (`loadConfig`).
- Used by: `src/routes.js` (`configureResponse`), `src/index.js` (`/status`).

**Generation pipeline (`scripts/*.mjs` + `.github/workflows/*.yml`):**
- Purpose: Bulk data production on cron or dispatch.
- Location: `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`
- Contains: Per-module fetch/filter/write + POST `/runs`; shared wrapper shape `{ catalog_id, name, type, scraped_at, sourceHash, items }`.
- Depends on: Worker `/export-config` (config source), source APIs (MDBList DOM / MDBList API / SIMKL calendar / TMDB API).
- Used by: Nobody at runtime; workflows invoke via `node *.mjs` with `--ids/--slugs/--kinds/--lists/--action` args.

## Data Flow

### Primary Request Path

1. Stremio client fetches manifest (`src/index.js:69` → `buildManifest` in `src/routes.js:69`).
2. `buildManifest` loads config (`src/config.js:434` `loadConfig`), filters to enabled lists, emits catalog entries per module (scraper `mdb_scrape_*`, official `mdboff_<slug>_<movie|show>`, simkl `simkl_arriving_today_*`, tmdb `tmdb_discover_*`).
3. Catalog page `GET /catalog/<type>/<id>.json` (`src/index.js:73`, `CATALOG_RE` in `src/routes.js:47`) → `handleCatalog` (`src/routes.js:178`): resolve id against 4 module registries, fetch `{GITHUB_PAGES_BASE}/data/<id>.json`, map rows via module-specific `rowToMeta*`, slice 100 by `skip`.
4. Unknown id → `{ metas: [] }` (`src/routes.js:190`); disabled-list id still serves (manifest gates discovery only).

### Save-Config Path (dispatch-before-persist)

1. `POST /save-config` (`src/index.js:89`) → `handleSaveConfig` (`src/routes.js:251`): shape-check body, `loadConfig` current, `migrateConfig` incoming.
2. Diff per module: scraper `listContentHash` compare (`src/routes.js:274`); official OFF→ON + added slugs (`src/routes.js:293`); simkl filter/timezone compare (`src/routes.js:307`); tmdb `tmdbContentHash` + toggle-on + type-switch old-id (`src/routes.js:327`).
3. Phase 1 regenerations fire first (simkl → official → tmdb → scraper), each carrying `config_version` (`src/routes.js:375`). Any failure → `502` rollback, nothing persisted.
4. Phase 2 destructive cleanups (official best-effort, tmdb `action=delete`, scraper `scrape_delete`) (`src/routes.js:421`).
5. `saveConfig` persists last (`src/routes.js:460`). Workflows poll `/export-config` until `configVersion` matches (wait loop in `.github/workflows/tmdb.yml:78`, mirrored in other workflows).

### Generation → Serve Path

1. Cron or `POST /trigger-refresh` (`src/routes.js:510`) dispatches workflow (`src/dispatch.js:10`).
2. Workflow sanitizes inputs, waits for KV consistency, runs `node scripts/<module>.mjs`, commits `data/*.json` (`git add -f 'data/*.json'`, rebase `-X theirs`, push).
3. Script POSTs run records to `POST /runs` (`src/routes.js:642` → `addRuns` in `src/config.js:567` with orphan-aware eviction via `liveCatalogIdsFor`).
4. `/status` reads runs keys (`runs:scraper`, `runs:official`, `runs:simkl`, `runs:tmdb`) + resolves names from config (`src/routes.js:208`).

### TMDB Preview Path (live, no persist)

1. `POST /tmdb/preview-discover` (`src/index.js:112`) → `handleTmdbPreviewDiscover` (`src/routes.js:868`).
2. `normalizeTmdbList` validates body; build AND fragment + per-OR-dimension source queries (same plan as `buildDiscoverSources` in `scripts/tmdb.mjs:87`); collection members fetched directly (`/collection/<id>`); paged discover rounds up to 25 pages; exclude-collection / exclude-item / exclude-network veto passes; `sortPreviewItems` (superset: undated sink, never dropped); return `{ items, truncated }`.

**State Management:**
- KV `STORE`: `config` blob (stamped `configVersion`), `runs:{scraper,official,simkl,tmdb}` arrays (cap 30, orphan-aware), `healed` one-shot flag, `rl:login:*` rate counters, `cache:network-search:*` + `cache:mdblist-official` 10-min proxy caches.
- No sessions in KV: stateless HMAC cookie (`src/auth.js:102`). PIN rotation invalidates all cookies via fingerprint.
- Client state: `/configure` single `state` object + `rerenderActive()`; dirty tracking gates save (`isDirty`, `refreshDirtyUI` in `src/configure.js:2500`).

## Key Abstractions

**Catalog-id schemes:**
- Purpose: Id encodes module; routing + history keys derive from prefix.
- Examples: `src/config.js:42` (`randomScraperId`), `src/config.js:32` (`tmdbCatalogId`), `src/config.js:168` (`officialCatalogsFor`), `src/config.js:126` (`SIMKL_CATALOGS`).
- Pattern: `mdb_scrape_<8>` (pinned seeds in `SEED_LISTS`, `src/config.js:178`), `mdboff_<slug>_<movie|show>`, `simkl_arriving_today_<series|anime>`, `tmdb_discover_<movie|series>_<8base36>`.

**Content hashes:**
- Purpose: Name-only edits never regenerate; dispatch diffs on content only.
- Examples: `src/config.js:393` (`listContentHash`: url+maxPages+enabled+type), `src/config.js:403` (`tmdbContentHash`: full discover field set, imported by `scripts/tmdb.mjs:32`), `src/config.js:62` (`configVersion`: whole-blob hash minus itself).
- Pattern: Hash compare at save; `sourceHash` stamped on data files for audit.

**rowToMeta* family:**
- Purpose: Per-module row shape → uniform Stremio meta.
- Examples: `src/routes.js:127` (`rowToMeta` scraper), `src/routes.js:142` (official), `src/routes.js:155` (simkl), `src/routes.js:168` (tmdb).
- Pattern: Selected by id-prefix match in `handleCatalog` (`src/routes.js:184`).

**Per-module normalize/migrate:**
- Purpose: All untrusted input (request body, KV blob) coerced at boundary; bad entries dropped, never healed into serving shapes.
- Examples: `src/config.js:288` (`migrateConfig`), `src/config.js:223` (`migrateOfficial`), `src/config.js:261` (`normalizeSimklList`), `src/config.js:318` (`normalizeTmdbList` with movie-only/series-only dimension stripping).

## Entry Points

**Worker fetch (`src/index.js:23`):**
- Location: `src/index.js`
- Triggers: Every HTTP request to worker.
- Responsibilities: OPTIONS preflight, login/logout bypass, auth gate, route table, 404 fallback.

**Cron schedules (`.github/workflows/*.yml`):**
- Location: `.github/workflows/scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml`
- Triggers: GitHub cron + `workflow_dispatch` from worker.
- Responsibilities: Sanitize inputs, wait KV consistency, run generator, commit `data/`, shared concurrency group `my-list-scrape` (`queue: max`).

**Generator CLIs (`scripts/*.mjs`):**
- Location: `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`
- Triggers: Workflow `node *.mjs --ids/--slugs/--kinds/--lists/--action`.
- Responsibilities: Pull `/export-config`, filter enabled scope, fetch source, write `data/<id>.json`, POST `/runs`.

**Admin SPA + status page:**
- Location: `src/configure.js:6` (`buildConfigurePage`), `src/status.js:224` (`statusPageResponse`)
- Triggers: `GET /configure`, `GET /status`.
- Responsibilities: Config editing UI; run-history dashboard.

## Architectural Constraints

- **Threading:** Single-threaded Workers runtime; no shared in-memory state across requests — all shared state lives in KV. Bulk work never runs in-request (15–30s `AbortSignal` timeouts bound every outbound fetch instead).
- **Global state:** None in worker. Scripts use module-level argv/env constants (`listsArg`, `WORKER_ORIGIN` in `scripts/scrape.mjs:50`; `TMDB_TOKEN` in `scripts/tmdb.mjs:37`). Configure SPA uses module-scope `state` + `activeModule` (`src/configure.js:911`).
- **Circular imports:** None. `scripts/tmdb.mjs` imports `src/config.js` one-way (`tmdbContentHash`); `src/status.js` imports `src/routes.js` + `src/config.js` one-way; `src/configure.js` exports only `buildConfigurePage` and imports nothing.
- **KV eventual consistency:** Close via `configVersion` dispatch-carry + workflow poll loop; never assume write-then-read visibility.
- **Concurrency:** Single-operator assumption — save path is unlocked read-modify-write (`src/routes.js:260`). Run writers serialized by shared Actions concurrency group.

## Anti-Patterns

### Combined generate+delete TMDB dispatch

**What happens:** One dispatch carrying both `ids` and `delete_ids` without `action=delete` silently drops deletes (`tmdb.yml` only forwards `--delete_ids` in delete mode).
**Why it's wrong:** Orphaned `tmdb_discover_*` files persist in `data/` forever.
**Do this instead:** Separate `action=delete` dispatch for `tmdbDeleteIds`, as done in `src/routes.js:433`.

### Inferring catalog type from row data

**What happens:** Guessing movie/series from row fields instead of operator-declared list type.
**Why it's wrong:** Scraper rows never reliably carried type; inference mislabels catalogs.
**Do this instead:** Type comes from config list / URL type param — see `rowToMeta(row, catalogType)` in `src/routes.js:127` and positional forward in `handleCatalog` (`src/routes.js:205`).

## Error Handling

**Strategy:** Fail-closed on admin paths (401 JSON, login page for HTML `/configure`); fail-empty on public catalog (`{ metas: [] }`); fail-loud with veto on save dispatches (502, nothing persisted); per-record isolation on `/runs` ingest.

**Patterns:**
- Structured dispatch results `{ dispatched, reason }` — callers veto/warn consistently (`src/dispatch.js:20`, `src/routes.js:380`).
- `SyntaxError` → 400, downstream fetch/timeout → 502 (`src/routes.js:495`, `src/routes.js:1054`, `src/routes.js:693`).
- Corrupt KV → fallback (empty config seeds / empty runs) never 500 (`src/config.js:434`, `src/config.js:542`, `src/config.js:597`).
- TMDB preview collection lookup failure is loud, not silent bypass (`src/routes.js:948`).

## Cross-Cutting Concerns

**Logging:** `console.log` stub-dispatch note + `console.warn` best-effort cleanup failure (`src/dispatch.js:15`, `src/routes.js:428`). No log framework; run diagnostics live in `/status`.
**Validation:** Boundary normalization in `src/config.js` (`migrate*`/`normalize*`); id regexes block path traversal (`src/config.js:296`, `src/config.js:321`); workflow inputs whitelisted via `tr -cd` (`tmdb.yml:64`); `fingerprint`/`constantTimeEqual` for PIN (`src/auth.js:76`).
**Authentication:** `isAuthEnabled` secure-default master switch + `isPublic`/`isAdminPath` classification (`src/auth.js:144`); session via HMAC cookie, KV fixed-window login rate limit (`src/auth.js:169`).

---

*Architecture analysis: 2026-09-15*
