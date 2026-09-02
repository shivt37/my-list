# Codebase Structure

**Analysis Date:** 2026-08-25

## Directory Layout

```text
my-list/
├── src/                     # Cloudflare Worker (deployed code)
│   ├── index.js             # Entry: fetch handler + route table (92 lines)
│   ├── routes.js            # All route handlers: Stremio API, admin API, proxies (822 lines)
│   ├── config.js            # KV persistence, config migration, hashes, seeds, run history (500 lines)
│   ├── dispatch.js          # GitHub workflow_dispatch adapter (46 lines)
│   └── configure.js         # /configure page: entire UI as one template literal (2057 lines)
├── scripts/                 # CI-side generators (run in GitHub Actions, Node 22)
│   ├── package.json         # "my-list-scraper": puppeteer deps; npm ci target
│   ├── scrape.mjs           # mdblist.com DOM scraping via puppeteer-extra+stealth
│   ├── official.mjs         # MDBList REST API fetcher/deleter for mdboff_* files
│   ├── simkl.mjs            # SIMKL v2 arriving-today calendar fetcher
│   ├── tmdb.mjs             # TMDB Discover list generator
│   └── node_modules/        # scripts-only deps (own lockfile)
├── .github/workflows/       # The scheduling/compute layer
│   ├── scrape.yml           # cron 00:00+12:00 UTC; inputs lists/action/delete_ids/debug
│   ├── official.yml         # same crons; inputs slugs/action/delete_ids
│   ├── simkl.yml            # same crons; input kinds
│   └── tmdb.yml             # cron 00:00 UTC only (12:00 deliberately commented out - once daily); ids/action/delete_ids
├── data/                    # Generated catalog JSON (bot-committed, served by GH Pages)
│   └── *.json               # mdboff_*, mdb_scrape_*, simkl_arriving_today_* files + .gitkeep
├── testing/                 # Local-only test/self-check scripts (gitignored)
│   ├── dry-test.mjs         # Full route suite vs fake KV + stubbed GitHub/Pages fetch
│   ├── save-config.test.mjs # handleSaveConfig diff/dispatch regression tests
│   ├── verify-tmdb.mjs      # TMDB module self-checks (config hash, source plan, UI)
│   └── verify-ui.mjs        # JSDOM check of built configure page
├── scratch/                 # Design notes, API specs, throwaway probes (gitignored)
├── implementation/          # UI implementation screenshots (gitignored)
├── .audit/                  # Audit sections/shots (gitignored)
├── .wrangler/               # Wrangler local state/bundles (gitignored)
├── .planning/codebase/      # GSD planning docs (this file, ARCHITECTURE.md, FUNCTIONAL-AUDIT.md)
├── .claude/                 # Project Claude settings (settings.local.json)
├── wrangler.toml            # Worker config: name, main, kv STORE binding, [vars]
├── PRODUCT.md               # Product definition (platform, users, capabilities)
├── UI-AUDIT.md              # UI audit doc
├── .dev.vars                # Local worker secrets (gitignored — never read/commit)
└── .gitignore               # Ignores data/*.json, testing/, scratch/, .dev.vars, etc.
```

## Directory Purposes

**`src/`:**
- Purpose: Everything deployed to Cloudflare Workers. Plain JS ES modules (`nodejs_compat` flag), no build step.
- Contains: Router, handlers, persistence, dispatcher, and the server-rendered admin UI.
- Key files: `src/index.js` (entry), `src/config.js` (all state logic), `src/routes.js` (all HTTP behavior)

**`scripts/`:**
- Purpose: Catalog regeneration programs that run on GitHub Actions (and locally with env vars set). Each has its own `package.json` because only these need puppeteer.
- Contains: One `.mjs` per catalog module. All follow the same contract: parse `--arg=` CLI flags → `GET {WORKER_ORIGIN}/export-config` → write `data/<catalog_id>.json` → POST run records to `{WORKER_ORIGIN}/runs`.
- Key files: `scripts/scrape.mjs` exports reusable pieces (`buildPageUrl`, `scrapeList`, `writeCatalog`, `deleteCatalog`, `main({getConfig, write, recordRuns})`) designed for injection in tests.

