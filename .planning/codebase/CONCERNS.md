# CONCERNS.md — my-list (Cloudflare Worker Stremio addon)

**Analysis Date:** 2026-09-03

Full-repo scan: `src/`, `scripts/`, `.github/workflows/`, `wrangler.toml`, `.gitignore`, `.dev.vars`, `.planning/codebase/*`. Known inline-documented concerns were verified against the code and are confirmed below with their acceptance dates.

<!-- refreshed: 2026-09-03 -->

## Summary

Severity counts: **3 high-exposure (accepted-by-design)**, **6 medium**, **5 low**, plus the accepted-debt ledger. No unaccepted *security-critical* finding was found; the sharpest risks are the three publicly-open control/data endpoints, which are load-bearing by design (GitHub Actions has no cookie) and therefore documented rather than fixed.

---

## 1. Security

### 1.1 POST /runs is public and spoofable — HIGH (accepted-by-design)
`src/routes.js:622` (`handleRunsPost`) and `src/auth.js:155` (`isPublic`): `POST /runs` requires no auth because `scripts/scrape.mjs` / `scripts/official.mjs` / `simkl.mjs` post run records from Actions with no browser cookie. Anyone can POST fake `{ runs: [...] }` rows (max 50/request, fields length-capped at `src/routes.js:640-649`) and pollute the status-page history (30-run window). Impact is limited to diagnostics display (no catalog data touched), but the history is falsifiable. Mitigations that would help: a shared run-ingest secret header, or origin-restricting to the Actions runner IPs (fragile). Not done — accepted; the module is single-operator.

### 1.2 /export-config exposes the full config publicly — HIGH (accepted-by-design)
`src/routes.js:501-504` + `src/auth.js:154`: `/export-config` is on the public list because workflows poll it for `configVersion` (`src/config.js:62-65`). It returns the entire migrated config: all list URLs, filters, simkl timezone, TMDB params. Contains no secrets (GH_TOKEN/MDBLIST_API_KEY/TMDB token are never persisted into KV config — verified: `src/dispatch.js:32` reads `env.GH_TOKEN` directly, never round-trips it). Exposure is thus information-only (list curation is visible to anyone who knows the URL). Accepted by design; if that ever changes, move workflow polling behind a static bearer token.

### 1.3 /status (HTML and JSON) is public — MEDIUM (accepted)
`src/auth.js:150`, `src/index.js:81-87`. Run history (catalog ids, error messages with up to 500 chars of scraper stderr context, IST timestamps) is readable by anyone. Error messages could leak internal URLs. Single-operator personal addon; accepted.

### 1.4 AUTH_ENABLED=false currently active in `.dev.vars` — HIGH (local-only, by intent)
`.dev.vars:8` sets `AUTH_ENABLED=false`; `.dev.vars:5` sets `ADMIN_PIN=123456`. The session gate is OFF on 127.0.0.1:8787 dev runs. `.dev.vars` is gitignored (verified: `git check-ignore .dev.vars` → ignored; `git ls-files` shows it is not tracked), so this cannot leak to prod. Production reads `AUTH_ENABLED` from the dashboard with `keep_vars=true` (`wrangler.toml:8`). The configure page surfaces the unlocked state deliberately (`src/configure.js:10-15`, the `auth-off-note`). Remaining risk: forgetting that dev origin is wide open if ever tunneled/exposed (e.g. `wrangler dev --show-remote-proxy`). Watch item, not a bug.

### 1.5 Session HMAC falls back to a public constant — MEDIUM
`src/auth.js:46`: `const secret = env.SESSION_SECRET || env.ADMIN_PIN || "change-me"`. If both `SESSION_SECRET` and `ADMIN_PIN` are unset while auth is enabled (the default is ON, `src/auth.js:145`), sessions are signed with the publicly-readable literal `"change-me"` — an attacker can forge a valid session cookie. In practice login also fails (empty PIN fails the `/^\d{4,12}$/` check at `src/auth.js:216`), so the gate stays shut, but forged cookies via a known HMAC key are still the wrong failure mode. Cheap fix: refuse to enable auth (or return 500 from `handleLogin`) when no secret material exists. Deployed instance presumably sets ADMIN_PIN; this is a latent-misconfiguration hazard.

