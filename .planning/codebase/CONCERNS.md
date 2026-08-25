# Codebase Concerns

**Analysis Date:** 2026-08-25

Companion context: `.planning/codebase/FUNCTIONAL-AUDIT.md` (2026-08-23 audit). Its Moderate fixes M1–M4 and minors m2/m3/m13/m14 are **verified applied** in current code (eye-button gating at `src/configure.js:977`, `process.exitCode=1` at `scripts/tmdb.mjs:436-440`, per-record isolation at `src/routes.js:562-581`, `AbortSignal.timeout` on TMDB/GH fetches at `src/routes.js:606` and `src/dispatch.js:36`). Findings below reflect the repo as it stands today.

## Tech Debt

**Broken regression suite: `testing/dry-test.mjs` cannot run at all**
- Issue: imports `OFFICIAL_CATALOGS` from `../src/config.js`, but that export was removed when dynamic official lists shipped (commit e60e07f replaced the frozen constant with `officialCatalogsFor()`). Module resolution throws `SyntaxError: does not provide an export named 'OFFICIAL_CATALOGS'` before any test executes. Assertions at `testing/dry-test.mjs:422-426` also assert the removed constant's shape.
- Files: `testing/dry-test.mjs` (lines 9-11, 422-426), `src/config.js`
- Impact: the largest integration suite (1191 lines covering save-dispatch ordering, runs routing, status shapes, hash gating) is dead. Regressions in `src/config.js`/`src/routes.js` ship undetected.
- Fix approach: swap `OFFICIAL_CATALOGS` for `officialCatalogsFor(officialDefaults())` in the import and assertions; re-run.

**Stale regression suite: `testing/verify-ui.mjs` crashes mid-run**
- Issue: asserts markup/handlers that no longer exist — `.card-controls`, `.create-list-section`, `.info`, `.card-top`, `w.askOfficialRefresh`, `w.askSimklRefresh`. Current markup uses `.card-head`/`.card-body`/`.name-wrap`; refresh handlers were unified into `askSingleRefresh`. Throws `TypeError: Cannot read properties of null` at `testing/verify-ui.mjs:57`.
- Files: `testing/verify-ui.mjs`, `src/configure.js`
- Impact: UI smoke coverage (rename flows, tab rendering, card structure) lost even where jsdom is installed.
- Fix approach: rewrite selectors/handler names against the current DOM contract, or retire it in favor of the Playwright harnesses in `.audit/` (`r*-verify.cjs`).

**Entire local test suite is gitignored**
- Issue: `.gitignore` excludes `testing/` wholesale. A fresh clone ships only `testing/verify-tmdb.mjs` (also gitignored — actually nothing under testing/ is tracked). Header comments still say "Run: node scripts/dry-test.mjs" (stale path).
- Files: `.gitignore`, `testing/`
- Impact: no CI, no fresh-machine verification; the suites exist on one machine only. FUNCTIONAL-AUDIT m8/m9 remain open.
- Fix approach: un-ignore `testing/`, declare `jsdom` (needed by `testing/verify-ui.mjs`, `testing/verify-tmdb.mjs`) in a package.json, optionally run suites in a GitHub workflow.

**Dead exports kept alive only by a broken test**
- Issue: `emptyConfig()` (`src/config.js:60`) and `randomTmdbListId()` (`src/config.js:39`) have zero production callers. `emptyConfig` is imported (unused) by the currently-unrunnable `testing/dry-test.mjs:9`.
- Files: `src/config.js`, `testing/dry-test.mjs`
- Impact: misleading API surface; blocks clean removal until dry-test is fixed.
- Fix approach: delete both plus the dry-test import once the suite is repaired.