**`.github/workflows/`:**
- Purpose: Scheduling (cron) and compute. Also the security gate — every workflow sanitizes its `workflow_dispatch` inputs through bash char-class whitelists before invoking a script.
- Contains: Four yml files sharing concurrency group `my-list-scrape` (`queue: max`, no cancel-in-progress).
- Key files: all four; the "Commit data changes" step pattern (always-run, force-add, rebase `-X theirs`) is identical across them.

**`data/`:**
- Purpose: The generated catalog store, committed to the repo and served via GitHub Pages at `${GITHUB_PAGES_BASE}/data/<id>.json`.
- Contains: One JSON file per enabled catalog. Wrapper shape: `{ catalog_id, name, type, scraped_at, sourceHash?, items }`; scraper files are bare arrays, others use `items`.
- Key files: none hand-maintained — `.gitkeep` plus bot-written `*.json`.

**`testing/`:**
- Purpose: Dependency-free assert-based checks runnable locally (`node testing/<file>.mjs`). Gitignored — never part of deploy or scrape.
- Key files: `testing/dry-test.mjs` is the broadest suite.

**`scratch/`, `implementation/`, `.audit/`, `.wrangler/`:**
- Purpose: Design docs/reference material, UI screenshots, audit artifacts, local Wrangler state. All gitignored except nothing committed from them.
- Key files: `scratch/official-dynamic-add-delete.md` (design doc for the latest feature), `scratch/MDBList API.yaml` (API spec reference).

## Key File Locations

**Entry Points:**
- `src/index.js`: Worker fetch handler — the only deployment entry (`main = "src/index.js"` in wrangler.toml)
- `scripts/*.mjs`: Script mains, each guarded by an `isMain` check (see `scripts/scrape.mjs`)
- `.github/workflows/*.yml`: CI entry points

**Configuration:**
- `wrangler.toml`: Worker name/main/KV binding id/non-secret vars
- `.dev.vars`: Local secrets for `wrangler dev` (exists; contents forbidden)
- Cloudflare secrets (dashboard/wrangler): `GH_TOKEN`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`, `TMDB_READ_ACCESS_TOKEN`, optional `GH_DISPATCH_STUB`
- GitHub repo secrets: `WORKER_ORIGIN`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`, `TMDB_READ_ACCESS_TOKEN`
- Runtime config blob: KV key `config` (managed via `/configure` + `/save-config`, not files)

**Core Logic:**
- Config normalization/migration/diffing/hashes: `src/config.js`
- Save orchestration (diff → ordered dispatches → persist): `src/routes.js#handleSaveConfig` (lines 235-431)
- Manifest assembly (all four modules): `src/routes.js#buildManifest` (lines 68-116)
- Catalog serving + meta mapping: `src/routes.js#handleCatalog` (lines 169-194)
- TMDB discover query planning (live preview): `src/routes.js` lines 643-768; offline twin `buildDiscoverSources` in `scripts/tmdb.mjs`

**Testing:**
- `testing/dry-test.mjs`, `testing/save-config.test.mjs`, `testing/verify-tmdb.mjs`, `testing/verify-ui.mjs` — plain `node` invocation, no test framework installed

## Naming Conventions

**Files:**
- Worker modules: lowercase single words, `.js` (`config.js`, `routes.js`, `dispatch.js`)
- Scripts: lowercase `.mjs` named after their module/source (`official.mjs`, `tmdb.mjs`)
- Tests: kebab-case with purpose suffix (`.test.mjs`, `dry-test.mjs`, `verify-*.mjs`)
- Data files: `<catalog_id>.json` — the filename IS the catalog id served on `/catalog`

**Directories:**
- Lowercase: `src`, `scripts`, `data`, `testing`, `scratch`