### 1.6 CORS `*` on every JSON response incl. admin APIs — LOW (accepted)
`src/index.js:11-21` attaches `Access-Control-Allow-Origin: *` to all `json()` responses, including 401s from admin endpoints. Cross-site writes are blocked by `SameSite=Lax` cookies (`src/auth.js:220`) + JSON-only body parsing, so no CSRF hole in practice. Cosmetic permissiveness; fine for a single-operator service.

### 1.7 HTML CSP / nosniff inconsistency — LOW
`src/routes.js:32-42` (`html()` helper used for `/configure`) sends a full CSP + `nosniff`. But:
- `src/status.js:506-508` (`statusPageResponse`) sends only `content-type` + `cache-control` — no CSP, no `nosniff`.
- `src/auth.js:190-195` (login page) also sends neither.
All three pages render server-side strings with escaping (`esc()` at `src/status.js:32`, `escapeAttr` at `src/configure.js:898`, `escapeForOnclick` at `src/configure.js:2025`), and the inline state blob is `<`-hardened (`src/configure.js:8-9`), so this is defense-in-depth debt, not an active hole. Copy the CSP onto the other two `Response` sites.

### 1.8 Secrets hygiene — CLEAN
- `GH_TOKEN` is correctly absent from `wrangler.toml` (comment at `wrangler.toml:18-20` mandates the Cloudflare secret) and is read only in `src/dispatch.js:19,32`.
- `.dev.vars` is gitignored (verified) and holds local API keys — normal practice.
- `scripts/` workflow ymls reference `secrets.MDBLIST_API_KEY`, `secrets.TMDB_READ_ACCESS_TOKEN`, `secrets.SIMKL_CLIENT_ID`, `secrets.WORKER_ORIGIN` only — no hardcoded tokens in `.github/workflows/*.yml`.
- One nit: `.dev.vars` contains a real-looking TMDB read token and MDBList key on disk. Local-only; rotate if the disk is ever shared/synced.

---

## 2. Concurrency / race conditions

### 2.1 KV read-modify-write race in addRun/addRuns — MEDIUM (accepted 2026-08-23)
Confirmed at `src/config.js:513-521` (comment block) and the bodies at `src/config.js:523-536` (`addRun`) / `src/config.js:548-558` (`addRuns`): get → unshift → put with no lock. Two truly simultaneous writers interleave and lose one batch. Accepted because all four workflows share the single Actions concurrency group `my-list-scrape` (`.github/workflows/scrape.yml:45-52`, mirrored in the other three ymls), so legitimate writers are serialized; worst case is a missing diagnostics row. `queue: max` at `scrape.yml:53-60` additionally keeps simultaneous cron triggers from being canceled. Thorough fix (per-post KV keys + merge-on-read) deferred.

### 2.2 Same race exists in the login rate limiter — LOW
`src/auth.js:169-187` (`rateLimitLogin`) does read → increment → put per attempt with no atomicity; two concurrent logins from one IP can undercount. Also the global 60/window cap (`src/auth.js:167`) means an attacker can deliberately exhaust the *global* window and lock everyone out (minor self-DoS of the login page only). Accepted; counters are best-effort protection.

### 2.3 handleSaveConfig read-modify-write clobber — MEDIUM (accepted, single-operator)
`src/routes.js:256-258`: explicit comment — no lock on load-config → diff → dispatch → persist. Two overlapping saves from different tabs/clients silently drop one side's intent (and can double-dispatch the same regen). Accepted for a single operator; document as "one browser, one editor at a time".

### 2.4 loadConfig has write side effects on the read path — LOW
`src/config.js:415-505`: every read can PUT (`src/config.js:494-497`) when seeding/healing. A fresh KV hammered by reads stays consistent (writes converge after first persist), but a read endpoint triggering KV writes is surprising and costs an extra KV read for `HEALED_KEY` (`src/config.js:479`) on *every* call until healed. Fine at this traffic level; flag if scaling.