**`src/configure.js` is a 2057-line monolith**
- Issue: entire admin UI — reset CSS (~600 lines), four tab renderers, ~74 inline browser functions, dialogs — lives in one exported template-literal string. All inter-element communication goes through inline `onclick="..."` attributes with nested escape layers (`escapeAttr`, `escapeForOnclick`, `\\\''` quoting inside a template literal).
- Files: `src/configure.js`
- Impact: any edit risks breaking the escaping choreography; no syntax highlighting/linting of the embedded JS; index-based card identity (`#ocard-${i}`, `pendingDeleteIndex`) breaks silently if render order changes.
- Fix approach: incremental — extract the CSS block and the pure-JS runtime into separate files served alongside, or accept as-is for a single-operator admin page (current implicit choice). Note the deferred R7/R8/R9/R10 UX roadmap in `UI-AUDIT.md` will all land in this file.

**Duplicated logic that must stay mirrored by hand**
- Issue: three deliberate cross-file mirrors with no mechanical enforcement:
  1. Simkl default filters: `SIMKL_LISTS` (`src/config.js:71-105`) vs `DEFAULT_FILTERS` (`scripts/simkl.mjs:60-84`) — byte-identical copies.
  2. TMDB content hash: `tmdbContentHash()` (`src/config.js:359-383`) vs `computeSourceHash()` (`scripts/tmdb.mjs`) — same field set, stamped onto data files.
  3. TMDB discover source-plan/sort: `handleTmdbPreviewDiscover` + `sortPreviewItems` (`src/routes.js:650-768`) vs `buildDiscoverSources`/`sortItems` (`scripts/tmdb.mjs`) — preview must match generated output.
  Client-side id derivation `randomId()` (`src/configure.js:1122`) must also match `randomScraperId()` (`src/config.js:50`).
