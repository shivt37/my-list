# Coding Conventions

**Analysis Date:** 2026-08-25

## Languages & Style Baseline

- Plain JavaScript ESM (`"type": "module"` implied by `.mjs`/import syntax in `src/*.js`; explicit in `scripts/package.json`). No TypeScript anywhere.
- No transpiler, no bundler for source — code runs as-is on Cloudflare Workers (`nodejs_compat` flag in `wrangler.toml`) and Node 22 in Actions.
- **No linter or formatter configured.** No `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `biome.json`, or `.editorconfig`. Style is enforced by convention and review only — match surrounding code exactly when editing.
- Double quotes in `src/*.js` and `scripts/*.mjs`; single quotes inside the browser-JS template literal in `src/configure.js` (it lives inside backticks, so it avoids nested backticks).

## Naming Patterns

**Files:**
- Worker modules: short lowercase nouns — `src/index.js`, `src/config.js`, `src/routes.js`, `src/dispatch.js`, `src/configure.js`
- Action scripts: lowercase `.mjs` matching their module — `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`
- Tests: `<area>-test.mjs`, `dry-test.mjs`, `verify-<area>.mjs` under `testing/`

**Functions:** camelCase verbs — `loadConfig`, `buildManifest`, `handleSaveConfig`, `dispatchScraperWorkflow`, `writeCatalog`, `normalizeTiers`. Route handlers uniformly prefixed `handle<Thing>` (`src/routes.js`).

**Constants:** UPPER_SNAKE_CASE at module top — `CONFIG_KEY`, `RUNS_MAX`, `MAX_OFFICIAL_LISTS`, `SANE_OFFICIAL_SLUG`, `TMDB_SORTS`, `PREVIEW_PAGES` (`src/config.js`, `src/routes.js`).

**Variables:** camelCase; booleans read as predicates (`wasSeeded`, `alreadyHealed`, `scraperDispatchNeeded`).

**Types:** None. Shapes are documented via header comments and normalization functions, not interfaces. A list's canonical shape is whatever its `normalize*/migrate*` function returns (`src/config.js:227-339`).

**Catalog id prefixes encode the module** and are relied on throughout: `mdb_scrape_*`, `mdboff_<slug>_<movie|show>`, `simkl_arriving_today_<kind>`, `tmdb_discover_<movie|series>_<8base36>`. New catalog families must follow this scheme (`src/config.js:18-45`, `runsKeyFor` keys off it).

## Code Style

**Formatting:** Not enforced by tooling. Observed: 2-space indent, ~120-char practical line limit, semicolons in `src/` and `scripts/`, arrow functions for small helpers, `const` by default.

**Linting:** None. Do not add config files unprompted.

## Import Organization

**Order:**
1. `node:` builtins (`node:crypto`, `node:fs`, `node:path`, `node:url`)
2. Sibling project modules (`./config.js`, `../src/routes.js`)
3. Third-party packages (`puppeteer-extra`, `puppeteer-extra-plugin-stealth`, `jsdom`)

All imports are named imports; one flat block per group. No path aliases — relative paths only.

## Module Design

**Exports:** Named exports exclusively. The single `export default` is the worker's fetch handler in `src/index.js:21` (Workers platform requirement).

**No barrel files.** Each module imported directly where needed.

**Dependency injection for testability (scripts):** every Action script's `main()` accepts injectable collaborators with production defaults:
```js
// scripts/official.mjs:177
export async function main({
  slugsArg = slugsArg,
  actionArg = rawAction,
  fetchConfig = enabledSlugs,
  fetchApi = fetchAllItems,
  write = writeCatalog,
  recordRuns = postRuns,
} = {}) {
```
New script logic must follow this pattern — pure-ish functions exported, `main()` parameterized, so `testing/dry-test.mjs` can import and drive them with fakes.

**isMain guard:** scripts guard side effects so tests can import safely:
```js
// scripts/official.mjs:260
export const isMain = typeof process !== "undefined" && !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) { ... }
```

**Entry-point routing:** `src/index.js` is a flat if-chain over `pathname` returning `Response`s; handlers live in `src/routes.js`. Add new endpoints as a `handleX(env, request)` export in `routes.js` plus one if-line in `index.js`.

## Input Validation (Trust Boundaries)

This is the strongest enforced convention — validate/coerce everything crossing a boundary, never throw past it:

- **Persisted config:** every field re-derived through `migrateConfig`/`migrateOfficial`/`normalizeTmdbList`/`normalizeTiers` on every load and every save (`src/config.js:204-344`). Regex-guard ids before they touch file paths: `/^mdb_scrape_[A-Za-z0-9_-]{1,32}$/`, `/^[a-z0-9][a-z0-9-]{0,63}$/`, `/^tmdb_discover_(movie|series)_[a-z0-9]{8}$/`.
- **Numeric clamps:** `maxPages` clamped `Math.min(50, Math.max(1, Math.floor(...)))` (`src/config.js:281`).
- **POST bodies:** shape-checked up front with a 400 carrying an actionable message (`src/routes.js:238-243`); per-record isolation in batch ingestion — one malformed record must not drop valid siblings (`src/routes.js:562-581`).
- **CLI/workflow args:** sanitized twice — char-class whitelist in the workflow bash step *and* regex rejection inside `main()` (`scripts/scrape.mjs:376-385`, `.github/workflows/scrape.yml` sanitize step).
- **XSS:** the embedded config blob is hard-escaped before injection into HTML: `JSON.stringify(config).replace(/</g, "\\u003c")` (`src/configure.js:9`); attribute values go through `escapeAttr`.

## Error Handling

**Patterns:**

1. **Degradation over 500s in the worker.** Corrupt KV values fall back to seeds/empty instead of throwing (`src/config.js:388-391`, `479-501`); unknown/disabled catalog ids return `{ metas: [] }` with 200 so Stremio chains don't break (`src/routes.js:180-189`).
2. **Explicit status-code contract:** 400 invalid body, 404 unknown id, 400 known-but-disabled with actionable message, 501/502 failed upstream dispatch, 500 catch-all `"Save failed."` (`src/routes.js:235-431`). Never leak stack traces to responses.
3. **Transactional save ordering:** all dispatches fire before `saveConfig` persist, non-destructive workflows before destructive ones, so any failure leaves config and data consistent (`src/routes.js:327-397`). Preserve this ordering when adding new dispatch paths.
4. **Fail-fast with context in scripts:** thrown errors carry slug/id/status text sliced to 200 chars (`scripts/official.mjs:100-104`); per-list try/catch records a `failed` run row and continues the batch (`scripts/scrape.mjs:461-468`).
5. **Never overwrite good data with empty:** a 0-item scrape skips the file write (`scripts/scrape.mjs:341-344`, `scripts/official.mjs:229-232`); simkl is the documented exception because an empty day is legitimate (`scripts/simkl.mjs:9-11`).
6. **Silent best-effort for non-critical writes:** cache writes wrapped in `try {} catch {}` with a comment saying why failure is acceptable (`src/routes.js:805`).
7. **UI errors humanized:** known infra messages mapped to plain sentences via `ERROR_MAP`/`humanizeError`; unknown messages pass through untouched (`src/configure.js:825-837`).

## Logging

**Framework:** None. `console.log` / `console.warn` / `console.error` directly.

- `scripts/*.mjs`: free use of all three; `warn` for recoverable, `error` for failures, and set `process.exitCode = 1` on partial failure so Actions marks the step red while still committing good data.
- `src/` (worker): essentially silent in production; the only `console.log` is the local-dev `GH_DISPATCH_STUB` branch in `src/dispatch.js:14-16` (never enabled in prod). Do not add console noise to worker code.

## Comments

**When to comment:** This codebase comments *why*, heavily and well. Follow it:
- Invariants and their rationale (`src/config.js:222-226` — blank tier would vacuously pass every title)
- Dated decisions and owner requests (`Owner request 2026-08-24: ...` in `src/routes.js:275`)
- Accepted limitations with revisit conditions (`src/config.js:473-477` — addRun race, references FUNCTIONAL-AUDIT M5)
- Cross-file mirrors that must stay in sync (`Mirrors computeSourceHash in scripts/tmdb.mjs` — `src/config.js:358`)
- Security reasoning (`src/config.js:274-277` — traversal guard)

**JSDoc/TSDoc:** Not used. Script files open with a block comment covering purpose, required env vars, and CLI usage (`scripts/scrape.mjs:2-27`) — replicate that header for new scripts.

## Function Design

- Handlers do orchestration; leaf helpers stay pure (`rowToMeta*` mappers, `sortPreviewItems`, `buildPageUrl`).
- Long linear flows are acceptable inside one handler when they're a single narrative (`handleSaveConfig`, ~200 lines) — split only when a piece is reused or independently testable.
- Diff-by-content-hash pattern: changes detected by hashing the fields that affect output, deliberately excluding display-only fields like `name` (`listContentHash`, `tmdbContentHash` — `src/config.js:349-383`). Any new list type needs the same hash discipline, mirrored between worker and generator script.

## UI Code (configure page)

- One giant template-literal document in `src/configure.js` (~2000 lines: CSS tokens + HTML shell + inline JS). Browser-side JS uses string-concatenation rendering into `#tabHost` with full re-render on change (`rerenderActive`), not DOM diffing.
- Design tokens as CSS custom properties on `:root` with a fixed spacing grid (`--s1..--s6`) — use the grid variables, not raw pixel values (`src/configure.js:48-53`).
- Global state in a single `state` object; handlers attached via inline `onchange="fn()"` referencing globals exposed on `window`.

## Git Conventions

Commit subjects follow `<type>: <summary>` — types observed: `feat:`, `fix:`, `chore(data):` (bot commits, `[skip ci]` suffix), `chore(dev):`, `ui:`. Data commits are made by bots (`my-list-bot`) in workflows; humans/AI commit code separately.

---

*Convention analysis: 2026-08-25*
