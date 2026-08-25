# Technology Stack

**Analysis Date:** 2026-08-25

## Languages

**Primary:**
- JavaScript (ES modules) - entire codebase. Worker code in plain `.js` (`src/index.js`, `src/config.js`, `src/routes.js`, `src/dispatch.js`, `src/configure.js`); Node scripts in `.mjs` (`scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`). No TypeScript anywhere; types documented via comments only.

**Secondary:**
- None.

## Runtime

**Environment:**
- Cloudflare Workers runtime - `src/index.js` default export `{ fetch(request, env) }`. `compatibility_date = "2026-01-01"` with `nodejs_compat` flag (used for `node:crypto` createHash in `src/config.js`).
- Node.js 22 - GitHub Actions runners (`actions/setup-node@v5`, `node-version: 22` in all four workflows).

**Package Manager:**
- npm (only dependency-bearing package is `scripts/package.json`; lockfile `scripts/package-lock.json` present).
- The Worker itself has ZERO npm dependencies - it runs on platform APIs only (`fetch`, `crypto.randomUUID`, `AbortSignal.timeout`, KV bindings).

## Frameworks

**Core:**
- None. No web framework - hand-rolled router in `src/index.js` (if-chains on pathname), hand-rolled HTML template literal UI in `src/configure.js` (2057 lines, single server-rendered page with inline CSS/vanilla JS, Google Fonts Inter).
- Stremio Addon protocol (HTTP convention, not a library): `/manifest.json` and `/catalog/<type>/<id>/skip=<n>.json` served from `src/routes.js`.

**Testing:**
- `node:assert/strict` standalone scripts - no test framework. Files in `testing/` (gitignored): `save-config.test.mjs`, `dry-test.mjs` (fake KV + stubbed globalThis.fetch), `verify-tmdb.mjs`, `verify-ui.mjs` (both use JSDOM, present in `scripts/node_modules/jsdom` but NOT declared in `scripts/package.json`).

**Build/Dev:**
- Wrangler - deploy/dev tool for the Worker (`wrangler.toml`, local state in `.wrangler/`). No build step, no bundler config beyond wrangler defaults.
- Local dev secrets in `.dev.vars` (gitignored; existence confirmed, contents never read).

## Key Dependencies

**Critical:**
- `puppeteer` ^25.3.0 - headless Chromium DOM scraping of mdblist.com listing pages (`scripts/scrape.mjs`). This is the whole scraper mechanism.
- `puppeteer-extra` ^3.3.6 + `puppeteer-extra-plugin-stealth` ^2.11.2 - stealth plugin applied before launch to avoid bot detection (`scripts/scrape.mjs`).

**Infrastructure:**
- `actions/checkout@v5`, `actions/setup-node@v5`, `actions/upload-artifact@v5` - GitHub Actions plumbing in all workflows.
- `node:crypto`, `node:fs`, `node:path`, `node:url` - stdlib only in scripts; no other runtime deps.
- jsdom - undeclared dev-only dep for UI verification tests (`testing/verify-tmdb.mjs`, `testing/verify-ui.mjs`).

## Configuration

**Environment:**
- Worker vars declared in `[vars]` of `wrangler.toml`: `GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`, `GH_TMDB_WORKFLOW`.
- Worker secrets (Cloudflare dashboard or `wrangler secret put`): `GH_TOKEN`, `TMDB_READ_ACCESS_TOKEN`, `MDBLIST_API_KEY`. Referenced as `env.*` in `src/dispatch.js` and `src/routes.js`.
- Optional flags: `GH_DISPATCH_STUB` (set in `.dev.vars` for local dev - stubs dispatches; never set on production), `GH_REF`, `GH_SIMKL_WORKFLOW` (env overrides read in `src/routes.js`).
- Script env (GitHub repo secrets passed by workflows): `WORKER_ORIGIN`, `MDBLIST_API_KEY` (official.yml only), `SIMKL_CLIENT_ID` (simkl.yml only), `TMDB_READ_ACCESS_TOKEN` (tmdb.yml only).
- App runtime config lives in KV (binding `STORE`) under key `config` - edited via `/configure` page, migrated on every load by `migrateConfig()` in `src/config.js`.

**Build:**
- `wrangler.toml` - worker name `my-list`, main `src/index.js`, KV binding `STORE` (id `36b7763e6e31445696e1a773c44de7a3`).
- No tsconfig, no bundler, no lint/format config detected.

## Platform Requirements

**Development:**
- Node 22 + wrangler for the worker; Chromium installed via puppeteer for running scrape.mjs locally.
- `npm ci` inside `scripts/` reproduces script deps.

**Production:**
- Cloudflare Worker (deployed via wrangler) + Cloudflare KV namespace.
- GitHub Pages serving `data/*.json` from the repo's `main` branch at `GITHUB_PAGES_BASE` (https://shivt37.github.io/my-list).
- GitHub Actions with `contents: write` permission committing data files back to the repo (bot identity `my-list-bot`).

---

*Stack analysis: 2026-08-25*
