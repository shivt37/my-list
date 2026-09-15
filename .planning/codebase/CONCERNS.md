# Codebase Concerns

**Analysis Date:** 2026-09-15

Single-operator Stremio addon: Cloudflare Worker (`src/`) + four GitHub Actions pipelines (`scripts/*.mjs`, `.github/workflows/*.yml`) + committed JSON data (`data/`). Most audit findings (Phase 1 + Phase 2 under `audit/report/`) are fixed; the open items below are owner-skipped decisions plus structural risks that survive.

## Tech Debt

**Monolithic admin SPA (`src/configure.js`, 2672 lines):**
- Issue: entire `/configure` UI is one template literal + inline script. No imports, no modules, palette duplicated in `src/status.js` (`ACCENT_COLORS` mirror, must be kept in sync by hand).
- Files: `src/configure.js`, `src/status.js`
- Impact: every UI change touches a giant string; escaping bugs (`escapeAttr`, `escapeForOnclick`) handled ad hoc; hard to test (DOM tests live outside in `testing/*.test.mjs` against string output).
- Fix approach: split into importable JS modules served as static assets, or at minimum extract shared palette/escape helpers into one module imported by both files.

**`src/routes.js` god-module (1114 lines, owns everything):**
- Issue: manifest, catalog proxy, save/refresh, runs ingest, TMDB proxies, MDBList proxy all in one file.
- Files: `src/routes.js`
- Impact: save-config dispatch sequence already needed multi-paragraph ordering comments (F2/F3A-1 history); next module addition repeats the risk.
- Fix approach: split by concern (`manifest.js`, `catalog.js`, `admin.js`, `tmdb.js`, `runs.js`); keep `routes.js` as thin re-export until callers migrate.

**Config read-modify-write has no lock:**
- Issue: concurrent `POST /save-config` calls clobber each other. Acknowledged in-code as accepted for single operator (`src/routes.js:260-261`).
- Files: `src/routes.js`, `src/config.js` (`saveConfig`, `addRuns`)
- Impact: two browser tabs saving at once loses one save; concurrent workflow `addRuns` writes can lose run records (workflows serialize via `concurrency: group: my-list-scrape` as mitigation).
- Fix approach: keep single-operator assumption; if multi-user ever needed, add KV optimistic concurrency (version check + retry).

**Healing/migration one-shot logic in hot path:**
- Issue: `loadConfig` in `src/config.js` seeds defaults, migrates, heals seed IDs, stamps `configVersion` on every read, and conditionally writes back. Correct but subtle; already caused one prod surprise (F8: one-shot healing rewrote prod scraper IDs on first load).
- Files: `src/config.js` (`loadConfig`, `seedScraperDefaults`, `migrateConfig`)
- Impact: future seed/migration edits risk repeating F8-style silent rewrites.
- Fix approach: freeze healing behind the existing `healed` KV flag; add a regression test asserting stable IDs across `loadConfig` round-trips (partially covered in `testing/save-config.test.mjs` — extend it).

**Deprecated transitive dependencies in scraper bundle:**
- Issue: `scripts/package-lock.json` carries deprecated `glob` (known CVEs per its own deprecation notice), `domexception`, `rimraf<4` via the puppeteer tree.
- Files: `scripts/package.json`, `scripts/package-lock.json`
- Impact: supply-chain noise; `npm install` warnings; no direct exploit path in CI-only code.
- Fix approach: bump `puppeteer`/`puppeteer-extra` major lines when convenient; no action needed otherwise (scripts never run in prod).

## Known Bugs

