# Codebase Structure

**Analysis Date:** 2026-09-15

## Directory Layout

```
my-list/
├── src/                # Cloudflare Worker (all request handling)
│   ├── index.js        # Router + auth gate
│   ├── routes.js       # Stremio + control API handlers (~1100 lines)
│   ├── config.js       # Config normalize/hash + KV store (~600 lines)
│   ├── auth.js         # PIN login, session cookie, rate limit
│   ├── dispatch.js     # GitHub workflow_dispatch client
│   ├── configure.js    # /configure admin SPA (single-file HTML/JS, ~2700 lines)
│   └── status.js       # /status dashboard page (server-rendered)
├── scripts/            # GitHub Actions generators (Node, run via workflows)
│   ├── scrape.mjs      # MDBList DOM scraper (puppeteer + stealth)
│   ├── official.mjs    # MDBList official-lists API puller
│   ├── simkl.mjs       # SIMKL calendar v2 → arriving-today filter
│   └── tmdb.mjs        # TMDB Discover generator
├── .github/workflows/  # Cron + dispatch schedules per module
│   ├── scrape.yml
│   ├── official.yml
│   ├── simkl.yml
│   └── tmdb.yml
├── data/               # Generated catalog JSON (committed, served via Pages)
├── testing/            # Node assert scripts + live/verify helpers
├── audit/report/       # Phase 1 + Phase 2 functional/UI audit reports + screenshots
├── scratch/            # Reference material (MDBList API yaml, SIMKL notes)
├── .planning/codebase/ # GSD codebase maps + research notes
├── wrangler.toml       # Worker name, entry, KV binding, public vars
└── README.md           # System overview, layout table, module docs
```

## Directory Purposes

**`src/`:**
- Purpose: Entire Worker runtime. No subdirectories — 7 flat ES modules.
- Contains: Request routing, business logic, KV access, HTML page builders.
- Key files: `src/index.js` (entry, `wrangler.toml` `main`), `src/routes.js` (bulk of logic), `src/config.js` (state shape), `src/configure.js` (largest file, admin UI).

**`scripts/`:**
- Purpose: Data-plane generators, executed only in GitHub Actions (never imported by Worker, except `scripts/tmdb.mjs` imports `tmdbContentHash` from `src/config.js`).
- Contains: 4 `.mjs` CLIs with `--ids/--slugs/--kinds/--lists/--action/--delete-ids` argv parsing, shared wrapper output shape `{ catalog_id, name, type, scraped_at, sourceHash, items }`.
- Key files: `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`.
- Note: `scripts/node_modules/` is a local install (puppeteer etc.) used by Actions; root `node_modules/` holds test/verify deps (jsdom, playwright).

**`.github/workflows/`:**
- Purpose: One workflow per module, each with own cron + `workflow_dispatch` inputs + shared `my-list-scrape` concurrency group (`queue: max`).
- Contains: Input sanitization (`tr -cd` whitelist), KV-consistency wait loop, `node <script>.mjs`, `git add -f 'data/*.json'` + rebase-push commit step.
- Key files: `.github/workflows/scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml`.

**`data/`:**
- Purpose: Generated catalog files, one per catalog id, committed to git and served as static JSON via GitHub Pages (`{GITHUB_PAGES_BASE}/data/<id>.json`).
- Contains: `mdb_scrape_*.json`, `mdboff_<slug>_<movie|show>.json`, `simkl_arriving_today_*.json`, `tmdb_discover_*_*.json`, plus `.gitkeep`.
- Generated: Yes (by Actions). Committed: Yes (deliberately — audit trail + survives worker downtime).

**`testing/`:**
- Purpose: Standalone Node verification scripts (no test runner; `node testing/<file>.mjs`).
- Contains: `*.test.mjs` (assert-based: `save-config`, `scrape-serve`, `tmdb-sort`, `preview-excl-dom`, `network-picker-dom`), `verify-*.mjs` / `*-live.mjs` / `*-repro.mjs` / `dry-test.mjs` (manual/live helpers), `theme-preview.html`.
- Key files: `testing/save-config.test.mjs` (save dispatch regression), `testing/scrape-serve.test.mjs`, `testing/tmdb-sort.test.mjs`.

