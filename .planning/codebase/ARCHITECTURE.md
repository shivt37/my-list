# ARCHITECTURE

**Analysis Date:** 2026-09-03

<!-- refreshed: 2026-09-03 -->

## Pattern

**Thin router worker + CI-side workers + static data plane.** The Cloudflare Worker is a thin router
(`src/index.js`) that never touches MDBList/SIMKL/TMDB for catalog data. Heavy lifting (scraping,
generation) runs in GitHub Actions; catalog data lives OUTSIDE the worker as static JSON committed to
the repo (`data/*.json`) and served via GitHub Pages. Runtime state (config + run history) is two KV
shapes in one namespace (`STORE` binding).

Three cooperating runtimes, no shared process:

1. **Worker** (`src/index.js`) — routes, manifest, catalog serving, admin config, auth.
2. **GitHub Actions** (`.github/workflows/*.yml`) — crons + dispatched runs; checkout repo, run a
   `scripts/*.mjs` main, commit `data/*.json` back (bot: `my-list-bot`), POST run records to the worker.
3. **GitHub Pages** — passive static host for `data/*.json`; worker fetches from it per catalog request.

## Layers

| Layer | Files | Responsibility |
|---|---|---|
| Router | `src/index.js` | Match pathname/method, auth gate, delegate. No business logic. |
| Routes/handlers | `src/routes.js` | Manifest, catalog, save/export config, refresh dispatch, runs ingest, TMDB search/preview, official picker. |
| Presentation (server-rendered) | `src/configure.js`, `src/status.js`, `src/auth.js` (`loginPageHtml`) | Full HTML pages embedded in JS. No template engine. |
| Domain/config | `src/config.js` | Config migration/normalization, seeding, id schemes, content hashes, run-history KV (cap 30). |
| Integration | `src/dispatch.js` | Single GitHub workflow-dispatch call site; `GH_DISPATCH_STUB` for local dev. |
| Auth | `src/auth.js` | HMAC-signed stateless session cookie, constant-time PIN check, KV fixed-window rate limit. |
| Jobs | `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs` | Each module's generator main; DOM scrape (puppeteer) or API fetch → write `data/<id>.json` → POST `/runs`. |
| CI | `.github/workflows/scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml` | Cron + workflow_dispatch, input sanitization, KV-consistency wait, data commit, shared concurrency group. |

## Entry points

