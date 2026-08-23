# FUNCTIONAL-AUDIT

**Date:** 2026-08-23 · **Scope:** whole repo across all three layers (Cloudflare Worker / GitHub Actions / GitHub Pages) · **Method:** full read of every source file, dependency audit, live verification against a local `wrangler dev` instance and headless-browser sessions; all proposed fixes were applied **only to an isolated temp copy**, verified there, and the real repo was left untouched (working tree clean, `main` unmodified, no workflow runs triggered).

---

## 0. How to read this report

You said you don't code — so every finding below leads with a plain-language explanation of what's actually going on before any technical detail. File/line references are included for the record.

Severity scale used:

| Severity | Meaning here |
|---|---|
| **Critical** | Data loss, security hole, or something that breaks the live catalog for consumers |
| **Moderate** | Works today but is fragile or wrong on edge cases |
| **Minor** | Dead code, small inefficiencies, stale comments, cosmetic inconsistencies |

One decision you made up front is respected throughout: **the `/configure` admin surface has no authentication and that is accepted as-is.** It is recorded factually in §7 but no auth fix is proposed anywhere in this report. Likewise §5 (git commit/push overlap) is deliberately **explanation-only** — no fix designed, per your instruction.

---

## 1. Executive summary

- **No Critical issues found.** In particular, the scenario you were most worried about — two Actions runs overlapping and corrupting the public catalog JSON on `main` — does not hold up under scrutiny (see §5 for exactly why, in plain language).
- **5 Moderate issues found.** Four have fixes that were fully implemented and verified safe in an isolated copy (M1–M4). One (M5, a genuine Worker-level race condition) was **reproduced deterministically**, but the honest recommendation is *documented acceptance* rather than a code fix — the reasoning is laid out so you can overrule it.
- **The feared git-push corruption path cannot produce a half-written JSON file on Pages.** Git physically can't push partial files; the real failure modes are "a run fails and next cron heals it" and "a queued run gets canceled if the queue feature misbehaves" — annoying, self-healing, never corrupt.
- Dependency audit (`npm audit`): **0 vulnerabilities** across all 69 production dependencies.
- A batch of Minor cleanups (dead code, one hardcoded string, a duplicated id-format string, missing fetch timeouts) are bundled into the verified fix set where trivially safe; a few others are listed as owner-decision items because fixing them means touching files the audit was forbidden to modify (dependency manifests, your local-only test scripts).

---

## 2. Map vs. reality — where `.planning/codebase` has drifted

The planning map is good and was genuinely useful, but eight places no longer match the code. The **code wins** in every case; the map needs these updates:

| # | Map says | Reality |
|---|---|---|
| 1 | `STACK.md`: jsdom "resolves from ambient root node_modules" | jsdom was **not installed at all** — both UI verify scripts could not run on this machine until I installed it during this audit. An unrelated orphaned `playwright-core` sat in root `node_modules` instead (nothing references it; my jsdom install pruned it — see §8 note). |
| 2 | `INTEGRATIONS.md` + `ARCHITECTURE.md`: dispatch.js validates workflow filenames against `/^[a-zA-Z0-9_.-]+\.yml$/` | **No such validation exists** in `src/dispatch.js`. Risk is low (workflow names come from trusted env vars/constants), but the map documents a guard that isn't there. |
| 3 | `ARCHITECTURE.md`: "`env.GH_FETCH` injection point used by tests" (and elsewhere "consulted nowhere") | Self-contradictory, and neither half is right as written: **no `GH_FETCH` seam exists anywhere.** Tests swap global `fetch`. |
| 4 | `ARCHITECTURE.md`/`CONVENTIONS.md`: configure page keeps state in `window.moduleState` | Actual code uses a single plain `let state` variable (`src/configure.js`). |
| 5 | `tmdb.yml` cron comment + `computeSourceHash` docstring: "fill-mode skip logic lives in tmdb.mjs via sourceHash comparison" | **No fill-mode skip exists.** `readExistingHash()` (`scripts/tmdb.mjs:91`) was written for it but is never called — dead code — and every run regenerates fully. Stale comment describes behavior that isn't implemented. |
| 6 | `src/configure.js` header: "Phase 1 ships the scraper tab; the other three render coming soon" | All four tabs (scraper/official/simkl/tmdb) are live. Stale phase-1 comment. |
| 7 | Map treats `scripts/dry-test.mjs`, `verify-ui.mjs` as part of the test suite | True locally, but **both are gitignored** — a fresh clone ships only `verify-tmdb.mjs`. Most of the test suite effectively doesn't exist for anyone but you (Minor finding m8). |
| 8 | Trivia: map says configure.js is 1773 lines | 1779 lines currently. |

---

## 3. Architecture as verified (three layers + the refresh chain traced)

Confirmed exactly as you described, with the full chain traced end-to-end:

