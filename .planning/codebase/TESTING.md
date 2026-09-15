# Testing Patterns

**Analysis Date:** 2026-09-15

## Test Framework

**Runner:**
- No runner, no `test` script. Every check is a standalone executable Node script: `node testing/<name>.mjs`. There is no root `package.json`; the only manifest is `scripts/package.json` (`"scripts": { "scrape": "node scrape.mjs" }`, deps `puppeteer`, `puppeteer-extra`, `puppeteer-extra-plugin-stealth`).
- Config: none (no `jest.config.*`, `vitest.config.*`, `playwright.config.*`).
- `jsdom` is imported by DOM tests (`testing/verify-ui.mjs`, `testing/preview-excl-dom.test.mjs`, `testing/network-picker-dom.test.mjs`) but is not declared in `scripts/package.json` — install separately before running those files.

**Assertion Library:**
- `node:assert/strict` only: `import assert from "node:assert/strict"` then `assert.equal`, `assert.deepEqual`, `assert.ok`.

**Run Commands:**
```bash
node testing/scrape-serve.test.mjs      # worker catalog serving (offline, stubbed fetch)
node testing/save-config.test.mjs       # save-config dispatch matrix (offline, stubbed fetch + fake KV)
node testing/tmdb-sort.test.mjs         # sortItems rules + preview mirror (offline)
node testing/preview-excl-dom.test.mjs  # preview exclusion DOM behavior (needs jsdom)
node testing/verify-ui.mjs              # configure page headless check (needs jsdom)
node testing/network-picker-dom.test.mjs # network picker vs live dev server at 127.0.0.1:8787
node testing/tmdb-exclude-e2e.mjs       # exclusions vs REAL TMDB API (needs TMDB_READ_ACCESS_TOKEN)
node testing/tmdb-repro.mjs             # ad-hoc generator repro, no assertions
node testing/dry-test.mjs               # full worker route dry-run (see caveat below)
node testing/verify-tmdb.mjs testing/networks-live.mjs testing/undated-live.mjs  # live API probes
```

## Test File Organization

**Location:**
- All tests live in `testing/` at repo root. Note: `testing/dry-test.mjs` and `testing/verify-ui.mjs` carry stale header comments claiming `scripts/` paths (`Run: node scripts/dry-test.mjs`, `Run: node scripts/verify-ui.mjs`) — the actual files are in `testing/`.

**Naming:**
- `*.test.mjs` = self-checking suites that print PASS/FAIL and `process.exit(fail ? 1 : 0)`.
- Bare `*.mjs` = manual/live/repro scripts (`dry-test`, `verify-ui`, `tmdb-repro`, `tmdb-exclude-e2e`, `verify-tmdb`, `networks-live`, `undated-live`).

**Structure:**
```
testing/
├── scrape-serve.test.mjs      # offline worker route test
├── save-config.test.mjs       # offline worker route test
├── tmdb-sort.test.mjs         # offline generator unit test (+ worker preview mirror)
├── preview-excl-dom.test.mjs  # jsdom DOM behavior test
├── network-picker-dom.test.mjs # jsdom + live dev-server test
├── dry-test.mjs               # offline full-route dry run
├── verify-ui.mjs              # jsdom page smoke check
├── tmdb-repro.mjs             # ad-hoc repro (prints, no asserts)
├── tmdb-exclude-e2e.mjs       # live-API E2E (asserts)
├── verify-tmdb.mjs / networks-live.mjs / undated-live.mjs  # live probes
└── theme-preview.html         # manual visual preview (open in browser)
```

## Test Structure

