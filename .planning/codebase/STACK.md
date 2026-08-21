# Technology Stack

**Analysis Date:** 2026-08-21

## Languages

**Primary:**
- JavaScript (ES modules, `"type": "module"`, no TypeScript) - everywhere: `src/*.js` (worker), `scripts/*.mjs` (CI scrapers/generators)

**Secondary:**
- Inline HTML/CSS/JS - the entire `/configure` admin UI is one template-literal string in `src/configure.js` (1773 lines)
- YAML - GitHub Actions workflows in `.github/workflows/` (scrape.yml, official.yml, simkl.yml, tmdb.yml)
- Bash - sanitize/commit steps inside the workflow YAML

## Runtime

**Environment:**
- Cloudflare Workers (`wrangler.toml`, `main = "src/index.js"`, `compatibility_date = "2026-01-01"`, `compatibility_flags = ["nodejs_compat"]`)
- Node.js 22 on GitHub Actions runners (`actions/setup-node@v5`, `node-version: 22` in all four workflows)
- Local dev machine observed on Node v26.5.0

**Package Manager:**
- npm (lockfile present at `scripts/package-lock.json`; `npm ci` in `scrape.yml`)
- Repo root has NO package.json, but a root-level `node_modules/` with `jsdom` + parse5/css-tree etc. exists for the local verify scripts (`scripts/verify-tmdb.mjs`, `scripts/verify-ui.mjs`). These deps are undeclared anywhere - install manually if missing.

## Frameworks

**Core:**
- None. The worker is a raw `fetch(request, env)` handler (`src/index.js`) with hand-rolled routing, JSON helpers, and CORS headers. No Hono/itty-router/Express.
- Vanilla DOM JS in the configure page (no framework, no bundler).

**Testing:**
- None (no test framework). Hand-rolled assert-based scripts:
  - `scripts/dry-test.mjs` - full route integration tests against fake in-memory KV + stubbed GH API
  - `scripts/verify-tmdb.mjs` - TMDB module self-checks (config migration, hashes, source plan) using jsdom
  - `scripts/verify-ui.mjs` - headless check of the built configure page HTML using jsdom
- All run directly with `node scripts/<file>.mjs`

**Build/Dev:**
- Wrangler (Cloudflare CLI) - deploy/dev via `wrangler.toml`. No build step; source ships as-is.
- GitHub Actions - both CI and the actual compute platform for scraping/generation.

## Key Dependencies

**Critical:**
- `puppeteer` ^25.3.0 - headless Chromium for DOM-scraping mdblist.com (`scripts/scrape.mjs`)
- `puppeteer-extra` ^3.3.6 + `puppeteer-extra-plugin-stealth` ^2.11.2 - anti-bot-evasion wrapper around puppeteer (`scripts/scrape.mjs` lines 29-35)

**Infrastructure (zero-install, platform-provided):**
- Cloudflare Workers KV - config + run-history storage, bound as `STORE` (`wrangler.toml` [[kv_namespaces]], id `36b7763e6e31445696e1a773c44de7a3`)
- Native `fetch` - all HTTP (worker + all scripts); `AbortSignal.timeout(15000-30000)` used throughout
- `node:crypto` (createHash sha256) - content-hash change detection (`src/config.js` `listContentHash`/`tmdbContentHash`, `scripts/tmdb.mjs` `computeSourceHash`)
- `node:fs`, `node:path`, `node:url` - file writes in scraper scripts
- `jsdom` (root node_modules only) - local verification of configure page

## Configuration

**Environment:**

Worker vars (plain text, `wrangler.toml` `[vars]`):
- `GITHUB_PAGES_BASE` = `https://shivt37.github.io/my-list` - where catalog JSON lives
- `GH_REPO` = `shivt37/my-list` - dispatch target repo
- `GH_WORKFLOW` = `scrape.yml`, `GH_OFFICIAL_WORKFLOW` = `official.yml`, `GH_TMDB_WORKFLOW` = `tmdb.yml`
- Note: `routes.js` reads optional `env.GH_SIMKL_WORKFLOW` (falls back to `"simkl.yml"` constant) and `env.GH_REF` (falls back to `"main"` in `dispatch.js`) - neither is declared in `wrangler.toml`

Worker secrets (Cloudflare):
- `GH_TOKEN` - GitHub PAT for workflow dispatch (`wrangler secret put GH_TOKEN`)
- `TMDB_READ_ACCESS_TOKEN` - TMDB v4 read token, checked in `routes.js` `tmdbTokenOrError()`

GitHub Actions repo secrets:
- `WORKER_ORIGIN` - worker base URL (all four workflows)
- `MDBLIST_API_KEY` - official lists API key (`official.yml`)
- `TMDB_READ_ACCESS_TOKEN` - discover generation (`tmdb.yml`)
- `SIMKL_CLIENT_ID` - Simkl calendar client id (`simkl.yml`)

KV layout (`src/config.js`): key `config` (full addon config), `runs:scraper|runs:official|runs:simkl|runs:tmdb` (last 30 run records each), `healed` (one-shot id-healing flag).

**Build:**
- `wrangler.toml` - sole build/deploy config; no tsconfig, no bundler config, no eslint/prettier configs detected.

## Platform Requirements

**Development:**
- Node 18+ (native fetch, AbortSignal.timeout), npm
- Wrangler authenticated to the Cloudflare account owning the KV namespace (`.wrangler/wrangler-account.json` cache present)

**Production:**
- Cloudflare Worker named `my-list` (workers.dev URL referenced as `https://my-list.st87.workers.dev` in tests)
- GitHub repo `shivt37/my-list` serving `data/*.json` via GitHub Pages from `main`; workflows force-add ignored `data/*.json` (`git add -f`) and push with `git pull --rebase -X theirs`
- Stremio consumes `/manifest.json` + `/catalog/...` endpoints from the worker

---

*Stack analysis: 2026-08-21*
