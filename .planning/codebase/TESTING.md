# Testing Patterns

**Analysis Date:** 2026-08-25

## Test Framework

**Runner:**
- **None.** No test framework, no test runner config, no `npm test` script. Tests are plain Node scripts using only built-ins:
  - `node:assert/strict` for assertions
  - Hand-rolled pass/fail runners with `console.log` output and `process.exit(failed ? 1 : 0)`
  - `jsdom` (installed in root `node_modules/`, untracked) for browser-side UI verification
- Run scripts directly: `node testing/<file>.mjs`

**Assertion Library:** `node:assert` (`strict as assert` in `testing/dry-test.mjs:6`, `node:assert/strict` default import in `testing/save-config.test.mjs:9`)

**Run Commands:**
```bash
node testing/save-config.test.mjs   # save-diff + dispatch behavior (24 tests)
node testing/dry-test.mjs           # dry-run integration suite (68 checks, all routes)
node testing/verify-tmdb.mjs        # TMDB module: migration, hashing, source plan, UI
node testing/verify-ui.mjs          # /configure page DOM checks via jsdom
```
No CI runs these — they are run manually before commits. There are no GitHub Actions test jobs.

## Test File Organization

**Location:** All tests live in `testing/`, which is **gitignored** (`.gitignore`: "local test scripts (not part of deploy or scrape)"). Tests are local-only safety nets; they never ship or run in CI.

**Naming:**
- `*-test.mjs` — focused behavioral suite (`save-config.test.mjs`)
- `dry-test.mjs` — the big integration sweep
- `verify-<area>.mjs` — feature self-checks (`verify-tmdb.mjs`, `verify-ui.mjs`)

**Structure:** Each file is standalone and dependency-free except jsdom where needed. Header comment states scope and run command.

## Test Structure

**Suite organization — two runner styles coexist:**

Style A (save-config.test.mjs): registered tests array executed at bottom:
```js
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("official OFF->ON dispatches official.yml with the slug", async () => { ... });

// runner
let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok:", name); }
  catch (e) { failed++; console.error("FAIL:", name, "\n      ", e.message); }
}
process.exit(failed ? 1 : 0);
```

Style B (dry-test.mjs): inline assertion blocks followed by a named `check()`:
```js
{
  const kv = makeKV();
  const cfg = await loadConfig(kv);
  assert.equal(cfg.scraper.lists.length, 3);
  check("loadConfig seeds 3 pinned lists on empty KV, persists", () => {});
}
```
Assertions run immediately (failures throw); `check()` records the pass/fail label and sets exit code. Use Style A for new suites — it isolates failures per test.

**Patterns:**
- Fresh fake KV per scenario ("each save persists" — `testing/dry-test.mjs:156-163`); never share KV state across cases
- Fixtures normalized through production code first so stored/incoming shapes match exactly (`baseConfig = () => migrateConfig(RAW_BASE())` — `testing/save-config.test.mjs:62`)
- `try/finally` to restore swapped globals

## Mocking

**Framework:** None — hand-rolled fakes of the two seams that exist:

**Pattern 1 — fake KV (Workers binding):**
```js
function fakeKV(initial) {
  let data = initial === undefined ? null : JSON.parse(JSON.stringify(initial));
  return {
    get: async () => (data === null ? null : JSON.parse(JSON.stringify(data))),
    put: async (_k, v) => { data = JSON.parse(v); },
    dump: () => data,
  };
}
// testing/save-config.test.mjs:27-34
```

**Pattern 2 — swap `globalThis.fetch` to capture dispatches / stub HTTP:**
```js
globalThis.fetch = async (url, init) => {
  const m = String(url).match(/actions\/workflows\/([^/]+)\/dispatches/);
  if (m && init?.method === "POST") {
    calls.push({ workflow: m[1], inputs: JSON.parse(init.body).inputs });
    return new Response(null, { status: 204 });   // GitHub's accept response
  }
  return realFetch(url, init);                     // pass everything else through
};
// restore in finally / at exit: globalThis.fetch = realFetch;
```
`dry-test.mjs` wraps this in `withFetch(fake, fn)` with try/finally (`testing/dry-test.mjs:84-88`) and builds env objects carrying an `env.GH_FETCH` fake plus `_ghCalls` recorder (`makeEnv`, `testing/dry-test.mjs:50-63`). A failure-mode twin (`makeEnvGHFail`, 401 always) drives the save-rejects path.

