# STRUCTURE

**Analysis Date:** 2026-09-03

<!-- refreshed: 2026-09-03 -->

## Top-level layout

```
my-list/
├── src/                  Cloudflare Worker (deployed; zero npm deps)
├── scripts/              GitHub Actions job scripts (puppeteer only dep)
├── data/                 Catalog JSON files (bot-written, git add -f, Pages-served)
├── .github/workflows/    4 CI workflows (cron + dispatch)
├── testing/              Standalone assert tests + fixtures (GITIGNORED)
├── audit/                UI/functional audit artifacts + reports (GITIGNORED)
├── .audit/               Earlier audit phase captures (GITIGNORED)
├── scratch/              One-off probe scripts, screenshots, logs (GITIGNORED)
├── .planning/            Planning/codebase docs (STACK.md, INTEGRATIONS.md, codebase/)
├── .claude/              Agent config
├── .wrangler/            Wrangler local state (GITIGNORED)
├── wrangler.toml         Worker config (KV binding STORE, vars)
├── .dev.vars             Local dev secrets (GITIGNORED)
├── PRODUCT.md            Product notes (GITIGNORED)
└── .gitignore
```

No root `package.json` — the worker has zero dependencies; only `scripts/package.json` exists
(`my-list-scraper`, deps: `puppeteer`, `puppeteer-extra`, `puppeteer-extra-plugin-stealth`; script:
`npm run scrape`).

## `src/` — the worker (camelCase, one concern per file)

| File | Lines | Purpose |
|---|---|---|
| `src/index.js` | 123 | Worker `fetch` handler. Thin router: CORS preflight, auth routes (always open), session gate, then exact pathname matches delegating to routes.js. |
| `src/routes.js` | 978 | All handlers: `buildManifest`, `handleCatalog` + `CATALOG_RE`, `handleStatus`, `handleSaveConfig` (per-module diff + phased dispatch), `handleExportConfig`, `handleTriggerRefresh`, `handleRunsPost`, TMDB helpers (`handleTmdbSearch`, `handleTmdbPreviewDiscover`), official picker (`handleMdblistOfficialCatalog`, KV-cached 10 min under `cache:mdblist-official`), `configureResponse`. Also the four `rowToMeta*` mappers (one per module). |
| `src/config.js` | 585 | Config schema + KV. `loadConfig`/`saveConfig`, `migrateConfig` + per-module normalizers, seeds (`SEED_LISTS`, `OFFICIAL_LISTS`, `SIMKL_LISTS`), id schemes (`randomScraperId`, `tmdbCatalogId`, `officialCatalogsFor`), hashes (`configVersion`, `listContentHash`, `tmdbContentHash`), run history (`addRun`, `addRuns`, `capRuns`, `getRuns`, `runsKeyFor`). |
| `src/configure.js` | 2267 | `/configure` page — ONE giant template literal (server-rendered shell + CSS + inline client JS + 4 module tabs). Backticks/`${` illegal in body; strings via `+`. Single `state` object, `rerenderActive()`. |
| `src/status.js` | 470 | `/status` page — normal template literal, `statusPageResponse()`; renders all 4 modules from `handleStatus`; `?format=json` bypasses to raw feed. Hand-mirrors `ACCENT_COLORS`. |
| `src/auth.js` | 376 | Login gate: HMAC stateless session cookie (`mylist_session`, `v1|exp|pinfp|nonce.hmac`), constant-time PIN compare, KV fixed-window rate limit (10/IP, 60/global per 5 min), route classification (`isPublic`, `isAdminPath`, `isAuthEnabled`), `loginPageHtml`. |
| `src/dispatch.js` | 53 | `dispatchScraperWorkflow` — single GitHub dispatch call site; 15s `AbortSignal.timeout`; `GH_DISPATCH_STUB` local no-op. |

## `scripts/` — CI job mains (kebab/mixed naming, `.mjs`)

| File | Lines | Purpose |
|---|---|---|
| `scripts/scrape.mjs` | 528 | DOM scraper: puppeteer-extra + stealth; `buildPageUrl` pagination rule; fetch config via `/export-config`; `writeCatalog` → `data/<id>.json`; `postRuns` (chunks of 50); `--action=scrape\|scrape_delete`, `--lists=`, `--delete-ids=`, `--debug`. |
| `scripts/official.mjs` | 257 | MDBList API for enabled official slugs × 2 mediatypes → `data/mdboff_<slug>_<movie\|show>.json`; `--slugs=`, `--action=refresh\|delete`, `--delete-ids=`. |
| `scripts/simkl.mjs` | 494 | SIMKL v2 calendar (tv + anime); per-list filter blocks (genres/countries/rating tiers) + global timezone; empty result is legitimate and overwrites; `--kinds=series\|anime`. |
| `scripts/tmdb.mjs` | 485 | TMDB `/discover` generator; AND/OR include modes; collection post-filter (no native param); 500-item cap; imports `tmdbContentHash` from `../src/config.js` (single hash source); items stored pre-sorted. |
| `scripts/package.json`, `scripts/package-lock.json` | — | Scraper deps (puppeteer only). `npm ci` in workflow. |

Shared script conventions: `export const ROOT/DATA_DIR` (repo-relative), `arg(name)` CLI parser,
`isMain` entry guard, `writeCatalog` per script, run-record shape `{catalog_id, pages_scraped,
triggered_by, movies_found, status, error_message, started_at, finished_at}`, id regex validation
before `join()` (path-traversal guard).

