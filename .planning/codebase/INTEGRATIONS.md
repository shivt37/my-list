# External Integrations

**Analysis Date:** 2026-08-21

## APIs & External Services

**MDBList (two distinct access modes):**
- Official lists API - `https://api.mdblist.com/lists/official/<slug>/items?apikey=...` (`scripts/official.mjs` line 31, 86-93)
  - Client: raw `fetch`, no SDK
  - Auth: `MDBLIST_API_KEY` env var (GitHub secret), passed as `apikey` query param
- Listing-page DOM scrape - `https://mdblist.com/movies|shows/?...` URLs saved in config; headless Chromium via puppeteer-extra + stealth (`scripts/scrape.mjs`)
  - Auth: none (stealth plugin evades bot detection)
- Note: `MDBLIST_API_KEY` is no longer mounted in scrape.yml nor read by scrape.mjs (cleaned up 2026-08-23) - only official.mjs talks to the MDBList API

**TMDB:**
- v3 API with v4 bearer token - `https://api.themoviedb.org/3/discover/{movie,tv}`, `/search/{keyword,company,collection}`, `/collection/<id>` (`src/routes.js` `tmdbApi()`, `scripts/tmdb.mjs` `tmdbFetch()` at line 101)
  - Client: raw `fetch`, Bearer Authorization header
  - Auth: `TMDB_READ_ACCESS_TOKEN` (Cloudflare secret + GitHub secret)
  - Used two ways: live search/preview proxies from the configure page (`routes.js` lines 513-688) and batch catalog generation in CI (`scripts/tmdb.mjs`)
  - Poster images pulled from `https://image.tmdb.org/t/p/w500<poster_path>` when building Stremio metas (`routes.js` `rowToMetaTmdb`)

**SIMKL:**
- v2 calendar API - `https://data.simkl.in/calendar/v2/{tv,anime}.json?client_id=...&app-name=simkl-arriving-today&app-version=3.9.0` (`scripts/simkl.mjs` `simklUrl()`)
  - Client: raw `fetch`
  - Auth: `SIMKL_CLIENT_ID` (GitHub secret); no user token - anonymous client-id app identity
  - Metadata (genres/country/ratings incl. IMDb + MAL) embedded in calendar response - no per-title calls

**GitHub Actions API (workflow dispatch):**
- `POST https://api.github.com/repos/<GH_REPO>/actions/workflows/<wf>/dispatches` (`src/dispatch.js`)
  - Client: raw `fetch`
  - Auth: `GH_TOKEN` (Cloudflare secret, Bearer PAT)
  - Expects exactly HTTP 204 on success; workflow filename comes from trusted env vars/constants (no runtime allowlist - corrected 2026-08-23); outbound fetch bounded by `AbortSignal.timeout(15000)` to block path injection
  - Dispatches four workflows: `scrape.yml` (lists/action/delete_ids inputs), `official.yml` (slugs input), `simkl.yml` (kinds input), `tmdb.yml` (ids/action/delete_ids inputs)

**GitHub Pages (catalog data plane):**
- `GET {GITHUB_PAGES_BASE}/data/<catalogId>.json` on every `/catalog/*` request (`src/routes.js` `githubPagesCatalogUrl()`)
  - No auth; worker is a thin fetcher that never touches mdblist itself
  - Missing/failed fetch returns `{ metas: [] }` with status 200, never an error

## Data Storage

**Databases:**
- Cloudflare Workers KV
  - Binding: `STORE` (`wrangler.toml`, namespace id `36b7763e6e31445696e1a773c44de7a3`)
  - Keys: `config` (full addon config JSON), `runs:scraper` / `runs:official` / `runs:simkl` / `runs:tmdb` (last-30 run history each, capped by `RUNS_MAX = 30` in `src/config.js`), `healed` (one-shot flag)
  - Access via `kv.get(key, "json")` / `kv.put`; corrupt config value falls back to seeds instead of erroring (`loadConfig`)

