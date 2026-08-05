# External Integrations

**Analysis Date:** 2026-08-05

## APIs & External Services

**MDBList Web Scraping (DOM-based):**
- Service: `mdblist.com` — Movie/TV database aggregation site
- Usage: Scrapes listing pages for catalog data (title, IMDB ID, score, poster, year)
- Client: Puppeteer with stealth plugin (no REST API for scraper module)
- Auth: None (public pages, bot detection bypassed via stealth)
- Files: `D:\New folder (5)\my-list\scripts\scrape.mjs`
- Endpoint pattern: `https://mdblist.com/movies/?...` or `https://mdblist.com/shows/?...`
- Anti-bot: Cloudflare challenge detection, warm-up session, human-like scrolling

**MDBList Official API:**
- Service: `api.mdblist.com` — REST API for official curated lists
- Usage: Fetches 3 fixed official lists (popular, justwatch-streaming-charts, moviemeter) for movies and shows
- SDK/Client: Native `fetch` (no SDK)
- Auth: API key passed as `apikey` query parameter
- Secret: `MDBLIST_API_KEY` (GitHub Actions secret)
- Base URL: `https://api.mdblist.com`
- Endpoint: `GET /lists/official/{slug}/items?apikey=...&limit=100&mediatype={movie|show}&append_to_response=poster`
- Pagination: Cursor-based (`next_cursor`, `has_more`), up to 50 pages
- Files: `D:\New folder (5)\my-list\scripts\official.mjs`

**GitHub API (Workflow Dispatch):**
- Service: `api.github.com` — Trigger GitHub Actions workflows from worker
- Usage: Worker dispatches scrape/official workflows when config changes or refresh requested
- SDK/Client: Native `fetch` (no SDK)
- Auth: Bearer token (`GH_TOKEN` Cloudflare secret)
- Endpoint: `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`
- Files: `D:\New folder (5)\my-list\src\dispatch.js`
- Headers: `Authorization: Bearer {token}`, `Accept: application/vnd.github+json`

**TMDB Image CDN:**
- Service: `image.tmdb.org` — Poster image hosting
- Usage: Poster URLs constructed as `https://image.tmdb.org/t/p/w500/{poster_path}`
- Auth: None (public CDN)
- Files: `D:\New folder (5)\my-list\src\routes.js` (line 102, `rowToMeta` function)

**Stremio:**
- Service: Stremio media center — Client application
- Usage: Addon protocol (manifest.json, catalog endpoints)
- Auth: None (public addon)
- Protocol: Stremio addon SDK (`/manifest.json`, `/catalog/{type}/{id}.json`)
- Files: `D:\New folder (5)\my-list\src\routes.js`, `D:\New folder (5)\my-list\src\index.js`

## Data Storage

**Cloudflare KV (Key-Value):**
- Provider: Cloudflare Workers KV
- Binding name: `STORE` (defined in `D:\New folder (5)\my-list\wrangler.toml`)
- Namespace ID: `36b7763e6e31445696e1a773c44de7a3`
- Keys stored:
  - `config` — JSON blob with scraper lists + official list toggles
  - `runs:scraper` — Last 30 scraper run records (most recent first)
  - `runs:official` — Last 30 official list run records
  - `healed` — One-shot migration flag (string `"1"`)
- Max run records: 30 per module (hardcoded in `D:\New folder (5)\my-list\src\config.js`, line 12)
- Client: Cloudflare Workers KV binding (global `env.STORE`)

**GitHub Pages (Static File Hosting):**
- Provider: GitHub Pages
- Base URL: `https://shivt37.github.io/my-list` (configured in `D:\New folder (5)\my-list\wrangler.toml`, line 13)
- Directory: `data/` in repo root
- Files served:
  - `data/{catalog_id}.json` — Scraper catalog data (e.g., `mdb_scrape_1djyii3b.json`)
  - `data/mdboff_{slug}_{type}.json` — Official catalog data (e.g., `mdboff_popular_movie.json`)
- Worker fetches these at runtime with 5-minute cache TTL (`cf: { cacheTtl: 300 }`)
- Files: `D:\New folder (5)\my-list\src\routes.js` (line 46-48, `githubPagesCatalogUrl`)

**Local Filesystem (Data Directory):**
- Location: `data/` directory in repo root
- Files: 9 JSON catalog files (3 scraper + 6 official)
- Purpose: Intermediate storage, committed to git, served via GitHub Pages
- Written by: GitHub Actions scraper/official scripts
- Files: `D:\New folder (5)\my-list\data\*.json`

**Caching:**
- Worker-to-GitHub-Pages: Cloudflare edge cache, 300s TTL (line 142 in routes.js)
- Catalog responses: `cache-control: public, max-age=300` (line 142 in routes.js)
- No Redis/Memcached

## Authentication & Identity

**Auth Provider:** None

**Secrets Management:**
- `GH_TOKEN` — Cloudflare secret (GitHub Actions dispatch from worker)
  - Set via: `wrangler secret put GH_TOKEN` or Cloudflare dashboard
  - Used in: `D:\New folder (5)\my-list\src\dispatch.js` (line 21)