**`audit/report/`:**
- Purpose: Historical QA evidence (Phase 1 + Phase 2 functional + UI audits with screenshots).
- Contains: `Phase 1/FUNCTIONAL-AUDIT.md`, `Phase 1/UI-AUDIT.md`, `Phase 2/FUNCTIONAL-AUDIT-2.md`, `Phase 2/UI-AUDIT-2.md`, `images/` per phase.
- Read-only reference; never import from it.

**`scratch/`:**
- Purpose: External API reference material for generator authors.
- Contains: `scratch/MDBList API.yaml`, `scratch/simkl-llms-full.txt`.

**`.planning/`:**
- Purpose: GSD planning artifacts + codebase maps.
- Contains: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`, `.planning/codebase/RESEARCH-own-mdblist-platform.md`.

## Key File Locations

**Entry Points:**
- `src/index.js`: Worker `fetch` handler — start here for any request-path question.
- `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`: Generator CLIs — start here for data-shape questions.
- `.github/workflows/*.yml`: Cron/dispatch wiring — start here for scheduling questions.

**Configuration:**
- `wrangler.toml`: Worker name (`my-list`), `main = "src/index.js"`, `STORE` KV binding id, public vars (`GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW*`). Secrets (`GH_TOKEN`, `ADMIN_PIN`, `TMDB_READ_ACCESS_TOKEN`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`) live only in Cloudflare dashboard / GitHub secrets — never in repo.
- KV `STORE` keys (runtime, not files): `config`, `runs:scraper`, `runs:official`, `runs:simkl`, `runs:tmdb`, `healed`, `rl:login:*`, `cache:network-search:*`, `cache:mdblist-official`.

**Core Logic:**
- `src/routes.js`: `buildManifest`, `handleCatalog`, `handleSaveConfig`, `handleExportConfig`, `handleTriggerRefresh`, `handleRunsPost`, `handleStatus`, TMDB/MDBList proxies.
- `src/config.js`: `loadConfig`, `saveConfig`, `migrateConfig`, `normalizeTmdbList`, `normalizeSimklList`, `migrateOfficial`, `listContentHash`, `tmdbContentHash`, `configVersion`, `addRuns`, `capRuns`.
- `src/configure.js`: `buildConfigurePage` + embedded SPA (`renderScraper`, `renderOfficial`, `renderSimkl`, `renderTmdb`, preview/picker/save flows).
- `src/auth.js`: `isPublic`, `isAdminPath`, `checkSession`, `handleLogin`, `handleLogout`, `rateLimitLogin`.
- `src/dispatch.js`: `dispatchScraperWorkflow`.
- `src/status.js`: `statusPageResponse`.

**Testing:**
- `testing/save-config.test.mjs`: Save-dispatch matrix (regen-on-enable, phased dispatch order).
- `testing/scrape-serve.test.mjs`: Catalog serving shape.
- `testing/tmdb-sort.test.mjs`, `testing/preview-excl-dom.test.mjs`, `testing/network-picker-dom.test.mjs`: TMDB sort/exclusion/network DOM+logic checks.
- `testing/verify-ui.mjs`, `testing/verify-tmdb.mjs`, `testing/tmdb-repro.mjs`, `testing/tmdb-exclude-e2e.mjs`, `testing/networks-live.mjs`, `testing/undated-live.mjs`, `testing/dry-test.mjs`: Manual/live verification helpers.

## Naming Conventions

**Files:**
- Worker: flat `src/*.js`, lowercase, one concern per file (`auth.js`, `dispatch.js`, `status.js`). No subdirectories, no barrel files, no framework.
- Generators: `scripts/<module>.mjs` (`.mjs` = ESM CLI with shebang + `process.argv` parsing). Workflows mirror module names: `scripts/tmdb.mjs` ↔ `.github/workflows/tmdb.yml`.
- Tests: `testing/<topic>.test.mjs` (assert suites) vs `testing/verify-*.mjs` / `testing/*-live.mjs` (manual/live) vs `testing/*-repro.mjs` / `testing/*-e2e.mjs` (reproductions).
- Data: `<catalog-id>.json` where id embeds module: `mdb_scrape_<8>`, `mdboff_<slug>_<movie|show>`, `simkl_arriving_today_<series|anime>`, `tmdb_discover_<movie|series>_<8base36>`.

**Directories:**
- Lowercase, no nesting beyond one level (`audit/report/Phase N/`, `.github/workflows/`, `.planning/codebase/`). `node_modules/` at root and under `scripts/` are installs, not source.

**Code identifiers:**
- Handlers: `handle<Thing>` (`handleCatalog`, `handleSaveConfig`, `handleTmdbPreviewDiscover` in `src/routes.js`; `handleLogin`/`handleLogout` in `src/auth.js`).
- Config: `migrate<Section>` (whole-section sanitize), `normalize<Thing>` (single-entry coerce), `<thing>Defaults`/`seed<Thing>Defaults` (fresh-install seeds), `<thing>ContentHash` (regen diff), `runsKeyFor` (prefix → history key) — all in `src/config.js`.
- KV keys: `runs:<module>`, `cache:<what>:<key>`, `rl:login:<ip>:<window>` (`src/config.js`, `src/routes.js`, `src/auth.js`).
- Configure SPA: `render<Module>` + `toggle<Thing>`/`set<Thing>`/`updateTmdb` + `tmdb*` helpers, all inside the single `<script>` in `src/configure.js`.

## Where to Add New Code

**New Worker endpoint:**
- Route entry: `src/index.js` `fetch` (pathname + method match, following existing order: auth bypass → gate → public → admin → proxies → 404).
- Handler: `src/routes.js` as `export async function handle<Thing>`; auth classification in `src/auth.js` (`isPublic` vs `ADMIN_PREFIXES`/`isAdminPath`).
- Tests: `testing/<topic>.test.mjs` with fake-KV + stubbed `fetch` harness (see `testing/save-config.test.mjs:13`).

**New catalog module (5th data source):**
- Config section: `src/config.js` — `migrate<Section>` + `normalize*` + catalog-id builder + content hash + `RUNS_<MOD>_KEY` + `runsKeyFor` branch + `loadConfig` seeding branch.
- Serving: `src/routes.js` — `rowToMeta<Mod>`, `buildManifest` block, `handleCatalog` registry lookup, `handleStatus` name map + `liveCatalogIdsFor` branch.
- Save/refresh: `handleSaveConfig` diff + phased dispatch, `handleTriggerRefresh` page branch, new `*_WORKFLOW` const.
- Admin UI: `render<Mod>` tab + `buildConfig`/`isDirty` branches in `src/configure.js`; status tab in `MODULES` in `src/status.js`.
- Pipeline: `scripts/<mod>.mjs` + `.github/workflows/<mod>.yml` (same concurrency group, same `data/*.json` + `/runs` contract).
- Data file: `data/<new-id-scheme>.json`.

**New TMDB discover dimension:**
- Shape: `normalizeTmdbList` in `src/config.js:318` + `tmdbContentHash` field list + `TMDB_DIMS`/`TMDB_FIELD_KEYS`/`TMDB_NAME_KEYS` + `tmdbDimSection` + add/remove helpers in `src/configure.js` + `buildDiscoverSources` in `scripts/tmdb.mjs:87` + preview query plan in `handleTmdbPreviewDiscover` (`src/routes.js:868`). All four must stay in sync or preview diverges from generated files.

**Utilities:**
- Shared Worker helpers: `src/routes.js` (`json`/`html`) or `src/config.js` (pure functions). No `utils/` dir exists — keep it that way; colocate with the layer that owns the concern.
- Shared test harness: inline per file (fake KV + fetch stub at top of `testing/save-config.test.mjs`); no shared test helper module.

## Special Directories

**`data/`:**
- Purpose: Committed build artifacts doubling as the production CDN (via GitHub Pages).
- Generated: Yes. Committed: Yes (with `-f` — `data/*.json` would otherwise risk ignore rules; see workflow commit steps).

**`node_modules/` (root) and `scripts/node_modules/`:**
- Purpose: Installed deps (jsdom/playwright at root for tests; puppeteer-extra stack under `scripts/` for the scraper).
- Generated: Yes. Committed: No.

**`audit/`:**
- Purpose: Frozen QA reports + screenshots.
- Generated: No (human/assistant-written). Committed: Yes.

---

*Structure analysis: 2026-09-15*
