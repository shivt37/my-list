# External Integrations

**Analysis Date:** 2026-09-15

## APIs & External Services

**TMDB (The Movie Database) - discover, search, preview, networks:**
- Generator: `scripts/tmdb.mjs` calls `https://api.themoviedb.org/3/discover/movie|tv` (20 results/page, `MAX_ITEMS = 500`, collection post-filter raises page cap 25 -> 100)
- Worker live proxies in `src/routes.js` (`tmdbApi` helper, `AbortSignal.timeout`, 3x retry on `ECONNRESET`): `GET /tmdb/search-keyword|company|collection|title`, `POST /tmdb/preview-discover`, `GET /tmdb/search-network`, `GET /tmdb/network/<id>`
  - Search proxy: `https://api.themoviedb.org/3${pathAndQuery}` with `Authorization: Bearer <TMDB_READ_ACCESS_TOKEN>`, results capped `TMDB_SEARCH_MAX = 12`
  - Network typeahead (no official `/search/network` API): proxies website route `https://www.themoviedb.org/search/remote/tv_network?query=...`, 10-min KV cache
  - Images: `https://image.tmdb.org/t/p/w500` (catalog posters), `w92` (search thumbs), `w185` (network logos)
- Auth: `TMDB_READ_ACCESS_TOKEN` (v4 bearer) - Cloudflare worker secret + GitHub repo secret consumed by `tmdb.yml`
- Note: token stays server-side; browser preview calls go through Worker proxies, never direct

**MDBList - official lists API + scraped listing pages:**
- Official API: `scripts/official.mjs` (`API = "https://api.mdblist.com"`) - per slug two pulls `mediatype=movie|show`, cursor pages `limit=100`, stops on `has_more=false` or 50 pages (5 000 items/catalog max); picker proxy in `src/routes.js` calls `https://api.mdblist.com/lists/official?apikey=...` with 10-min KV cache
- DOM scraping: `scripts/scrape.mjs` opens mdblist.com browse URLs in headless Chromium (puppeteer-extra + stealth, 1920x1080, scroll capped ~3000px); pagination replays `q_current_page`/`q_page_next` params; pacing 1.5-3.5s between pages, 2.5-5s between lists, 120s nav timeout, 1 retry
- Auth: `MDBLIST_API_KEY` as query param `?apikey=` - worker secret + CI secret (official path only; scraper deliberately mounts no key)
- Upstream limits: free tier ~1 000 API req/day, 24h refresh minimum; `MAX_OFFICIAL_LISTS = 30` per save

**SIMKL - arriving-today calendar:**
- `scripts/simkl.mjs` fetches `https://data.simkl.in/calendar/v2/{tv,anime}.json?client_id=...&app-name=simkl-arriving-today&app-version=3.9.0` with `User-Agent: simkl-arriving-today/3.9.0`; 30s fetch timeout, 500ms pause between kinds; "today" keyed by operator timezone via `Intl`
- Auth: `SIMKL_CLIENT_ID` query param - worker secret + CI secret consumed by `simkl.yml`
- Upstream limit: 10 GET/s

**GitHub REST API - workflow dispatch:**
- `src/dispatch.js` (`dispatchScraperWorkflow`): `POST https://api.github.com/repos/<GH_REPO>/actions/workflows/<wf>/dispatches` with `Authorization: Bearer <GH_TOKEN>`, `Accept: application/vnd.github+json`, `User-Agent: my-list-worker`, 15s timeout; body `{ ref, inputs }`; success = HTTP 204, else structured `{ dispatched: false, reason }`
- Triggered by `POST /save-config` (hash change per module) and `POST /trigger-refresh` in `src/routes.js`; per-module workflow files `scrape.yml` / `official.yml` / `simkl.yml` / `tmdb.yml`
- Local-dev stub: `GH_DISPATCH_STUB` env makes dispatch log-and-succeed without network

**Google Fonts (UI asset):**
- `src/configure.js` + CSP in `src/routes.js` (`html()` helper): `https://fonts.googleapis.com` (Inter 400/500/600/700 stylesheet) and `https://fonts.gstatic.com` (font files); `preconnect` links in page head

## Data Storage

**Databases:**
- Cloudflare KV, binding `STORE` (`wrangler.toml`, id `36b7763e6e31445696e1a773c44de7a3`)
  - Connection: Worker runtime binding `env.STORE`; no connection string
  - Client: native KV API via helpers in `src/config.js` (`loadConfig`/`saveConfig`/`addRuns`/`getRuns`/`migrateConfig`) - single `config` key holds `{ scraper, official, simkl, tmdb }` plus `configVersion` content hash; `runs:scraper|official|simkl|tmdb` keys hold last-30 run records; 10-min caches for TMDB network search and MDBList official catalog
  - Consistency note: KV is eventually consistent - workflows poll `GET /export-config` until dispatched `configVersion` is visible (5 attempts x 20s) before running

**File Storage:**
- GitHub Pages static hosting: committed `data/*.json` (one file per catalog id, e.g. `data/mdb_scrape_*.json`, `data/mdboff_*_*.json`, `data/simkl_arriving_today_*.json`, `data/tmdb_discover_*.json`) served at `${GITHUB_PAGES_BASE}/data/<catalogId>.json`; Worker is a thin proxy (`githubPagesCatalogUrl` in `src/routes.js`), never generates data
- Files are gitignored (`data/*.json` in `.gitignore`) but force-added by bot commits (`git add -f 'data/*.json'`, `git pull --rebase -X theirs`, `[skip ci]` message)