**What to mock:**
- Cloudflare KV binding (`env.STORE`)
- `fetch` to GitHub dispatches API (assert exact workflow file names and `inputs` payloads)
- Script collaborators injected via `main({...})` DI params (`fetchConfig`, `fetchApi`, `write`, `recordRuns`)
- jsdom for the configure page (runScripts dangerously, wait ~1200ms for inline JS, capture `window.onerror`)

**What NOT to mock:**
- The module under test's own logic — call real `handleSaveConfig`, `loadConfig`, `migrateConfig`, script `main()`s directly
- `Request`/`Response` — Workers runtimes provide them natively in Node; construct real ones (`new Request("http://worker.test/save-config", {...})`)

## Fixtures and Factories

**Test Data:** Inline factory functions with spread overrides, not fixture files:
```js
const RAW_BASE = () => ({ scraper: { lists: [ ... ] }, official: { lists: [...] }, simkl: {...}, tmdb: { lists: [] } });
const tmdbList = (over = {}) => ({ discoverListId: "abcd1234", mediaType: "movie", sort: "popularity_desc", ..., ...over });
// testing/save-config.test.mjs:45-78
```
Fixtures must respect documented invariants (e.g., official/simkl sections carry exactly their known slug counts, or `loadConfig` wholesale-replaces them — noted at `testing/save-config.test.mjs:50-57`).

**Location:** Top of each test file. No shared fixtures directory.

## Coverage

**Requirements:** None enforced (no tooling). In practice the save/dispatch diff engine is heavily covered — every change branch has a positive, negative, ordering, and regression test. Match that bar when extending `handleSaveConfig`.

## Test Types

**Unit Tests:** Pure-function checks inside the larger files (hash stability/rename-exclusion, tier filtering truth tables, URL pagination building).

**Integration Tests:** Full route handlers against fake KV + stubbed fetch — request in, assert status + parsed JSON body + captured dispatch calls + final KV state (`kv.dump()`, e.g. persist-skipped-on-dispatch-failure at `testing/save-config.test.mjs:179-195`).

**E2E Tests:** Not used. Closest analogues:
- `verify-ui.mjs`: renders the real built page in jsdom, exercises handlers (rename flows, tab switching), asserts DOM structure
- Manual browser verification noted in commit messages ("verified via node suite + 5-scenario browser check")

## Data-Safety Rules in Tests

Because suites touch the REAL `data/*.json` catalog filenames, `dry-test.mjs` snapshots any pre-existing file before a write and restores original bytes after cleanup deletes (`snapshotFiles`/`safeRm`, `testing/dry-test.mjs:22-36`). Any new test writing into `data/` must use these helpers — never let a test destroy committed catalog data.

## Common Patterns

**Error-path testing:**
```js
test("official dispatch failure rejects save AND skips persist", async () => {
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  try {
    const { status, json } = await save(kv, b);
    assert.equal(status, 502);
    assert.match(json.error, /official dispatch failed/);
    assert.equal(kv.dump().official.lists[2].enabled, false, "persist skipped on failure");
  } finally { globalThis.fetch = real; }
});
```

**Dispatch-ordering assertions:** capture calls array, assert index order across workflows (official before destructive scraper — `testing/save-config.test.mjs:257-266`).

**Regression labeling:** tests whose name ends "(regression)" pin previously-fixed behavior; keep them passing verbatim.

**Async UI testing (jsdom):**
```js
dom.window.activateModule("tmdb");
await new Promise((r) => setTimeout(r, 50));   // let re-render settle
check("UI: renderTmdb renders card", !!doc.getElementById("tcard-0"));
```
Re-query DOM after each action — every edit re-renders via innerHTML, so node references go stale (`testing/verify-ui.mjs:134-136`).

---

*Testing analysis: 2026-08-25*