```
[you click Refresh in /configure]
   → Cloudflare Worker POST /trigger-refresh        (layer 1, src/routes.js)
   → dispatchScraperWorkflow()                      (src/dispatch.js → api.github.com, expects HTTP 204)
   → GitHub Actions run starts (cron or dispatch)   (layer 2, .github/workflows/*.yml)
       → sanitize inputs (tr -cd whitelists in bash)
       → node scrape.mjs|official.mjs|simkl.mjs|tmdb.mjs
           → GET {WORKER_ORIGIN}/export-config      (reads config back from the Worker)
           → scrape/fetch upstream → write data/<catalog_id>.json
           → POST {WORKER_ORIGIN}/runs              (run history into Worker KV)
       → git add -f data/*.json → commit "[skip ci]" → git pull --rebase -X theirs → push
   → GitHub Pages serves main instantly             (layer 3, no build buffer)
   → Stremio asks Worker /catalog/... → Worker fetches Pages JSON → returns metas
```

Key verified facts about layer interactions:
- All four workflows share concurrency group `my-list-scrape` with `cancel-in-progress: false` and `queue: max`.
- `queue: max` is a **real, documented GitHub feature** (changelog 2026-05-07): up to 100 pending runs per group, executed sequentially. Requires `cancel-in-progress: false`, which all four workflows set. The workflow comments describing it are accurate.
- No cron triggers exist on the Worker itself (`wrangler.toml` confirms); scheduling lives entirely in workflow YAML.
- KV binding `STORE`; secrets `GH_TOKEN` + `TMDB_READ_ACCESS_TOKEN` (Cloudflare) and four repo secrets (GitHub). Verified none are hardcoded or logged anywhere.

---

## 4. Function inventory

Surfaces: **ADMIN** = `/configure` admin surface (single-user framing applies) · **PUBLIC** = catalog-serving surface consumed by Stremio clients (normal severity framing) · **MACHINE** = called only by the CI scripts · **UI** = browser-side JS inside the configure page.

### Layer 1 — Cloudflare Worker (`src/`)

**`src/index.js`** — router (87 lines)

| Function | Lines | Purpose / notes | Surface |
|---|---|---|---|
| `default fetch(request, env)` | 21–86 | Only runtime entry. Matches pathname/method to handlers; CORS preflight; root info text | ADMIN + PUBLIC |
| `json(body, status, extraHeaders)` | 14–19 | Local JSON-response helper | both |

**`src/routes.js`** — all route handlers (689 lines)

| Function | Lines | Calls → | Path type | Surface |
|---|---|---|---|---|
| `json` / `html` helpers | 24–41 | — | utility | both |
| `CATALOG_RE` (const) | 46 | used by index.js | PUBLIC routing | PUBLIC |
| `githubPagesCatalogUrl` | 48–50 | — | utility | PUBLIC |
| `configureResponse` | 53–55 | buildConfigurePage | request-serving | ADMIN |
| `toIST` | 57–66 | — | display util | ADMIN |
| `buildManifest` | 68–116 | loadConfig | request-serving | PUBLIC |
| `rowToMeta` | 118–131 | — | mapper | PUBLIC |
| `rowToMetaOfficial` | 133–142 | — | mapper | PUBLIC |
| `rowToMetaSimkl` | 146–154 | — | mapper | PUBLIC |
| `rowToMetaTmdb` | 159–167 | — | mapper | PUBLIC |
| `handleCatalog` | 169–194 | loadConfig, fetch(Pages) | request-serving | PUBLIC |
| `handleStatus` | 196–233 | loadConfig, getRuns ×4 keys | request-serving | ADMIN (status page) |
| `handleSaveConfig` | 235–367 | loadConfig, migrateConfig, hashes ×2, dispatchScraperWorkflow ×3, saveConfig | request-serving (mutating) | ADMIN |
| `handleExportConfig` | 369–372 | loadConfig | request-serving | MACHINE (scripts read config) + ADMIN |
| `handleTriggerRefresh` | 374–477 | loadConfig, dispatchScraperWorkflow | request-serving (mutating) | ADMIN |
| `handleRunsPost` | 483–511 | addRun, runsKeyFor | ingest endpoint | MACHINE |
| `tmdbTokenOrError` | 518–523 | — | guard | ADMIN |
| `tmdbApi` | 525–534 | fetch(TMDB) | proxy helper | ADMIN |
| `handleTmdbSearch` | 538–558 | tmdbApi | request-serving | ADMIN |
| `sortPreviewItems` | 571–585 | — | pure helper | ADMIN |
| `handleTmdbPreviewDiscover` | 587–689 | normalizeTmdbList, tmdbApi ×many | request-serving (heavy fan-out) | ADMIN |

**`src/config.js`** — KV store, normalization, hashing (458 lines)

