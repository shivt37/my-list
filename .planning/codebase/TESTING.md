# Testing Patterns

**Analysis Date:** 2026-08-05

## Test Framework

**Runner:** Node.js built-in test runner NOT used. Tests are plain scripts executed directly with `node`.

**Assertion Library:** `node:assert` (strict mode):
```javascript
import { strict as assert } from "node:assert";
```

**No test framework:** No Jest, Vitest, Mocha, or any npm test runner. Tests are standalone `.mjs` files run via `node scripts/<test>.mjs`.

**Run Commands:**
```bash
node scripts/dry-test.mjs       # Integration tests for worker routes + config
node scripts/verify-ui.mjs      # Headless DOM check of /configure page
```

## Test File Organization

**Location:** `scripts/` directory, co-located with production scripts

**Naming:** Descriptive, action-oriented names: `dry-test.mjs`, `verify-ui.mjs`

**Gitignored:** Both test files are in `.gitignore` — they are local-only, not part of CI or deploy:
```
scripts/dry-test.mjs
scripts/verify-ui.mjs
```

**Structure:** Single-file tests, no separate test directories, no test runner config.

## Test Structure

### dry-test.mjs — Integration Tests

**Pattern:** Flat sequential blocks, each wrapped in a bare `{ ... }` block scope:

```javascript
// ── config.js ──
{
  const kv = makeKV();
  const cfg = await loadConfig(kv);
  assert.equal(cfg.scraper.lists.length, 3);
  check("loadConfig seeds 3 pinned lists on empty KV, persists", () => {});
}

// ── routes.js ──
{
  const { env } = await freshEnv();
  const man = await buildManifest(env);
  assert.equal(man.catalogs.length, 3 + 6);
  check("buildManifest lists 3 scraper + 6 official catalogs", () => {});
}
```

**Check function:** Simple pass/fail printer, sets `process.exitCode = 1` on failure:
```javascript
let n = 0;
function check(name, fn) {
  try { fn(); n++; console.log("PASS " + name); }
  catch (e) { console.log("FAIL " + name + " - " + e.message); process.exitCode = 1; }
}
```

**Test flow:**
1. Run assertions immediately (not inside `check` callback)
2. Call `check("description", () => {})` after assertions pass
3. If assertions throw, `check` is never reached — failure logged automatically

**Suite organization by module:**
- `config.js` tests: loadConfig seeding, content hashing, migration, run history cap
- `routes.js` tests: manifest building, save-config dispatch logic, trigger-refresh, catalog serving, status page, XSS escaping
- Official module tests: seeding, toggle persistence, slug validation, catalog IDs, run routing

### verify-ui.mjs — DOM Structure Tests

**Pattern:** Builds the configure page with JSDOM, runs checks against the rendered DOM:

```javascript
const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });
dom.window.addEventListener("error", (e) => errors.push(e.message));
await new Promise((r) => setTimeout(r, 1200));

check("no JS errors", errors.length === 0);
check("toolbar Status button exists", !!doc.querySelector(".scraper-toolbar .secondary"));
```

**Check function:** Same pattern as dry-test.mjs but `fail` counter instead of `process.exitCode`:
```javascript
let fail = 0;
const check = (name, ok) => {
  console.log((ok ? "PASS" : "FAIL") + " " + name);
  if (!ok) fail++;
};
process.exit(fail ? 1 : 0);
```

**Coverage:** Verifies scraper tab DOM structure, official tab rendering, handler function existence, menu/accent bindings.

## Mocking

**No mocking library.** All mocks are hand-rolled.

### Fake KV Store

```javascript
function makeKV() {
  const m = new Map();
  return {
    get: async (k, t) => { const v = m.get(k); return t === "json" && v ? JSON.parse(v) : v ?? null; },
    put: async (k, v) => m.set(k, typeof v === "string" ? v : JSON.stringify(v)),
    _m: m,
  };
}
```

### Fake Environment

```javascript
function makeEnv(kv) {
  const ghCalls = [];
  const env = {
    STORE: kv,
    GITHUB_PAGES_BASE: "https://stub.pages/base",
    GH_TOKEN: "tok", GH_REPO: "u/r", GH_WORKFLOW: "scrape.yml", GH_REF: "main",
    _ghCalls: ghCalls,
  };
  env.GH_FETCH = async (url, opts) => {
    ghCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    return { status: 204, text: async () => "" };
  };
  return env;
}
```

### Failing GH Dispatch Mock

