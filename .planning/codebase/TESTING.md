# Testing Patterns

**Analysis Date:** 2026-08-21

## Test Framework

**Runner:**
- None - plain Node scripts with `node:assert` (strict mode) and a hand-rolled `check()` helper. No jest/vitest/mocha.
- UI tests use `jsdom` (`runScripts: "dangerously"`) - **note: jsdom is imported by `scripts/verify-tmdb.mjs`, `scripts/verify-ui.mjs`, and `scripts/dry-test.mjs` but is NOT declared in `scripts/package.json`; it resolves from ambient installs.**

**Run Commands:**
```bash
node scripts/dry-test.mjs      # main suite: worker routes + config + script mains (~68 checks)
node scripts/verify-tmdb.mjs   # TMDB module self-checks (~34 checks incl. jsdom UI checks)
node scripts/verify-ui.mjs     # configure-page UI structure/behavior checks (~39 checks)
```
All three are gitignore-aware locals or committed files run manually; none wired into CI. `scripts/dry-test.mjs` and `scripts/verify-ui.mjs` are listed in `.gitignore` (local-only).

**Assertion Library:** `import { strict as assert } from "node:assert"` plus a boolean `check(name, ok)` reporter:

```javascript
// scripts/verify-tmdb.mjs:9
let fail = 0;
const check = (name, ok) => { console.log((ok ? "PASS" : "FAIL") + " " + name); if (!ok) fail++; };
// ...
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
```

Variant in `scripts/dry-test.mjs:71-74` wraps a throwing fn and sets `process.exitCode = 1` instead of exiting immediately.

## Test File Organization

**Location:** All in `scripts/`, sibling to the code they test (imports like `../src/config.js`). No `__tests__/` dirs, no `.test.`/`.spec.` suffixes.

**Naming:**
- `dry-test.mjs` - integration-style suite over worker + script modules
- `verify-<area>.mjs` - focused self-check suites

**Structure:**
```
scripts/
├── dry-test.mjs        # routes.js, config.js, dispatch, official/simkl/tmdb mains
├── verify-tmdb.mjs     # tmdb migration/hash/source-plan + configure UI
├── verify-ui.mjs       # configure page DOM structure + interactions
```

## Test Structure

**Suite organization:** Top-level `await`-friendly blocks grouped per module with section comments; no nested describe/it.

```javascript
// scripts/dry-test.mjs pattern
{
  const { kv, env } = await freshEnv();
  const man = await buildManifest(env);
  assert.equal(man.catalogs.length, 3 + 6 + 2);
  check("buildManifest lists 3 scraper + 6 official + 2 simkl catalogs", () => {});
}
```

**Patterns:**
- Arrange-Act-Assert inside each block; assertion messages used as documentation (`"config NOT persisted on dispatch failure"`)
- Each save scenario gets a FRESH KV/env (`freshEnv()`) because saves persist
- Regression tests named with their bug id/comment ("C2 fix", "#5", "H3") - e.g. `dry-test.mjs:560+` "API error path records failed run (C2 fix, no ReferenceError)"
- Exit-code hygiene around script calls that set `process.exitCode`: save/restore `const savedExit = process.exitCode; ... process.exitCode = savedExit;` (`dry-test.mjs:574-577`)
- Cache-busting dynamic import for scripts capturing env at module load: `await import("../scripts/official.mjs?t=1")` after setting `process.env.WORKER_ORIGIN` first (`dry-test.mjs:552-556`)

## Mocking

**Framework:** None - hand-built fakes injected via `main()` parameter defaults (see CONVENTIONS.md) or swapped globals.

**Fake KV (in-memory Workers KV):**
```javascript
// scripts/dry-test.mjs:21-28
function makeKV() {
  const m = new Map();
  return {
    get: async (k, t) => { const v = m.get(k); return t === "json" && v ? JSON.parse(v) : v ?? null; },
    put: async (k, v) => m.set(k, typeof v === "string" ? v : JSON.stringify(v)),
    _m: m,
  };
}
```

**Stub GitHub dispatch via a plain env object + global fetch swap:**
```javascript
// scripts/dry-test.mjs - the fake GH call recorder rides on the fake env;
// there is NO env.GH_FETCH seam in production code - dispatch.js always
// uses global fetch, so tests swap it:
env._ghCalls = [];

async function withFetch(fake, fn) {
  const og = global.fetch;
  global.fetch = fake;
  try { return await fn(); } finally { global.fetch = og; }
}
```
Every `withFetch` call restores the real fetch in `finally` - **always pair them**.

