# Technology Stack

**Analysis Date:** 2026-09-15

## Languages

**Primary:**
- JavaScript (ES modules, `"type": "module"`) - all Worker code in `src/*.js`, all CI scripts in `scripts/*.mjs`, all tests in `testing/*.mjs`
- No TypeScript, no build/transpile step - Worker ships raw `src/index.js` as entry

**Secondary:**
- HTML/CSS/vanilla JS (template literals) - admin SPA in `src/configure.js`, status page in `src/status.js`, preview page in `testing/theme-preview.html`
- Bash (inline `run:` blocks) - input sanitization + KV-consistency polling inside `.github/workflows/*.yml`
- PowerShell - documented local-dev shell in `README.md`

## Runtime

**Environment:**
- Cloudflare Workers - entry `src/index.js` (`export default { async fetch }`), `compatibility_date = "2026-01-01"`, `compatibility_flags = ["nodejs_compat"]` in `wrangler.toml`
- Web-standard APIs only in `src/`: `fetch`, `Response`, `URL`, `crypto.subtle` (HMAC sessions in `src/auth.js`), `AbortSignal.timeout`, `TextEncoder`, `Intl` (timezone in SIMKL path)
- Node.js 22 - GitHub Actions runners (`actions/setup-node@v5`, `node-version: 22` in all four `.github/workflows/*.yml`); local script runs via `node scripts/<x>.mjs`

**Package Manager:**
- npm (`npm ci`) in `scripts/` only; lockfile present at `scripts/package-lock.json`
- Worker itself has zero runtime dependencies and no root `package.json` - intentional, keeps Worker bundle dependency-free

## Frameworks

**Core:**
- None - no web framework. Thin router in `src/index.js` dispatches to handlers in `src/routes.js`; HTML pages built as string templates in `src/configure.js` and `src/status.js`

**Testing:**
- Node built-in test runner + `node:assert/strict` - tests import Worker modules directly, e.g. `testing/scrape-serve.test.mjs`, `testing/save-config.test.mjs`, `testing/tmdb-sort.test.mjs`, `testing/preview-excl-dom.test.mjs`, `testing/network-picker-dom.test.mjs`
- Ad-hoc live/verify scripts (manual, hit real APIs): `testing/verify-tmdb.mjs`, `testing/verify-ui.mjs`, `testing/networks-live.mjs`, `testing/undated-live.mjs`, `testing/tmdb-repro.mjs`, `testing/tmdb-exclude-e2e.mjs`
- No assertion library, no coverage tool, no test config file

**Build/Dev:**
- Wrangler CLI (`npx wrangler dev src/index.js`, local dev on `http://127.0.0.1:9090`) - deploy + `wrangler secret put` for secrets; `keep_vars = true` in `wrangler.toml` so dashboard vars survive deploys
- Puppeteer stack (CI scraper only, `scripts/package.json`): `puppeteer@^25.3.0`, `puppeteer-extra@^3.3.6`, `puppeteer-extra-plugin-stealth@^2.11.2` - used by `scripts/scrape.mjs` with headless Chromium (1920x1080, realistic UA)

## Key Dependencies

**Critical:**
- `puppeteer` + `puppeteer-extra` + `puppeteer-extra-plugin-stealth` (`scripts/package.json`) - DOM scraping of mdblist.com listing pages in `scripts/scrape.mjs`; only `scrape.yml` runs `npm ci`, the other three workflows need no install
- `node:crypto` (`createHash` sha256) in `src/config.js` - `randomScraperId` (seeded list ids) and `configVersion` content hashing; `scripts/tmdb.mjs` imports `tmdbContentHash` from `../src/config.js` as single source of truth
- `node:fs` / `node:path` / `node:url` in `scripts/*.mjs` - write `data/*.json` catalog files, resolve repo root
- Google Fonts `Inter` (external stylesheet link in `src/configure.js`) - only third-party asset loaded by the UI

**Infrastructure:**
- Cloudflare KV (`STORE` binding, id `36b7763e6e31445696e1a773c44de7a3` in `wrangler.toml`) - single `config` key + `runs:<module>` history keys (30 capped) via `src/config.js` (`loadConfig`/`saveConfig`/`addRuns`/`getRuns`)
- GitHub Actions (4 workflows, shared concurrency group `my-list-scrape` with `queue: max`): `.github/workflows/scrape.yml` (30 min timeout), `official.yml`, `simkl.yml`, `tmdb.yml` (15 min each)
- GitHub Pages - serves committed `data/*.json` at `{GITHUB_PAGES_BASE}/data/<catalog_id>.json` (see `githubPagesCatalogUrl` in `src/routes.js`)

## Configuration

**Environment:**
- `wrangler.toml` `[vars]`: `GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`, `GH_TMDB_WORKFLOW` (SIMKL workflow name is a code constant `SIMKL_WORKFLOW = "simkl.yml"` in `src/routes.js`)
- Secrets (Cloudflare dashboard / `wrangler secret put`, mirrored as GitHub repo secrets for CI): `GH_TOKEN`, `ADMIN_PIN`, `MDBLIST_API_KEY`, `TMDB_READ_ACCESS_TOKEN`, `SIMKL_CLIENT_ID`, plus `SESSION_SECRET` (optional HMAC key fallback), `WORKER_ORIGIN` (CI-only), `AUTH_ENABLED` (bool kill-switch var), `GH_DISPATCH_STUB` (local-dev only)
- `.dev.vars` file present at repo root - local dev vars for `wrangler dev` (existence only; never read or commit real values). `.gitignore` excludes `.dev.vars`, `node_modules/`, `.wrangler/`, `debug/`, `scratch/`, `audit/`, `testing/`

**Build:**
- No build config: no `tsconfig.json`, no bundler, no linter/formatter config, no root `package.json`
- Deploy unit is `wrangler.toml` (`name = "my-list"`, `main = "src/index.js"`); CI has no build step - workflows checkout, optionally `npm ci` (scrape only), then `node <script>.mjs`

## Platform Requirements

**Development:**
- Node 22, Wrangler CLI, `AUTH_ENABLED=false` for frictionless local admin (`README.md` local-development section)
- `scripts/*.mjs` run from `scripts/` with env set (`WORKER_ORIGIN` + per-module API key); TMDB calls may need retries on flaky links
- Windows PowerShell noted: no `&&`/`||` chaining, use `if ($?)`

**Production:**
- Cloudflare Workers (serves Stremio manifest/catalogs, `/configure` admin SPA, `/status` dashboard)
- GitHub Actions ubuntu-latest runners (cron 00:00 + 12:00 UTC; TMDB once daily 00:00 UTC) commit `data/*.json` via `git add -f` (files are gitignored but force-added)
- GitHub Pages hosts the static catalog JSON the Worker proxies; Stremio clients consume `https://my-list.st87.workers.dev`

---

*Stack analysis: 2026-09-15*
