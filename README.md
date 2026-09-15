# my-list

A personal **Stremio addon** that aggregates four kinds of catalogs — scraped MDBList listings, official MDBList lists, Simkl "arriving today" calendars, and TMDB Discover lists — into one installable addon with a browser-based admin panel.

Live: `https://my-list.st87.workers.dev`

```
┌────────────────────┐   GET /export-config    ┌──────────────────────────┐
│  Cloudflare Worker │ ◄────────────────────── │ GitHub Actions workflows │
│  (this repo: src/) │ ──────────────────────► │ (scripts/*.mjs)          │
│  - Stremio API     │   POST /runs,           │ scrape / official /      │
│  - /configure UI   │   workflow_dispatch      │ simkl / tmdb             │
│  - /status page    │                         └─────────┬────────────────┘
│  KV STORE: config  │                                   │ commit data/*.json
└─────────┬──────────┘                                   ▼
          │ fetch                                GitHub Pages (this repo)
          ▼                                      {GITHUB_PAGES_BASE}/data/<catalog_id>.json
   /catalog/... proxy ──────────────────────────► serves the JSON
```

- **Worker** (`src/`) holds operator config in KV (`STORE`), serves the Stremio
  manifest + catalogs, the admin UI, and the status page. It never generates data.
- **GitHub Actions** (`.github/workflows/` + `scripts/`) fetch the real data on
  cron, commit it to `data/` in this repo, which GitHub Pages serves as static
  JSON. The worker proxies those files.
- Result: data survives worker downtime, config changes apply without redeploy,
  and every run is auditable in git history.

---

## Repository layout

| Path | What |
|---|---|
| `src/index.js` | Worker router — all HTTP endpoints below |
| `src/config.js` | Config normalize/hash, catalog-ID schemes, seed defaults |
| `src/configure.js` | `/configure` admin SPA (one giant HTML/JS template literal) |
| `src/routes.js` | Catalog proxy, status, save/export config, TMDB preview & search handlers |
| `src/auth.js` | PIN login, session cookies, public-path allowlist |
| `src/dispatch.js` | `workflow_dispatch` calls to GitHub Actions |
| `src/status.js` | Status page HTML (run history per module) |
| `scripts/scrape.mjs` | MDBList page scraper (headless Chromium) |
| `scripts/official.mjs` | MDBList official-lists API puller |
| `scripts/simkl.mjs` | Simkl calendar v2 → filtered "arriving today" lists |
| `scripts/tmdb.mjs` | TMDB Discover generator (runs on cron) |
| `data/` | Generated catalog JSON, one file per catalog id (committed) |
| `.planning/` | Design docs, research notes, ADR-style context |

---

## Worker endpoints (the "pages")

| Route | Auth | Purpose |
|---|---|---|
| `GET /` | public | Plain-text index of the three URLs above |
| `GET /manifest.json` | public | Stremio addon manifest; only **enabled** modules appear |
| `GET /catalog/<type>/<id>.json[?skip=N]` | public | Catalog page, 100 metas per request (Stremio pagination) |
| `GET /configure` | PIN | Admin SPA — edit all four modules |
| `POST /save-config` | PIN | Validate + normalize + store config; dispatches refresh when needed |
| `GET /export-config` | public | The config JSON the CI scripts pull (read-only) |
| `GET/POST /status` | public | HTML status dashboard (`?format=json` for raw feed) |
| `POST /runs` | public | CI scripts report run records here (batch cap 50, history 30 per module) |
| `POST /trigger-refresh` | PIN | Manual "Reload" → GitHub `workflow_dispatch` |
| `GET /tmdb/search/<movie\|series>?query=` | public | TMDB title search (used by pickers) |
| `GET /tmdb/search-network?query=` | public | Network typeahead proxy (TMDB remote search, 10-min KV cache) |
| `GET /tmdb/network/<id>` | public | Network detail (logo, country) for the picker |
| `POST /tmdb/preview-discover` | PIN | Live preview of a TMDB list, same code path as the generator |
| `GET /mdblist/official-catalog` | public | Full official-list slug catalog for the picker (10-min KV cache) |
| `/configure/login`, `/configure/logout` | — | PIN session (12 h, 30 d with "remember") |