**Caching:**
- No dedicated cache service; ephemeral 10-min KV entries for `/tmdb/search-network` and `/mdblist/official-catalog` proxy results

## Authentication & Identity

**Auth Provider:**
- Custom PIN gate in `src/auth.js` - zero runtime deps, no third-party IdP
  - Implementation: `ADMIN_PIN` worker secret compared constant-time; session = stateless HMAC-SHA256-signed cookie (`mylist_session`, WebCrypto `crypto.subtle`, `SESSION_SECRET` or `ADMIN_PIN` as key material, `AUTH_VERSION = "v1"`); TTL 12h default, 30d with "remember me"; brute-force defended by KV fixed-window per-IP + global lockout counters
  - Protected (session required when `AUTH_ENABLED != "false"`): `/configure` page, `POST /save-config`, `POST /trigger-refresh`, `/tmdb/*`, `/mdblist/*` (`ADMIN_PREFIXES` + `isAdminPath`/`isPublic` in `src/auth.js`, enforced in `src/index.js`)
  - Public by design (CI has no cookie): `/`, `/manifest.json`, `/catalog/*`, `/status`, `/export-config`, `POST /runs`, login/logout routes

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry or equivalent)

**Logs:**
- `console.log` dispatch-stub line in `src/dispatch.js`; `console.error` on script failures in `scripts/*.mjs` (surfaced in Actions job logs)
- Status dashboard: `GET /status` HTML page (`src/status.js`, tabs per module `scraper|official|simkl|tmdb`) backed by KV run history; `?format=json` raw feed via `handleStatus` in `src/routes.js`; per-run records POSTed by scripts to `POST /runs` (batch cap 50)
- Debug artifacts: `scrape.yml` uploads `debug/*` via `actions/upload-artifact@v6` (7-day retention) on `--debug` or failure

## CI/CD & Deployment

**Hosting:**
- Cloudflare Workers (`my-list`, live `https://my-list.st87.workers.dev`); `keep_vars = true` so dashboard vars survive deploys
- GitHub Pages (same repo) serves `data/*.json` catalog files
- Stremio clients consume Worker `/manifest.json` + `/catalog/<type>/<id>.json` (100 metas/page, `skip=N` pagination)

**CI Pipeline:**
- GitHub Actions, 4 cron workflows (`.github/workflows/scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml`): `actions/checkout@v5` + `actions/setup-node@v5` (Node 22); shared `concurrency.group: my-list-scrape` with `queue: max`, `cancel-in-progress: false` so data commits serialize
- Schedules: scrape/official/simkl twice daily `0 0 * * *` + `0 12 * * *` (05:30/17:30 IST); tmdb once daily `0 0 * * *` (noon run commented out)
- Each run: sanitize inputs (char-class whitelist) -> wait for KV consistency (`curl $WORKER_ORIGIN/export-config`) -> `node <script>.mjs` (`npm ci` first for scrape only) -> commit `data/*.json` (`my-list-bot`) -> `POST /runs`
- No deploy-on-push for Worker code; data commits carry `[skip ci]`

## Environment Configuration

**Required env vars:**
- Worker secrets: `GH_TOKEN`, `ADMIN_PIN`, `MDBLIST_API_KEY`, `TMDB_READ_ACCESS_TOKEN`, `SIMKL_CLIENT_ID` (optional `SESSION_SECRET`)
- Worker vars (`wrangler.toml`): `GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`, `GH_TMDB_WORKFLOW`, `AUTH_ENABLED`
- CI secrets/env per workflow: `WORKER_ORIGIN` (all four), plus `MDBLIST_API_KEY` (official), `TMDB_READ_ACCESS_TOKEN` (tmdb), `SIMKL_CLIENT_ID` (simkl)

**Secrets location:**
- Production: Cloudflare dashboard Variables and Secrets + GitHub repo Actions secrets (`WORKER_ORIGIN`, API keys); `GH_REF` optionally pins dispatch branch (default `main`)
- Local dev: `.dev.vars` at repo root (gitignored, existence only - never commit values); `GH_DISPATCH_STUB=1` avoids real dispatches

## Webhooks & Callbacks

**Incoming:**
- `POST /runs` (public, `handleRunsPost` in `src/routes.js`) - CI scripts report run records; batch-capped, routed per catalog id via `runsKeyFor` in `src/config.js`
- `POST /trigger-refresh`, `POST /save-config` - operator/admin UI actions that fan out to GitHub `workflow_dispatch` (authenticated, not third-party webhooks)
- No Stremio, TMDB, MDBList, or SIMKL inbound webhooks - all upstream contact is outbound poll/proxy

**Outgoing:**
- GitHub `workflow_dispatch` events per module (see GitHub REST API above) with module-specific inputs (`lists`/`slugs`/`kinds`/`ids`, `action`, `delete_ids`/`delete-ids`, `config_version`, `debug`)
- No outbound webhooks to TMDB/MDBList/SIMKL beyond direct API fetches

---

*Integration audit: 2026-09-15*