**Identifiers (load-bearing prefixes — changing one means changing storage everywhere):**
- Scraper lists: `mdb_scrape_<8 alnum>` (regex-guarded in `src/config.js:277`)
- Official catalogs: `mdboff_<slug>_<movie|show>` (derived in `src/config.js:149`)
- Simkl catalogs: `simkl_arriving_today_series|anime` (`src/config.js:107`)
- TMDB catalogs: `tmdb_discover_<movie|series>_<8 base36>` (`src/config.js:32`)
- KV keys: `config`, `runs:<module>`, `cache:mdblist-official`, `healed` (`src/config.js:9-15`)

## Where to Add New Code

**New Worker endpoint/route:**
1. Handler export in `src/routes.js` (follow existing `handleXxx(env, request)` shape returning `Response` via the local `json()`/`html()` helpers)
2. Path match in `src/index.js` (exact string compare, or a regex above the 404 line)
3. Test in `testing/dry-test.mjs`

**New catalog module (a fifth data source):**
1. Defaults/constants + normalizer + content-hash fn + id scheme in `src/config.js` (mirror the tmdb module's four pieces: defaults fn, `normalizeXxxList`, `migrateXxx`, `xxxContentHash`)
2. Add section to `emptyConfig()`, `migrateConfig()`, and `loadConfig()` normalization chain
3. Mapper function `rowToMetaXxx` + ownership branch in `handleCatalog` and `buildManifest` in `src/routes.js`
4. Generator script `scripts/xxx.mjs` following the shared contract (export-config → data file → POST /runs), with its own `package.json` only if it needs deps beyond Node stdlib
5. Workflow `.github/workflows/xxx.yml` cloned from `simkl.yml`: new sanitize step whitelist, join the `my-list-scrape` concurrency group, identical commit step
6. Wire workflow name constant in `src/routes.js:15-17` + var override in `wrangler.toml` `[vars]`; add save-diff branch in `handleSaveConfig` following the simkl/tmdb pattern

**New configure-page tab/feature:**
- Stay inside `src/configure.js`: add a `renderXxx()` function writing into `#tabHost` (pattern at lines 867/1135/1272/1453), extend the shared `state` object and `buildConfig()` (line 1885). Escape all interpolations (`escapeAttr`, `<` escaping). No new files/frameworks.

**Utilities:**
- Shared helpers used by both worker and scripts currently live duplicated-by-design (hash fns, slug regex) — see Anti-Patterns in ARCHITECTURE.md; when editing one side, grep for the mirror (`computeSourceHash`, `SANE_SLUG`).

**Tests:**
- New file in `testing/`, zero-dependency `node:assert` style, stub `globalThis.fetch` and pass a fake KV object (pattern in `testing/save-config.test.mjs:14-40`).

## Special Directories

**`data/`:**
- Purpose: Generated catalog artifacts served publicly via GitHub Pages
- Generated: Yes — exclusively by Actions bots (force-added past gitignore); gitignored locally so clones stay clean
- Committed: Yes (bot commits only, message convention `chore(data): ...` with `[skip ci]`)

**`testing/`:**
- Purpose: Local verification scripts
- Generated: No
- Committed: No (explicitly gitignored — "local test scripts (not part of deploy or scrape)")

**`scratch/`:**
- Purpose: Design documents, third-party API references, probe output
- Generated: Mixed (hand-written notes + fetched specs)
- Committed: No (gitignored)

**`.wrangler/`:**
- Purpose: Wrangler dev-server state and temporary bundles
- Generated: Yes
- Committed: No

**`.planning/codebase/`:**
- Purpose: GSD planning documents consumed by plan/execute phases
- Generated: By GSD tooling
- Committed: Yes
- Note: `FUNCTIONAL-AUDIT.md` belongs to another process — referenced by comments in source (e.g., `src/config.js:472`) but owned elsewhere; do not modify

---

*Structure analysis: 2026-08-25*
