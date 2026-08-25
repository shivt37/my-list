# External Integrations

**Analysis Date:** 2026-08-25

## APIs & External Services

**Stremio (consumer, not called):**
- The Worker IS a Stremio addon. Stremio clients GET `/manifest.json` and `/catalog/<type>/<id>/skip=<n>.json` (`src/routes.js` - `buildManifest`, `handleCatalog`, `CATALOG_RE`). No auth.

**MDBList API:**
- Official lists refresh + configure-page picker.
  - Caller: `src/routes.js` `handleMdblistOfficialCatalog` (GET `https://api.mdblist.com/lists/official?apikey=...`) and `scripts/official.mjs` (`apikey` query param via `url.searchParams.set`).
  - Auth: `MDBLIST_API_KEY` - Cloudflare worker secret for the picker proxy; GitHub repo secret for official.yml.
  - Note: key travels as a URL query param on both paths (API's convention), visible in access logs upstream.
- mdblist.com website scraping (DOM, not API): `scripts/scrape.mjs` drives headless Chromium with puppeteer-extra stealth against listing URLs stored in config; pagination params appended per the page-0/1+ rule documented in the script header.

**TMDB API:**
- Two consumers of `https://api.themoviedb.org/3`:
  1. Live helpers for the configure UI: keyword/company/collection search (`handleTmdbSearch`) and full Discover preview (`handleTmdbPreviewDiscover`) in `src/routes.js`; 30s fetch timeout via `AbortSignal.timeout`.
  2. Catalog generation: `scripts/tmdb.mjs` builds discover source plans (AND/OR modes, collection post-filter, 500-item cap).
- Auth: `TMDB_READ_ACCESS_TOKEN` as Bearer token (TMDB v4 read token) - Cloudflare secret + GitHub secret.
- Posters served from `https://image.tmdb.org/t/p/w500/...` (built into metas in `src/routes.js`).

**SIMKL API:**
- Arriving-today calendars: `https://data.simkl.in/calendar/v2/{tv,anime}.json?client_id=...&app-name=simkl-arriving-today&app-version=3.9.0` (`scripts/simkl.mjs`). Metadata comes embedded in the calendar payload - no per-title calls.
- Auth: public `SIMKL_CLIENT_ID` (GitHub repo secret) - app-level identification, not user auth.

**GitHub API (Actions dispatch):**
- `POST https://api.github.com/repos/{GH_REPO}/actions/workflows/{workflow}/dispatches` - single choke point is `dispatchScraperWorkflow()` in `src/dispatch.js`. 15s timeout; expects HTTP 204.
- Auth: `GH_TOKEN` Bearer (Cloudflare secret). Vars `GH_REPO`, plus workflow-file names from wrangler.toml vars / constants in `src/routes.js`.
- Workflows dispatched: `scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml` (all in `.github/workflows/`).

**Google Fonts:**
- Inter font loaded by the configure page from `fonts.googleapis.com` / `fonts.gstatic.com` (`src/configure.js`; CSP in `src/routes.js` html helper allows these origins).

## Data Storage

**Databases:**
- None (no D1, no SQL).

**KV Store:**
- Cloudflare Workers KV, binding `STORE` (`wrangler.toml`), accessed via `env.STORE` throughout `src/config.js` and `src/routes.js`.
  - `config` - the whole multi-module list config (scraper/official/simkl/tmdb sections); read-migrated-written by `loadConfig()`.
  - `runs:scraper`, `runs:official`, `runs:simkl`, `runs:tmdb` - last 30 scrape-run records each (`addRun`/`getRuns` in `src/config.js`), written via POST `/runs` from the scripts.
  - `healed` - one-shot seed-id healing flag.
  - `cache:mdblist-official` - 10-minute TTL cache (manual timestamp check) of the MDBList official catalog for the picker proxy.

**File Storage:**
- Catalog data files are JSON committed to the repo's `data/` directory (e.g. `data/mdb_scrape_*.json`, `data/mdboff_*_*.json`, `data/simkl_arriving_today_*.json`, `data/tmdb_discover_*.json`) and served publicly via GitHub Pages at `{GITHUB_PAGES_BASE}/data/<id>.json`. The Worker only fetches them (`githubPagesCatalogUrl` in `src/routes.js`); scripts write them locally and workflows commit+push (`git pull --rebase -X theirs` then push, in every workflow).

**Caching:**
- KV-based cache for the MDBList official catalog only (see above). No CDN/cache headers beyond default Worker behavior; no other caching layer.

## Authentication & Identity

**Auth Provider:**
- None. No user auth anywhere - this is deliberate:
  - Stremio catalog endpoints are public by protocol.
  - `/configure`, `/save-config`, `/export-config`, `/trigger-refresh` are unauthenticated admin surfaces (single-operator model; noted read-modify-write race accepted in `src/routes.js` comments).
- Machine-to-machine secrets only: `GH_TOKEN`, `TMDB_READ_ACCESS_TOKEN`, `MDBLIST_API_KEY` (Cloudflare secrets); `SIMKL_CLIENT_ID`, `WORKER_ORIGIN` (GitHub secrets).

## Monitoring & Observability

**Error Tracking:**
- None.

**Logs:**
- `console.log`/`console.error` in worker + scripts (visible in Cloudflare dash / Actions logs). Dispatch stub logs `[dispatch-stub] ...` (`src/dispatch.js`).
- Self-reported run history: scripts POST run records to the Worker's `/runs` endpoint after each list scrape; `/status` page renders the last 30 per module with IST timestamps (`toIST` in `src/routes.js`).

## CI/CD & Deployment

**Hosting:**
- Worker: Cloudflare Workers via wrangler.
- Static data: GitHub Pages from `main`.

**CI Pipeline:**
- Four GitHub Actions workflows (all cron `30 1,13 * * *` UTC = 07:00/19:00 IST except tmdb.yml which has the second cron commented out):
  - `.github/workflows/scrape.yml` - puppeteer DOM scrape; inputs `lists/action/delete_ids/debug`; input sanitization step before bash; commits data with `[skip ci]`.
  - `.github/workflows/official.yml` - MDBList API refresh/delete; inputs `slugs/action/delete_ids`.
  - `.github/workflows/simkl.yml` - SIMKL calendar refresh; input `kinds`.
  - `.github/workflows/tmdb.yml` - TMDB generate/delete; inputs `ids/action/delete_ids`.
- All four share concurrency group `my-list-scrape` (`cancel-in-progress: false`, `queue: max`) to serialize data-dir writes and KV run-record posts.
- Deploy pipeline for the Worker itself: none detected (manual wrangler deploy; no CI workflow deploys it).

## Environment Configuration

**Required env vars (Worker):**
- Secrets: `GH_TOKEN`, `TMDB_READ_ACCESS_TOKEN`, `MDBLIST_API_KEY` (each guarded with a clear "not configured" error in `src/dispatch.js` / `src/routes.js`).
- Vars (wrangler.toml): `GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`, `GH_TMDB_WORKFLOW`.
- Optional: `GH_DISPATCH_STUB` (local dev only), `GH_REF` (defaults `main`), `GH_SIMKL_WORKFLOW` (defaults constant).

**Required env vars (scripts, set by workflows from repo secrets):**
- `WORKER_ORIGIN` (all four scripts - required, hard-exit when missing in scrape.mjs main path).
- `MDBLIST_API_KEY` (official.mjs), `SIMKL_CLIENT_ID` (simkl.mjs), `TMDB_READ_ACCESS_TOKEN` (tmdb.mjs).
- `.dev.vars` file exists locally for wrangler dev (gitignored; contents not inspected).

**Secrets location:**
- Worker side: Cloudflare dashboard / `wrangler secret put` (documented in wrangler.toml comments).
- Scripts side: GitHub repo secrets referenced in workflow files under `${{ secrets.* }}`.

## Webhooks & Callbacks

**Incoming:**
- `POST /runs` - callback from all four scraper scripts recording run history into KV (`src/routes.js` `handleRunsPost`; batches capped at 50 records). Unauthenticated.
- No other inbound webhooks.

**Outgoing:**
- GitHub Actions dispatches (see GitHub API above) are effectively the outbound trigger mechanism; no HTTP webhooks fired by this codebase.

---

*Integration audit: 2026-08-25*