- Files: `src/config.js`, `src/routes.js`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`, `src/configure.js`
- Impact: a change to one side silently diverges preview-from-output or breaks change detection (missed or spurious regenerations).
- Fix approach: shared module imported by both worker and scripts (worker bundles via `nodejs_compat`; scripts run plain Node ESM) — feasible but touches deploy packaging; otherwise keep the existing loud comments as the guard.

**Error swallowing hides root causes on save**
- Issue: `handleSaveConfig`'s outer catch returns a bare `{ error: "Save failed." }` (`src/routes.js:428-430`) with no detail and no server log, unlike every other handler which surfaces reasons.
- Files: `src/routes.js`
- Impact: a malformed body passing shape-validation but throwing in migration is undiagnosable from the UI.
- Fix approach: include `e.message` (sanitized) like `handleTmdbPreviewDiscover` does at `src/routes.js:766`.

## Known Bugs

**Public catalog fetch has no timeout (regression vs stated convention)**
- Symptoms: `handleCatalog` fetches GitHub Pages JSON with no `AbortSignal.timeout` (`src/routes.js:184`). Every other outbound worker fetch carries one (M4 fixed TMDB + GH dispatch but missed this — the hottest path).
- Files: `src/routes.js:184`
- Trigger: a hung/unresponsive Pages or intermediate connection stalls the Stremio-facing request until the platform kills it, instead of returning the graceful `{ metas: [] }` fallback at line 188.
- Workaround: none at runtime; platform request limit eventually fires.
- Fix approach: add `signal: AbortSignal.timeout(15000)` matching `scripts/*` conventions.

**Duplicate scraper URLs collide onto one catalog id**
- Symptoms: `confirmCreateList` (`src/configure.js:1044-1067`) guards duplicate *names* only. Two lists sharing the same mdblist URL derive the same pinned id via `randomScraperId`/`randomId` (sha256 of URL), so both cards write/read the same `data/<id>.json` and appear twice in the manifest.
- Files: `src/configure.js:1122-1132`, `src/config.js:50-58`
- Trigger: paste the same listing URL into two differently-named lists.
- Workaround: operator discipline.
- Fix approach: one-line URL-duplicate guard next to the name-clash check.

## Security Considerations

**Unauthenticated admin/control surface (owner-closed decision — recorded, not reopened)**
- Risk: `/save-config`, `/trigger-refresh`, `/export-config`, `/runs`, `/tmdb/search-*`, `/tmdb/preview-discover`, `/mdblist/official-catalog` accept anonymous traffic; every response sends `Access-Control-Allow-Origin: *` (`src/index.js:9-12`, `src/routes.js:19-22`). Anyone learning the workers.dev URL can rewrite config, fire paid GitHub Actions runs, read the full config, forge status-page history (`POST /runs`, `src/routes.js:552`), or burn TMDB API quota through the preview fan-out (up to 25 pages × N sources per call, `src/routes.js:720-737`).
- Files: `src/index.js`, `src/routes.js`
- Current mitigation: none (deliberate). FUNCTIONAL-AUDIT §6.4 records this as accepted for a private single-operator addon.
- Recommendations: if posture ever changes, a single shared-secret header checked in `src/index.js` before routing covers all mutating endpoints with ~5 lines; leave catalog serving public.

**API keys travel in URL query strings**
- Risk: `?apikey=` to MDBList (`src/routes.js:795`, `scripts/official.mjs:94`) and `client_id` to SIMKL (`scripts/simkl.mjs:48-55`) end up in any upstream/proxy access logs. This is how the vendor APIs work; exposure is limited to key-scoped read access.
- Files: `src/routes.js`, `scripts/official.mjs`, `scripts/simkl.mjs`
- Current mitigation: keys live only in Cloudflare/GitHub secrets (`.dev.vars` exists locally, contents never committed); error bodies proxied to the client are truncated to 200 chars (`src/routes.js:610`).
- Recommendations: none practical while vendors require query-param keys.

**Inline-script CSP relies on `'unsafe-inline'`**
- Risk: the configure page's CSP (`src/routes.js:36`) permits inline scripts/styles because the whole app is one inline blob. The `<`-escaping of the injected state blob (`src/configure.js:9`, `:728`) is correct, and user strings pass through `escapeAttr`/`escapeForOnclick`, but the pattern means any future unescaped interpolation is instantly script injection.
- Files: `src/routes.js:36`, `src/configure.js`
- Current mitigation: careful escaping helpers; `frame-ancestors 'none'`, `object-src 'none'`.
- Recommendations: keep all list-name/slug interpolations routed through the two escape helpers; never interpolate raw values into `onclick` payloads.

**Dev stub flag is a prod foot-gun**
- Risk: `GH_DISPATCH_STUB` makes every dispatch report success without firing (`src/dispatch.js:14-17`). Set on production, saves would "succeed" while catalogs silently never regenerate.
- Files: `src/dispatch.js`, `.dev.vars` (existence noted only)
- Current mitigation: comment warns "never set on production"; stub responses carry `stubbed: true`.
- Recommendations: acceptable; optionally have `buildConfigurePage` badge the UI when the stub is active.

## Performance Bottlenecks

**No caching on the catalog-serving hot path**
- Problem: every Stremio catalog request re-fetches the full Pages JSON (`src/routes.js:184`) and re-reads+migrates config from KV (`loadConfig` at `src/routes.js:170`). Pretty-printed data files (`JSON.stringify(out, null, 2)` in all four `scripts/*.mjs` writers) inflate transfer size ~2x.
- Files: `src/routes.js:169-194`, `scripts/scrape.mjs` (`writeCatalog`), `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`
- Cause: simplicity-first design; Workers KV read is cheap but the Pages round-trip dominates latency on page-turns.
- Improvement path: `caches.default` with a short TTL on the Pages fetch, and minified JSON output in the generators. Both are behavior tradeoffs (staleness window) the owner declined to pick during the audit (m5) — revisit if Stremio latency matters.

**TMDB preview endpoint fan-out**
- Problem: one preview click can issue dozens of sequential TMDB rounds (25 pages × up to 3 OR-sources, plus collection lookups), each bounded at 30s (`src/routes.js:720-737`). Unauthenticated (see Security).
- Files: `src/routes.js:666-768`
- Cause: faithful port of the old worker's preview semantics.
- Improvement path: lower `PREVIEW_PAGES`, or cache previews per content-hash in KV like `handleMdblistOfficialCatalog` already does (`src/routes.js:775-809` — good in-repo pattern to copy).

## Fragile Areas

**Save-config diff + dispatch orchestration (`handleSaveConfig`)**
- Files: `src/routes.js:235-431`
- Why fragile: one 190-line function hand-rolls change detection for four modules (scraper by `listContentHash`, simkl by JSON.stringify compare, TMDB by hash + strict enable-toggle, official by slug set arithmetic), then sequences up to five dispatches whose order encodes destructiveness (scraper last, deliberately — see comment block at `src/routes.js:327-334`). There is also a TOCTOU window: dispatches fire *before* `saveConfig` persists (`src/routes.js:397`), so a workflow runner starting unusually fast could read the pre-save config from `/export-config` and (for officials) drop the just-added slug at the intersect guard (`scripts/official.mjs:214`). In practice the KV write lands in milliseconds while runners take seconds, and the failure mode is a missed regeneration, never corruption.
- Safe modification: preserve dispatch-before-persist ordering and the destructive-last rule; extend `testing/save-config.test.mjs` (currently the only green suite covering this path) before touching the diff logic.
- Test coverage: good — `testing/save-config.test.mjs` (387 lines, ALL PASS) covers regen-on-enable, cleanup dispatches, cap enforcement.

**DOM scraping choreography (`scripts/scrape.mjs`)**
- Files: `scripts/scrape.mjs:144-336`
- Why fragile: depends on mdblist.com's exact DOM (`.search-results-list > .card`, `.header.movie-title`, `a[href^="/movie/"]`...) and on bot-detection mood (warm-up homepage visit, randomized scrolls, UA spoofing). Any upstream redesign or stricter challenge breaks scrapes overnight with no code change on our side.
- Safe modification: keep the warm-up dance intact; use `--debug` artifacts (uploaded by `scrape.yml` on failure) to re-derive selectors.
- Test coverage: none possible offline; run records on `/status?page=` are the tripwire. Empty-result guard (`scripts/scrape.mjs:344`) prevents bad scrapes from clobbering good data.

**Index-keyed UI state (`src/configure.js`)**
- Why fragile: cards address state by array index (`toggleList(i)`, `pendingDeleteIndex`, `#ocard-${i}`); the rename blur/pointerdown commit already needed a guard for module-switch-with-rename-open (`src/configure.js:993-1002`) and an outside-click capture handler (`src/configure.js:1021-1027`). New per-card controls must repeat the module-dispatch ternaries seen throughout.
- Safe modification: always re-query the DOM after `rerenderActive()` (innerHTML swap replaces every node — see note at `testing/verify-ui.mjs:135`).

**GitHub Actions serialization contract**
- Files: `.github/workflows/*.yml` (all four)
- Why fragile: correctness of `addRun`'s read-modify-write and of data commits rests on the shared concurrency group `my-list-scrape` + the `queue: max` feature (2026-05). If GitHub drops/renames `queue: max`, simultaneous crons cancel pending runs (missed refreshes, self-healing next cron). Documented in-workflow and in `src/config.js:472-477`.
- Safe modification: never split the concurrency group without first fixing the M5 race below.

## Scaling Limits

**Run history: KV read-modify-write race (M5 — reproduced, acceptance documented)**
- Current capacity: 30 records per module (`RUNS_MAX`, `src/config.js:14`), 50 per POST batch (`src/routes.js:558`).
- Limit: two truly concurrent `POST /runs` interleave get+put and lose one writer's records (`addRun`, `src/config.js:479-492`). Reproduced deterministically during the 2026-08-23 audit; accepted because the shared Actions concurrency group serializes all legitimate writers. Worst case: a missing diagnostics row.
- Scaling path: unique-key-per-post + capped merge-on-read if the concurrency group ever loosens; Workers KV has no CAS primitive, so cheap fixes don't exist.

**Official lists cap**
- Current capacity: `MAX_OFFICIAL_LISTS = 20` (`src/config.js:142`), enforced server-side in `migrateOfficial` (`src/config.js:204-220`).
- Limit: entries past the cap are dropped *silently* on save — the picker UI (`addOfficial`, `src/configure.js:1216-1224`) doesn't check the cap, so list #21 vanishes without feedback.
- Scaling path: surface a count/warning in the picker; raise the cap consciously (each active slug costs 2 API pulls × 2 cron runs/day).

**Workflow queue depth**
- Limit: `queue: max` holds 100 pending runs per group; beyond that arrivals are canceled. Irrelevant at current volume (4 workflows × ≤2 crons/day + manual saves).

## Dependencies at Risk

**puppeteer-extra 3.3.6 (+ stealth plugin 2.11.2)**
- Risk: predates Puppeteer v25 (`scripts/package.json` pins `puppeteer ^25.3.0`); upstream hasn't declared v25 support. A puppeteer minor bump could silently break the stealth wrapper and thus the entire scraper (bot detection returns).
- Impact: `scripts/scrape.mjs` produces nothing; other modules unaffected.
- Migration plan: pin puppeteer exactly; test one minor bump manually via a dispatched debug run before letting `^` float. Watch item from FUNCTIONAL-AUDIT m10.

**jsdom (undeclared)**
- Risk: required by `testing/verify-tmdb.mjs` / `testing/verify-ui.mjs` but declared in no manifest (no root package.json; `scripts/package.json` has only puppeteer deps). Works on this machine only because it was installed ad hoc during the audit.
- Impact: test suites fail on any fresh checkout.
- Migration plan: fold into the "un-ignore testing/" fix above.

Otherwise: zero runtime dependencies in the Worker (platform-provided APIs only — `src/` imports nothing external), which is a deliberate strength.

## Missing Critical Features

**CI never runs the tests**
- Problem: all four `.github/workflows/*.yml` are data pipelines; no workflow lints or tests `src/`. Combined with the gitignored/broken suites, nothing verifies changes between "works on my machine" and production.
- Blocks: confident refactoring of `src/config.js`/`src/routes.js` (the highest-churn files).

**Deferred UX state contract (R7) and motion pass (R8)** — tracked in `UI-AUDIT.md`; skeletons/regional retry/field validation agreed but not scheduled. Not blocking; listed so planners know the roadmap lives there, not in code TODOs (the codebase contains zero TODO/FIXME/HACK markers).

## Test Coverage Gaps

**`testing/dry-test.mjs` + `testing/verify-ui.mjs` non-functional** — see Tech Debt above. Everything they covered is currently unprotected.

**Preview/generator parity untested**
- What's not tested: that `handleTmdbPreviewDiscover`'s source-plan and sort (`src/routes.js:650-768`) produce the same ordering/filtering as `scripts/tmdb.mjs` `buildDiscoverItems` — the invariant the preview promises the operator.
- Files: `src/routes.js`, `scripts/tmdb.mjs`
- Risk: silent divergence — preview shows X, catalog serves Y.
- Priority: Medium (one fixture-driven assert comparing both paths on a canned TMDB response would pin it).

**`/mdblist/official-catalog` proxy untested**
- What's not tested: cache hit/miss, TTL expiry, configured-slug exclusion, non-array upstream shape handling (`src/routes.js:778-823`).
- Files: `src/routes.js`
- Risk: Low (small, defensive); a fake-KV unit test is ~30 lines.
- Priority: Low-Medium.

**Configure-page escaping untested after verify-ui broke**
- What's not tested: that adversarial list names survive `escapeAttr`/`escapeForOnclick`/state-blob embedding round-trips.
- Files: `src/configure.js`
- Risk: XSS regression would be invisible until exploited.
- Priority: Medium — restore with the verify-ui rewrite.

---

*Concerns audit: 2026-08-25*