## `data/` — catalog data plane

Bot-owned artifacts, **gitignored as `data/*.json`** then force-added (`git add -f data/*.json`)
by workflows. `data/.gitkeep` keeps the dir in fresh clones. Files:

- `mdb_scrape_<id>.json` — scraper rows (3 files)
- `mdboff_<slug>_<movie|show>.json` — official lists (`justwatch-streaming-charts`, `most-watched-week`)
- `simkl_arriving_today_<series|anime>.json`
- `tmdb_discover_<movie|series>_<id>.json`

Wrapper shape: `{ catalog_id, name, type, scraped_at, sourceHash, items }` (tmdb documented;
others equivalent). Never hand-edited — throwaway artifacts, regenerated per cron; conflicts resolved
by `git pull --rebase -X theirs`.

## `.github/workflows/` — CI

- `scrape.yml` — 2 crons (00:00/12:00 UTC = 05:30/17:30 IST), inputs `lists/action/delete_ids/config_version/debug`, input sanitization step, KV-consistency wait, 30-min timeout, debug artifact upload.
- `official.yml` — same crons; inputs `slugs/action/delete_ids/config_version`; 15-min timeout.
- `simkl.yml` — same crons; inputs `kinds/config_version`.
- `tmdb.yml` — ONE cron daily (12:00 UTC line deliberately commented out, owner decision); inputs `ids/action/delete_ids/config_version`.

All four: `permissions: contents: write`, shared `concurrency: my-list-scrape` + `queue: max`,
bot commit `chore(data): … [skip ci]`.

## Supporting dirs

- `testing/` — GITIGNORED. Standalone tests (no framework, `node:assert/strict`, stub `fetch` + fake KV):
  `save-config.test.mjs` (regen-on-enable + scraper regressions), `scrape-serve.test.mjs` (S1 typing
  regression), `tmdb-sort.test.mjs`, `verify-tmdb.mjs`, `verify-ui.mjs`, `dry-test.mjs`,
  `theme-preview.html`.
- `audit/` — GITIGNORED. `audit/report/FUNCTIONAL-AUDIT.md`, `audit/report/UI-AUDIT.md` +
  `audit/report/images/F*.png` (F01–F18 before/after evidence), `audit/status-design/`
  (`mockup-a/b/c.html`, `REPORT.md`, `STATUS-REVIEW.md`, `mockup-b/option-*.html`).
- `.audit/` — GITIGNORED. Earlier audit phase captures (phase1–4 notes, DOM/style JSON dumps,
  probe scripts, wrangler logs, html smoke screenshots, `build-xlsx.py`, `mockups/`).
- `scratch/` — GITIGNORED. One-off probes and screenshots: `*.mjs` verification scripts
  (`agent-review-*.mjs`, `ui-f*.mjs`, `dim-*.mjs`, `status-verify.mjs`, `sync-local-from-prod.mjs`),
  `MDBList API.yaml`, `wrangler-dev.log`, screenshots (`look-*.png`, `status-*.png`, `*-dim-*.png`),
  `scratch/audit/` subfolder (live-test outputs, config snapshots, UI screenshot corpus 01–96).
- `.planning/` — tracked planning docs: `STACK.md`, `INTEGRATIONS.md`, `FUNCTIONAL-AUDIT.md`,
  `codebase/` (this mapping).

## Gitignored areas (`.gitignore`)

`node_modules/`, `.wrangler/`, `dev-dist/`, `debug/`, `scratch/`, `.audit/`, `audit/`, `.dev.vars`,
`PRODUCT.md`, `data/*.json` (force-added by bots), `testing/`, `implementation/`, `.DS_Store`.

## Naming conventions

- **`src/`** — camelCase filenames (`config.js`, `configure.js`, `routes.js`, `status.js`, `auth.js`,
  `dispatch.js`, `index.js`); ES modules, ESM imports; exported `handleX` / `buildX` verbs.
- **`scripts/`** — lowercase single-word `.mjs` mains (`scrape`, `official`, `simkl`, `tmdb`), one per
  module; kebab-case in workflow names (`official.yml`).
- **Data files** — flat `<prefix>_<identifier>.json`, never nested dirs (id = filename = catalog id).
- **Catalog id prefixes** — module-dispatch contract: `mdb_scrape_` / `mdboff_` / `simkl_` /
  `tmdb_discover_`; `runsKeyFor()` and `handleCatalog` branch on prefix.
- **KV keys** — `config`, `runs:<module>` (`runs:scraper`, `runs:official`, `runs:simkl`, `runs:tmdb`),
  `healed`, `cache:mdblist-official`, `rl:login:<ip>:<window>`, `rl:login:global:<window>`.
- **Env/secrets** — UPPER_SNAKE (`ADMIN_PIN`, `GH_TOKEN`, `WORKER_ORIGIN`, `MDBLIST_API_KEY`,
  `SIMKL_CLIENT_ID`, `TMDB_READ_ACCESS_TOKEN`, `GH_DISPATCH_STUB`, `AUTH_ENABLED`, `SESSION_SECRET`,
  `GH_SIMKL_WORKFLOW`, `GH_TMDB_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`, `GITHUB_PAGES_BASE`).
- **Workflows** — one file per module (`scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml`); cron
  lines edited on github.com, never worker-side.
- **Tests** — `*.test.mjs` (behavior) + `verify-*.mjs` (manual verification) + `dry-test.mjs`.

---

*Structure analysis: 2026-09-03*
