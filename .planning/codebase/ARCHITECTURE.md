<!-- refreshed: 2026-08-25 -->
# Architecture

**Analysis Date:** 2026-08-25

## System Overview

```text
┌────────────────────────────────────────────────────────────────────┐
│                        Consumers                                    │
│   Stremio/Nuvio clients          Single owner-admin browser         │
│   (manifest + catalog JSON)      (/configure control panel)         │
└────────┬───────────────────────────────┬───────────────────────────┘
         │                               │
         ▼                               ▼
┌────────────────────────────────────────────────────────────────────┐
│              Cloudflare Worker  (src/, plain JS modules)            │
│                                                                    │
│  Router: `src/index.js` (fetch handler, path matching)             │
│  ├─ Stremio API: `src/routes.js`                                   │
│  │    /manifest.json · /catalog/<type>/<id>[.json] · /status       │
│  ├─ Admin API: `src/routes.js`                                     │
│  │    /configure · /save-config · /export-config                   │
│  │    /trigger-refresh · /runs                                     │
│  ├─ Live proxies: `src/routes.js`                                  │
│  │    /tmdb/search-* · /tmdb/preview-discover                      │
│  │    /mdblist/official-catalog (KV-cached 10 min)                 │
│  ├─ Persistence: `src/config.js` (KV binding STORE)                │
│  ├─ Dispatch: `src/dispatch.js` (GitHub workflow_dispatch API)     │
│  └─ Admin UI: `src/configure.js` (single template literal:         │
│       inline CSS + JS, tabs per module, ~2057 lines)               │
└───────┬──────────────────────────────────┬─────────────────────────┘
        │ KV read/write                    │ workflow_dispatch POST
        ▼                                  ▼
┌────────────────────┐   ┌──────────────────────────────────────────┐
│ Cloudflare KV      │   │ GitHub Actions (.github/workflows/)       │
│ (binding STORE)    │   │ scrape.yml · official.yml · simkl.yml     │
│  config            │   │ tmdb.yml  — all share concurrency group   │
│  runs:<module>     │   │ my-list-scrape (queue: max)               │
│  cache:mdblist-*   │   └───────┬──────────────────────────────────┘
│  healed            │           │ run node script
└────────────────────┘           ▼
                        ┌──────────────────────────────────────────┐
                        │ scripts/*.mjs (Node 22, ubuntu runner)   │
                        │ scrape.mjs  - puppeteer DOM scraping     │
                        │ official.mjs - MDBList REST API          │
                        │ simkl.mjs   - SIMKL v2 calendar API      │
                        │ tmdb.mjs    - TMDB Discover API          │
                        │ Each: GET /export-config → generate     │
                        │ → write data/<id>.json → POST /runs     │
                        └───────┬──────────────────────────────────┘
                                │ git commit + push (bot)
                                ▼
                        ┌──────────────────────────────────────────┐
                        │ data/<catalog_id>.json (repo, force-add) │
                        │ served via GitHub Pages                  │
                        │ (GITHUB_PAGES_BASE var in wrangler.toml) │
                        └───────┬──────────────────────────────────┘
                                │ fetch on every /catalog request
                                └──► back to Worker catalog handler
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Worker router | CORS, OPTIONS, URL dispatch to handlers | `src/index.js` |
| Stremio routes | Manifest build, catalog serving (fetch Pages JSON, slice, map to metas), status page data | `src/routes.js` |
| Admin routes | Save-config diff + dispatch orchestration, trigger-refresh, run-record ingestion, export-config | `src/routes.js` |
| TMDB/MDBList proxies | Live search boxes, discover preview, official-list picker feed | `src/routes.js` |
| Config store | Load/migrate/normalize/save config in KV, run history (last 30/module), content hashes, id generation, seeds/healing | `src/config.js` |
| Workflow dispatcher | Single choke point for all GitHub Actions dispatches; local-dev stub via `GH_DISPATCH_STUB` | `src/dispatch.js` |
| Configure page | Full admin UI as one exported string builder (`buildConfigurePage`) — shell, tabs, dialogs, toasts, save/refresh logic | `src/configure.js` |
| Scraper scripts | Regenerate catalog JSON files from four sources; report runs back to `/runs` | `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs` |
| Workflows | Cron (00:00/12:00 UTC), input sanitization, bot commit/push of `data/*.json` | `.github/workflows/scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml` |

## Pattern Overview

**Overall:** Serverless request-handler + scheduled batch pipeline ("worker as thin router, Actions as the compute layer"). The Worker never scrapes; it serves pre-generated static JSON fetched from GitHub Pages. All heavy lifting happens in GitHub Actions, which writes results back into the repo as committed JSON files.

**Key Characteristics:**
- Four independent catalog "modules" (scraper, official, simkl, tmdb) share one config shape `{ scraper|official|simkl|tmdb: { lists: [] } }` and one save endpoint.
- Data plane is fully decoupled from control plane: saving config never writes catalog data directly — it dispatches workflows that regenerate files asynchronously (minutes later).
- Catalog ids are namespaced by prefix (`mdb_scrape_*`, `mdboff_<slug>_<movie|show>`, `simkl_arriving_today_<kind>`, `tmdb_discover_<movie|series>_<8 base36>`); the prefix routes run-history keys (`runsKeyFor`, `src/config.js:18`) and selects the row-to-meta mapper (`handleCatalog`, `src/routes.js:169`).
- Everything is plain JavaScript ES modules — no framework, no TypeScript, no bundler for the Worker.

## Layers

**Routing layer:**
- Purpose: Match pathname/method to a handler; CORS preflight.
- Location: `src/index.js`
- Depends on: `src/routes.js`
- Used by: Cloudflare runtime

**API/handler layer:**
- Purpose: Manifest/catalog/status (Stremio contract) + save/export/refresh/runs (admin) + live proxies.
- Location: `src/routes.js`
- Depends on: `src/config.js`, `src/dispatch.js`, `src/configure.js`
- Used by: `src/index.js`; scripts call `/export-config` and POST `/runs`

**Persistence/domain layer:**
- Purpose: The only code that touches KV. Normalization/migration is the trust boundary for all persisted config (regex-guarded ids block path traversal, capped arrays, coerced fields).
- Location: `src/config.js`
- Contains: `loadConfig`/`saveConfig`, `migrateConfig` + per-module normalizers, seed constants (`SEED_LISTS`, `OFFICIAL_LISTS`, `SIMKL_LISTS`), `listContentHash`/`tmdbContentHash`, `addRun`/`getRuns`, id generators.
- Used by: `src/routes.js`

**Dispatch adapter:**
- Purpose: Wrap the GitHub `workflow_dispatch` REST call; returns `{ dispatched, reason }` instead of throwing so callers can convert failures into HTTP error responses.
- Location: `src/dispatch.js`
- Used by: `src/routes.js`

**Presentation layer (server-rendered):**
- Purpose: Emit the entire `/configure` SPA as one HTML string with embedded initial-state JSON (`let state = ${initial}`, escaped `<` → `<`, `src/configure.js:9`).
- Location: `src/configure.js`
- Used by: `routes.js#configureResponse`

**Batch pipeline (out-of-process):**
- Purpose: Regenerate catalog data files; runs only in CI or locally via `node scripts/*.mjs`.
- Location: `scripts/*.mjs`, orchestrated by `.github/workflows/*.yml`
- Depends on: Worker's `/export-config` (config source of truth), Worker's `/runs` (run history sink)

## Data Flow

### Primary Request Path (Stremio catalog read)

1. Client requests `/catalog/movie/mdboff_popular_movie/skip=100.json` (`src/index.js:46`, regex `CATALOG_RE` in `src/routes.js:46`)
2. `handleCatalog` loads config from KV, resolves which module owns the id, picks the matching mapper (`rowToMeta` / `rowToMetaOfficial` / `rowToMetaSimkl` / `rowToMetaTmdb`) (`src/routes.js:169-175`)
3. Fetches `https://shivt37.github.io/my-list/data/<id>.json` (GH Pages); unknown id, disabled module, non-OK response, or fetch throw all return `{ metas: [] }` with 200 — never 404 the chain (`src/routes.js:180-189`)
4. Slices rows `[skip, skip+100]`, maps to Stremio metas (`src/routes.js:191-193`)

### Control Plane Path (config save → regeneration)

1. Operator edits state in `/configure`; `buildConfig()` serializes client state (`src/configure.js:1885`), `saveAll()` POSTs to `/save-config` (`src/configure.js:1923`)
2. `handleSaveConfig` validates body shape, runs incoming through `migrateConfig` (normalize/trust boundary) (`src/routes.js:235-247`)
3. Diffs incoming vs current per module: scraper lists by `listContentHash`, simkl by enabled+filter compare, official by slug set + strict OFF→ON toggles, tmdb by `tmdbContentHash` plus toggle-on rescue (`src/routes.js:249-319`)
4. Dispatches workflows in deliberate order — simkl, then official regen, then official delete-cleanup, then scraper (potentially destructive `scrape_delete`), then tmdb. Any dispatch failure aborts before persist (502), so no config write happens unless every dispatch was accepted (`src/routes.js:335-391`)
5. Only after all dispatches accepted: `saveConfig` persists to KV (`src/routes.js:397`)
6. GitHub Actions picks up the dispatch, sanitizes inputs through char-class whitelists, runs the script, commits `data/*.json` as `my-list-bot` with `git pull --rebase -X theirs` (`scrape.yml` commit step)
7. Next `/catalog` request serves the regenerated file from Pages

### Telemetry Path (run records)

1. Script finishes a list → POSTs batches of ≤50 run records to `/runs` (`postRuns` in `scripts/scrape.mjs:86`)
2. `handleRunsPost` sanitizes each record independently (one malformed record skipped, valid siblings kept) and calls `addRun` (`src/routes.js:552-581`)
3. `addRun` does read-modify-write on `runs:<module>` keyed by catalog-id prefix, unshift + cap at 30 (`src/config.js:479-492`)
4. `/status?page=<module>` reads the matching key, resolves display names back through config, renders IST timestamps (`src/routes.js:196-233`)

**State Management:**
- Server state lives entirely in Cloudflare KV under four kinds of keys: `config` (whole config as one JSON blob), `runs:scraper|official|simkl|tmdb`, `cache:mdblist-official` (10-min TTL picker cache), `healed` (one-shot migration flag). See `src/config.js:9-15` and `src/routes.js:775`.
- Client state is a single module-level `state` object in the configure page's inline JS, hydrated from server-rendered JSON; re-render happens through per-module `renderScraper()/renderOfficial()/renderSimkl()/renderTmdb()` functions writing into `#tabHost` (`src/configure.js:683, 729, 867, 1135, 1272, 1453`). Accent color persists in `localStorage`.

## Key Abstractions

**Catalog id namespaces:**
- Purpose: One string identifies a catalog everywhere — manifest entry, data filename (`data/<id>.json`), run-history routing, refresh targeting.
- Examples: `src/config.js:32` (`tmdbCatalogId`), `src/config.js:149` (`officialCatalogsFor` builds `mdboff_<slug>_<movie|show>` pairs), `src/config.js:107` (`SIMKL_CATALOGS`)
- Pattern: Prefix-based polymorphism instead of a class hierarchy.

**Content hashes (change detection):**
- Purpose: Decide which lists a save must regenerate. Hash covers only fields that change scraped output; `name` deliberately excluded so renames never re-scrape.
- Examples: `listContentHash` (`src/config.js:349`), `tmdbContentHash` (`src/config.js:359`) — the latter mirrors `computeSourceHash` in `scripts/tmdb.mjs`; keep both sides in sync when editing fields.
- Pattern: Shared hash function on both sides of the worker/script boundary, stamped onto data files as `sourceHash` for audit.

**Config migration as trust boundary:**
- Purpose: Every read AND every write of config passes through `migrateConfig`/normalizers — corrupted KV, hostile saves, and legacy shapes all converge on one normalized form.
- Examples: `migrateConfig` (`src/config.js:269`), `migrateOfficial` (`src/config.js:204`, sane-slug regex + cap 20), `normalizeTmdbList` (`src/config.js:299`, regex-guarded ids), `normalizeSimklList` (`src/config.js:242`)
- Pattern: Parse-don't-validate; ids regexes double as path-traversal defense for `data/` joins in scripts.

**Row-to-meta mapper family:**
- Purpose: Convert each module's distinct item shape into the common Stremio meta object.
- Examples: `src/routes.js:118-167` (`rowToMeta`, `rowToMetaOfficial`, `rowToMetaSimkl`, `rowToMetaTmdb`)
- Pattern: Plain functions selected by ownership lookup in `handleCatalog`; new module = new mapper + a branch in the lookup chain.

**Workflow dispatch descriptor:**
- Purpose: One dispatcher signature covers all four workflows; callers pass either the scraper default (`lists`/`action`/`deleteIds`) or an explicit `{ workflow, inputs }` object matching that workflow's declared inputs.
- Examples: `dispatchScraperWorkflow(env, {...})` (`src/dispatch.js:10`)
- Pattern: Single adapter; workflow-file names also exported as constants in `src/routes.js:15-17` and overridable via env vars (`GH_OFFICIAL_WORKFLOW` etc.).

## Entry Points

**Worker fetch handler:**
- Location: `src/index.js:21` (`export default { async fetch }`)
- Triggers: Any HTTPS request to the deployed worker
- Responsibilities: CORS preflight, root info text, route table (exact paths + two regexes), 404 fallback

**Scraper script mains:**
- Location: `scripts/scrape.mjs:371` (`main()`), analogous in `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`
- Triggers: Workflow `schedule` crons (00:00/12:00 UTC; tmdb.yml deliberately only 00:00 - once daily by owner decision) and `workflow_dispatch`
- Responsibilities: Fetch config from `/export-config`, regenerate requested catalogs, write `data/*.json`, POST run records

**Workflows:**
- Location: `.github/workflows/scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml`
- Triggers: Cron + manual dispatch
- Responsibilities: Checkout, Node 22 setup, `npm ci` in `scripts/`, char-class input sanitization step, script invocation, always-run commit/push of data files

**Tests/self-checks:**
- Location: `testing/dry-test.mjs` (full route suite vs fake KV + stubbed fetch), `testing/save-config.test.mjs` (regen-on-enable regressions), `testing/verify-tmdb.mjs` (module self-check incl. generator source-plan), `testing/verify-ui.mjs` (JSDOM render check of the built page)

## Architectural Constraints

- **Threading:** Single-threaded request handling per isolate. The preview endpoint can issue dozens of sequential paged TMDB rounds bounded by `AbortSignal.timeout(30000)`; outbound dispatches bound at 15s (`src/dispatch.js:36`), MDBList proxy at 20s (`src/routes.js:797`).
- **Global serialization via Actions:** All four workflows share one concurrency group `my-list-scrape` with `queue: max`, `cancel-in-progress: false`. This is load-bearing: it serializes writers to both `data/` commits and the KV `addRun` read-modify-write (documented in each yml and in `src/config.js:472-477`). Do not give a workflow its own group without fixing the KV race first.
- **Save ordering invariant:** Dispatch-before-persist with destructive-action-last ordering (`src/routes.js:325-334`). A failed dispatch must leave KV untouched; the scraper dispatch must stay adjacent to the persist because it can delete data files.
- **No auth beyond obscurity:** `/save-config`, `/trigger-refresh`, `/runs` have no authentication — single-operator product decision (see `PRODUCT.md`). Do not expose this worker publicly to untrusted parties.
- **Read-modify-write races (accepted):** `handleSaveConfig` has no lock (concurrent saves clobber; noted `src/routes.js:244`); `addRun` can lose records under true simultaneous writes (mitigated only by the Actions group). Accepted for single-operator scale.
- **Data files are artifacts, not source:** `data/*.json` is gitignored locally but force-added (`git add -f`) by bot commits; local clones only carry `.gitkeep`. Never hand-edit them.
- **Worker never talks to MDBList's site/API for catalogs:** catalog bytes come exclusively from GH Pages; MDBLIST_API_KEY reaches only `official.yml` and the picker proxy.

## Anti-Patterns

### Monolithic template-literal UI

**What happens:** The entire admin SPA (~2050 lines of CSS + HTML + JS) lives inside one exported template literal in `src/configure.js`, with behavior wired via inline `onclick="..."` attributes referencing global functions defined in the same literal.
**Why it's wrong (by conventional standards):** No modules, no type checking, hard to test in isolation (tests resort to JSDOM parsing of the emitted string), easy to break quoting/escaping between layers.
**Do this instead:** This is a deliberate design choice for a zero-build single-file deployment (documented in `PRODUCT.md`). When touching it: keep new markup in the existing tab-render-function pattern (`renderScraper` style, injecting into `#tabHost`), escape anything interpolated with `escapeAttr`/`<` escaping, and do not introduce a bundler/framework without an explicit owner decision. If a change grows large, prefer extracting another `renderXxxTabHtml` function within the same file.

### Duplicated hash/logic across worker and scripts

**What happens:** `tmdbContentHash` (`src/config.js:359`) must mirror `computeSourceHash` in `scripts/tmdb.mjs`; sane-slug regex exists in both `migrateOfficial` (`src/config.js:144`) and `scripts/official.mjs`.
**Why it's wrong:** Silent drift — a field added on one side only makes saves stop dispatching (or dispatch forever) without any error.
**Do this instead:** When changing hashed fields or slug rules, grep both sides (`Grep pattern: computeSourceHash|SANE_SLUG|listContentHash`) and update together; comments at each site name the mirror.

## Error Handling

**Strategy:** Fail soft on the read path (never break a Stremio chain), fail loud-and-reject on the write path (no partial config states).

**Patterns:**
- Catalog serving: any failure (unknown id, disabled module, non-OK fetch, JSON parse throw) → `{ metas: [] }` with 200 (`src/routes.js:180-189`)
- KV reads: corrupt/non-array values fall back to empty/default rather than throwing (`loadConfig` `src/config.js:385-399`, `getRuns` `src/config.js:494-501`, picker cache read `src/routes.js:786-791`); best-effort cache writes swallow errors (`src/routes.js:805`)
- Save path: invalid body → 400; any dispatch rejection → 502 with reason and NO persist (`src/routes.js:335-391`); unexpected throw → generic 500 `"Save failed."` (`src/routes.js:428-430`)
- Dispatcher returns result objects (`{ dispatched: false, reason }`) instead of throwing; caller maps to HTTP codes (`src/dispatch.js:42-45`)
- Run ingestion: per-record try/catch isolation — one bad record never drops its batch siblings (`src/routes.js:565-581`)
- Secrets: missing token checked up front with actionable message (`tmdbTokenOrError` `src/routes.js:593`, `MDBLIST_API_KEY` guard `src/routes.js:779`, `dispatchScraperWorkflow` guard `src/dispatch.js:19`)
- Local dev without GitHub secrets: `GH_DISPATCH_STUB` env flag makes saves succeed with logged-not-fired dispatches (`src/dispatch.js:14-17`); never set in production

## Cross-Cutting Concerns

**Logging:** `console.log` only where meaningful — dispatch stub logging in `src/dispatch.js:15`; scripts log progress to Actions stdout. No structured logger.

**Validation:** Centralized in `migrateConfig` + per-module normalizers (`src/config.js`); workflow inputs additionally sanitized by bash `tr -cd` whitelists before reaching scripts (each yml's "Sanitize workflow inputs" step) — defense-in-depth against shell injection.

**Authentication:** None on endpoints (single-operator). Secrets (`GH_TOKEN`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`, `TMDB_READ_ACCESS_TOKEN`, `WORKER_ORIGIN`) are Cloudflare Worker secrets / GitHub repo secrets; `.dev.vars` exists locally (presence only — contents not inspected). Non-secret vars live in `wrangler.toml` `[vars]` (`GITHUB_PAGES_BASE`, `GH_REPO`, workflow filenames).

**CORS/security headers:** Wide-open CORS (`Access-Control-Allow-Origin: *`) on everything; the HTML page carries a strict CSP (`src/routes.js:36`) restricting connect-src to 'self', frame-ancestors none, plus `nosniff` everywhere.

---

*Architecture analysis: 2026-08-25*
