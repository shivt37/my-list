# CONVENTIONS.md — my-list (Cloudflare Worker Stremio addon)

**Analysis Date:** 2026-09-03

Full-repo scan of `src/*.js`. Runtime: Cloudflare Workers (module syntax, ES2022+).
Zero runtime dependencies — Node stdlib (`node:crypto`) + Workers globals
(`crypto.subtle`, `KVNamespace`, `fetch`, `Request`, `Response`).

<!-- refreshed: 2026-09-03 -->

## File map

| File | Lines | Role |
|---|---|---|
| `src/index.js` | 123 | Thin router: path/method match → handler. Default export `fetch(request, env)`. |
| `src/routes.js` | 978 | Stremio routes (manifest/catalog/status) + save/export/refresh/runs + TMDB live helpers + MDBList proxy. |
| `src/config.js` | 585 | KV storage, migrate/normalize functions, seeds, content hashes, run history. |
| `src/dispatch.js` | 55 | GitHub Actions workflow dispatch (single funnel for save/refresh/runs). |
| `src/auth.js` | 394 | Session gate: HMAC cookie, constant-time PIN, KV rate limit, login page. |
| `src/configure.js` | 2392 | The whole /configure page: one giant template literal (CSS + HTML + inline JS). |
| `src/status.js` | 509 | Server-rendered /status HTML page wrapping `handleStatus`. |

## Formatting

- **2-space indent** everywhere, including inline CSS/JS inside `configure.js`.
- **Line width** unbounded (long single-line `if` returns, long comments, giant
  seed URLs kept byte-identical in `src/config.js` SEED_LISTS).
- **const-first**; `let` only for genuinely re-bound values. No `var`.
- **Named exports** throughout (`export function`, `export const`). The single
  `export default` is the worker `fetch` handler in `src/index.js`.
- **One handler per route**, exported from `src/routes.js`, wired by hand in
  `src/index.js` (no router library, no middleware chain).
- Arrow functions for short callbacks, `function` declarations for top-level
  exports; async/await only, no `.then` chains except tiny KV reads
  (`src/auth.js` rate limiter).
- No linter/formatter config in the repo — conventions are enforced by review,
  not tooling.

## Quote rules (per file — deliberate)

- `src/routes.js`, `src/config.js`, `src/auth.js`, `src/status.js`,
  `src/dispatch.js`, `src/index.js`: **double quotes**; template literals used
  freely (URLs, KV keys, log strings).
- `src/configure.js`: the file body is **one giant template literal** (lines
  18–2391). Constraint: **NO backticks or `${` inside the page markup/inline
  script** — anything nested would terminate or leak the outer literal.
  - Inline JS uses **single quotes** + `+` concatenation:
    `'rgba(' + rgb + ',' + dim + ')'` (src/configure.js:920).
  - Only the outer wrapper and the two state-injection lines use backticks
    (`const initial = JSON.stringify(config).replace(/</g, "\\u003c");`,
    `const ORIGIN = ${JSON.stringify(origin).replace(/</g, "\\u003c")};`,
    src/configure.js:890-891).
  - Inline `on*` handler attributes need JS-in-HTML-in-JS quotes — use `\'`
    escaping at one nesting: `onchange="updateList(' + i + ', \'url\', this.value)"`
    (src/configure.js:1051); two levels for generated strings:
    `'\\\'url\\\''` (src/configure.js:1166).
  - `src/status.js` intentionally avoids importing `configure.js` for shared
    values ("that file is one template literal - not importable") and mirrors
    `ACCENT_COLORS` by hand with a keep-in-sync comment (src/status.js:15-30).

## Naming

- `camelCase` for functions/variables; `UPPER_SNAKE` for module constants
  (`RUNS_MAX`, `SESSION_TTL_DEFAULT_MS`, `ADMIN_PREFIXES`).
- Route handlers: `handle*` (`handleSaveConfig`, `handleRunsPost`).
- Mappers: `rowToMeta*` per data-shape (`rowToMetaOfficial`, `rowToMetaSimkl`,
  `rowToMetaTmdb`).
- Normalizers/migrators: `normalize*` returns sanitized value or `null`
  (caller filters); `migrate*` maps-and-filters a persisted section.
- Builders: `buildManifest`, `buildConfigurePage`.
- Exported `*_KEY` constants pair with a `runsKeyFor(catalogId)` router
  (`src/config.js:18-23`).
- Finding IDs from audits (`F#`, `S#`, `B#`, `O#`, `R#`, `UI-F#`, `M#`) appear
  only in comments, never identifiers.

## Comments — WHY-first, dated, audit-traceable

