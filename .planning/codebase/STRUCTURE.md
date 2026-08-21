# Codebase Structure

**Analysis Date:** 2026-08-21

## Directory Layout

```text
my-list/
├── .github/
│   └── workflows/            # 4 GitHub Actions pipelines
│       ├── scrape.yml        # cron + dispatch → scripts/scrape.mjs
│       ├── official.yml      # cron + dispatch → scripts/official.mjs
│       ├── simkl.yml         # cron + dispatch → scripts/simkl.mjs
│       └── tmdb.yml          # cron + dispatch → scripts/tmdb.mjs
├── .planning/codebase/       # GSD analysis docs (this dir)
├── .wrangler/                # local wrangler state (gitignored)
├── data/                     # catalog JSON files — bot-written, Pages-served
│   ├── .gitkeep              # keeps dir in fresh clones
│   ├── mdb_scrape_*.json     # scraper module output
│   ├── mdboff_*_movie.json / *_show.json  # official module output
│   ├── simkl_arriving_today_*.json        # simkl module output
│   └── tmdb_discover_*.json  # tmdb module output
├── scratch/                  # throwaway research files (gitignored)
├── scripts/                  # Node 22 ESM batch jobs + tests (own package.json)
│   ├── scrape.mjs            # puppeteer DOM scraper for mdblist.com
│   ├── official.mjs          # MDBList API official lists fetcher
│   ├── simkl.mjs             # SIMKL v2 calendar arriving-today builder
│   ├── tmdb.mjs              # TMDB discover list generator
│   ├── dry-test.mjs          # worker route integration tests (fake KV)
│   ├── verify-tmdb.mjs       # TMDB additions self-check (jsdom)
│   ├── verify-ui.mjs         # configure page smoke test (jsdom)
│   ├── package.json          # deps: puppeteer, puppeteer-extra(+stealth)
│   └── package-lock.json
├── src/                      # Cloudflare Worker (no bundler, plain ESM)
│   ├── index.js              # fetch handler + router
│   ├── routes.js             # all route handlers (manifest/catalog/status/save/runs/tmdb proxies)
│   ├── config.js             # KV config store, migration, hashes, run history
│   ├── dispatch.js           # GitHub Actions workflow dispatch (single function)
│   └── configure.js          # admin SPA as one HTML string (1773 lines)
├── .gitignore                # ignores data/*.json (force-added by bots) and local tests
└── wrangler.toml             # worker name/main/KV binding STORE/vars
```

## Directory Purposes

**`src/`:**
- Purpose: the Cloudflare Worker deployable. Everything served at `*.workers.dev`.
- Contains: router, handlers, KV access layer, dispatcher, admin UI generator.
- Key files: `src/index.js` (`main` per `wrangler.toml`), `src/routes.js`, `src/config.js`.

**`scripts/`:**
- Purpose: GitHub Actions batch jobs and their test harnesses. Has its own `package.json` (`"type": "module"`) because only these need npm deps.
- Contains: one `.mjs` per data module, three standalone test scripts.
- Key files: `scripts/scrape.mjs`, `scripts/dry-test.mjs`.

**`.github/workflows/`:**
- Purpose: scheduling, input sanitization, secret wiring, bot commit of `data/*.json`.
- Contains: four near-identical YAMLs; all share concurrency group `my-list-scrape` with `queue: max`, `cancel-in-progress: false`, and the same commit recipe ending in `git pull --rebase -X theirs`.

**`data/`:**
- Purpose: generated catalog payloads committed by bot workflows and served via GitHub Pages at `{GITHUB_PAGES_BASE}/data/<catalog_id>.json`.
- Generated: Yes — every filename is `<catalog_id>.json`; worker never writes here.
- Committed: Yes (gitignored via `data/*.json` but force-added with `git add -f` by workflows).

**`scratch/`:**
- Purpose: ad-hoc research dumps (SIMKL API samples). Gitignored.

**`.planning/`:**
- Purpose: GSD planning docs including this codebase map.

## Key File Locations

**Entry Points:**
- `src/index.js`: Worker `fetch(request, env)` handler — the only runtime entry
- `.github/workflows/scrape.yml` (+ 3 siblings): scheduled/manual CI entry points
- `scripts/*.mjs` `main()`: CLI entry points guarded by per-file `isMain` checks