**Owner-skipped audit findings (accepted, still present by decision):**
- F4 — `POST /runs` is a public, login-free write surface. Sanitized + capped (50/batch, 30 history per module, per-record isolation in `src/routes.js:642-698`), so damage is bounded to fake run history. Files: `src/routes.js` (`handleRunsPost`). Revisit if `/status` ever shows unrecognized records; fix is a shared-secret header on scripts + workflows.
- F15 — legitimately-empty TMDB result records a `failed` run and keeps serving stale data. Files: `scripts/tmdb.mjs` (`finalize`, empty-result path). Revisit if a narrowed list "won't take effect."
- F11 — empty catalog vs fetch failure both serve `{ metas: [] }`; a Pages hiccup looks like deleted data. Files: `src/routes.js` (`handleCatalog`). Fix is stale-if-error cache; skipped.
- F9 — scraper release-date extraction hangs on one mdblist DOM selector and degrades silently to year-only `releaseInfo`. Current `data/` files have full dates; next mdblist DOM change re-triggers. Files: `scripts/scrape.mjs` (date selector). Fix is multi-selector fallback + loud warning.
- F18 — status timestamps IST-only, no timezone-independent field. Files: `src/routes.js` (`toIST`), `src/status.js` (`istToEpoch`, `istDisplay`). Reverted at owner request; keep as-is.
- F5/F7 — TMDB partial-collection `warning` dropped before `/status` (visible only in Actions logs); no catalog-coverage probe. Files: `scripts/tmdb.mjs` (`finalize` returns `warning`), `src/routes.js` (`handleRunsPost` allowlist strips it).
- F30 — no per-list filter on `/status` page; raw `?format=json` feed is the workaround. Files: `src/status.js`.

**TMDB-vs-scraper empty-result exit-code inconsistency:**
- Symptoms: noted in F26 fix commit message — pipelines disagree on whether empty means failure.
- Files: `scripts/tmdb.mjs`, `scripts/scrape.mjs`, `scripts/official.mjs`
- Trigger: narrow any list to zero results.
- Workaround: none; left as-is by owner decision.

## Security Considerations

**Secrets handling (good, keep pattern):**
- Risk: four service tokens + PIN cross worker, scripts, workflows.
- Files: `src/auth.js` (`ADMIN_PIN`, `SESSION_SECRET`), `src/routes.js` (`TMDB_READ_ACCESS_TOKEN`, `MDBLIST_API_KEY`), `src/dispatch.js` (`GH_TOKEN`), `wrangler.toml` (only non-secret vars + KV id; `keep_vars = true`), `.github/workflows/*.yml` (tokens via `${{ secrets.* }}`, workflow inputs sanitized via `tr -cd` whitelist before bash use).
- Current mitigation: no secret values in repo (verified: only names referenced); `AUTH_ENABLED` secure-by-default (missing/typo = ON, `src/auth.js:144-146`); constant-time PIN compare; HMAC-signed stateless sessions with PIN-rotation revocation; KV login rate-limit (10/IP + 60 global per 5-min window).
- Recommendations: rotate `ADMIN_PIN` if login rate-limit 429s spike; never add secret values to `wrangler.toml` `[vars]`.

**Public auth-adjacent surfaces:**
- Risk: `GET /export-config` exposes full operator config (list URLs, names, filters, timezone) without auth — required by CI polling, but also readable by anyone.
- Files: `src/routes.js` (`handleExportConfig`), `src/auth.js` (`isPublic`).
- Current mitigation: no secrets inside config blob (tokens stay in env/secrets); deliberate design with comment.
- Recommendations: none unless config ever carries sensitive fields — then move CI to a secret header (same fix as F4).

**XSS surface in server-rendered pages:**
- Risk: `/configure` builds HTML by string concat with operator-controlled names/URLs; `/status` renders run-history fields.
- Files: `src/configure.js` (`escapeAttr`, `escapeForOnclick`), `src/status.js` (`esc`), `src/routes.js` (`html` CSP header).
- Current mitigation: escaping helpers used consistently; `</script>` escape on inline state blob (`src/configure.js:7-8`); CSP `script-src 'self' 'unsafe-inline'` + `frame-ancestors 'none'` on both pages (F21 fix unified them).
- Recommendations: keep `'unsafe-inline'` only because the pages are inline-script SPAs; any move to external scripts should tighten CSP.

**CORS wildcard on JSON APIs:**
- Risk: `Access-Control-Allow-Origin: *` on catalog/manifest/run APIs (`src/index.js`, `src/routes.js`).
- Files: `src/index.js`, `src/routes.js`
- Current mitigation: Stremio clients require public catalog fetches; admin mutations are cookie-authenticated with `SameSite=Lax`, so cross-origin writes are not amplified.
- Recommendations: no change; do not add credentialed CORS.