- `src/index.js` — worker `fetch` handler (only worker entry; no scheduled handler — crons are the
  workflows' own lines, edited on github.com).
- `.github/workflows/*.yml` — CI entries (schedule + `workflow_dispatch`).
- `scripts/*.mjs` mains — CLI entries (`--lists=`, `--slugs=`, `--kinds=`, `--ids=`, `--action=`,
  `--delete-ids=`, `--debug`); `isMain` guard in `scripts/scrape.mjs`.
- `testing/*.mjs` — standalone assert-based tests (no framework), run via `node`.

## The 4 list modules

Every module has: a config section (KV `config` key), a run-history key, a data-file id prefix, a
generator script, a workflow:

| Module | Config shape | Catalog ids | Data file | Script | Workflow | Runs key |
|---|---|---|---|---|---|---|
| scraper (MDBList custom URLs, DOM-scraped) | `{ lists: [{id, name, url, type, maxPages, enabled}] }` | `mdb_scrape_<8 alnum>` | `data/mdb_scrape_*.json` | `scripts/scrape.mjs` | `scrape.yml` | `runs:scraper` |
| official (MDBList prebuilt, API) | `{ lists: [{slug, name, enabled}] }`, open slug set, cap 30 | `mdboff_<slug>_<movie\|show>` | `data/mdboff_*.json` | `scripts/official.mjs` | `official.yml` | `runs:official` |
| simkl (built-in Arriving Today) | `{ lists: [{slug, name, enabled, filter}], timezone }`, exactly 2 fixed slugs (`series`, `anime`) | `simkl_arriving_today_<slug>` | `data/simkl_arriving_today_*.json` | `scripts/simkl.mjs` | `simkl.yml` | `runs:simkl` |
| tmdb (Discover queries) | `{ lists: [{discoverListId, mediaType, sort, includeModes, …}] }` | `tmdb_discover_<movie\|series>_<8 base36>` (`tmdbCatalogId()` in `src/config.js`) | `data/tmdb_discover_*.json` | `scripts/tmdb.mjs` | `tmdb.yml` | `runs:tmdb` |

Id prefix routing is centralized: `runsKeyFor(catalogId)` in `src/config.js:18`.

## Data flow

**Config write path (admin):** `/configure` UI → POST `/save-config` → `handleSaveConfig`
(`src/routes.js:247`): diff old vs new per module (content hashes `listContentHash` /
`tmdbContentHash`; enable-toggle detection) → dispatch regeneration workflows FIRST, destructive
cleanup dispatches LAST (tail-adjacent; failed regen = clean rollback, no persist) → `saveConfig()`
persists with stamped `configVersion` (content hash, `src/config.js:62`) → response reports what will
regenerate.

**Dispatch-decoupling protocol (F3):** every dispatch carries `config_version`. Workflow waits on
`GET /export-config` (up to 5 × 20s) until the expected version is visible — closes the KV
eventual-consistency race for new ids AND edited settings.

**Scrape/regen path:** cron or dispatch → workflow sanitizes inputs (`tr -cd` whitelist), waits for
KV, runs `node <script>.mjs` → script pulls config from `/export-config` → fetches/scrapes source →
writes `data/<id>.json` → POST `/runs` (batched 50, `addRuns` in `src/config.js`) → workflow
`git add -f data/*.json` + commit + `git pull --rebase -X theirs` + push.

**Serve path (Stremio):** client → GET `/manifest.json` (`buildManifest`, built live from config) →
GET `/catalog/<type>/<id>/skip=N.json` → `handleCatalog` (`src/routes.js:178`) resolves the id
against all 4 modules, picks a module-specific `rowToMeta*` mapper, fetches
`$GITHUB_PAGES_BASE/data/<id>.json`, slices 100 per page, returns `{ metas }`. Unknown id → empty;
disabled-module ids keep serving (manifest gates discovery; direct URLs stay valid across toggles).

**Status path:** workflows POST `/runs` → KV run history (last 30/module) → `/status`
(`statusPageResponse`, `src/status.js`) server-renders all 4 modules; `?format=json` keeps the raw
`handleStatus` feed for tests/tooling.

## Abstractions

- **No framework.** Hand-rolled router + plain `Response` helpers (`json`/`html` in
  `src/index.js`, `src/routes.js`, `src/auth.js`). Zero runtime deps in the worker
  (`nodejs_compat` flag gives `node:crypto`).
- **One dispatch chokepoint:** `dispatchScraperWorkflow` in `src/dispatch.js` — all three save/refresh
  paths reach GitHub through it; workflow file overridable per call (`env.GH_SIMKL_WORKFLOW` etc.).
- **Config as validated-then-normalized blob:** every load passes `loadConfig` → `migrateConfig` →
  per-module normalizers (`migrateOfficial`, `migrateSimkl`, `migrateTmdb`, `normalizeTiers`,
  `normalizeTz`). Corrupt KV heals to defaults rather than 500-ing. One-shot id healing gated by KV
  `healed` flag. Seed-only-when-key-absent semantics (an operator's deliberate empty list survives).
- **Id-as-address:** catalog id doubles as data-file name and config key; prefixes route behavior.
  Path-traversal blocked at the config normalizer regex (`/^mdb_scrape_[A-Za-z0-9_-]{1,32}$/`) and at
  script arg regexes before `join()` in `writeCatalog`.
- **Content hashes for change detection:** `listContentHash` (scraper: url/maxPages/enabled/type —
  name excluded so rename ≠ rescrape) and `tmdbContentHash` (single source of truth, imported
  directly by `scripts/tmdb.mjs` from `src/config.js`).
- **Shared serialization:** all 4 workflows share `concurrency: my-list-scrape` + `queue: max` —
  serializes KV read-modify-write on run history and data commits (documented accepted limitation in
  `src/config.js:516`).

## Embedded-UI constraints

- `src/configure.js` (2267 lines) is **ONE giant server-rendered template literal** for `/configure`.
  Backticks and `${` are ILLEGAL inside the template body — all client strings use `+` concatenation.
  The only interpolations are the state/origin JSON blobs at `src/configure.js:890-891` (hard-escaped
  `<` → `\u003c`). Client JS lives inline in the same literal; single `state` object,
  `rerenderActive()` re-render.
- `src/status.js` (470 lines) is the newer status page — normal template literal (`statusPageResponse`),
  mirrors `ACCENT_COLORS` from configure.js by hand ("not importable" — see comment at
  `src/status.js:15`).
- `src/auth.js` login page follows the same pattern (template literal, `+` concatenation inside).

## Configuration & secrets

- `wrangler.toml`: worker name, `STORE` KV binding, `keep_vars = true`, vars
  `GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`, `GH_TMDB_WORKFLOW`.
- Cloudflare secrets (dashboard): `GH_TOKEN`, `ADMIN_PIN`, `SESSION_SECRET`, `WORKER_ORIGIN`-side
  nothing — `AUTH_ENABLED` var. `.dev.vars` (gitignored) mirrors these locally plus `GH_DISPATCH_STUB`
  and `MDBLIST_API_KEY` / `TMDB_READ_ACCESS_TOKEN` / `SIMKL_CLIENT_ID` for scripts.
- GitHub repo secrets: `WORKER_ORIGIN`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`, `TMDB_READ_ACCESS_TOKEN`.
- `GH_TOKEN` needs `contents: write` (declared per-workflow).

## Public vs admin surface

Public (per `isPublic` in `src/auth.js:147`): `/`, `/manifest.json`, `/catalog/*`, `/status`,
`/export-config`, `/runs` (workflows have no browser cookie). Admin-gated: `/configure`,
`/save-config`, `/trigger-refresh`, `/tmdb/*`, `/mdblist/*`. `AUTH_ENABLED="false"` bypasses session
check (dev only); misspelled value = ON (secure default).

---

*Architecture analysis: 2026-09-03*
