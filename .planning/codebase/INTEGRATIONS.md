# INTEGRATIONS.md — External APIs, Storage, Auth

**Analysis Date:** 2026-09-03
**Scope:** full repo (`D:\New folder (5)\my-list`)

Worker (`src/`) and scraper scripts (`scripts/`) integrate with five external
systems: MDBList, Simkl, TMDB, GitHub (Actions + Pages), and Cloudflare KV.
Plus the Stremio client as the downstream consumer. Read-only (R) vs
read-write (RW) noted per section.

## 1. MDBList

Three distinct touchpoints:

### a) DOM scraping of listing pages — `scripts/scrape.mjs` (R)
- Headless Chromium (`puppeteer-extra` + stealth plugin) loads operator-supplied `https://mdblist.com/movies/...` / `/shows/...` filter URLs from config.
- Pagination rule: page 0 sets `q_current_page=0`; pages 1+ set `q_page_next=1` and `q_current_page=<page-1>` (`buildPageUrl`, `scripts/scrape.mjs:109-120`).
- Extracts per-row: `imdb_id`, `title`, `year`, `poster_path`, `digital_release_date`/`first_air_date`. No API key used — deliberately not mounted for this workflow (`scrape.yml` step comment).
- Human-like scroll + random delays; one bounded retry per page (S8).

### b) Official lists API — `scripts/official.mjs` (R)
- `GET https://api.mdblist.com/lists/official/{slug}/items?apikey={MDBLIST_API_KEY}&limit=100&mediatype=movie|show&append_to_response=poster&cursor=...` (`fetchAllItems`, `scripts/official.mjs:87-100`).
- Cursor-paginated (`has_more`); cap 50 pages. Auth: `apikey` query param.

### c) Official catalog listing — worker proxy, `src/routes.js:925-978` (R)
- `GET https://api.mdblist.com/lists/official?apikey={MDBLIST_API_KEY}` (`handleMdblistOfficialCatalog`). Powers the `/configure` picker.
- Cached ~10 min in KV under `cache:mdblist-official` (`OFFICIAL_CATALOG_CACHE_KEY`, `OFFICIAL_CATALOG_TTL_MS`) — endpoint undocumented, rate limits unknown.
- Response mapped to `{ slug, name, description, items, movies, shows, updated }`, minus already-configured slugs.
- Secret: `MDBLIST_API_KEY` (Cloudflare secret + GitHub repo secret for `official.yml` only).

## 2. Simkl API

- `scripts/simkl.mjs` (R): `GET https://data.simkl.in/calendar/v2/{tv,anime}.json?client_id={SIMKL_CLIENT_ID}&app-name=simkl-arriving-today&app-version=3.9.0` (`simklUrl`, `scripts/simkl.mjs:48-55`).
- Returns `{ calendar, metadata }`; metadata keyed by simkl id already carries genres/country/ratings — no per-title calls.
- Auth: client id query param only (`SIMKL_CLIENT_ID` secret). Simkl ratings: IMDb (series) / MAL (anime) tiers filtered operator-side.

## 3. TMDB API (v3, bearer token)

Two consumers, same auth: `Authorization: Bearer {TMDB_READ_ACCESS_TOKEN}` (v4 read token). All read-only (R).

### Worker live proxies — `src/routes.js:687-923`
- `/tmdb/search-keyword|company|collection?query=...` → `api.themoviedb.org/3/search/keyword|company|collection` (max 12 results).
- `POST /tmdb/preview-discover` → `/discover/movie` / `/discover/tv` (multi-source AND/OR query plan, `&with_genres|with_keywords|with_companies|without_*|with_release_type&region=US|vote_count.gte`), plus `/collection/{id}` for collection members.
- 30 s `AbortSignal.timeout`, up to 3 connection-level retries (`tmdbApi`, `src/routes.js:699-724`).

### Generator — `scripts/tmdb.mjs` (R)
- Same `/discover/{movie,tv}` + `/collection/{id}` calls; 500-item cap; sort baked into the query. Mirrors the worker's hash via shared import (`tmdbContentHash` from `src/config.js`).

### Image CDN (unauthenticated, R)
- Posters: `https://image.tmdb.org/t/p/w500{poster_path}` (`rowToMeta`, `rowToMetaTmdb`, `src/routes.js:133-137, 168-176`); scraped rows missing absolute posters get the same prefix.

## 4. GitHub (Actions dispatch + Pages)

### `workflow_dispatch` — `src/dispatch.js` (RW — triggers workflows)
- `POST https://api.github.com/repos/{GH_REPO}/actions/workflows/{wf}/dispatches`
- Headers: `Authorization: Bearer {GH_TOKEN}`, `Accept: application/vnd.github+json`, `User-Agent: my-list-worker`. Body: `{ ref: "main" (GH_REF override), inputs: {...} }`. Success = 204. 15 s abort timeout. Local dev stub: `GH_DISPATCH_STUB=1`.
- Workflow inputs per file:
  - `scrape.yml`: `lists`, `action` (`scrape|scrape_delete`), `delete_ids`, `config_version`, `debug`
  - `official.yml`: `slugs`, `action` (`refresh|delete`), `delete_ids`, `config_version`
  - `simkl.yml`: `kinds` (`series,anime`), `config_version`
  - `tmdb.yml`: `ids`, `action` (`generate|delete`), `delete_ids`, `config_version`
- `save-config` (`src/routes.js:247-499`) dispatches before persisting (rollback on failure) and stamps `config_version` (12-hex content hash) into every dispatch.