Catalog serving rule: unknown ids return `{ metas: [] }`; ids of **disabled**
lists keep serving on purpose — the manifest gates discovery, direct URLs stay
stable across enable/disable.

---

## Module 1 — MDBList Scraper (`mdb_scrape_*`)

**What it is.** Any mdblist.com *browse* URL (a filtered movies/shows listing)
is scraped to a JSON catalog. Operator pastes a URL, picks type, sets pages.

**How it works** (`scripts/scrape.mjs`, workflow `scrape.yml`):
1. Fetch config from `/export-config`; take every enabled scraper list.
2. Headless Chromium (puppeteer-extra + stealth, realistic UA, 1920×1080)
   opens the listing URL, scrolls to bottom (capped ~3000 px), and extracts
   each row's poster slug → id/title/year.
3. Pagination is URL-parameter replay, byte-for-byte as MDBList generated it:
   page 0 gets `q_current_page=0`; pages 1+ get `q_page_next=1` and
   `q_current_page = page-1`.
4. Writes `data/mdb_scrape_<id>.json`; commits; POSTs a run record to `/runs`.

**Limits / knobs:**
- `maxPages` per list: default **3**, hard-clamped **1..50** (server + UI).
- Anti-ban pacing: 1.5–3.5 s between pages, 2.5–5 s between lists, 5–10 s + 1
  retry on page failure; per-page nav timeout 120 s.
- Job timeout: 30 min. Cron: 00:00 + 12:00 UTC, plus manual dispatch.
- List id is **forever**: `mdb_scrape_` + 8 chars mapped (hex nibble → id
  alphabet) from first 8 hex of sha256(listing URL) at creation
  (`randomScraperId`); renaming never changes it, and once a data
  file exists the id is pinned. Editing `url`/`type`/`maxPages`/enabled changes
  the config hash → next save schedules a scrape.

## Module 2 — MDBList Official (`mdboff_<slug>_<movie|show>`)

**What it is.** MDBList's curated official lists (Popular, JustWatch Streaming
Charts, MovieMeter, …) pulled via their **API**, no scraping.

**How it works** (`scripts/official.mjs`, workflow `official.yml`):
1. Enabled slugs come from operator config (picker fed by
   `/mdblist/official-catalog`, which proxies `api.mdblist.com/lists/official`).
2. Per slug, two pulls: `mediatype=movie` and `mediatype=show`. Each walks
   cursor pages (`limit=100`, stops on `has_more=false` or **50 pages** →
   5 000 items per catalog max).
3. Emits `data/mdboff_<slug>_movie.json` and `_show.json`; run record to `/runs`.

**Limits / knobs:**
- Catalog ids: `mdboff_<slug>_movie` / `mdboff_<slug>_show` (type shows as
  series to Stremio).
- **MAX_OFFICIAL_LISTS = 30** per config save (server silently drops extras;
  UI mirrors the cap). Each active slug = 2 API pulls × 2 cron runs/day.