---

## 3. Fragile areas

### 3.1 `src/configure.js` — one giant template literal, 2267 lines — MEDIUM (fragile, high blast radius)
`buildConfigurePage` (`src/configure.js:5`) returns the entire admin UI — CSS + HTML + inline JS — as a single template literal. Hard constraints: no stray backticks, no unescaped `${` in embedded JS (regex literals containing `${`, template-literal examples in comments, etc. are live footguns). Diffing and reviewing UI changes is expensive (git log shows repeated whole-card UI fixes landing as massive single-commit diffs, e.g. `5a4b3f8`). Already paid down once (per-tab render functions, shared `state`), but the file remains the highest-risk edit target in the repo. Extraction into separate static assets would fix it, at the cost of the worker's zero-asset, single-file deploy story — hence not done.

### 3.2 IST string round-trip between routes.js and status.js — MEDIUM (fragile coupling)
`src/routes.js:58-67` (`toIST`) formats epoch → fixed-width `"DD-MM-YYYY hh:mm:ss AM/PM"` IST strings into the JSON feed; `src/status.js:37-43` (`istToEpoch`) regex-parses those strings back to epoch for "relative time" display. Epoch → string → regex → epoch loses timezone metadata and breaks silently (returns `null`, UI shows `-`) if either format ever drifts. Cleanest fix: emit raw `started_at`/`finished_at` epoch ms alongside the IST strings. Until then, the two functions must be edited as a pair (noted at `src/status.js:36`).

### 3.3 Duplicated constants between worker and scripts — LOW
- `tmdbContentHash` (`src/config.js:388-413`) must mirror `computeSourceHash` in `scripts/tmdb.mjs` (noted in both comments).
- `SANE_OFFICIAL_SLUG` (`src/config.js:163`) mirrors `SANE_SLUG` in `scripts/official.mjs`.
- `ACCENT_COLORS` exists twice: `src/configure.js:900` and `src/status.js:17-30` (status.js comment: "not importable — that file is one template literal"). Palette drift would silently desync the two pages' accent theming.
- `GITHUB_PAGES_BASE`/`GH_*` workflow filenames repeated as fallback constants in `src/routes.js:16-18`.
All are consciously duplicated; any change must sweep both sides.

### 3.4 `dispatch.js` retry comment drift — LOW
`src/routes.js:700-704`: the `ponytail:` comment says "single retry" but the loop (`attempt < 3`) makes **up to 3 attempts** (2 retries). Behavior is intentional for the flaky local network; the comment undercounts. Fix the comment, not the code.

---

## 4. Error-handling gaps

### 4.1 GitHub Pages catalog fetch has no timeout — LOW
`src/routes.js:193-198` (`handleCatalog`): `fetch(githubPagesCatalogUrl(...))` has no `AbortSignal.timeout`, unlike `src/dispatch.js:38` (15 s), `src/routes.js:712` (TMDB, 30 s), `src/routes.js:952` (MDBList, 20 s). A hung Pages connection stalls the Stremio catalog request until platform kill. Failures do degrade to `{ metas: [] }` correctly. Add the same timeout pattern for consistency.

### 4.2 Silent catch-everywhere style — LOW (accepted)
KV reads (`src/config.js:418-421, 526-533, 579-584`), Pages fetches, and cache writes (`src/routes.js:960`) all swallow errors into safe defaults ("corrupt KV → seeds / empty history"). This is deliberate fail-open hardening (documented in each comment) and each failure mode is non-destructive, but it also hides operational errors — a persistently broken KV looks like "no history" rather than an alert. Acceptable at this scale; would want logging/metrics if it ever mattered.

---

## 5. Performance / efficiency