- Every file opens with a purpose contract comment (e.g. `src/index.js:1-4`
  states "no scheduled handler - schedules are the workflows' own cron
  lines").
- **Owner decisions carry dates**: "Owner request 2026-08-24: enabling an
  official list regenerates its data immediately" (src/routes.js:286),
  "Owner request 2026-08-25: movies without a release date are dropped"
  (src/routes.js:760), "Owner request 2026-08-26: releaseInfo shows the full
  release date" (src/routes.js:123).
- **Finding IDs** pin changes to audit reports: `F2` dispatch ordering,
  `F3`/`F3A-1` configVersion + delete-dispatch root cause, `F10` best-effort
  cleanup, `F17` dead-export deletion, `F19` batched runs, `F20` 400/500
  classification, `S5` no-op refresh, `B1`–`B15` bug fixes
  (`src/routes.js`, `src/config.js`, `src/configure.js` throughout).
- **Accepted limitations are declared, dated, and scoped** — e.g. the KV
  read-modify-write race above `addRun` ("accepted 2026-08-23 - see
  .planning/codebase/FUNCTIONAL-AUDIT.md M5 ... Revisit only if that group
  ever loosens", src/config.js:516-521).
- **Deleted code gets a tombstone**: "F17: randomTmdbListId deleted - zero
  callers ... dead exports rot the surface API" (src/config.js:36-37);
  same for `isAuthRoute` (src/auth.js:158-159).
- **Deliberate simplifications use the `ponytail:` marker** naming the ceiling
  and upgrade path: single-retry TMDB fetch ("Remove when local networking is
  stable", src/routes.js:700-703); minimal inline undo toast ("R7's S13 toast
  system replaces this widget", src/configure.js:1289-1290).
- CSS sections in `configure.js` use `/* ── SECTION ── */` banners; JS uses
  `// ── Section ──` / `// ─── Section ───` banners (src/config.js:513,
  src/auth.js:23,44,72,100,140,164,189,243).

## Error handling

- **Defensive KV reads — corrupt value degrades to empty, never throws.**
  `loadConfig` wraps `kv.get(..., "json")` in try/catch → seeds
  (src/config.js:417-421); `addRun`/`addRuns`/`getRuns` wrap identically and
  fall back to `[]` with a "corrupt KV value → empty history rather than a
  thrown 500" comment (src/config.js:523-536, 578-585). Non-array JSON also
  treated as absent.
- **Degradation over 500s for read paths**: `handleCatalog` returns
  `{ metas: [] }` on fetch failure, non-OK, or bad JSON
  (src/routes.js:192-199); unknown catalog id → empty 200 by contract
  (B11, src/routes.js:186-190).
- **Fetch timeouts on every outbound call** via `AbortSignal.timeout`:
  15s GitHub (src/dispatch.js:38), 30s TMDB (src/routes.js:712), 20s MDBList
  (src/routes.js:952). Comment states why (bound a hung connection).
- **Error classification at the body-parse boundary**: `SyntaxError` → 400
  with actionable message; everything else → 500 (`F20`, src/routes.js:491-497;
  same pattern in preview, B15, src/routes.js:917-922).
- **Rollback-by-order in save flow**: all regenerative dispatches fire first,
  destructive cleanups last, persist is the final step — any dispatch failure
  returns 502 and nothing was written (F2, src/routes.js:353-450). One
  deliberate exception is flagged `F10`: failed official-cleanup dispatch
  returns 200 + `officialCleanupPending` instead of vetoing (src/routes.js:411-426).
- Swallowed errors always carry a justification comment
  ("Skip the bad record; keep ingesting the rest of the batch",
  src/routes.js:653-655; "One key's write failing must not drop the other
  keys' records", src/routes.js:663-665).
- `console.warn`/`console.log` for non-fatal diagnostics only.

## Input validation / clamping at trust boundaries

All untrusted input (KV JSON, request bodies) passes through a migrate/normalize
layer before use — the raw shape never reaches logic:

- `migrateConfig` (src/config.js:288-304): list id regex
  `/^mdb_scrape_[A-Za-z0-9_-]{1,32}$/` explicitly blocks path traversal
  (`"mdb_scrape_a/../../../x"` comment); `maxPages` clamped
  `Math.min(50, Math.max(1, Math.floor(...)))`; `name` trimmed + `.slice(0, 200)`
  with `"Untitled"` fallback; `url` `.slice(0, 2000)`; type binary-coerced.
- `migrateOfficial` (src/config.js:223-239): `SANE_OFFICIAL_SLUG` regex
  (`/^[a-z0-9][a-z0-9-]{0,63}$/`, mirrors `scripts/official.mjs`), slug dedupe,
  `MAX_OFFICIAL_LISTS` cap (30), junk entries dropped silently.
- `normalizeTmdbList` (src/config.js:318-368): `discoverListId` regex
  `/^[a-z0-9]{8}$/`, sort allowlist `TMDB_SORTS`, numeric-array filters
  (`Number.isFinite`), name arrays index-aligned and truncated, movie-only
  dimensions coerced off series lists (B4).
- `normalizeTiers` (src/config.js:246-259): only `Number.isFinite` fields kept;
  **empty tiers dropped** (an empty `{}` tier would vacuously pass every title).
- `normalizeTz` (src/config.js:72-81): validates via the platform's own tz
  database (`Intl.DateTimeFormat` throws → heal to "UTC").
- `handleRunsPost` (src/routes.js:622-671) — trust-boundary sanitization:
  batch cap 50 records; per-record try/catch (malformed record skipped, never
  poisons siblings); every field type-guarded (`Number.isInteger` + `>= 0`,
  `String(...).slice(0, 64)` for catalog_id, `.slice(0, 500)` for
  error_message, status/triggered_by binary-coerced); per-key write
  try/catch so one history key's failure can't drop others.
- Client side mirrors the clamp where it edits the same fields
  (`setTier` clamps and writes back, src/configure.js:1588-1604; create-row
  maxPages clamp, src/configure.js:1264-1266).

## Escaping / XSS

- Server-side HTML: `esc()` in `src/status.js:32-34` (entity-encodes
  `& " < >`); applied to every interpolated dynamic value.
- Client-side generated markup: `escapeAttr()` in `src/configure.js:898-900`;
  `escapeForOnclick()` layers apostrophe escaping on top for strings placed
  inside inline `onclick` attributes (src/configure.js:2023-2026).
- Embedded JSON into `<script>`: `</script>` escape via
  `.replace(/</g, "\\u003c")` with the WHY comment
  (src/configure.js:6-9, 890-891).
- HTML responses carry a strict CSP header in the shared `html()` helper
  (`default-src 'self'; ... frame-ancestors 'none'`, src/routes.js:32-42);
  all JSON responses set `x-content-type-options: nosniff` and CORS `*`.
- Cookie: `HttpOnly; Secure; SameSite=Lax`, `cache-control: no-store`
  (src/auth.js:220-229).

## Auth & security patterns (src/auth.js)

- Stateless HMAC-signed session cookie (`version|exp|pinfp|nonce`), verified
  with `crypto.subtle.verify` (spec-guaranteed constant-time); length checked
  before verify to avoid a length oracle (src/auth.js:61-70).
- Constant-time PIN comparison with equal-length XOR accumulator; on length
  mismatch, burns a SHA-256 digest so timing doesn't leak length
  (src/auth.js:76-90).
- Fail-secure defaults: `AUTH_ENABLED` absent/misspelled = ON
  (src/auth.js:144-146); PIN rotation revokes sessions via fingerprint.
- KV fixed-window rate limit, per-IP + global, best-effort puts with
  `.catch(() => {})` (src/auth.js:169-187).

## Recurring patterns

- **Single source of truth helpers** stop id drift: `tmdbCatalogId`
  (src/config.js:32-34), `runsKeyFor`, `officialCatalogsFor`. Mirror
  implementations in `scripts/*.mjs` carry explicit "Mirrors ...
  in scripts/... (same field set)" comments (src/config.js:387).
- **Content hashes gate regeneration**: `listContentHash` excludes `name`
  (rename must not re-scrape, src/config.js:375-383); `tmdbContentHash`
  excludes `enabled` and names, sorts arrays for order-independence
  (src/config.js:388-413). `configVersion` self-excludes its own key for
  idempotency (src/config.js:56-65).
- **Pinned IDs**: seed lists carry permanent ids matching already-committed
  data files; one-shot healing via `HEALED_KEY` rewrites legacy ids once
  (src/config.js:472-497).
- **Save-vs-dispatched honesty in API responses**: `changed` vs
  `officialDispatched`/`simklDispatched` arrays kept distinct so the UI never
  claims a regeneration that didn't fire (src/routes.js:464-488).
- Local-dev stub: `GH_DISPATCH_STUB` env makes dispatches succeed without
  secrets ("Never set on production", src/dispatch.js:11-17).

## Anti-patterns avoided

- No classes, no DI, no abstraction with a single implementation; helpers are
  free functions grouped by concern.
- No comments restating code — every comment justifies a decision, records a
  date/finding ID, or warns a future maintainer.
- No silent widening of public surfaces: dead exports are deleted with a
  tombstone comment (F17).
- No `try {} catch {}` without a reason in the catch body or adjacent comment.

---
*Covers `src/index.js`, `src/routes.js`, `src/config.js`, `src/configure.js`,
`src/status.js`, `src/auth.js`, `src/dispatch.js` — analysis: 2026-09-03.*