### Config-consistency polling — workflows → worker (R)
- Workflows curl `{WORKER_ORIGIN}/export-config` up to 5× at 20 s intervals until the dispatched `configVersion` (and dispatched ids/slugs) are visible — closes the KV eventual-consistency race (`scrape.yml:86-131`, mirrored in all four).

### GitHub Pages — worker reads catalogs (R)
- `GET {GITHUB_PAGES_BASE}/data/{catalogId}.json` per catalog request (`githubPagesCatalogUrl`, `src/routes.js:49-51`). Unknown id / non-200 / parse failure → `{ metas: [] }`.

### Data commit flow — scripts → repo (RW via `contents: write` permission)
- Scripts write `data/<id>.json`; workflows commit as `my-list-bot` and push (`git pull --rebase -X theirs`).

## 5. Cloudflare KV (`STORE` binding)

| Key | Shape | Writer | Reader |
|---|---|---|---|
| `config` | `{ scraper:{lists:[{id:"mdb_scrape_*",name,url,type,maxPages,enabled}]}, official:{lists:[{slug,name,enabled}]}, simkl:{lists:[{slug,name,enabled,filter{rating_source,rating_filter_enabled,exclude_genres,include_countries,exclude_countries,rating_tiers}}],timezone}, tmdb:{lists:[{discoverListId,name,mediaType,sort,enabled,includeModes,includeGenres,excludeGenres,includeKeywords,...,minVoteCount}]}, configVersion }` | `saveConfig` (`src/config.js:507-511`), self-heal path | worker, all scripts via `/export-config` |
| `runs:scraper` / `runs:official` / `runs:simkl` / `runs:tmdb` | Array (cap 30, newest first) of `{ id, catalog_id, started_at, finished_at, pages_scraped, movies_found, status:"success"|"failed", error_message, triggered_by:"scheduled"|"manual" }` | `POST /runs` (scripts) → `addRuns` | `/status`, `/status?format=json` |
| `healed` | `"1"` one-shot marker | `loadConfig` seed-id healing | `loadConfig` |
| `cache:mdblist-official` | `{ fetched_at, lists }`, 10-min TTL checked at read | `/mdblist/official-catalog` | same |
| `rl:login:{ip}:{window}` / `rl:login:global:{window}` | integer counters, `expirationTtl` 300 s | `rateLimitLogin` (`src/auth.js:169-187`) | same |

- Run-key routing: `runsKeyFor` — `mdboff_*` → `runs:official`, `simkl_*` → `runs:simkl`, `tmdb_*` → `runs:tmdb`, else `runs:scraper` (`src/config.js:18-23`).
- Serialization relies on the shared GitHub Actions concurrency group (accepted single-writer assumption, `src/config.js:516-521`).

## 6. Auth (self-hosted, no external IdP)

- Secret: `ADMIN_PIN` (worker secret; local dev in `.dev.vars`). Master switch `AUTH_ENABLED` (absent = ON — secure default, `src/auth.js:144-146`).
- Session: stateless HMAC-SHA256-signed cookie `mylist_session` — payload `v1|expMs|pinFingerprint|nonce` b64url + MAC; TTL 12 h (30 d "remember me"). Key material `SESSION_SECRET || ADMIN_PIN`. Rotation of `ADMIN_PIN` invalidates all sessions via the `pinfp` fingerprint check.
- PIN compare: constant-time XOR; length burn on mismatch (`src/auth.js:76-90`).
- Brute force: KV fixed-window limiter — 10 attempts/IP, 60 global per 5-min window (`rateLimitLogin`).
- Gate: admin prefixes `/configure`, `/save-config`, `/trigger-refresh`, `/tmdb/`, `/mdblist/` require a session; public routes (needed by the no-cookie workflows + Stremio): `/`, `/manifest.json`, `/status`, `/catalog/*`, `/export-config`, `/runs`, `/configure/login|logout` (`isPublic`, `src/auth.js:147-157`).

## 7. Stremio client (downstream consumer)

- Standard addon protocol served by the worker: `GET /manifest.json` (catalog list from live config) and `GET /catalog/{type}/{id}/skip={N}.json` (`CATALOG_RE`, `src/routes.js:47`; page size 100). Wide-open CORS (`Access-Control-Allow-Origin: *`, `src/index.js:11-14`).
- Catalog id namespaces: `mdb_scrape_*` (DOM scraper), `mdboff_{slug}_{movie|show}` (MDBList official), `simkl_arriving_today_{series|anime}`, `tmdb_discover_{movie|series}_{8hex}`.

## Secrets Inventory (names only — values never in repo)

| Secret | Where | Used by |
|---|---|---|
| `ADMIN_PIN` | Cloudflare secret / `.dev.vars` | worker auth |
| `SESSION_SECRET` | Cloudflare secret | worker auth (optional, falls back to ADMIN_PIN) |
| `AUTH_ENABLED` | Cloudflare secret / `.dev.vars` (value `"false"` locally) | auth gate |
| `MDBLIST_API_KEY` | Cloudflare secret; GitHub repo secret (official.yml) | official lists API + official catalog proxy |
| `TMDB_READ_ACCESS_TOKEN` | Cloudflare secret; GitHub repo secret (tmdb.yml) | TMDB v3 bearer |
| `SIMKL_CLIENT_ID` | Cloudflare secret; GitHub repo secret (simkl.yml) | Simkl calendar |
| `GH_TOKEN` | Cloudflare secret | workflow dispatch |
| `WORKER_ORIGIN` | GitHub repo secret | scripts → worker config/runs callbacks |
| `GH_DISPATCH_STUB` | `.dev.vars` only | local dispatch stub |

---

*integrations analysis: 2026-09-03*
<!-- refreshed: 2026-09-03 -->