### 5.1 /status HTML loads: 8 KV reads where 2 would do — MEDIUM (known, accepted)
`src/status.js:198-203` (`statusPageResponse`) calls `handleStatus` 4× (once per module via `moduleRuns` at `src/status.js:83-86`). Each `handleStatus` (`src/routes.js:208-245`) does `loadConfig` (config KV get + `healed` KV get, `src/config.js:479`) **plus** one runs-key get → net ≈ 8+ reads per page load vs the theoretical 2 (one config + four runs keys, i.e. ~5–10 total if loaded once and shared). Confirmed. Header comment at `src/status.js:5` says the JSON contract was preserved intentionally to keep the data path untouched. Latency impact is small (parallelizable, KV is fast); refactor = load config once + read all four runs keys directly, bypassing `handleStatus`.

### 5.2 No caching of GitHub Pages catalog fetches — MEDIUM (audit item m6, owner decision)
`src/routes.js:194`: every Stremio page-turn re-downloads the catalog JSON from Pages. `caches.default` with a short TTL would cut latency/load at the cost of a staleness window. Listed in `.planning/codebase/FUNCTIONAL-AUDIT.md` (m-series table) as an owner-decision observation.

### 5.3 Per-request `loadConfig` on every route — LOW
8 call sites in `src/routes.js` (lines 70, 179, 213, 258, 502, 507, 677, 937). Each request to `/manifest.json`, `/catalog/*`, `/status*`, `/save-config`, `/trigger-refresh`, `/export-config` re-reads config from KV. KV reads are cheap and strongly consistent at the edge; at this traffic level this is fine. Only worth revisiting alongside 5.2.

---

## 6. Ops / config drift

### 6.1 `keep_vars=true` + `[vars]` in wrangler.toml — MEDIUM (drift risk)
`wrangler.toml:6-8, 15-24`: `keep_vars=true` preserves dashboard-only vars across `wrangler deploy`, while the `[vars]` block (`GITHUB_PAGES_BASE`, `GH_REPO`, `GH_WORKFLOW`, `GH_OFFICIAL_WORKFLOW`, `GH_TMDB_WORKFLOW`) overwrites same-named vars on every deploy. Two consequences:
- A var changed in the dashboard (e.g. someone retargets `GH_REPO`) is silently reverted by the next deploy if it also exists in `[vars]` — and survives silently if it doesn't. **Vars drift between the dashboard and the file with no single source of truth.**
- `env.GH_REF` is read at `src/dispatch.js:40` (`env.GH_REF || "main"`) but never declared anywhere in `wrangler.toml` or docs — an implicit default only discoverable from code.
- `GH_SIMKL_WORKFLOW` likewise has no `[vars]` entry (`src/routes.js:373` falls back to the constant `SIMKL_WORKFLOW`). Consistent, but undeclared.
Accepted for a single-operator setup; document "dashboard vars are canonical for secrets, wrangler.toml for plain vars" somewhere visible.

### 6.2 Single KV namespace for everything — LOW (accepted)
`wrangler.toml:11-13` binds one namespace (`STORE`) for: `config`, `runs:{scraper,official,simkl,tmdb}`, `healed`, `rl:login:*` (windowed, expiring), `cache:mdblist-official` (`src/routes.js:930`). Prefixes are disjoint so collision risk is theoretical; the real cost is shared capacity/latency stats and no per-domain eviction. Fine at this scale.

### 6.3 No root `package.json` / no lint / no typecheck — LOW
Worker source is zero-dependency by design (`src/auth.js:2`), so the absence of a root manifest is intentional, but it also means there is no `npm run lint`/`typecheck` gate at all. Verification lives entirely in gitignored scripts (see 6.4). Deploy correctness rests on `wrangler deploy` succeeding + manual UI checks.

### 6.4 `testing/` and `audit/` gitignored; scratch-only verification — MEDIUM (audit item m8, accepted)
`.gitignore:5,9,20` excludes `scratch/`, `audit/`, `testing/`. The real test suite (`testing/dry-test.mjs`, `testing/save-config.test.mjs`, `testing/scrape-serve.test.mjs`, `testing/tmdb-sort.test.mjs`, `testing/verify-ui.mjs`) imports live `src/*` modules but exists only on this machine — a fresh clone cannot run any of it (only `testing/verify-tmdb.mjs` is tracked, per FUNCTIONAL-AUDIT m8). `scratch/` holds the UI-verification tooling (playwright-style probes, screenshots, live-test logs). Acceptance was recorded in FUNCTIONAL-AUDIT; revisit if this repo ever gains a second contributor.