**Suite Organization:**
- No suites/describe blocks. Flat script: header comment with `Run:` line, imports, fixtures, a tiny `check`/`ok`/`test` collector, sequential blocks, summary + exit code. Copy this shape for new tests:
```javascript
// testing/tmdb-sort.test.mjs
import assert from "node:assert/strict";
import { sortItems } from "../scripts/tmdb.mjs";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ok:", name); }
  catch (e) { failed++; console.error("FAIL:", name, "\n      ", e.message); }
};

check("movie release_asc order kept", () => {
  const out = sortItems([...DATED], "release_asc", "movie");
  assert.deepEqual(out.map((i) => i.id), [1726, 3154, 1724]);
});
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} FAILURES`);
process.exit(failed ? 1 : 0);
```
- The `test(name, fn)` collector variant (async) in `testing/save-config.test.mjs`:
```javascript
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
test("official OFF->ON dispatches official.yml with the slug", async () => { /* ... */ });
for (const [name, fn] of tests) { /* run, count, report */ }
```

**Patterns:**
- Setup: build fixtures inline at top of file (see `SERIES_FIXTURE` / `MOVIE_FIXTURE` in `testing/scrape-serve.test.mjs`, `RAW_BASE` + `tmdbList` factories in `testing/save-config.test.mjs`).
- Teardown: none — each process exits; `testing/dry-test.mjs` snapshots/restores real `data/*.json` bytes via `snapshotFiles`/`safeRm` instead of teardown.
- Assertion: one behavior per `check`, label states expectation (`"every series meta typed 'series' (was 100% 'movie' before S1)"`).

## Mocking

**Framework:** Hand-rolled stubs only. No sinon/jest mocks.

**Patterns:**
```javascript
// Stub global fetch by URL shape — testing/scrape-serve.test.mjs
globalThis.fetch = async (url) => {
  servedUrl = String(url);
  const id = servedUrl.endsWith("mdb_scrape_ogu4jkeo.json") ? SERIES_FIXTURE : null;
  return { ok: Boolean(id), status: id ? 200 : 404, json: async () => id ?? {} };
};
```

```javascript
// Fake KV matching real semantics — testing/save-config.test.mjs
function fakeKV(initial) {
  let data = initial === undefined ? null : JSON.parse(JSON.stringify(initial));
  return {
    get: async () => (data === null ? null : JSON.parse(JSON.stringify(data))),
    put: async (_k, v) => { data = JSON.parse(v); },
    dump: () => data,
  };
}
```

```javascript
// Capture GitHub dispatches, emulate 204 — testing/save-config.test.mjs
globalThis.fetch = async (url, init) => {
  const m = String(url).match(/actions\/workflows\/([^/]+)\/dispatches/);
  if (m && init?.method === "POST") {
    calls.push({ workflow: m[1], inputs: JSON.parse(init.body).inputs });
    return new Response(null, { status: 204 });
  }
  return realFetch(url, init);
};
```

```javascript
// jsdom page harness — testing/preview-excl-dom.test.mjs
import { JSDOM } from "jsdom";
import { buildConfigurePage } from "../src/configure.js";
const html = buildConfigurePage("https://example.workers.dev", { scraper: { lists: [] }, official: { lists: [] }, simkl: { lists: [] }, tmdb: { lists: [/* ... */] } });
const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.workers.dev" });
dom.window.fetch = () => Promise.resolve({ json: () => Promise.resolve({ items: ITEMS, truncated: false }) });
```

**What to Mock:**
- `globalThis.fetch` for Pages data files and GitHub dispatch endpoints — keeps `scrape-serve`, `save-config`, `dry-test` fully offline.
- `STORE` KV with the `fakeKV`/`makeKV` in-memory shim (`get(key, "json")` returns parsed clone, `put` stores string).
- `dom.window.fetch` for TMDB preview/search proxies in jsdom tests.

**What NOT to Mock:**
- The units under test themselves: tests import the real `src/routes.js`, `src/config.js` (`migrateConfig`, `sortItems` via `scripts/tmdb.mjs`, `buildDiscoverItems`, `buildConfigurePage`) so normalization and routing logic run for real.
- Live E2E (`testing/tmdb-exclude-e2e.mjs`) hits the real TMDB API deliberately to catch drift in baked ids.

## Fixtures and Factories

**Test Data:**
```javascript
// Factory with overrides — testing/save-config.test.mjs
const tmdbList = (over = {}) => ({
  discoverListId: "abcd1234", name: "TMDB One", mediaType: "movie",
  sort: "popularity_desc", enabled: true,
  includeModes: {}, includeGenres: [], excludeGenres: [],
  /* ... */
  ...over,
});
```

**Location:**
- Inline at the top of each test file. No shared `fixtures/` directory. `testing/dry-test.mjs` embeds `SEED_URL` (exact copy of `SEED_LISTS[0].url` from `src/config.js`) for healing tests.

## Coverage

**Requirements:** None enforced. No coverage tool, no threshold, no CI gate — CI (`.github/workflows/*.yml`) only runs generators, never `testing/`.

**View Coverage:**
- Not applicable. To audit manually: `node --experimental-test-coverage` is not wired up; rely on the per-file check lists.

## Test Types

**Unit Tests:**
- `testing/tmdb-sort.test.mjs`: `sortItems` across all five sort modes × movie/series, undated-drop rule, empty-string dates, plus worker preview-mirror parity via `handleTmdbPreviewDiscover` from `src/routes.js`.
- `testing/save-config.test.mjs`: save-config dispatch matrix (OFF→ON regen per module, scraper regressions) through real `handleSaveConfig` + `migrateConfig`.
- `testing/scrape-serve.test.mjs`: `handleCatalog` typing/releaseInfo regression (S1) through real route with stubbed fetch.

**Integration Tests:**
- `testing/dry-test.mjs`: every worker route against fake KV + stubbed GitHub API. Caveat: header says `scripts/dry-test.mjs` and its imports assume that layout — verify paths before running.
- `testing/tmdb-exclude-e2e.mjs`: real generator (`buildDiscoverItems` from `scripts/tmdb.mjs`) with live TMDB baseline; asserts removed-set equality and AND-mode warning denominator.
- `testing/network-picker-dom.test.mjs`: jsdom page driving the live dev server at `http://127.0.0.1:8787` (`wrangler dev` must be running).

**E2E Tests:**
- No Playwright/Cypress. Closest equivalents: the live-API probes (`testing/verify-tmdb.mjs`, `testing/networks-live.mjs`, `testing/undated-live.mjs`) and manual `testing/theme-preview.html` (open in browser).

## Common Patterns

**Async Testing:**
```javascript
// Top-level await is the norm — no async wrapper needed
const resp = await handleCatalog(env, "series", "mdb_scrape_ogu4jkeo", 0);
const body = await resp.json();
ok(body.metas.length === 2, `series fixture serves ${body.metas.length} metas`);
```

**Error Testing:**
- Unknown-id catalogs must return empty 200, not 404 (`testing/scrape-serve.test.mjs`):
```javascript
const resp = await handleCatalog(env, "movie", "mdb_scrape_unknown1", 0);
const body = await jsonOf(resp);
ok(Array.isArray(body.metas) && body.metas.length === 0, "unknown id still returns empty 200");
```
- jsdom tests assert zero page errors via a window error listener:
```javascript
const errors = [];
dom.window.addEventListener("error", (e) => errors.push(e.message));
// ... after interactions:
check("no JS errors", errors.length === 0);
```
- DOM timing uses explicit `wait`/`poll` helpers, never bare assumes:
```javascript
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(300); } return fn(); };
```

---

*Testing analysis: 2026-09-15*
