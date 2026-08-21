# Codebase Concerns

**Analysis Date:** 2026-08-21

## Tech Debt

**Unauthenticated admin surface (highest priority):**
- Issue: Every mutating/config endpoint is open to anonymous internet traffic. No auth check exists anywhere in `src/index.js` or `src/routes.js`.
- Files: `src/index.js` (lines 37-83 route table), `src/routes.js` (`handleSaveConfig`, `handleTriggerRefresh`, `handleExportConfig`, `handleRunsPost`)
- Impact: Any stranger can (a) rewrite the entire addon config via POST `/save-config`, (b) trigger unlimited GitHub Actions runs via `/trigger-refresh` (burns Actions minutes, queues the shared concurrency group for hours), (c) read the full config via GET `/export-config` (leaks operator's mdblist URLs/filters), (d) forge run history via POST `/runs`. The destructive `scrape_delete` action is reachable through `/save-config` by deleting lists.
- Fix approach: Add a shared-secret check (e.g. `ADMIN_TOKEN` worker secret compared against an `Authorization`/query param) on `/save-config`, `/trigger-refresh`, `/export-config`, `/runs`. The configure page JS (`src/configure.js` `saveAll`/`confirmRefresh`) would need to send it. Catalog reads (`/manifest.json`, `/catalog/*`) stay public.

**Worker-as-free-TMDB-proxy:**
- Issue: `/tmdb/search-*` and `/tmdb/preview-discover` (`src/routes.js` lines 538-689) forward arbitrary queries to TMDB using the worker's own bearer token, with no auth or rate limit. The preview endpoint fans out to up to 25 pages x N sources plus collection fetches per request.
- Files: `src/routes.js` (`tmdbApi`, `handleTmdbSearch`, `handleTmdbPreviewDiscover`), `wrangler.toml` (token as secret)
- Impact: Abuse exhausts the TMDB API quota tied to the operator's account; catalogs stop generating.
- Fix approach: Same admin-token gate as above, or Cloudflare WAF rate-limiting rule on `/tmdb/*`.

**Duplicated logic that must stay in sync (drift risk):**
- Issue: Three parallel implementations exist by design and are only kept aligned by comments.
  - Hash: `tmdbContentHash` (`src/config.js` lines 329-353) vs `computeSourceHash` (`scripts/tmdb.mjs` lines 66-89). A field added to one and not the other makes fill-mode skip logic disagree with the save-time diff.
  - Discover query plan: `buildDiscoverSources` (`scripts/tmdb.mjs` lines 118-173) vs inline copy in `handleTmdbPreviewDiscover` (`src/routes.js` lines 604-658). Comment says "Same source plan" but nothing enforces it.
  - Simkl defaults: `SIMKL_LISTS` (`src/config.js` lines 64-98) vs `DEFAULT_FILTERS` (`scripts/simkl.mjs` lines 60-84). Editing one silently diverges fallback behavior.
- Files: as listed
- Impact: Silent behavioral divergence; preview shows different results than the generated catalog; stale-filter overwrites.
- Fix approach: Extract the hash and source-plan functions into a shared module importable by both worker and scripts (both already ESM; worker has `nodejs_compat`). At minimum, add a verify-script assertion comparing outputs.

**Copy-paste helpers across scripts:**
- Issue: `arg()`, `chunkArray()`, `postRuns()`, `sleep` are duplicated nearly verbatim in `scripts/scrape.mjs`, `scripts/official.mjs`, `scripts/simkl.mjs`, `scripts/tmdb.mjs`.
- Files: as listed
- Impact: Bug fixes (e.g. retry/backoff on `/runs` POST failure) must be applied 4 times.
- Fix approach: Shared `scripts/lib/common.mjs`.

**Dead secret plumbing:**
- Issue: `MDBLIST_API_KEY` is declared in `scrape.yml` env and documented in `scripts/scrape.mjs` header, but the DOM-based scraper never reads it ("only used for nothing today").
- Files: `.github/workflows/scrape.yml` (line 84), `scripts/scrape.mjs` (lines 14-15)
- Impact: Confusing threat model; secret mounted where unnecessary.
- Fix approach: Remove from `scrape.yml` env block; keep only in `official.yml` where `official.mjs` actually uses it.

**MDBList API key in query string:**
- Issue: `fetchAllItems` passes `apikey` as a URL search param (`scripts/official.mjs` line 87).
- Files: `scripts/official.mjs`
- Impact: Key can leak into any upstream/proxy access logs. Error messages include response bodies but not URLs, so current leak surface is limited to transport logs.
- Fix approach: Move to `X-MDbList-Key`-style header if the API supports one; otherwise accept (documented limitation).

## Known Bugs

**Stale-catalog-on-silent-scrape-failure (design tradeoff with blind spot):**
- Symptoms: A blocked/broken scrape writes nothing (empty-result guard), so the served catalog keeps showing old data indefinitely while `/status` shows failures only if the operator checks.
- Files: `scripts/scrape.mjs` (`writeCatalog` lines 341-356), `scripts/official.mjs` (`writeCatalog` guard line 196), `scripts/tmdb.mjs` (`items.length > 0` guard line 403)
- Trigger: mdblist changes its DOM selectors, bot detection starts blocking, or TMDB returns 0 rows for a valid filter combo.
- Workaround: Watch `/status?page=scraper` manually; debug artifacts on failure (`scrape.yml` upload step).

**`git pull --rebase -X theirs` push can still fail:**
- Symptoms: Commit step fails after a successful scrape if another writer pushes between the rebase and the push; run exits non-zero though local files were correct.
- Files: `.github/workflows/scrape.yml` (lines 99-120), same block in `official.yml`/`simkl.yml`/`tmdb.yml`
- Trigger: Only matters when the shared concurrency group fails to serialize (see Scaling Limits below).
- Workaround: Re-run the workflow; next cron heals.

**Second TMDB cron disabled:**
- Symptoms: TMDB discover lists refresh once daily (01:30 UTC) while scraper/official/simkl refresh twice; the 13:30 UTC line is commented out in `tmdb.yml` line 10.
- Files: `.github/workflows/tmdb.yml`
- Trigger: N/A - current state.
- Workaround: Manual refresh from configure page. Confirm intent or uncomment.

**`triggered_by` collapse:**
- Symptoms: `/status` maps any non-"scheduled" trigger value to "manual" (`src/routes.js` line 224), so a forged `/runs` POST or future trigger types misreport as manual.
- Files: `src/routes.js`
- Workaround: None; cosmetic.

**Run-id collisions:**
- Symptoms: `addRun` ids are `Date.now() + random(1000)` (`src/routes.js` line 495); two runs in the same millisecond can collide. Ids are display-only today (list is ordered by insertion, not id), so impact is latent.
- Files: `src/routes.js`, `src/config.js` (`addRun`)
- Workaround: None needed currently.

## Security Considerations

**Inbound auth (see Tech Debt item 1):**
- Risk: Full config takeover + unlimited Actions dispatch + run-history poisoning by anonymous users.
- Files: `src/index.js`, `src/routes.js`
- Current mitigation: None on inbound requests. Workflow inputs ARE sanitized (see below); outbound secrets are handled correctly.
- Recommendations: Admin shared secret on the four sensitive routes; consider Cloudflare Access as an alternative.

**TMDB bearer token handling (audited - clean):**
- Risk: Token leakage into logs/responses.
- Files: `src/routes.js` (`tmdbApi` lines 525-534), `scripts/tmdb.mjs` (`tmdbFetch` lines 101-111), `.github/workflows/tmdb.yml` (line 71)
- Current mitigation: Token lives only in `env.TMDB_READ_ACCESS_TOKEN` / `secrets.TMDB_READ_ACCESS_TOKEN`; sent solely in the `Authorization: Bearer` header; never interpolated into URLs, error messages, or console output. Error paths echo only the TMDB *response* body sliced to 200 chars (`src/routes.js` line 531), which does not contain the token. Missing-token path returns a generic config error without echoing any value. Verified: no `console.log` of the token anywhere in the repo.
- Recommendations: Keep as-is; do not add the token to any thrown Error message in `scripts/tmdb.mjs`.

**Workflow input sanitization (audited - solid):**
- Current mitigation: Every `${{ github.event.inputs.* }}` interpolation goes through `tr -cd` char-class whitelists in a dedicated sanitize step BEFORE reaching bash args or `$GITHUB_OUTPUT`: `[a-zA-Z0-9,_-]` for lists/delete_ids (`scrape.yml` lines 70-72), `[a-z,]` for kinds (`simkl.mjs` line 49 / `simkl.yml`), `[a-z0-9,_-]` for slugs (`official.yml` line 51), `[a-z0-9,_-]` + `[a-z_]` for tmdb ids/action (`tmdb.yml` lines 61-63). Defense in depth continues in the scripts: id regexes gate `deleteCatalog`/`writeCatalog` joins (`scripts/scrape.mjs` lines 376-384, `scripts/tmdb.mjs` `ID_RE` line 37 + line 369, `scripts/official.mjs` `SANE_SLUG` line 179, `scripts/simkl.mjs` `SANE_KIND` line 396), and `migrateConfig` enforces `^mdb_scrape_[A-Za-z0-9_-]{1,32}$` (`src/config.js` line 247) blocking path traversal into `data/`.
- Residual risk: Sanitization strips rather than rejects, so garbage input silently becomes empty/default (e.g. a malformed `action` becomes `scrape` - full re-scrape). Acceptable.
- Recommendations: None required.

**Configure page XSS surface:**
- Risk: List names/URLs are operator-supplied and rendered via string-concatenated HTML with inline `onclick` handlers (`src/configure.js` `nameEditBlock`, `pickTmdbResult`, `escapeForOnclick`). CSP permits `script-src 'unsafe-inline'` (`src/routes.js` line 36).
- Files: `src/configure.js`, `src/routes.js` (`html()` CSP)
- Current mitigation: `escapeAttr` escapes `& " < >`; `</script>` breakout of the embedded state blob is hard-escaped (`src/configure.js` line 14); `escapeForOnclick` handles the attribute-JS-string double context. Since the config is single-operator and only the operator can write it, this is self-XSS unless combined with the unauthenticated `/save-config` hole above - an attacker who can write config could plant a name payload that executes in the operator's browser.
- Recommendations: Fixing the auth hole closes the realistic exploit chain; longer term, replace inline handlers with delegated listeners and drop `'unsafe-inline'`.

**Secrets inventory (existence only):**
- `.env` files: none present. Secrets referenced: `GH_TOKEN`, `TMDB_READ_ACCESS_TOKEN`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`, `WORKER_ORIGIN` as GitHub/Cloudflare secrets. KV namespace id in `wrangler.toml` is an identifier, not a credential.

## Performance Bottlenecks

**Global serialization of all four workflows:**
- Problem: All crons fire at the SAME minute (01:30 and 13:30 UTC) and share concurrency group `my-list-scrape` (`cancel-in-progress: false`, `queue: max`). Worst case: puppeteer scrape (30 min timeout) head-of-line blocks official/simkl/tmdb refreshes behind it.
- Files: `.github/workflows/scrape.yml` (lines 38-50), `official.yml` (25-37), `simkl.yml` (25-36), `tmdb.yml` (37-48)
- Cause: Deliberate - they all write `data/*.json` and POST `/runs` (KV read-modify-write in `addRun`).
- Improvement path: Stagger cron minutes (e.g. 01:30/01:40/01:50/02:00 UTC) to cut contention while keeping the lock as backstop.

**Unbounded scraper-list fan-out:**
- Problem: One save can create arbitrarily MANY enabled lists (count uncapped in `migrateConfig`); a full refresh dispatches all of them into one 30-minute-budget workflow run with per-page sleeps (1.5-3.5 s) plus warm-up navigation.
- Files: `src/config.js` (`migrateConfig`), `scripts/scrape.mjs` (`main` loop)
- Cause: No ceiling on `cfg.scraper.lists.length`.
- Improvement path: Cap list count (e.g. 20) in `migrateConfig`.

**Preview fan-out cost:**
- Problem: `handleTmdbPreviewDiscover` runs up to 25 pages x up to 4 sources + collection lookups synchronously in the worker per click.
- Files: `src/routes.js` (lines 587-689)
- Improvement path: Auth/rate-limit (see security); cache previews keyed by content hash.

**KV read-modify-write per run record:**
- Problem: `addRun` does get+put per record with no lock (acknowledged in `src/routes.js` line 245 comment for saves; same pattern in `src/config.js` `addRun`). Concurrent writers lose records.
- Files: `src/config.js` (lines 450-454)
- Improvement path: Concurrency group mostly serializes legitimate writers today; move runs to Durable Objects only if the group ever loosens.

## Fragile Areas

**Puppeteer DOM scraping of mdblist.com:**
- Files: `scripts/scrape.mjs` (selectors at lines 231, 253-264; bot-detection warm-up at lines 173-211)
- Why fragile: Hardcoded CSS selectors (`.card`, `.idscore.search-score-main`, `a[href^="/movie/"]`) and anti-bot choreography (UA spoofing, homepage warm-up, scroll simulation). Any mdblist redesign or stricter Cloudflare challenge silently yields 0 rows.
- Safe modification: Never widen the empty-result guard to overwrite files; keep `writeCatalog` returning null on empty. Test selector changes against a saved HTML fixture.
- Test coverage: None for selectors (requires live site).

**Catalog regex + pagination contract:**
- Files: `src/routes.js` (`CATALOG_RE` line 46, skip parse lines 49-51), `scripts/scrape.mjs` (`buildPageUrl` lines 109-120)
- Why fragile: The `q_page_next`/`q_current_page` encoding mirrors mdblist's generated URLs byte-for-byte; the trailing `skip=N.json` segment rides inside the catalog id match. A Stremio request-shape change or mdblist pagination change breaks silently (empty metas).
- Safe modification: Change only with captured live URLs as fixtures.
- Test coverage: Partially covered in `scripts/dry-test.mjs` (gitignored).

**Configure page monolith:**
- Files: `src/configure.js` (~1770 lines: CSS + HTML + all tab JS in one template literal)
- Why fragile: Four modules' UI state machines share globals (`state`, `activeModule`, index-based card ids `#card-i`/`#ocard-i`/`#socard-i`/`#tcard-i`); innerHTML-string rendering means any quote-escaping slip breaks silently. The pointerdown rename-commit workaround (lines 873-879) depends on exact DOM timing.
- Safe modification: Touch one tab's render function at a time; re-run `node scripts/verify-ui.mjs` (drives the real DOM via jsdom).
- Test coverage: `scripts/verify-ui.mjs` + `scripts/dry-test.mjs` cover rename/pointer flows; both gitignored local-only.

**Seed/heal one-shot KV migration:**
- Files: `src/config.js` (`seedScraperDefaults`, heal block lines 420-439, `HEALED_KEY`)
- Why fragile: First-load seeding persists config on READ; a cold KV hit by two concurrent readers can double-write. After healing flips, seed-URL re-adds keep user ids forever - re-triggering healing requires manual KV surgery.
- Safe modification: Don't reorder the wasSeeded/healed conditions without tracing both branches.
- Test coverage: Covered in `scripts/verify-tmdb.mjs` config-migration checks.

## Scaling Limits

**GitHub Actions queue depth:**
- Current capacity: `queue: max` claims up to 100 pending slots per concurrency group (comments cite the 2026-05 feature).
- Limit: If the feature is unavailable on the plan or renamed, behavior falls back to default depth 1 - simultaneous crons cancel all but one pending run, losing scheduled refreshes entirely.
- Files: all four `.github/workflows/*.yml` concurrency blocks
- Scaling path: Verify `queue: max` takes effect after first simultaneous-cron window; otherwise stagger crons.

**KV value/list-count ceilings:**
- Current capacity: Config is one JSON blob under key `config`; run history capped at 30/module (`RUNS_MAX`), `/runs` capped at 50 records/request.
- Limit: Workers KV value cap (25 MiB) and list-count-unchecked growth (see Performance). Manifest grows linearly with enabled lists; Stremio clients refetch it often.
- Scaling path: Cap list count; split config per module if it ever nears limits.

**Single-worker egress:**
- Current capacity: Every catalog request fetches `GITHUB_PAGES_BASE/data/<id>.json` fresh from Pages (`src/routes.js` `handleCatalog`) - no cache API usage.
- Limit: Popular catalogs pay Pages latency per Stremio skip-page; Pages soft rate limits apply.
- Scaling path: Add `caches.default` around the Pages fetch (data changes only per-cron; 5-10 min TTL safe).

## Dependencies at Risk

**puppeteer / puppeteer-extra / stealth plugin:**
- Risk: Chromium download pinned loosely (`^25.3.0`); stealth plugin lags Chrome fingerprint changes; mdblist bot detection arms race.
- Impact: Whole scraper module stops producing data.
- Migration plan: None needed until failures appear; debug artifacts (`--debug`) aid diagnosis.

**jsdom (undeclared):**
- Risk: Imported by `scripts/verify-tmdb.mjs`, `scripts/verify-ui.mjs`, `scripts/dry-test.mjs` but present in NO `package.json` (repo root has none; `scripts/package.json` lists only puppeteer family). Resolves from an ambient root-level `node_modules/` install.
- Impact: Fresh clone cannot run any verification script; CI-less project gives no signal.
- Migration plan: Add root `package.json` with jsdom as devDependency (or move verify scripts under `scripts/` and declare it there).

**`queue: max` (GitHub Actions feature):**
- Risk: New platform capability; subject to change/removal.
- Impact: Scheduled-run loss as described under Scaling Limits.
- Migration plan: Cron staggering removes reliance.

## Missing Critical Features

**No inbound authentication (covered above):**
- Problem: Blocks any public exposure beyond hobby use; currently the biggest gap.
- Blocks: Sharing the configure URL, multi-operator use, hosting without embarrassment.

**No CI:**
- Problem: No workflow runs lint/tests on push; verification scripts are manual and gitignored.
- Files: `.github/workflows/` contains only data-pipeline workflows.
- Blocks: Regression safety for `src/` changes.

**No structured logging/alerting:**
- Problem: Worker has zero logging; failures surface only via `/status` (which itself depends on unauthenticated `/runs` posts). No alert when a cron fails repeatedly.
- Blocks: Noticing silent scrape death without manual checks.

## Test Coverage Gaps

**Worker `src/` has no direct tests:**
- What's not tested: `src/routes.js` end-to-end (save-config diffing/dispatch ordering, catalog serving fallbacks, status name resolution), `src/index.js` routing.
- Files: `src/routes.js`, `src/index.js`, `src/dispatch.js`
- Risk: Save-config's dispatch-order rules (simkl-first/scraper-last/persist-last) and hash-gated regeneration are the most intricate logic in the repo and regress invisibly.
- Priority: High.

**Live-site scraper selectors:**
- What's not tested: `scripts/scrape.mjs` `page.evaluate` extraction block.
- Files: `scripts/scrape.mjs` (lines 251-305)
- Risk: Breaks unnoticed until catalogs go stale.
- Priority: Medium (fixture-based smoke test feasible).

**Verify scripts not runnable from clean checkout:**
- What's not tested: Anything, on machines lacking ambient jsdom (see Dependencies at Risk).
- Files: `scripts/verify-tmdb.mjs`, `scripts/verify-ui.mjs`, `scripts/dry-test.mjs`
- Priority: High (one-line package.json fix).

---

*Concerns audit: 2026-08-21*
