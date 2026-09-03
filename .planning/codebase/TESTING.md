# TESTING.md — my-list (Cloudflare Worker Stremio addon)

**Analysis Date:** 2026-09-03

Full-repo scan of `testing/*.mjs` and `scratch/*.mjs`.

<!-- refreshed: 2026-09-03 -->

## Framework

**None.** Plain Node (22) + `node:assert` (strict mode) + `console` output.
No test runner, no jest/vitest/mocha, no coverage tool. Every suite is a
self-contained ESM script that:

- runs assertions via `assert` from `node:assert/strict`
  (`testing/save-config.test.mjs:9`, `testing/dry-test.mjs:6`),
- wraps checks in a local `check(name, fn)` / `ok(cond, label)` helper that
  prints `PASS`/`FAIL` (or `  ok:`) per check,
- sets `process.exitCode = 1` (or `process.exit(1)`) on failure and prints a
  final `ALL CHECKS PASSED` / `ALL PASS` / `FAILED` summary
  (`testing/dry-test.mjs:90-94, 1249`; `testing/save-config.test.mjs:425-438`;
  `testing/scrape-serve.test.mjs:65-66, 90-91`).

Async suites use top-level `await` (Node ESM). Async test tables collect
`[name, fn]` pairs into an array and loop them
(`testing/save-config.test.mjs:87-88, 425-435`).

Both `testing/` and `scratch/` are **gitignored** (`.gitignore:20`,
`.gitignore:5`): "local test scripts (not part of deploy or scrape)". They
still import the real `src/*.js` and `scripts/*.mjs` modules, so they run
against working-tree code only.

## Run commands

```
node testing/dry-test.mjs
node testing/save-config.test.mjs
node testing/scrape-serve.test.mjs
node testing/tmdb-sort.test.mjs
node testing/verify-ui.mjs          # needs jsdom
node testing/verify-tmdb.mjs        # needs jsdom
```

Playwright scratch checks (need `wrangler dev` running on
`http://127.0.0.1:8787` first): `node scratch/status-verify.mjs`, etc.

Stale-path note: several header comments still say
`Run: node scripts/dry-test.mjs` (`testing/dry-test.mjs:4`,
`testing/save-config.test.mjs:4`, `testing/verify-ui.mjs:3`,
`testing/verify-tmdb.mjs:3`) — files were moved to `testing/`; the commands
above are correct.

## Test inventory

| File | Lines | Scope | Deps |
|---|---|---|---|
| `testing/dry-test.mjs` | 1249 | Route-by-route integration of every module + scraper/official/simkl scripts | node stdlib only |
| `testing/save-config.test.mjs` | 438 | `handleSaveConfig` dispatch contract (official/tmdb/scraper/simkl regen, ordering, rollbacks) | node stdlib only |
| `testing/scrape-serve.test.mjs` | 91 | S1 regression: catalog typing + releaseInfo mapping | node stdlib only |
| `testing/tmdb-sort.test.mjs` | 116 | Undated-item sort rules in `scripts/tmdb.mjs` `sortItems` + preview-route mirror | node stdlib only |
| `testing/verify-ui.mjs` | 202 | Rendered /configure page DOM via JSDOM (~90 checks) | `jsdom` |
| `testing/verify-tmdb.mjs` | 108 | TMDB config migration, content hashes, generator source plan, UI glue | `jsdom` |
| `scratch/*.mjs` | various | Exploratory / per-finding verification (Playwright, fetch probes) | `playwright` |

## Harness patterns

### In-memory fake KV — `makeKV()` (`testing/dry-test.mjs:41-48`)

Map-backed stub with Workers KV semantics: `get(k, "json")` returns the
parsed value (or `null`), `put(k, v)` stores strings; `_m` exposes the raw
Map for seed-persistence assertions (`assert.ok(kv._m.has("config"))`).
Variants: `fakeKV(initial)` deep-clones a starting config and exposes
`dump()` for post-save persistence assertions
(`testing/save-config.test.mjs:27-34`); `scrape-serve.test.mjs` uses a
minimal two-method shim (`get` returns a stub config, `put` no-ops,
lines 48-61).

### Stubbed `global.fetch`

- **Dispatch capture** (`testing/save-config.test.mjs:16-25`): swaps
  `globalThis.fetch` with a stub that regex-matches
  `/actions\/workflows\/([^/]+)\/dispatches/`, records
  `{ workflow, inputs }` into a `calls` array, returns GitHub's `204`. A
  `byWf("official.yml")` filter drives per-workflow assertions. Restored in
  `finally` / at suite end (`testing/save-config.test.mjs:437`).
- **Scoped swap helper** `withFetch(fake, fn)` in `testing/dry-test.mjs:84-88`
  swaps `global.fetch` for one call and restores it in `finally` — used where
  `dispatch.js` reads the real global.
- **Failure injection**: `makeEnvGHFail` always returns 401 to assert the
  save-rejects path (`testing/dry-test.mjs:66-79`); per-workflow targeted
  failures swap fetch to throw only for a specific workflow + action
  (`testing/save-config.test.mjs:182-194, 384-393, 408-415`).
- **Fixtures by URL suffix** (`testing/scrape-serve.test.mjs:33-46`): fake
  fetch serves JSON fixtures keyed on the catalog filename; non-matching URLs
  404 to exercise the empty-catalog contract.
- **Fake env** `makeEnv(kv)` (`testing/dry-test.mjs:50-63`): sets
  `STORE`, `GITHUB_PAGES_BASE`, `GH_TOKEN/GH_REPO/GH_WORKFLOW/GH_REF`, and a
  `_ghCalls` array the fake fetch appends to.