### 6.5 No README.md — LOW (docs drift confirmed)
`README.md` does **not exist** at the repo root (verified). Docs live in `.planning/codebase/*` (ARCHITECTURE, STACK, STRUCTURE, CONVENTIONS, INTEGRATIONS, TESTING, FUNCTIONAL-AUDIT) and `PRODUCT.md` (gitignored). Nothing at root tells a fresh visitor what the worker is, what env vars/secrets are required, or how to deploy — the deployment knowledge is scattered across `wrangler.toml` comments, workflow comments, and `.planning/` docs.

---

## 7. Known-item verification ledger

| Known concern (from brief) | Verified? | Location | Status |
|---|---|---|---|
| addRun/addRuns KV race (accepted 2026-08-23) | ✅ | `src/config.js:513-521` | Confirmed + serialized by Actions concurrency group (§2.1) |
| handleSaveConfig RMW clobber (accepted) | ✅ | `src/routes.js:256-258` | Confirmed, single-operator accepted (§2.3) |
| configure.js giant template literal | ✅ | `src/configure.js` (2267 lines) | Confirmed fragile (§3.1) |
| handleStatus 4× per status HTML (8 KV reads) | ✅ | `src/status.js:198-203` | Confirmed accepted inefficiency (§5.1) |
| AUTH_ENABLED=false in .dev.vars | ✅ | `.dev.vars:8` | Confirmed, gitignored, local-only (§1.4) |
| /status, /export-config, POST /runs public | ✅ | `src/auth.js:147-157` | Confirmed; spoofability of /runs real but cosmetic (§1.1–1.3) |
| Orphaned runs / eviction | ✅ | `src/config.js:562-576` (`capRuns` with `liveIds`), `src/routes.js:659-685`, commit `be9a2be` | **Resolved** — orphan-aware eviction live at ingest |
| testing/ + audit/ gitignored | ✅ | `.gitignore:5,9,20` | Confirmed; m8 accepted (§6.4) |
| README drift | ✅ | repo root | README.md absent entirely (§6.5) |
| Single KV namespace | ✅ | `wrangler.toml:11-13` | Confirmed, prefixes disjoint (§6.2) |
| GITHUB_PAGES_BASE + keep_vars drift risk | ✅ | `wrangler.toml:6-24` | Confirmed drift surface, incl. undeclared `GH_REF` (§6.1) |
| GH_TOKEN never in wrangler.toml | ✅ | `wrangler.toml:18-20`, `src/dispatch.js` | Clean — secret only via Cloudflare |

## 8. Newly found (not in the brief)

| Concern | Severity | Where |
|---|---|---|
| Session HMAC `"change-me"` fallback when secrets unset | Medium | `src/auth.js:46` (§1.5) |
| IST-string round-trip coupling routes↔status | Medium | `src/routes.js:58`, `src/status.js:37` (§3.2) |
| Missing CSP/nosniff on /status + login pages | Low | `src/status.js:506`, `src/auth.js:190` (§1.7) |
| No timeout on GitHub Pages catalog fetch | Low | `src/routes.js:194` (§4.1) |
| Login rate-limiter RMW race + global-window lockout | Low | `src/auth.js:169-187` (§2.2) |
| "single retry" comment vs 3-attempt loop | Low | `src/routes.js:700-705` (§3.4) |
| loadConfig write-on-read side effects | Low | `src/config.js:494-497` (§2.4) |
| `ACCENT_COLORS` duplicated across non-importable files | Low | `src/configure.js:900`, `src/status.js:17` (§3.3) |

---

*2026-09-03 concerns analysis of the full my-list repo.*