## Performance Bottlenecks

**TMDB preview fans out dozens of sequential TMDB calls:**
- Problem: `/tmdb/preview-discover` issues sequential discover rounds + include/exclude resolution + network veto scans; one slow TMDB response stalls the whole preview.
- Files: `src/routes.js` (`handleTmdbPreviewDiscover`, `tmdbApi` with 30s `AbortSignal.timeout` + single retry marked `ponytail:`).
- Cause: correctness-first sequential pagination; operator-local network drops noted in comment.
- Improvement path: parallelize independent rounds (`Promise.all` per page batch, as `/status` already does for modules); cache preview results briefly in KV.

**Catalog proxy fetches GitHub Pages per request, no cache:**
- Problem: every `GET /catalog/...` does config load + full JSON fetch from Pages, then slices 100 rows.
- Files: `src/routes.js` (`handleCatalog`, `githubPagesCatalogUrl`).
- Cause: no `cache-control` / KV caching on catalog path (freshness preferred).
- Improvement path: add short `Cache-Control: public, max-age=300` or KV edge cache; files change at most twice daily by cron, so staleness risk is low. Measure before changing — current p99 is likely fine.

**Scraper is headless-Chromium-per-page (slowest pipeline):**
- Problem: `scripts/scrape.mjs` drives puppeteer-extra + stealth through mdblist listing pages with `networkidle2` waits (30–60s timeouts) and one bounded retry per failing page.
- Files: `scripts/scrape.mjs`, `.github/workflows/scrape.yml` (`timeout-minutes: 15`, `concurrency: group: my-list-scrape` + `queue: max`).
- Cause: anti-bot page; no API alternative for arbitrary browse URLs.
- Improvement path: none available — accepted cost; the queue/concurrency settings already prevent overlap loss.

## Fragile Areas

**mdblist DOM scraping (`scripts/scrape.mjs`):**
- Files: `scripts/scrape.mjs`
- Why fragile: single CSS selector for release dates (F9); Cloudflare challenges fail even after retry; `waitUntil: networkidle2` flaky on heavy pages.
- Safe modification: change selectors only with fixture test in `testing/scrape-serve.test.mjs`; check `data/` diff after a manual dispatch before trusting cron.
- Test coverage: `testing/scrape-serve.test.mjs`, `testing/dry-test.mjs` (dry-run harness) — no selector-fallback coverage.

**Save-config dispatch choreography (`src/routes.js:251-503`):**
- Files: `src/routes.js` (`handleSaveConfig`), `src/dispatch.js`, `.github/workflows/*.yml`
- Why fragile: 6 sequential dispatches with regen-before-delete ordering (F2), per-workflow input names (`slugs` vs `kinds` vs `ids` vs `lists`), `configVersion` stamping, best-effort vs vetoing cleanup distinction (F10: official best-effort, scraper/TMDB veto).
- Safe modification: mirror changes in both worker input shape and the target workflow's `workflow_dispatch` inputs + sanitize step; extend `testing/save-config.test.mjs` assertions (it already pins the F3A-1 `action=delete` contract).
- Test coverage: `testing/save-config.test.mjs` (438 lines, strongest suite in repo).

**TMDB discover query builder (include/exclude + network veto scan):**
- Files: `src/routes.js` (preview path ~lines 850–1060), `scripts/tmdb.mjs`
- Why fragile: worker preview and `scripts/tmdb.mjs` generator must build identical queries; `tmdbContentHash` deliberately excludes `enabled` and both sides must keep excluding it; pair-scan network veto has a page-budget cap that can truncate ("collected X/Y" warning, currently discarded per F5).
- Safe modification: change query logic in both files together; verify with `testing/tmdb-sort.test.mjs`, `testing/tmdb-exclude-e2e.mjs`, `testing/verify-tmdb.mjs`.
- Test coverage: moderate — sort/exclude/network-picker DOM tests exist; no contract test asserting worker-preview == script-generator query equality.