| Function | Lines | Notes | Used by |
|---|---|---|---|
| `runsKeyFor(catalogId)` | 18–23 | routes mdboff_/simkl_/tmdb_ prefixes → runs key | handleRunsPost |
| `OFFICIAL_RUNS_KEY/SIMKL_RUNS_KEY/TMDB_RUNS_KEY` consts | 25–27 | OFFICIAL_RUNS_KEY was exported-but-unused (m2) | routes.js |
| `randomTmdbListId` | 32–38 | **dead** — zero call sites (needs dry-test edit to remove) | nobody |
| `randomScraperId(seedUrl)` | 43–51 | sha256(url)-derived pinned ids | migrateConfig |
| `emptyConfig()` | 53–55 | **dead** — zero call sites (same removal caveat) | nobody |
| `SIMKL_LISTS/SIMKL_CATALOGS/OFFICIAL_LISTS/OFFICIAL_CATALOGS` consts | 64–135 | fixed module catalogs | many |
| `simklDefaults` / `seedScraperDefaults` / `officialDefaults` | 107–179 | seed builders | loadConfig |
| `migrateOfficial` | 184–190 | keep only known slugs | migrateConfig |
| `normalizeTiers` | 197–210 | blank tiers dropped | normalizeSimklList |
| `normalizeSimklList` | 212–232 | filter coercion | migrateSimkl, loadConfig |
| `migrateSimkl` | 234–237 | — | migrateConfig |
| `migrateConfig` | 239–255 | full-config normalizer incl. scraper-id regex guard | handleSaveConfig, loadConfig |
| `normalizeTmdbList` | 269–309 | drops malformed TMDB entries | migrateTmdb, preview handler, loadConfig |
| `migrateTmdb` | 311–314 | — | migrateConfig |
| `listContentHash` | 319–324 | change detection (excludes name) | handleSaveConfig |
| `tmdbContentHash` | 329–353 | same, TMDB fields | handleSaveConfig |
| `loadConfig(kv)` | 355–441 | read→migrate→seed/heal→persist-once | everything |
| `saveConfig(kv,cfg)` | 443–445 | single put | handleSaveConfig |
| `addRun(kv,run,key)` | 450–454 | last-30 cap | handleRunsPost |
| `getRuns(kv,key)` | 456–458 | — | handleStatus |

**`src/dispatch.js`** — one function (37 lines): `dispatchScraperWorkflow(env,{lists,action,deleteIds,workflow,inputs})` L10–37. Single chokepoint for every GitHub Actions trigger; expects HTTP 204; builds `{dispatched, reason}` result objects, never throws.