- `MDBLIST_API_KEY` — GitHub Actions secret (MDBList API access)
  - Used in: `D:\New folder (5)\my-list\scripts\official.mjs` (line 28)
  - Scope: Official lists API only (scraper is DOM-based, does not use API key)
- `WORKER_ORIGIN` — GitHub Actions secret (worker base URL)
  - Used in: `D:\New folder (5)\my-list\scripts\scrape.mjs` (line 56), `D:\New folder (5)\my-list\scripts\official.mjs` (line 29)
  - Purpose: POST run records back to worker `/runs` endpoint

**CORS:**
- All origins allowed (`Access-Control-Allow-Origin: *`)
- Methods: GET, POST, OPTIONS
- Headers: content-type
- Files: `D:\New folder (5)\my-list\src\index.js` (line 9-12), `D:\New folder (5)\my-list\src\routes.js` (line 17-20)

## Monitoring & Observability

**Error Tracking:** None (no Sentry, LogRocket, etc.)

**Logs:**
- Worker: No logging (Cloudflare Workers logs via `wrangler tail`)
- Scraper: `console.log` / `console.error` in scripts (visible in GitHub Actions logs)
- Run records: Stored in KV, exposed via `/status` endpoint

**Status Page:**
- Endpoint: `/status` (scraper runs) or `/status?page=official` (official runs)
- Returns: Last 30 run records with catalog name, pages scraped, movies found, duration, status
- Files: `D:\New folder (5)\my-list\src\routes.js` (lines 145-166)

## CI/CD & Deployment

**Hosting:**
- Cloudflare Workers (worker deployment via Wrangler)
- GitHub Pages (static catalog data)

**CI Pipeline:**
- GitHub Actions — Two workflows:
  - `D:\New folder (5)\my-list\.github\workflows\scrape.yml` — Scrapes MDBList, commits JSON to `data/`, pushes to repo
  - `D:\New folder (5)\my-list\.github\workflows\official.yml` — Fetches official API lists, commits JSON to `data/`, pushes to repo
- Both workflows: cron every 12h (`0 */12 * * *`) + manual dispatch
- Concurrency group: `my-list-scrape` (no in-progress cancellation)
- Node.js 22 on `ubuntu-latest`
- Committer: `my-list-bot` (automated commits with `[skip ci]`)

**Deployment:**
- Worker: `wrangler deploy` (manual, no CI for worker code)
- Data: Auto-committed by GitHub Actions workflows

## Environment Configuration

**Required env vars (Worker - wrangler.toml):**
- `GITHUB_PAGES_BASE` — GitHub Pages URL for catalog data
- `GH_REPO` — GitHub repo (owner/name format)
- `GH_WORKFLOW` — Scraper workflow filename
- `GH_OFFICIAL_WORKFLOW` — Official workflow filename

**Required secrets (Worker):**
- `GH_TOKEN` — GitHub personal access token with `repo` scope

**Required secrets (GitHub Actions):**
- `WORKER_ORIGIN` — Cloudflare Worker base URL
- `MDBLIST_API_KEY` — MDBList API key (for official lists only)

**Secrets location:**
- Cloudflare: `wrangler secret put` or dashboard
- GitHub: Repository settings > Secrets and variables > Actions

## Webhooks & Callbacks

**Incoming:**
- `/save-config` (POST) — Admin UI saves config, triggers workflow dispatch
- `/trigger-refresh` (POST) — Admin UI requests manual refresh
- `/runs` (POST) — Scraper scripts report run completion
- GitHub Actions `workflow_dispatch` — External trigger for scraping

**Outgoing:**
- `POST /repos/{repo}/actions/workflows/{workflow}/dispatches` — Trigger GitHub Actions from worker
- `POST {WORKER_ORIGIN}/runs` — Scraper/official scripts report back to worker

## Data Flow Summary

```text
┌─────────────────────┐
│   Stremio Client     │
│  (manifest/catalog)  │
└──────────┬──────────┘
           │ GET /manifest.json, /catalog/...
           ▼
┌─────────────────────┐     ┌─────────────────────┐
│  Cloudflare Worker   │────▶│  Cloudflare KV       │
│  (src/*.js)          │     │  (config, run history)│
└──────────┬──────────┘     └─────────────────────┘
           │ GET data/{id}.json
           ▼
┌─────────────────────┐
│  GitHub Pages        │
│  (data/*.json)       │
└──────────▲──────────┘
           │ git commit + push
┌─────────────────────┐     ┌─────────────────────┐
│  GitHub Actions      │────▶│  MDBList.com         │
│  (scrape.yml)        │     │  (web scraping)      │
└─────────────────────┘     └─────────────────────┘
           │
           ▼
┌─────────────────────┐
│  GitHub Actions      │────▶ MDBList API
│  (official.yml)      │     (api.mdblist.com)
└─────────────────────┘
```

---

*Integration audit: 2026-08-05*