**Timezone handling (IST display, operator tz for Simkl):**
- Files: `src/routes.js` (`toIST`), `src/status.js` (`istToEpoch`, `istDisplay`), `src/config.js` (`normalizeTz`), `scripts/simkl.mjs`
- Why fragile: display timezone hardcoded to IST+5:30 with manual arithmetic (no `Intl`); round-trip parse depends on exact `"DD-MM-YYYY HH:MM:SS AM"` shape; Simkl "today" depends on operator tz string validated against platform tz DB.
- Safe modification: don't change timestamp format without updating both `toIST` and `istToEpoch`; `normalizeTz` heals bad values to UTC silently — log when healing fires.
- Test coverage: none dedicated; covered indirectly by status tests.

## Scaling Limits

**KV run history (30/module, 50/batch):**
- Current capacity: 4 keys × 30 records; ingest caps at 50 records/request.
- Limit: history is diagnostic-only; beyond ~30 runs/module the oldest silently evict (orphans first via `liveCatalogIdsFor`).
- Scaling path: no change needed — raise `RUNS_MAX` in `src/config.js` if deeper history wanted; KV value-size limit (~25MB) is orders of magnitude away.

**GitHub Actions serialization:**
- Current capacity: all four workflows share `concurrency: group: my-list-scrape` with `queue: max` (100 pending).
- Limit: simultaneous saves/crons serialize; a burst of saves queues rather than parallelizes.
- Scaling path: acceptable for single operator; split concurrency groups per module only if queue waits appear in Actions UI.

**Data files committed to git:**
- Current capacity: 13 JSON files in `data/`; each regen commits.
- Limit: git history bloat as lists/pages grow; Pages serves full file per catalog request (worker slices 100).
- Scaling path: paginate data files or move to R2/KV when any file approaches ~10MB; not a current problem.

## Dependencies at Risk

**None critical.** Runtime has zero npm deps (Worker uses WebCrypto/`fetch` only). CI-only `puppeteer` tree carries deprecated transitive packages (see Tech Debt) — no prod exposure.

## Missing Critical Features

**No catalog-coverage probe (F7, skipped):**
- Problem: nothing verifies an advertised catalog has a data file behind it; disabled-list URLs intentionally keep serving, so orphans are invisible.
- Blocks: detecting stale/orphaned `data/*.json` without manual checks.

**No multi-operator support:**
- Problem: single PIN, no roles, read-modify-write races (accepted, see Tech Debt).
- Blocks: shared operation; not requested.

## Test Coverage Gaps

**`/configure` + `/status` rendering:**
- What's not tested: full page renders, tab switching, filter engine, accent/module `localStorage` handling. Only fragment DOM tests exist (`testing/network-picker-dom.test.mjs`, `testing/preview-excl-dom.test.mjs`).
- Files: `src/configure.js`, `src/status.js`
- Risk: UI regressions caught only by manual/Playwright audit passes.
- Priority: Low (audit screenshots + browser probes cover releases; pages change rarely).

**Auth paths:**
- What's not tested: no test file exercises `issueSession`/`checkSession`/rate-limit/login flow.
- Files: `src/auth.js`
- Risk: session-format or gate regression locks out admin or opens it.
- Priority: Medium — small pure-function suite (cookie round-trip, expiry, PIN rotation, `isPublic`/`isAdminPath` matrix) would be cheap and high-value.

**Live/manual-only scripts:**
- What's not tested except by hand: `testing/verify-ui.mjs`, `testing/verify-tmdb.mjs`, `testing/networks-live.mjs`, `testing/undated-live.mjs`, `testing/tmdb-repro.mjs`, `testing/tmdb-exclude-e2e.mjs` require tokens/network; not runnable in CI.
- Files: `testing/*.mjs`
- Risk: TMDB/MDBList/Simkl API changes surface only at cron time (mitigated by run-history + `/status` error messages).
- Priority: Low — keep as manual runbooks.

---

*Concerns audit: 2026-09-15*