### Real filesystem with a safety net (`testing/dry-test.mjs:18-36`)

The suite writes real catalog files (writeCatalog round-trips), which could
overwrite genuine files in `data/` (e.g. `mdboff_popular_movie.json`).
`snapshotFiles(paths)` records pre-existing bytes into `_preExisting` and
`safeRm(f)` deletes then **restores the original bytes** — running the suite
can never destroy real catalog data ("m14 safety net"). `SEED_URL`
(line 39) is a verbatim copy of `src/config.js` `SEED_LISTS[0].url` because
healing matches URLs exactly.

### In-browser DOM — JSDOM (`testing/verify-ui.mjs`, `testing/verify-tmdb.mjs`)

Renders the real `buildConfigurePage` output with
`new JSDOM(html, { runScripts: "dangerously", resources: "usable" })`,
attaches a window `error` listener, waits ~1200ms for inline scripts, then
asserts DOM structure and handler existence via
`doc.querySelector` / `w.someHandler` (function-source probes like
`w.openStatus.toString().includes("window.open")`). Covers all four module
tabs, rename flows, tier tables, timezone bar, accent picker.

### Real-browser checks — Playwright (`scratch/*.mjs`)

- `scratch/status-verify.mjs` (198 lines, ~43 browser checks): launches
  `chromium` via `playwright`, navigates `http://127.0.0.1:8787/status`,
  collects `pageerror`/console errors, verifies 4 tabs, header/row column
  alignment within ±2px, all 5 filter chips, 12h AM/PM format, relative
  time, accent sync, row expand, and a mobile 375px viewport.
- Other scratch scripts are per-finding verifications following audit IDs:
  `f12-tz-display-test.mjs`, `f13-f14-test.mjs`, `f16-f20-test.mjs`,
  `ui-f1-*.mjs`, `dim-sweep.mjs`, `click-sweep.mjs`, `look.mjs`,
  `interactive-spy.mjs`, `isolate-mutators.mjs`, `agent-review-*.mjs`,
  plus `sync-local-from-prod.mjs` (pulls prod KV via wrangler) and saved
  PNG screenshots as review evidence.

## Coverage shape

- **Every route in `src/index.js` has a dry-test block** in
  `testing/dry-test.mjs`, organized by `// ── section ──` banners:
  `config.js` (line 96: seeds, migrate/clamping, healing, run caps, orphan
  eviction), `routes.js` (line 198: manifest shape + skip extras, save
  no-op/add/delete/change, dispatch-order F2, GH-fail 502 + no persist,
  malformed body 400, `/runs` validation + 50-cap + prefix routing,
  `/status` IST + name mapping + `?page=` scoping, catalog mapping +
  unknown-id, `CATALOG_RE`, configure-page XSS escaping), official module
  (line 434), `scripts/official.mjs` (line 641), simkl module (line 762),
  `scripts/simkl.mjs` (line 1024: precompute, bulk-air range tails,
  writeCatalog rename/defaults, `--kinds` operator-filter wiring).
- TMDB routes have dedicated files: `testing/tmdb-sort.test.mjs` exercises
  `handleTmdbPreviewDiscover` end-to-end against a fake TMDB fetch
  (preview mirror), `testing/verify-tmdb.mjs` covers
  `migrateConfig`/`normalizeTmdbList`/`tmdbContentHash` and the generator's
  `buildDiscoverSources`/`computeSourceHash`.
- `testing/save-config.test.mjs` is the regression net for the
  save→dispatch contract: OFF→ON dispatch, ON→OFF silence, net-unchanged
  silence, joined multi-slug dispatch, rename-only silence, changed-vs-
  dispatched honesty, 502 rollback, F10 best-effort cleanup vs critical
  scraper-delete veto, F3A-1 `action: "delete"` pin.
- Auth (`src/auth.js`) has no dedicated suite; the gate and login/logout
  routes are verified in-browser via scratch scripts.
- `/tmdb/search-*` and `/mdblist/official-catalog` proxies rely on the
  preview-adjacent coverage + scratch verification, not a dedicated block.

## CI

**No CI test workflow.** `.github/workflows/` contains only data-refresh
pipelines — `scrape.yml`, `official.yml`, `simkl.yml`, `tmdb.yml` — each
with its own cron + `workflow_dispatch`, sharing the
`my-list-scrape` concurrency group (`queue: max`,
`cancel-in-progress: false`) so data-file commits and KV `/runs` posts
serialize. Tests never run in CI; suites are executed manually before
deploys. Workflow inputs (e.g. `config_version`) mirror the dispatch
contracts the tests pin.

## Conventions for adding tests here

- New route → add a block to `testing/dry-test.mjs` under a
  `// ── <module> ──` banner; reuse `makeKV()`/`makeEnv()`/`withFetch()` and
  the `check()` runner; snapshot any `data/` file the block touches via
  `snapshotFiles` + `safeRm`.
- New save-flow behavior → assert the *dispatches* (workflow + inputs), the
  response arrays, and persistence via `kv.dump()` in
  `testing/save-config.test.mjs`; fixtures must pass through
  `migrateConfig()` so stored/incoming shapes match (comment at
  `testing/save-config.test.mjs:45-62`).
- UI behavior → extend `testing/verify-ui.mjs` (JSDOM, no network); live
  polish/visual verification goes in a one-off `scratch/*.mjs` Playwright
  script against local `wrangler dev` on 127.0.0.1:8787.

---
*Covers `testing/`, `scratch/`, `.github/workflows/` — analysis: 2026-09-03.*
