# Technology Stack

**Analysis Date:** 2026-08-05

## Languages

**Primary:**
- JavaScript (ES Modules) - Worker source (`src/*.js`), scraper scripts (`scripts/*.mjs`), tests (`scripts/dry-test.mjs`, `scripts/verify-ui.mjs`)

**Secondary:**
- HTML/CSS - Inline in `src/configure.js` (configure page, ~850 lines)
- YAML - GitHub Actions workflows (`.github/workflows/*.yml`)

**Notable absence:** No TypeScript. Entire codebase is plain JavaScript.

## Runtime

**Worker Runtime:**
- Cloudflare Workers (V8 isolate, edge network)
- Compatibility date: `2026-01-01`
- Compatibility flags: `nodejs_compat`
- Entry point: `src/index.js`

**Scraper Runtime:**
- Node.js 22 (GitHub Actions runner)
- Runs headless Chromium via Puppeteer
- `scripts/` directory contains all scraper logic

**Platform:** `wrangler.toml` at `D:\New folder (5)\my-list\wrangler.toml`

## Package Manager

**npm**
- Lockfile: `scripts/package-lock.json` (present)
- Note: No root `package.json` — dependencies are scoped to `scripts/` only
- Worker (`src/`) has zero npm dependencies; relies on Cloudflare Workers runtime globals

## Frameworks

**Core:**
- Cloudflare Workers (module syntax) - `D:\New folder (5)\my-list\src\index.js`
- No web framework (Express, Hono, etc.) — manual routing via URL pathname matching

**Testing:**
- Node.js built-in `assert` (strict mode) - `D:\New folder (5)\my-list\scripts\dry-test.mjs`
- JSDOM - DOM verification for configure page - `D:\New folder (5)\my-list\scripts\verify-ui.mjs`
- No test runner framework (no Jest, Vitest, Mocha)

**Scraping:**
- Puppeteer ^25.3.0 - Headless Chromium
- puppeteer-extra ^3.3.6 - Plugin system
- puppeteer-extra-plugin-stealth ^2.11.2 - Anti-detection evasion

## Key Dependencies

**Critical:**
- `puppeteer` ^25.3.0 - Headless browser for scraping mdblist.com (`D:\New folder (5)\my-list\scripts\scrape.mjs`)
- `puppeteer-extra` ^3.3.6 - Plugin host for stealth (`D:\New folder (5)\my-list\scripts\scrape.mjs`)
- `puppeteer-extra-plugin-stealth` ^2.11.2 - Evades bot detection (`D:\New folder (5)\my-list\scripts\scrape.mjs`)
- `jsdom` - DOM parser for UI verification tests (`D:\New folder (5)\my-list\scripts\verify-ui.mjs`)

**Infrastructure:**
- Cloudflare KV namespace (binding `STORE`) - Config + run history storage
- GitHub Actions workflows - Scheduled scraping (every 12h) and manual dispatch

## Configuration

**Environment (Cloudflare Worker):**
- `wrangler.toml` - Worker config, KV binding, vars
- KV keys: `config` (JSON blob), `runs:scraper`, `runs:official`, `healed`
- Secrets (not in wrangler.toml): `GH_TOKEN`

**Environment (GitHub Actions):**
- Secrets: `WORKER_ORIGIN`, `MDBLIST_API_KEY`, `GH_TOKEN` (Cloudflare)
- Workflow vars in `wrangler.toml`: `GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`

**Build:**
- No build step for worker (ES modules, direct deployment via Wrangler)
- `npm ci` in `scripts/` before scraper runs

## Platform Requirements

**Development:**
- Node.js 22 (for scraper scripts and tests)
- Wrangler CLI (for worker deployment)
- Chromium (bundled with Puppeteer)

**Production:**
- Cloudflare Workers (edge compute)
- GitHub Pages (static catalog data hosting)
- GitHub Actions (scheduled scraping, cron-based)

---

*Stack analysis: 2026-08-05*