- Slugs validated `^[a-z0-9][a-z0-9-]{0,63}$`.
- Job timeout 15 min; cron 00:00 + 12:00 UTC + manual.
- Upstream: MDBList **free tier** — 4 dynamic + 4 static MDBList-hosted lists
  (this module doesn't touch those, it only reads the official catalog API),
  ~1 000 API requests/day, 24 h refresh minimum.

## Module 3 — Simkl Arriving Today (`simkl_arriving_today_*`)

**What it is.** Two fixed lists — **series** and **anime** — of shows airing
*today* (new shows, new seasons, new episodes, finales), filtered by rating
tiers. Replaces a hand-maintained watchlist morning feed.

**How it works** (`scripts/simkl.mjs`, workflow `simkl.yml`):
1. `GET https://api.simkl.com/calendar/...` (v2, `Client-ID` header) — returns
   the day's entries + metadata map.
2. "Today" is keyed in the operator timezone (`cfg.simkl.timezone`, default
   UTC) via `Intl` calendar-day matching — never offset math.
3. `precompute()` groups entries per show, picks a headline episode (finale wins
   over highest S/E), maps ids imdb → `tmdb:` → `kitsu:`, applies the list's
   filter, sorts: New Show > New Season > New Episode (rating desc) and
   attaches badges (label + priority).
4. Writes `data/simkl_arriving_today_series.json` / `_anime.json`; run record.

**Filters** (per list, editable in /configure; defaults verbatim from the
legacy worker):
- series — rating source **IMDb**: exclude genres (Talk Show, Reality, Sport,
  News, Soap, Documentary, …), exclude countries `cn,kr,pt,jp`, tiers
  `≥7.0 & ≥500 votes` OR `6.0–6.9 & ≥5000 votes`.
- anime — rating source **MAL**: exclude country `cn`, tiers `≥8.0` OR
  `7.0–7.9 & ≥5000 votes` OR `7.0–7.9 & Simkl rating ≥8.0`.
  (`min_secondary_rating` always tests the Simkl rating.)

**Limits / knobs:**
- Only **two** kinds, fixed ids; window is **today only** (no future days).
- 500 ms pause between kinds; 30 s fetch timeout; job timeout 15 min.
- Cron 00:00 + 12:00 UTC — list refreshes twice a day, "today" follows the
  configured timezone at run time.
- Upstream: Simkl API **10 GET/s**.

## Module 4 — TMDB Discover (`tmdb_discover_<type>_<8-char>`)

**What it is.** The power-user module. A saved TMDB Discover filter (genres,
year window, rating floor, vote floor, streaming provider, collection,
networks, per-title exclusions) that generates a catalog daily.

**How it works** (`scripts/tmdb.mjs` generator, `src/routes.js` preview):
1. Config lives per list under `cfg.tmdb.lists`; catalog id =
   `tmdb_discover_movie_<8>` / `tmdb_discover_series_<8>`.
2. **Preview parity rule:** `/tmdb/preview-discover` on the worker and
   `buildDiscoverItems` in the generator run the same logic. Saving a TMDB
   list changes its config hash → `/save-config` dispatches `tmdb.yml` so the
   committed file matches what the preview showed.
3. Generator: builds one or more Discover querysets (see fan-out below), pages
   `api.themoviedb.org/3/discover/movie|tv` (20 results/page) with the
   operator's sort (popularity, rating, release date, …), dedupes by id,
   applies per-title exclusions, writes `data/tmdb_discover_*.json`, reports
   run + warnings (e.g. collection lookup failures).
4. TMDB token (`TMDB_READ_ACCESS_TOKEN`) is a worker secret; the preview
   searches/discover on the server side, so the browser never sees it.

**Filter dimensions & semantics:**
- **Genres, countries, language, year window, rating/vote floors, release
  type, provider** → passed straight to TMDB as AND-ed discover params
  (release type is **movie-only**).
- **Collections** (e.g. Joker Collection) are a *source*, not a filter:
  `includeSet` fans out over each collection's parts. Because a collection
  members list can't be AND-ed into a page-sorted window, the generator marks
  it a **post-filter** and raises the page scan cap from 25 to **100**
  (`effectiveCap`) so an old collection still intersects the window.
- **Networks** (`includeNetworks/Names`, `excludeNetworks/Names`,
  `includeModes.network`) are **series-only** — movie lists strip them
  server-side because TMDB silently ignores `with_networks` on movies.
  Multiple includes fan out (OR); excludes AND-fold. Include × exclude is
  vetoed by re-scanning the window (pair scan `i,e`, cap **100 combos** —
  beyond that the save is rejected). Picker: type-ahead search, TMDB network
  id, or paste a `themoviedb.org/network/…` link — all in one bar; shows the
  network logo in a 48×28 contain box.
- **Per-title exclusions** (`excludeItems` by id, `excludeItemNames`): Option
  A — exclusions belong to the list, not a global blocklist. Preview X button
  (grid + list view) and "Excluded Titles" chips with inline search, all wired
  through the hash so exclusions regenerate the file.
- **Undated items:** TMDB sometimes returns no `release_date`. The **file**
  drops undated *movies and series*; the **preview** keeps them, sorted last —
  so the preview explains missing rows instead of hiding them.

**Limits / knobs:**
- **MAX_ITEMS = 500** per list (25 pages × 20), hard slice at the end.
- Page cap 100 only when a collection post-filter is active (quota fuse).
- Network include×exclude combos ≤ 100.
- Discover results cap at 10 000 rows per query upstream in TMDB (paging stops
  at 500 anyway — never hit).
- Cron: **00:00 UTC only** (noon run is commented out); job timeout 15 min;
  `workflow_dispatch` on every config save that changes a TMDB list.
- Upstream: TMDB soft limit ~50 req/s (non-commercial) + attribution required;
  transient `ECONNRESET` is real — worker `tmdbApi` retries 3×, the CI script
  is single-shot per request.

---

## Config, hash & regeneration

- Single KV key holds `{ scraper, official, simkl, tmdb }`; `/export-config`
  (public) and `/save-config` (PIN) are the only doors.
- Every save **normalizes** (clamps maxPages, validates ids/slugs, rebuilds
  catalog ids) and hashes the *data-affecting* fields
  (`url,type,maxPages,enabled` for scraper; slugs for official; filter+tz for
  simkl; full filter set incl. exclusions/networks for tmdb).
- Hash change per module → dispatch that module's workflow. Cosmetic renames
  never trigger a run.
- Every save stamps `configVersion` (content hash of the whole blob); the
  dispatched workflow polls `/export-config` until that version is visible
  before scraping, closing the KV eventual-consistency race (so a run can
  never fetch the pre-save config).

## Secrets / vars (worker)

| Key | Where | Use |
|---|---|---|
| `MDBLIST_API_KEY` | secret + CI | official pulls, official-catalog proxy |
| `TMDB_READ_ACCESS_TOKEN` | secret + CI | discover + preview/search |
| `SIMKL_CLIENT_ID` | secret + CI | calendar |
| `ADMIN_PIN` | secret | /configure login |
| `AUTH_ENABLED` | var (bool) | kill-switch for PIN |
| `GH_TOKEN` | secret | workflow_dispatch |
| `GH_REPO`, `GITHUB_PAGES_BASE` | vars | dispatch target, data origin |
| `WORKER_ORIGIN` | CI env | scripts talk back to the worker |
| `GH_DISPATCH_STUB=1` | local dev | dispatch prints instead of POSTing |

## Local development

```powershell
npx wrangler dev src/index.js   # dev server http://127.0.0.1:9090
```
Supply the keys above as local dev vars for `wrangler dev`
(`AUTH_ENABLED=false` for frictionless local admin). CI scripts run locally
too: `node scripts/<x>.mjs` from `scripts/` with env set — TMDB calls may
need retries on flaky links.

## Gotchas that will bite contributors

- `src/configure.js` is a **template literal** — no backticks or `${` inside,
  and use `[0-9]` not `\d` (raw backslash sequences get eaten).
- Old Windows PowerShell here: no `&&`/`||`; chain with `if ($?)`.
- If push is rejected by a `chore(data)` commit: `git pull --rebase` then push.
- workflow cron/timeouts: scrape 30 min, others 15; scrape/official/simkl twice
  daily (00:00 + 12:00 UTC), tmdb once (00:00 UTC).