**Configuration:**
- `wrangler.toml`: KV binding `STORE`, vars `GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`, `GH_TMDB_WORKFLOW`; `nodejs_compat` flag
- Cloudflare secrets (not in repo): `GH_TOKEN`, `TMDB_READ_ACCESS_TOKEN`
- GitHub secrets (not in repo): `WORKER_ORIGIN`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`, `TMDB_READ_ACCESS_TOKEN`
- `src/config.js`: seed lists/default filters/id constants — the de-facto schema definition

**Core Logic:**
- `src/routes.js`: manifest build, catalog resolution, save diffing/dispatch ordering, run ingest, TMDB live preview
- `src/config.js`: normalization/migration on every load, content hashes, runs storage
- `scripts/scrape.mjs`: pagination rule (`q_current_page`/`q_page_next`), bot-detection warm-up, DOM extraction selectors
- `scripts/simkl.mjs`: filter tiers, bulk-air grouping, priority sort
- `scripts/tmdb.mjs`: AND/OR discover source plan, collection post-filtering, sourceHash

**Testing:**
- `scripts/dry-test.mjs`: full route coverage with fake KV + stubbed fetches (`node scripts/dry-test.mjs`)
- `scripts/verify-tmdb.mjs`, `scripts/verify-ui.mjs`: targeted self-checks using jsdom
- Note: `dry-test.mjs` and `verify-ui.mjs` are gitignored ("local test scripts")

## Naming Conventions

**Files:**
- Worker modules: lowercase single words (`index.js`, `routes.js`, `config.js`, `dispatch.js`, `configure.js`)
- Scripts: kebab/lowercase `.mjs` matching workflow purpose (`scrape.mjs`, `verify-tmdb.mjs`, `dry-test.mjs`)
- Workflows: lowercase `.yml` named after their module (`scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml`) — filenames are API identifiers used by `dispatchScraperWorkflow`

**Directories:**
- Lowercase, no nesting beyond two levels anywhere

**Identifiers (data):**
- Catalog ids double as filenames and carry a module prefix that everything keys off: `mdb_scrape_`, `mdboff_`, `simkl_arriving_today_`, `tmdb_discover_<mediaType>_`
- KV keys: `config`, `runs:<module>`, `healed`

## Where to Add New Code

**New catalog module (5th data source):** follow the four-part pattern exactly:
1. Script: `scripts/<name>.mjs` with injectable `main({ fetchCfg, write, recordRuns, ... })`, id-prefix regex whitelist on args, `writeCatalog` producing `{ catalog_id, name, type, scraped_at, items }` into `data/<id>.json`, `postRuns` chunked ≤50
2. Workflow: copy `.github/workflows/tmdb.yml`, add input sanitization step, join concurrency group `my-list-scrape` with `queue: max`, keep commit recipe verbatim
3. Worker config section: defaults + migrator in `src/config.js` (mirror `migrateSimkl`/`migrateTmdb`; add to `emptyConfig`, `migrateConfig` return, and `loadConfig` normalization block)
4. Worker routes: constants in `src/config.js` exports, catalog branch + `rowToMeta<Name>` mapper in `handleCatalog`/`buildManifest`, runs-key prefix in `runsKeyFor`, status page branch in `handleStatus`, refresh branch in `handleTriggerRefresh`, optional save-dispatch diff in `handleSaveConfig`
5. UI tab in `src/configure.js` if operator-editable (register in `rerenderActive()`)
6. Tests: extend `scripts/dry-test.mjs` (routes) and add `verify-<name>.mjs` if logic-heavy

**New worker endpoint:** add handler to `src/routes.js`, wire pathname/method check in `src/index.js` before the 404. Keep CORS via the shared `json()` helper.

**New scraper list type:** no new file needed — scraper lists are data-driven from KV (`SEED_LISTS` seeds, `/save-config` adds more); only touch `src/config.js` if the record shape changes (then update `listContentHash` fields deliberately).

**Utilities/shared helpers:** there is no shared util file between `src/` and `scripts/` and none should be invented without a bundler — duplicated small helpers (`chunkArray`, `postRuns`, `arg`) are the accepted convention; mirror-comment both sides when they must stay in sync.

**Tests:** colocated in `scripts/` as runnable `.mjs` files with zero test framework (`node:assert` + jsdom where DOM is needed).

## Special Directories

**`data/`:**
- Purpose: live catalog payload store
- Generated: Yes, exclusively by workflows
- Committed: Yes — force-added despite `data/*.json` gitignore rule; fresh clones see only `.gitkeep` until first cron lands

**`debug/`:** created at repo root by `scrape.mjs --debug` (HTML/screenshots); gitignored; uploaded as CI artifact.

**`.wrangler/`:** local dev state; gitignored; not part of deployment.

---

*Structure analysis: 2026-08-21*