**`src/configure.js`** — `buildConfigurePage(origin, config)` (L11) exports one HTML string containing ~74 inline browser functions (UI surface): page shell (`escapeAttr`(client copy), accent color picker, menu/tabs), per-tab renderers `renderScraper/renderOfficial/renderSimkl/renderTmdb`, card mutations (`updateList/toggleList/updateTmdb/setCsv/setTier/addTier/removeTier…`), rename flow (`startNameEdit/saveName/cancelName` + pointerdown outside-click commit), create flows (`confirmCreateList/confirmCreateTmdb/randomId` — client mirrors server's sha256 id derivation), delete/refresh confirm modals, TMDB dimension editor (~20 fns: sections/chips/inline search/pick), TMDB live preview (`toggleTmdbPreview/loadTmdbPreview/tmdbPreviewHtml`), `saveAll`, `openStatus`. Full line-numbered enumeration available in audit working notes; the load-bearing one for findings is **`nameEditBlock` (L829–842)**, shared by all four tabs — see M1.

### Layer 2 — GitHub Actions

**Workflows** (all: checkout@v5 → setup-node@v5 Node 22 → bash input sanitization → run script → commit block `if: always()`: force-add data → skip-if-no-diff → commit `[skip ci]` → `git pull --rebase -X theirs` → push):
- `scrape.yml` (129 ln): crons 01:30+13:30 UTC; puppeteer scrape; 30-min timeout; debug artifact upload on failure/debug.
- `official.yml` (83 ln): same crons; MDBList API; 15-min timeout.
- `simkl.yml` (81 ln): same crons; SIMKL calendar; 15-min.
- `tmdb.yml` (104 ln): cron 01:30 only (13:30 commented out); generate/delete actions.

**Scripts** (`scripts/*.mjs`, Node 22 ESM, dependency-injected `main()` pattern):

| Script | Key exports (lines) | Role |
|---|---|---|
| `scrape.mjs` | arg/buildPageUrl(109)/fetchConfig(75)/scrapeList(316)/scrapeOnePage(213)/warmUpSession(173)/writeCatalog(341, empty-guard)/deleteCatalog(358)/main(371) + postRuns/sleep/debugDump/humanScroll | Headless-Chromium DOM scrape of mdblist.com with bot-detection warm-up choreography; per-page try/catch → structured run records; exit 1 on failures when run as CLI |
| `official.mjs` | enabledSlugs(49)/getFullConfig(67)/fetchAllItems(80, cursor pagination ≤50 pages)/writeCatalog(123)/main(168) | MDBList official lists × movie/show; empty-result guard; exit 1 on failure (CLI) |
| `simkl.mjs` | simklUrl(48)/enabledKindsAndFilters(86)/matchesCountry(123)/passesRatingTiers(136)/precompute(184, grouping+tiers+labels+priority sort)/fetchTodaysCalendar(306)/writeCatalog(334 — empty day IS valid)/main(380) | Arriving-today builder; typo'd CLI kinds fail loudly; exit 1 on failure (CLI) |
| `tmdb.mjs` | computeSourceHash(66)/buildDiscoverSources(118, AND/OR plan)/sortItems(214)/buildDiscoverItems(230, ≤500 items, collection post-filter)/writeCatalog(305)/deleteCatalog(321)/main(353) | TMDB discover generator; **was the only script whose main() never signaled failure to Actions (M2)** |
| `verify-ui.mjs`, `verify-tmdb.mjs` | check()-style suites (jsdom) | Local test suites (first is gitignored/local-only) |

### Layer 3 — GitHub Pages
No code — serves committed `data/*.json` from `main` directly. Worker fetches per-request; nothing else involved.

---

## 5. The git commit/push overlap — explanation only (no fix attached, per your instruction)

Plain language first:

**What the safety net actually is.** All four pipelines share one GitHub Actions "concurrency group" — think of it as a single bathroom lock for all data-writing jobs. Only one job can ever hold it; everyone else waits in line. The `queue: max` setting (verified against GitHub's own changelog and docs, added May 2026) makes the waiting room hold up to 100 jobs instead of the old default of 1.

**So can two runs really overlap?** Under normal operation, no — that's the point of the lock. The scenarios where the lock story breaks:

1. **`queue: max` stops being honored** (feature renamed/removed, plan change). Then GitHub falls back to the old behavior: one job running + one pending, and a newly arriving job *cancels* the older pending one. Result: some scheduled refreshes silently never happen. Your catalog then just stays one cycle staler until the next cron. Not corruption — missed chores.
2. **A rejected push after a successful scrape.** Even with the lock, there's a tiny window between this run's `git pull --rebase` and its `git push` where a human (or anything else) could push to `main` first; the push then bounces. The run exits red even though its scraped files were correct locally. Next cron re-scrapes and heals. Again: delay, not damage.

**The specific fear — "half-written JSON goes live to everyone" — cannot happen through this pipeline,** and here's the concrete why: the script writes the file completely on the runner first; `git commit` snapshots the *entire* file as an immutable object; `git push` transfers whole objects and updates `main`'s tip in a single atomic step. There is no mechanism by which Pages could serve a fractionally-updated JSON file. The worst realistic outcomes are (a) a red run that self-heals next cycle, (b) canceled queued runs during simultaneous-cron windows if the queue feature misbehaves, or (c) in a same-file conflict, `-X theirs` resolving wholesale in favor of the fresher regeneration — which is exactly the intent documented in the workflow comments (and I verified their rebase ours/theirs semantics are described correctly).

One nuance worth knowing: the merge strategy operates line-by-line on pretty-printed JSON, so a same-file conflict resolved by `-X theirs` favors the newer file *per conflicting hunk*, not necessarily whole-file. Under the current serialization that situation essentially can't arise (it requires two writers holding the lock simultaneously, which the lock prevents by definition). If you ever loosen or remove the shared concurrency group, revisit this paragraph before assuming safety.

No fix is designed here, per your instruction. If/when you want that conversation, the candidate directions (staggering cron minutes, verifying `queue: max` took effect after a simultaneous window, or splitting groups) are already sketched in `CONCERNS.md`.

---

## 6. Findings

### 6.1 CRITICAL — none found

Nothing met the bar (data loss, security hole, live-catalog breakage). Notably:
- Secrets handling audited clean: `GH_TOKEN`/`TMDB_READ_ACCESS_TOKEN` only ever appear from env bindings, only in Authorization headers, never interpolated into URLs/logs/error messages (token-bearing error text is upstream response bodies, sliced to 200 chars).
- Path-traversal defenses verified layered and sound (bash `tr -cd` whitelists → script-side id regexes → `migrateConfig`'s `^mdb_scrape_[A-Za-z0-9_-]{1,32}$` guard).
- Input sanitization on workflow inputs verified solid end-to-end.

### 6.2 MODERATE (fixes implemented & verified in isolated copy)

---

#### M1 — Configure page: the "preview" eye button appears on every tab and misbehaves off the TMDB tab

**Plain language:** Every list card in the admin page shows a little eye icon labeled "Preview results." That button was rendered identically on all four tabs, but the code behind it only knows how to preview *TMDB* lists, using the card's position number as its lookup key. Consequences on the other three tabs: if you don't have any TMDB lists, clicking it does nothing at all (a dead button); if you *do* have TMDB lists, clicking the eye on, say, scraper card #1 reaches into your TMDB list #1 instead — flipping it open, firing a network request, and yanking the whole page over to the TMDB tab while the menu still claims you're on Scraper.

**Evidence:** reproduced headlessly. With a TMDB list present at the same index, clicking the eye on a scraper card flipped the header to "TMDB List" (screenshot `before-2-eye-hijacked-to-tmdb.png`); with none present it's a silent no-op (observed live on the local dev instance, whose fresh local KV had zero TMDB lists). Either way it's a trap button.

**Why it matters:** silent wrong-list state mutation plus disorienting tab hijack on the admin surface you use daily.

**Fix applied:** render the eye only when the active tab is TMDB (`nameEditBlock`, src/configure.js). One conditional; no signature/caller changes.

**Brainstorm (15 considered, condensed):**
hide-on-non-TMDB ✅ · module-aware preview routing (feature build) · remove preview everywhere (loses feature) · move eye to TMDB-only controls row · early-return guard inside toggleTmdbPreview (still leaves dead button) · disabled+tooltip rendering (visual noise) · split nameEditBlock in two (refactor churn) · opts-flag param from renderTmdb (equivalent, more plumbing) · global delegated clicks (over-rearchitecture) · CSS-hide via body[data-module] (JS still wired, fragile) · replace all inline onclick with listeners (rewrite of UI conventions) · real previews for every module (scope creep) · server-side strip (can't know client tab state) · template-with-actions refactor (medium churn) · document-and-ignore (trap remains).
**Winner: hide-on-non-TMDB** — smallest diff, kills both the no-op and hijack variants, zero blast radius beyond the bug.

**Verification:** PASS — jsdom harness: eye count 3→0 on scraper/official/simkl tabs, still 1 on TMDB cards; hijack repro flips title before-fix, impossible after (button gone). Live headless Edge against patched `wrangler dev`: 0 stray eyes on all three non-TMDB tabs, save/rename/refresh flows unchanged. Suites: dry-test + verify-tmdb + verify-ui ALL PASS on patched copy.

---

#### M2 — tmdb.mjs is the only generator whose failures show GREEN on GitHub Actions

**Plain language:** When the scraper, official, or SIMKL jobs finish with failures, they deliberately exit with a "failed" signal so the run shows red on GitHub and you notice. The TMDB generator was the odd one out: it recorded failures into your status page but then exited "success" — so a night where every TMDB list failed to generate would look like a perfectly green run on GitHub, and you'd only find out by manually checking the status page.

**Why it matters:** silent-failure visibility gap on a public-data-producing pipeline; contradicts the explicit convention its three siblings follow.

**Fix applied:** after recording runs, if any result failed and the script is running as a CLI (not imported by tests), set `process.exitCode = 1`. Also removed the dead `readExistingHash()` and corrected the misleading fill-mode comments (in-script docstring; the matching stale comment in `tmdb.yml` should be updated when applying — noted in action list).

**Brainstorm (15, condensed):**
process.exitCode=1 guarded by isMain ✅ · process.exit(1) exactly like siblings (**tested — hard-crashes Node v26.5.0/Windows inside completing async main: libuv assertion; rejected on evidence**) · throw after recordRuns (breaks import-mode tests) · unconditional exitCode (breaks tests importing main) · parse Summary stdout in YAML (brittle bash) · marker-file handshake with commit step (clunky) · interpret result object in the isMain bootstrap wrapper (equivalent, splits logic) · console.error only (no CI effect) · dedicated YAML verification step (parsing again) · abort remaining lists on first failure (behavior change) · combined exit/exitCode sibling-mirror (same crash) · per-catch exitCode (scattered, same net) · top-level catch sets exitCode (extra indirection) · rely on /status alone (status quo problem) · auto-retry failed lists (masks signals, scope creep).
**Winner: exitCode-under-isMain** — correct semantics for a main() that returns naturally; verified live after the crash finding disqualified the literal-sibling approach.

**Verification:** PASS — deterministic end-to-end: mock `/export-config` server feeding one list, dummy token → real TMDB 401. Original script: logs `[tmdb_discover_movie_exitcod1] failed: TMDB 401…` then **exit 0** (green). Patched script: identical failure log, **exit 1** (red). Success path untouched (failure branch only). Suites re-run post-edit: ALL PASS. Honest note: this fix also caught and fixed a flaw in my *own first attempt* (filter keyed on wrong field shape) — exactly what the before/after discipline is for.

---

#### M3 — One bad record in a `/runs` batch could throw away its healthy siblings; corrupted history could take down `/status`

**Plain language:** After each scraping job, the CI scripts phone home to `/runs` with a bundle of run records ("popular movies: success, 200 items", etc.). Two fragilities existed: (a) the records were processed in one all-or-nothing try/catch — if writing record #2 hit a transient storage error, record #3 was never attempted and the whole request answered "failed," even though #1 was already saved and #3 was perfectly fine; (b) the status page reads those stored records back without any protection, so if that stored history ever became unreadable garbage, opening `/status` would crash the whole request instead of showing an empty or partial table. Also: run-record ids were built from millisecond timestamps plus a random offset and could collide (cosmetic today, latent tomorrow). Fix isolates each record (one bad apple no longer spoils the batch), tolerates corrupted/non-array stored history on both read and write (mirroring how config loading already defends the exact same failure), and switches ids to proper unique ones.

**Why it matters:** this is the ingestion path for the only monitoring this system has; its fragility directly degrades your ability to see silent scrape death (already flagged as the system's biggest operational blind spot).

**Fix applied:** per-record try/catch in `handleRunsPost`; `crypto.randomUUID()` ids; defensive guards in `addRun`/`getRuns` (`Array.isArray` + swallow-corrupt like `loadConfig` does).

**Brainstorm (15, condensed):**
per-record isolation + uuid ✅ · upfront validation rejecting whole batch (harsher contract; siblings lost anyway on later KV fault) · trust-the-scripts (status quo) · whole-batch retry (duplicate partial writes) · Durable Object serializer (new infra for history cosmetics) · unique-key-per-batch + merge-on-read (schema ripple through /status + 4 scripts) · waitUntil background writes (still racy) · smaller chunk cap (doesn't address blast radius) · extract normalizeRunRecord helper (nice refactor; foldable later) · return {stored,skipped} summary (API shape change nobody consumes) · rate-limit /runs (orthogonal/auth-closed) · HMAC-signed /runs (auth-closed territory) · append-only blob (breaks RUNS_MAX cap design) · KV compare-and-swap loop (Workers KV has no CAS primitive — impossible as stated) · accept-as-is (leaves hole).
**Winner: per-record isolation + uuid + corrupt-KV guards** — cuts the real blast radius with zero contract changes; verified both directions.

**Verification:** PASS — failing-KV simulation mid-batch: original → HTTP 500, third record never attempted; patched → HTTP 200, records 1&3 ingested, bad one skipped. Corrupt-value KV: patched getRuns/addRun survive, `/status` returns usable 200 where original threw (unhandled → Cloudflare error page). Same-millisecond ids now unique. Suites: ALL PASS.

---

#### M4 — Two outbound calls in the Worker had no timeout

**Plain language:** Everything in this project that talks to the internet uses a built-in watchdog ("give up after N seconds") — every script fetch, everywhere. Two spots in the Worker skipped it: the TMDB proxy used by the admin page's search/preview (which can fire dozens of sequential requests per click) and the GitHub dispatcher behind Save/Refresh. Without a watchdog, a hung connection just sits there until the platform eventually kills the whole request — slow, opaque failures instead of fast clear ones. The repo's own conventions doc states fetches always carry this watchdog; these two violated that.

**Why it matters:** worst case compounds on the preview endpoint's fan-out; and Save/Refresh stalling gives you no feedback versus a crisp error message.

**Fix applied:** `AbortSignal.timeout(30000)` on the TMDB proxy fetch, `(15000)` on the GH dispatch fetch — matching the values the scripts already use for the same upstreams.

**Brainstorm (15, condensed):**
signal.timeout constants at both sites ✅ · shared TIMEOUT constant module (two literals don't justify cross-module plumbing) · env-configurable timeouts (config creep) · global fetch wrapper injecting defaults (hidden magic) · platform limits only (status quo) · hand-rolled Promise.race (reinvents standard API) · retry-on-abort (masks incidents) · tighter 10s (legit slow pages exist; 30s matches scripts) · looser 60s (defeats purpose) · AbortController+timers (verbose equivalent) · guard only the heavy preview endpoint (inconsistent half-fix) · KV-backed circuit breaker (massively overkill) · egress queue limiter (overkill) · documentation-only (stays fragile) · architecture migration (unrelated).
**Winner: literal signal.timeouts** — restores stated convention with two-line diff; values copied from the scripts' proven choices.

**Verification:** PASS — stubbed-fetch capture proves both call sites now carry a live AbortSignal; normal responses unaffected; suites ALL PASS. (Runtime abort behavior itself relies on the standard platform API already used throughout `scripts/` — same mechanism, different side of the repo.)

---

#### M5 — Worker-level race: concurrent run-history writes lose records (REPRODUCED; recommendation: accept & document)

**Plain language:** When two run-history posts arrive at the Worker at the same moment, each one reads the stored history, adds its records, and saves the whole thing back. If their read-add-save cycles interleave, the second save stomps the first — the first writer's records vanish. This is a real, demonstrated race, not a theoretical one.

**Reproduction (deterministic):** gated fake KV forcing both readers to snapshot *before* either write, driving the actual unmodified production handler: two concurrent `POST /runs` → final stored history contains only the second writer's record. Logged as `RACE REPRO original … LOSE one writer's record — PASS` in the harness output.

**Why I'm recommending acceptance rather than a code fix (this is a judgment call you can overrule):** For this race to bite in production, two workflows must be writing run-history simultaneously — which the shared Actions concurrency group prevents *by design* (that's literally why the group exists, per the workflow comments). The residual exposure is the failure modes in §5 item 1 (queue feature misbehaving). Meanwhile every genuine repair costs real complexity: Durable Objects introduce new infrastructure; per-run KV keys reshape the schema consumed by the status page and all four scripts; Workers KV simply lacks the atomic operations a cheap fix would need. For a single-operator system whose worst-case symptom is *a missing row in a diagnostics list*, that trade doesn't clear the bar. The verified M3 hardening shrinks the adjacent blast radius (bad batches no longer nuke siblings), which is the portion worth paying for now.

**Decision options weighed (15, condensed):** accept+document ✅ · Durable Object append serializer · unique-key-per-post + merge-on-read · read-write-read-verify retry loop · isolate-local single-flight lock (ineffective across colos) · atomic-counter trick (KV can't) · migrate runs to D1 · R2 append-log · fewer/larger script batches · staggered crons (complementary, not curative) · per-module concurrency groups (reintroduces cross-group races) · lock-artifact files between runs (racy itself) · client-side merge in scripts (moves race, worsens) · chain workflows via `needs` (couples them) · silent ignore (chosen option minus the documentation).
**If you disagree and want a real fix:** the durable-options winner among these is unique-key-per-post with capped merge-on-read — moderate schema churn, no new infra. Happy to spec it separately.

**Honesty notes:** the patched copy retains the same underlying race (guards don't claim otherwise — verified: identical loss under forced interleave). Fully local verification of the *production* timing is inherently approximate; the reproduction is deterministic by construction rather than observed in the wild.

---

### 6.3 Minor findings

Where marked **[fixed]**, the change is in the verified patch bundle; otherwise it's recorded for a future pass.

| # | Finding | Plain language | Status |
|---|---|---|---|
| m1 | Dead code cluster | `emptyConfig()` (config.js:53), `randomTmdbListId()` (config.js:32) have zero callers; `routes.js` imports `randomTmdbListId` without using it; configure.js had an unused server-side `escapeAttr` copy and two write-only variables (`tmdbCreateOpen`, `tmdbPreviewIndex`); tmdb.mjs's `readExistingHash` never called (removed via M2) | Server-side escapeAttr + vars **[fixed]**; `emptyConfig`/`randomTmdbListId` deletion **needs your sign-off** because your local-only `dry-test.mjs` imports them (unused) and would crash until edited — caller-change rule |
| m2 | `routes.js:203` hardcodes `"runs:official"` while sibling branches use imported constants | Same value spelled two ways; drift waiting to happen | **[fixed]** — now uses `OFFICIAL_RUNS_KEY`, which also un-orphans that export |
| m3 | TMDB catalog-id string rebuilt inline in 3 places (`buildManifest`, `handleCatalog`, `handleTriggerRefresh`) | One typo away from a catalog that won't resolve; extracted `tmdbCatalogId()` helper | **[fixed]** |
| m4 | `saveAll` posts UI-state bloat (cached preview items, flags) inside the save payload | Server strips unknown fields so it's correctness-neutral; wastes bytes on every save | Observation — suggested remedy (strip `preview*`/`count` keys client-side) trivial but touches the save path every press uses; left for a convenient moment |
| m5 | No caching of Pages catalog fetches | Every Stremio page-turn re-downloads the same JSON from GitHub Pages; `caches.default` with short TTL would cut latency/load | Observation — behavior tradeoff (staleness window) is yours to choose; map already sketches it |
| m6 | `toIST` hardcodes UTC+5:30 | Timestamps misrender for any non-IST viewer; fine if you're the only reader | Note only |
| m7 | Disabled-single-refresh answers 400 on scraper tab but 404 on other tabs | Cosmetic inconsistency in error codes for the same mistake | Note only |
| m8 | Most of the test suite is gitignored | Fresh clone gets only `verify-tmdb.mjs`; `dry-test`/`verify-ui` exist solely on your machine | Needs your decision: un-ignore them or accept |
| m9 | jsdom undeclared anywhere | Verify scripts fail on any machine without manual setup — including this one, until I installed it | Needs manifest change (forbidden during audit) — recommend adding to `scripts/package.json` devDeps or a root package.json |
| m10 | puppeteer-extra@3.3.6 predates Puppeteer v25; upstream hasn't declared v25 support | Locked puppeteer 25.4.0 works today (recent successful scrapes prove it), but a future minor bump could break the stealth wrapper silently | Watch item; pin awareness when updating |
| m11 | `queue: max` platform dependency | Whole serialization story rests on a 2026-05 feature; fallback cancels pending runs | Already in map; keep the after-first-simultaneous-window verification habit |
| m12 | Second TMDB cron commented out | TMDB regenerates once daily vs twice for others | Confirm intent (map already flags) |
| m13 | `MDBLIST_API_KEY` mounted into scrape.yml though the DOM scraper never reads it | Dead secret plumbing; confusing threat model | Map already flags; cleanup whenever convenient |
| m14 | `dry-test.mjs` write-then-delete cleanup deletes real tracked `data/*.json` if present locally | Running your own test suite on a clone that has catalog files will delete them from the working tree (they're restorable via `git checkout -- data/…`) | Discovered the hard way during baseline runs — restored immediately; consider pointing the roundtrip at temp paths |

### 6.4 Factual security record (closed decisions — recorded, not acted on)

Per your standing decision, recorded so it's on paper:
- **Unauthenticated endpoints:** `/save-config`, `/trigger-refresh`, `/export-config`, `/runs`, `/tmdb/*` accept anonymous traffic. Anyone who learns the workers.dev URL could rewrite config, trigger Actions runs, read full config, or forge run history.
- **Amplifier:** every response carries `Access-Control-Allow-Origin: *`, meaning *any web page you visit* could also read `/export-config` cross-origin (no URL-guessing needed, just knowledge of the subdomain). This is the same accepted exposure viewed from a different angle — noting it because it slightly widens who "anyone" is. Still closed per your instruction; no auth/CORS fix proposed.
- Catalog-serving path is unaffected by all of the above (public by design, served from Pages).

---

## 7. Verification log (what was actually done, and how to re-run it)

**Isolation guarantee:** all patches lived in `%TEMP%\opencode\mylist-audit\` (full copy of `src/` + `scripts/`, junction to node_modules). The real repo received **zero source modifications**; `git status` clean before/after; `main` untouched; no real workflow dispatched (local dev instances have no `GH_TOKEN` — dispatches fail fast with "not configured", confirmed empirically before any testing).

| Step | Command / method | Result |
|---|---|---|
| Dependency audit | `npm audit` in `scripts/` (npm + package-lock.json confirmed as the manager) | 0 vulnerabilities (69 prod deps); tool severities n/a — nothing flagged. Cross-check: puppeteer family ships only to Actions runners, never the Worker runtime; Worker deps are zero-install (platform-provided) |
| Baseline suites (original code) | `node scripts/dry-test.mjs` · `node scripts/verify-tmdb.mjs` · `node scripts/verify-ui.mjs` | ALL PASS ×3 (after installing missing jsdom) |
| Patched suites | Same three commands against temp copy, run twice more after later patch edits | ALL PASS ×3, every time |
| Eye-button before/after (DOM-exact) | jsdom harness `audit-checks.mjs` (temp) injecting a TMDB list at shared index | Before: 3 eyes on scraper tab; click → header becomes "TMDB List" (hijack). After: 0 eyes on non-TMDB tabs, 1 preserved on TMDB cards |
| Eye-button live (headless Edge via playwright-core) | `driver.cjs http://127.0.0.1:8787 … before` (your running dev instance) and `:8788` (patched temp instance) | Before: 3 stray eyes; click = no-op here (fresh local KV has no TMDB lists — matches the second predicted variant). After: 0 stray eyes; Save/Rename/Refresh flows byte-for-byte same messages. Screenshots in `%TEMP%\opencode\shots-before\` & `\shots-after\` (ephemeral; textual results above are the record) |
| M2 before/after (real CLI) | Mock `/export-config` server (127.0.0.1:8799) + `node tmdb.mjs --ids=tmdb_discover_movie_exitcod1` with dummy token → genuine TMDB 401 | Original exits **0** despite logged failure; patched exits **1**. First patched attempt exposed my own filter bug (wrong field) and a Windows/Node-26 crash with literal `process.exit(1)` — both caught *by* this verification and corrected |
| M3 before/after | `audit-checks2.mjs`: flaky-KV (put throws on 2nd write) + corrupt-value KV + getter-poison attempts | Original: HTTP 500, sibling record lost, `/status` crashes. Patched: HTTP 200, siblings kept, poison skipped, `/status` survives, uuid ids unique |
| M4 | Stubbed fetch capturing init args | Both call sites carry live AbortSignal; happy-path responses unchanged |
| M5 race reproduction | Gated KV forcing both writers' reads before either write, driving the real unmodified handler | Deterministic loss reproduced (1 of 2 records survives). Patched code shown to retain same race (documented honesty, not a regression) |
| Concurrent double-refresh (Worker level) | Two truly parallel `POST /trigger-refresh` against patched dev instance | Both HTTP 501 in 29 ms, reasons identical, `/export-config` byte-identical before/after → no worker-side shared-state mutation under overlap; execution-order effects live entirely in the Actions queue (§5) |
| Regression sweep (rule 7) | Siblings/consumers of every touched function: dry-test covers save-dispatch ordering, runs-key routing, status shapes, hash gating; verify-ui covers rename/pointer flows; driver exercised Save/Rename/Refresh end-to-end | No regressions detected |
| Environment restoration | Restored 4 tracked `data/*.json` deleted by dry-test's cleanup (m14); killed only my 8788 instance (your 8787 session left running) | `git status --porcelain` → empty; last commit unchanged (`0c7655e`) |

**Unverifiable-locally disclosures:** (a) real mdblist DOM behavior/bot-detection timing under actual Actions resources; (b) whether `queue: max` is active on your plan (needs one real simultaneous-cron window to observe — deliberately not triggered); (c) production KV timing characteristics. Everything else claimed above was executed and observed, not argued.

---

## 8. Prioritized action list

**Apply now (Critical + Moderate, fully verified safe):**
1. Apply the verified patch bundle M1+M2+M3+m1(partial)+m2+m3 (+ the two-line `tmdb.yml` comment correction that belongs to M2). Exact diffs are in the temp workspace and mirror the descriptions above; every piece passed the existing suites plus targeted before/after checks.
2. Re-run the three suites after applying (`node scripts/dry-test.mjs && node scripts/verify-tmdb.mjs && node scripts/verify-ui.mjs`) — expected: ALL PASS, as observed against this exact bundle.

**Needs your input before proceeding:**
3. M5 verdict — accept-and-document (recommended), or commission the unique-key-per-post redesign.
4. m1 completion — deleting `emptyConfig`/`randomTmdbListId` requires editing your local-only `dry-test.mjs` imports (caller change rule).
5. m8/m9 — decide whether dry-test/verify-ui become tracked, and where jsdom gets declared. Until then: fresh clones can't run most tests.
6. m12 — confirm the once-daily TMDB cadence is intentional.

**Optional cleanup (Minor):** m4 payload slimming · m5 catalog caching (choose staleness tolerance first) · m6/m7 consistency polish · m10 puppeteer-extra watch item · m13 dead secret plumbing · m14 dry-test temp-path cleanup · map corrections from §2.

**Left as-is by design:** authentication posture (§6.4, closed), git-overlap hardening (§5, explanation-only awaiting your go-ahead).

---

*Audit artifacts: temp workspace `%TEMP%\opencode\mylist-audit\` (patched copies, harnesses `audit-checks*.mjs`, `driver.cjs`, screenshots `shots-before/`·`shots-after/`). Nothing in the repository was modified by this audit except the addition of this report file.*
