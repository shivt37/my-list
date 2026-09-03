# STACK.md — Technology Stack

**Analysis Date:** 2026-09-03
**Scope:** full repo (`D:\New folder (5)\my-list`)

## What This Is

Stremio addon ("my-list") backed by a Cloudflare Worker. The worker serves
catalog metadata live (thin fetcher), all heavy data generation runs in
GitHub Actions, and generated catalog files are served as static JSON from
GitHub Pages. Config + run history live in Cloudflare KV.

## Language & Runtime

- **Language:** JavaScript ES modules throughout (`"type": "module"` in `scripts/package.json`; worker uses ESM `import` in `src/*.js`).
- **Worker runtime:** Cloudflare Workers (workerd). `wrangler.toml` sets `compatibility_date = "2026-01-01"` and `compatibility_flags = ["nodejs_compat"]`.
- **Script runtime:** Node.js 22 (`actions/setup-node@v5`, `node-version: 22` in `.github/workflows/scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml`).
- **No root `package.json`:** the worker itself has **zero npm dependencies**. The only manifest is `scripts/package.json` (the GitHub Actions scraper).

## Framework

- **None.** Raw `fetch` handler: `export default { async fetch(request, env) }` in `src/index.js` with a hand-rolled pathname router (regex matches such as `CATALOG_RE` in `src/routes.js`).
- No Hono/itty-router/Express; responses are hand-built `Response` objects with inline CORS + security headers (`src/index.js:11-21`, `src/routes.js:20-42`).

## Source Layout (worker)

| File | Role |
|---|---|
| `src/index.js` | Router: routes, CORS, auth gate |
| `src/routes.js` | Manifest, catalog serving, save-config, refresh dispatch, run ingestion, TMDB proxies, MDBList official picker |
| `src/config.js` | KV config load/save/migrate, catalog id derivation, run history (KV), content hashes (`node:crypto` sha256) |
| `src/auth.js` | PIN login, HMAC session cookie, KV rate limiting, login page HTML |
| `src/configure.js` | `/configure` admin page (single server-rendered template literal, ~2400 lines) |
| `src/status.js` | `/status` HTML page (template literal) |
| `src/dispatch.js` | GitHub Actions `workflow_dispatch` client |

## Data Layer

- **Cloudflare KV**, single binding `STORE` (`wrangler.toml` `[[kv_namespaces]]`, id `36b7763e6e31445696e1a773c44de7a3`).
- No D1, no R2, no Durable Objects, no database.
- See `INTEGRATIONS.md` for the KV key schema.

## Static Data Hosting

- **GitHub Pages**: `GITHUB_PAGES_BASE` var (`https://shivt37.github.io/my-list`) in `wrangler.toml`; catalog files at `data/<catalogId>.json` in the repo, fetched by the worker per request (`githubPagesCatalogUrl` in `src/routes.js:49-51`). Files are written by GitHub Actions scripts (`scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`) and committed by the workflows.

## CI/CD (GitHub Actions)

- 4 workflows in `.github/workflows/`: `scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml`.
- `ubuntu-latest`, `actions/checkout@v5`, `actions/setup-node@v5`, Node 22, `actions/upload-artifact@v5` (scrape debug artifacts).
- Shared `concurrency` group `my-list-scrape`, `cancel-in-progress: false`, `queue: max` (all four serialize — protects the KV read-modify-write + data-commit race).
- All data commits use `git pull --rebase -X theirs` (data files are throwaway artifacts).
- Schedules are cron lines in the workflow files themselves (no worker scheduled handler).

## Dependencies

- **Worker:** none (stdlib only; `node:crypto`, WebCrypto `crypto.subtle`, `Intl`).
- **Scripts (`scripts/package.json`):** `puppeteer ^25.3.0`, `puppeteer-extra ^3.3.6`, `puppeteer-extra-plugin-stealth ^2.11.2` — headless-Chromium DOM scraping of mdblist.com listing pages.
- **Test tooling (ambient, undeclared):** `jsdom` used by `testing/verify-ui.mjs` / `testing/verify-tmdb.mjs` but declared nowhere (known gap, see `.planning/codebase/FUNCTIONAL-AUDIT.md` m9). An orphaned `playwright-core` was used ad hoc during audits, not part of the repo.

## Configuration

- `wrangler.toml`: worker name `my-list`, `main = "src/index.js"`, `keep_vars = true` (dashboard vars survive deploys), KV binding, and vars:
  - `GITHUB_PAGES_BASE`, `GH_REPO` (`shivt37/my-list`), `GH_WORKFLOW` (`scrape.yml`), `GH_OFFICIAL_WORKFLOW` (`official.yml`), `GH_TMDB_WORKFLOW` (`tmdb.yml`).
- **Secrets** (never in repo; dashboard / `wrangler secret put` / GitHub secrets): `GH_TOKEN`, `SESSION_SECRET`, `MDBLIST_API_KEY`, `TMDB_READ_ACCESS_TOKEN`, `SIMKL_CLIENT_ID`, `ADMIN_PIN`, `AUTH_ENABLED`, `WORKER_ORIGIN` (GitHub repo secret).
- `.dev.vars` (gitignored, local-only) carries the same key names for `wrangler dev` plus `GH_DISPATCH_STUB` (routes dispatches to a console-log stub) and `AUTH_ENABLED=false` (keeps login gate off on 127.0.0.1:8787). Values live only in that file — never copied into docs or commits.

## HTML / Frontend

Server-rendered, no build step, no bundler. Three inline template-literal pages:
- `/configure` → `buildConfigurePage` (`src/configure.js`), Inter font from Google Fonts, dark theme, inline vanilla JS.
- `/status` → `src/status.js` (tabs for the 4 modules; `?format=json` keeps the raw feed).
- `/configure/login` → `loginPageHtml` (`src/auth.js`).
CSP set on HTML responses in `src/routes.js:37` (`script-src 'self' 'unsafe-inline'`, Google Fonts allowed).

## Testing

No test framework or runner config — plain scripts run directly with `node`:
- `testing/save-config.test.mjs`, `testing/scrape-serve.test.mjs`, `testing/tmdb-sort.test.mjs` — `node:assert/strict` suites with stubbed `fetch` + fake KV.
- `testing/dry-test.mjs` — full-route integration dry run (in-memory KV, stub GitHub API).
- `testing/verify-ui.mjs`, `testing/verify-tmdb.mjs` — jsdom headless UI checks.
- `scripts/package.json` `npm run scrape` → `node scrape.mjs` (manual).

## Deployment

`wrangler deploy` (standard); `wrangler dev` for local (`127.0.0.1:8787`). No custom build, no CI deploy pipeline found in-repo — deploys appear manual.

---

*tech stack + integrations analysis: 2026-09-03*
<!-- refreshed: 2026-09-03 -->