```javascript
function makeEnvGHFail(kv) {
  // ... same as makeEnv but GH_FETCH returns { status: 401 }
}
```

### Global fetch Stub

```javascript
async function withFetch(fake, fn) {
  const og = global.fetch;
  global.fetch = fake;
  try { return await fn(); } finally { global.fetch = og; }
}
```

Used to stub `dispatchScraperWorkflow` which calls global `fetch`:
```javascript
const res = await withFetch(env.GH_FETCH, () => handleSaveConfig(env, ...));
```

Catalog data stubbed via direct `global.fetch` override:
```javascript
global.fetch = async (u) => ({
  ok: true,
  json: async () => ({ items: [{ imdb_id: "tt1", title: "A", ... }] })
});
```

**What to mock:**
- KV store (always — no real Cloudflare KV in tests)
- `global.fetch` when testing dispatch or catalog serving
- Environment bindings (`env.STORE`, `env.GH_TOKEN`, etc.)

**What NOT to mock:**
- Config migration logic (tested against real migration functions)
- Hash functions (`listContentHash`, `randomScraperId`)
- Response construction (`json()`, `html()`)

## Fixtures and Factories

**Test data:**
- Seed URL copied verbatim from `src/config.js` for healing tests:
  ```javascript
  const SEED_URL = "https://mdblist.com/movies/?q_title=&q_sort=releasedigital...";
  ```
- Fresh environment created per test block via `freshEnv()`:
  ```javascript
  async function freshEnv() {
    const k = makeKV();
    const e = makeEnv(k);
    await loadConfig(k);  // seed the 3 pinned lists
    return { kv: k, env: e };
  }
  ```
- No fixture files — all test data inline

**Location:** Fixtures defined at top of test file, before test blocks.

## Coverage

**Requirements:** None enforced. No coverage tool configured.

**Manual coverage assessment:** `dry-test.mjs` covers:
- `config.js`: loadConfig, saveConfig, migrateConfig, emptyConfig, randomScraperId, listContentHash, addRun, getRuns, runsKeyFor, seedScraperDefaults, officialDefaults, migrateOfficial
- `routes.js`: buildManifest, handleStatus, handleSaveConfig, handleExportConfig, handleTriggerRefresh, handleRunsPost, handleCatalog, CATALOG_RE, rowToMeta, rowToMetaOfficial
- `configure.js`: buildConfigurePage (XSS escaping)

**Not tested:**
- `src/index.js` fetch handler (thin router — tested indirectly via route handlers)
- `dispatch.js` (mocked in integration tests, not unit tested independently)
- `scripts/scrape.mjs` (requires headless Chromium, runs in CI only)
- `scripts/official.mjs` (requires MDBList API key, runs in CI only)

## Test Types

**Unit Tests:**
- Individual functions tested in isolation within `dry-test.mjs` blocks
- Config migration, hashing, seeding tested directly

**Integration Tests:**
- Full route handler flows: save-config → dispatch → persist
- Request/response cycle via `new Request(...)` construction
- Multiple routes composed in single test blocks (e.g., save → status → verify)

**E2E Tests:**
- `verify-ui.mjs` serves as a lightweight E2E for the configure page DOM
- Real CI tests run via GitHub Actions workflows (`scrape.yml`, `official.yml`)

**No browser E2E tests** (Playwright, Cypress, etc.)

## Common Patterns

### Request Construction

```javascript
const res = await handleSaveConfig(env, new Request("http://x/save-config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));
```

### Response Parsing

```javascript
const jsonOf = async (r) => JSON.parse(await r.text());
const d = await jsonOf(res);
assert.equal(d.ok, true);
```

### Assertion Patterns

```javascript
// Exact equality
assert.equal(cfg.scraper.lists.length, 3);

// Deep equality
assert.deepEqual(man.types, ["movie", "series"]);

// Truthy
assert.ok(kv._m.has("config"), "seed persisted");

// Regex match
assert.match(out[0].started_at_ist, /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2} (AM|PM)$/);

// Negative assertion
assert.notEqual(listContentHash(l0), listContentHash({ ...l0, maxPages: 5 }));

// Does not contain
assert.ok(!("id" in out[0]), "no internal run id");
```

### Test Naming Convention

Descriptive strings stating the expected behavior:
```javascript
check("save no-op: no dispatch", () => {});
check("save add: dispatches scrape for the added list only", () => {});
check("configure page escapes hostile name/url", () => {});
```

Format: `<scenario>: <expected behavior>`

---

*Testing analysis: 2026-08-05*
