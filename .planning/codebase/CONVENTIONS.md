# Coding Conventions

**Analysis Date:** 2026-09-15

## Naming Patterns

**Files:**
- Worker source: lowercase single-word `src/*.js` — `src/index.js`, `src/routes.js`, `src/config.js`, `src/auth.js`, `src/dispatch.js`, `src/status.js`, `src/configure.js`
- Generator scripts: lowercase `scripts/*.mjs` — `scripts/scrape.mjs`, `scripts/tmdb.mjs`, `scripts/simkl.mjs`, `scripts/official.mjs`
- Tests: kebab-case with suffix `testing/<topic>.test.mjs` for assertions (`testing/scrape-serve.test.mjs`, `testing/save-config.test.mjs`, `testing/tmdb-sort.test.mjs`, `testing/preview-excl-dom.test.mjs`, `testing/network-picker-dom.test.mjs`) and bare `.mjs` for manual/live or repro scripts (`testing/verify-ui.mjs`, `testing/dry-test.mjs`, `testing/tmdb-repro.mjs`, `testing/tmdb-exclude-e2e.mjs`, `testing/verify-tmdb.mjs`, `testing/networks-live.mjs`, `testing/undated-live.mjs`)

**Functions:**
- Use camelCase verbs: `loadConfig`, `saveConfig`, `migrateConfig`, `buildManifest`, `handleCatalog`, `handleSaveConfig`, `dispatchScraperWorkflow`, `normalizeTmdbList`, `officialCatalogsFor`, `tmdbCatalogId`, `runsKeyFor`, `sortItems`, `buildDiscoverItems`
- Predicates start with `is`/`has`: `isAuthEnabled`, `isAdminPath`, `isPublic` (all in `src/auth.js`)
- Pure normalizers named `normalize*` / `migrate*`: `normalizeTz`, `normalizeTiers`, `normalizeSimklList`, `normalizeTmdbList`, `migrateOfficial`, `migrateSimkl`, `migrateTmdb`, `migrateConfig` (all in `src/config.js`)

**Variables:**
- camelCase locals; SNAKE_UPPER only for true constants: `ADDON_ID`, `ADDON_NAME`, `OFFICIAL_WORKFLOW`, `CATALOG_RE`, `SESSION_TTL_DEFAULT_MS`, `MAX_OFFICIAL_LISTS`, `RUNS_MAX`, `TMDB_SORTS`, `SIMKL_LISTS`, `OFFICIAL_LISTS`
- KV keys as module constants in `src/config.js`: `CONFIG_KEY`, `RUNS_SCRAPER_KEY`, `RUNS_OFFICIAL_KEY`, `RUNS_SIMKL_KEY`, `RUNS_TMDB_KEY`, `HEALED_KEY`
- Env bindings accessed as `env.STORE`, `env.GH_TOKEN`, `env.GH_REPO`, `env.GH_WORKFLOW`, `env.GITHUB_PAGES_BASE`, `env.WORKER_ORIGIN`, `env.ADMIN_PIN`, `env.SESSION_SECRET`

**Types:**
- No TypeScript anywhere. No JSDoc type annotations in `src/`. Shape contracts live in comments and in the normalize/migrate functions themselves, e.g. `src/config.js` header: "each list = { id, name, url, type, maxPages, enabled }"

## Code Style

**Formatting:**
- No formatter configured (no Prettier, no Biome, no ESLint config in repo). Match surrounding style by hand.
- 2-space indent, double quotes, semicolons, trailing commas in multiline literals. Verified across `src/config.js`, `src/routes.js`, `src/auth.js`.
- Line width is free-form; long URL/query-string literals stay on one line (see `SEED_LISTS` in `src/config.js`).

**Linting:**
- No linter. CI (`.github/workflows/scrape.yml`, `tmdb.yml`, `official.yml`, `simkl.yml`) runs `node <script>.mjs` directly — a syntax error fails the workflow, so keep every file parseable by plain `node --check`.

**Module system:**
- ESM everywhere: `import`/`export` in both `src/*.js` (worker, `nodejs_compat` flag in `wrangler.toml`) and `scripts/*.mjs` / `testing/*.mjs` (`"type": "module"` in `scripts/package.json`).
- Node builtins use the `node:` prefix: `import assert from "node:assert/strict"`, `import { createHash } from "node:crypto"`.

## Import Organization

**Order:**
1. Node builtins (`node:assert/strict`, `node:crypto`, `node:fs`)
2. Relative project modules (`../src/routes.js`, `../src/config.js`, `../src/configure.js`)
3. Single third-party import only where needed: `import { JSDOM } from "jsdom"` at top of DOM tests

**Examples from codebase:**
```javascript
// testing/save-config.test.mjs
import assert from "node:assert/strict";
import { handleSaveConfig } from "../src/routes.js";
import { migrateConfig, SIMKL_LISTS } from "../src/config.js";
```