**Dependency injection over monkey-patching:** script tests pass fakes straight to `main()`:
```javascript
await off.main({ slugsArg: "popular", fetchConfig: async () => ["popular"], fetchApi: boom, recordRuns: async (runs) => { recorded.push(...runs); } });
```

**What to mock:** network boundaries only - GitHub API, GitHub Pages catalog fetch, worker `/export-config`, TMDB/SIMKL APIs, KV storage. Filesystem writes stay REAL where cheap (writeCatalog round-trips read back with `readFile` then `rm(f, { force: true })` cleanup, `dry-test.mjs:640-650`).

**What NOT to mock:** pure logic under test (`passesRatingTiers`, `precompute`, `computeSourceHash`, regexes) is called directly; no spies needed beyond simple push-capturing arrays.

**UI testing via jsdom:** build the real HTML string from `buildConfigurePage()`, load into JSDOM with scripts enabled, wait for timers, then drive exported globals:
```javascript
// scripts/verify-tmdb.mjs:78-88
const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });
dom.window.addEventListener("error", (e) => errors.push(e.message));
await new Promise((r) => setTimeout(r, 1200));   // let inline JS settle
dom.window.activateModule("tmdb");
```
XSS is tested through the render path: hostile names injected into config, assert `\\u003c/script>` escaping and `escapeAttr` usage survive (`dry-test.mjs:497-508`).

## Fixtures and Factories

**Test data:** inline object literals + tiny factory arrows:
```javascript
// scripts/dry-test.mjs:929-934
const meta = (id, over = {}) => ({ ids: { imdb: `tt${id}`, tmdb: id }, title: `Show ${id}`, poster: null,
  genres: [], country: "us",
  ratings: { imdb: { rating: 7.5, votes: 9000 }, simkl: { rating: 7.4, votes: 900 } }, ...over });
const e = (sid, season, episode, date, finaleType = null) => ({ simkl_id: sid, date, episode: { season, episode }, finale_type: finaleType });
```

**Location:** defined at point of use, no fixtures directory. The seed-list URL is duplicated verbatim into `dry-test.mjs:19` because healing matches URLs byte-for-byte - keep in sync with `SEED_LISTS` in `src/config.js`.

## Coverage

**Requirements:** None enforced (no tooling). De facto: every route handler, migrate function, hash function, filter helper, and each script's success/error/delete/empty paths has at least one check.

**View Coverage:** Not available - would require instrumenting with c8/nyc manually.

## Test Types

**Unit Tests:** pure helpers asserted directly (`matchesCountry`, `passesRatingTiers`, `simklPoster`, `CATALOG_RE`, content hashes, id normalizers).

**Integration Tests:** route handlers exercised with fake env/KV/Request objects end-to-end (`new Request("http://x/save-config", { method: "POST", ... })` then `JSON.parse(await res.text())`) - covers dispatch ordering, rollback-on-failure, runs key routing, status field shapes.

**E2E Tests:** Not used. Closest is verify-ui/jsdom driving the real configure page DOM including pointer-event rename flows.

## Common Patterns

**Async Testing:**
```javascript
// top-level await throughout .mjs files - no async wrapper needed
const s1 = await sim.precompute("series", [e(1, 1, 5, "2026-08-05T20:00:00Z"), ...], { 1: meta(1) }, tvFilter);
assert.match(s1[0].description, /🏁 Finale \(season\) \| S01E06/, "finale headline uses its own S/E");
```

**Error Testing:**
```javascript
// loud failure expected (dry-test.mjs:952-964)
let typoThrew = false;
try { await sim.main({ kindsArg: "serie", /* fakes... */ }); } catch { typoThrew = true; }
check("simkl: unknown --kinds throws instead of refreshing all", () => assert.equal(typoThrew, true));

// HTTP error shape asserted on Response objects
const res = await handleSaveConfig(envFail, new Request(...));
assert.equal(res.status, 502, "dispatch failure rejected");
const after = await loadConfig(kv);
assert.equal(after.scraper.lists[0].maxPages, 3, "config NOT persisted on dispatch failure");
```

**Writing a new test - follow this recipe:**
1. Add a block in the matching section of `scripts/dry-test.mjs` (worker/routes/config) or the right `verify-*.mjs`
2. Fresh `makeKV()`/`freshEnv()` per scenario; wrap any global.fetch swap in `withFetch`
3. Assert with messages, then register one `check("behavior description", fn)`
4. Clean up written files with `rm(f, { force: true })`; restore `process.exitCode` and env vars

---

*Testing analysis: 2026-08-21*