**File Storage:**
- Git repo `data/*.json` files committed by CI bots and served via GitHub Pages. Ignored locally (`.gitignore` `data/*.json`) but force-added in workflows (`git add -f 'data/*.json'`). Push strategy: `git pull --rebase -X theirs`.
- File naming convention encodes module: `mdb_scrape_<8 chars>.json`, `mdboff_<slug>_<movie|show>.json`, `simkl_arriving_today_<series|anime>.json`, `tmdb_discover_<movie|series>_<8 base36>.json`

**Caching:**
- None. Every catalog request re-fetches from GitHub Pages.

## Authentication & Identity

**Auth Provider:**
- None for the addon itself. Stremio consumes the manifest/catalog anonymously.
- The `/configure` admin page, `/save-config`, `/trigger-refresh`, and `/export-config` have NO authentication - anyone with the worker URL can read full config and trigger GitHub Actions runs. Single-operator assumption noted in code comment ("Accepted for a single-operator admin page" at `src/routes.js` line 245).

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry/GlitchTip).

**Logs:**
- `console.log`/`console.error` in scripts (visible only in GitHub Actions run logs)
- Structured run-history instead of logs: scrapers POST `{ runs: [...] }` to the worker's `/runs` endpoint (`routes.js` `handleRunsPost`), stored in KV, rendered by `/status?page=<module>` with IST timestamps (`toIST()` hardcodes UTC+5:30)

## CI/CD & Deployment

**Hosting:**
- Worker: Cloudflare Workers (deployed via Wrangler)
- Data/catalogs: GitHub Pages from `shivt37/my-list` repo root
- Compute for scraping: GitHub Actions ubuntu-latest runners

**CI Pipeline:**
- Four scheduled+manual-dispatch workflows, all sharing concurrency group `my-list-scrape` with `queue: max` (serialize all data writes):
  - `.github/workflows/scrape.yml` - cron `30 1,13 * * *` UTC, puppeteer scrape, 30 min timeout
  - `.github/workflows/official.yml` - same crons, MDBList official API, 15 min
  - `.github/workflows/simkl.yml` - same crons, Simkl calendar fetch, 15 min
  - `.github/workflows/tmdb.yml` - cron `30 1 * * *` UTC only (the `30 13` line is commented out), TMDB discover generation, 15 min
- All four: checkout@v5, setup-node@v5 (Node 22), input sanitization via `tr -cd` whitelists, then commit-and-push data changes as `my-list-bot`
- No PR checks, no lint/test CI

## Environment Configuration

**Required env vars:**

Cloudflare secrets:
- `GH_TOKEN` - required for any save/refresh dispatch
- `TMDB_READ_ACCESS_TOKEN` - required for `/tmdb/search-*` and `/tmdb/preview-discover` (fails fast with 500 if unset)

Cloudflare vars (`wrangler.toml`): `GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`, `GH_TMDB_WORKFLOW`; optional undeclared-but-read: `GH_SIMKL_WORKFLOW`, `GH_REF`

GitHub Actions secrets: `WORKER_ORIGIN`, `MDBLIST_API_KEY`, `TMDB_READ_ACCESS_TOKEN`, `SIMKL_CLIENT_ID`

**Secrets location:**
- Cloudflare dashboard / `wrangler secret put` (worker side)
- GitHub repo Settings > Secrets and variables > Actions (CI side)
- `.env` files not detected; `node_modules/.cache/wrangler/wrangler-account.json` present (local account cache)

## Webhooks & Callbacks

**Incoming:**
- `POST /runs` - called by `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs` after each list run to record run history in KV (chunked ≤50 records per request). Unauthenticated.
- `POST /save-config` - configure page persists config and triggers workflow dispatches (simkl first, scraper last, tmdb combined generate+delete; dispatches must succeed before KV persist)
- `POST /trigger-refresh` - manual refresh, optional `{ id, page }` body scopes to one list/module
- `POST /tmdb/preview-discover` - configure page preview, up to 25 TMDB pages per call

**Outgoing:**
- Workflow dispatches (see GitHub Actions API above) - the worker's only write-path into the data pipeline

---

*Integration audit: 2026-08-21*