```javascript
// scripts/tmdb.mjs
import { tmdbContentHash } from "../src/config.js";
```

**Path Aliases:**
- None. Always relative paths (`./config.js`, `../src/routes.js`).

## Error Handling

**Patterns:**
- Route handlers return JSON error envelopes with matching status, never throw to the runtime. Canonical helpers in `src/routes.js` and `src/index.js`:
```javascript
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "x-content-type-options": "nosniff", ...corsHeaders, ...extraHeaders },
  });
}
return json({ error: "Unknown scraper list." }, 404);
return json({ ok: false, error: "Save rejected - GitHub dispatch failed: " + dispatchResult.reason }, 502);
```
- Status-code convention in `src/routes.js`: 400 malformed body / disabled list, 401 unauthorized (`src/index.js`), 404 unknown list/catalog, 500 save/record failure, 501 trigger-refresh dispatch failure, 502 save-config dispatch failure.
- Defensive `try/catch` around every KV read with degrade-to-default instead of 500. Pattern from `src/config.js` (`loadConfig`, `addRun`, `addRuns`, `getRuns`):
```javascript
let raw = null;
try {
  raw = await kv.get(CONFIG_KEY, "json");
} catch {
  raw = null; // corrupt KV value → fall back to seeds rather than 500
}
```
- `SyntaxError` from `request.json()` gets its own 400 with the parse message; all other save errors collapse to a generic 500 (`src/routes.js` `handleSaveConfig`, `handleRunsPost`).
- External fetch failures are converted to structured `{ dispatched: false, reason }` results, never thrown (`src/dispatch.js` wraps `fetch` in try/catch plus `AbortSignal.timeout(15000)`).
- Input sanitization is whitelist-based at every trust boundary: regex id checks (`/^mdb_scrape_[A-Za-z0-9_-]{1,32}$/` in `migrateConfig`, `/^[a-z0-9]{8}$/` for `discoverListId`, `ID_RE` in `scripts/tmdb.mjs`), `SANE_OFFICIAL_SLUG` in `src/config.js`, `tr -cd` char-class stripping in all four `.github/workflows/*.yml` sanitize steps.

## Logging

**Framework:** `console` only (`console.log` stub-dispatch line in `src/dispatch.js`, `console.log`/`console.error` result lines in `testing/*.mjs`). No logging library.

**Patterns:**
- Worker dispatch stub logs instead of firing: `console.log(`[dispatch-stub] ${workflow} <-`, inputs)` (`src/dispatch.js`).
- Test scripts print `ok:` / `PASS` per check and a final summary, exiting nonzero on failure — CI-visible without a reporter.

## Comments

**When to Comment:**
- Every file opens with a 1–6 line `//` header stating module ownership and non-obvious invariants (e.g. `src/index.js`, `src/auth.js`, `src/dispatch.js`, `scripts/tmdb.mjs`, each `testing/*.mjs` states its `Run:` command).
- Cross-file coupling gets an explicit pointer comment naming the other file and why they must stay in sync (e.g. `tmdbContentHash` "Mirrors computeSourceHash in scripts/tmdb.mjs"; `ACCENT_COLORS` in `src/status.js` "Keep in sync if the configure palette ever changes").
- Accepted limitations are documented inline with owner + date (e.g. `addRun` race "accepted 2026-08-23 … Revisit only if that group ever loosens" in `src/config.js`).
- Dead-code deletions leave a tombstone comment (`randomTmdbListId deleted - zero callers` in `src/config.js`).

**JSDoc/TSDoc:**
- Not used. Contracts are prose comments plus runtime normalization.

## Function Design

**Size:** Small pure helpers (5–30 lines) in `src/config.js` and `src/auth.js`; route handlers in `src/routes.js` are longer (50–150 lines) but branch-linear, no nesting past 3 levels. `buildConfigurePage` in `src/configure.js` is the single giant template-literal builder — edit its render-function sections, do not restructure.

**Parameters:** Positional args in fixed order `(env, ...)`: `handleCatalog(env, type, catalogId, skip)`, `handleSaveConfig(env, request)`, `dispatchScraperWorkflow(env, { lists, action, deleteIds, workflow, inputs })`. Options objects only where ≥3 optional fields (`configureResponse` opts, dispatch opts).

**Return Values:** Worker handlers return `Response` objects. Pure helpers return fresh objects/arrays, never mutated inputs — spread-copy pattern everywhere:
```javascript
return { ...cfg, scraper: { lists: SEED_LISTS.map((s) => ({ ...s })) } };
```

## Module Design

**Exports:** Named exports for everything (`export function`, `export const`, `export async function`). Single exception: `src/index.js` uses `export default { async fetch(...) }` as the worker entrypoint.

**Barrel Files:** None. Import directly from the owning module (`../src/config.js`, `../src/routes.js`, `../src/configure.js`).

---

*Convention analysis: 2026-09-15*
