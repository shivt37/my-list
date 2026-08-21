# Coding Conventions

**Analysis Date:** 2026-08-21

## Language & Module System

**Plain JavaScript ESM - no TypeScript, no transpile step:**
- Worker source: `.js` files in `src/`, ESM (`import`/`export`)
- Node scripts: `.mjs` files in `scripts/`; `scripts/package.json` sets `"type": "module"`
- Worker runs on Cloudflare Workers with `"compatibility_flags = ["nodejs_compat"]"` and imports `node:crypto` (`src/config.js:7`)
- No JSDoc types on signatures - types are enforced by runtime normalize/migrate functions instead (see Input Validation)

## Naming Patterns

**Files:**
- kebab-case not used; single-word lowercase names: `config.js`, `routes.js`, `dispatch.js`, `scrape.mjs`, `tmdb.mjs`, `simkl.mjs`, `official.mjs`
- Self-check suites prefixed `verify-`: `scripts/verify-tmdb.mjs`, `scripts/verify-ui.mjs`; the main suite is `scripts/dry-test.mjs`

**Functions:**
- camelCase verbs: `loadConfig`, `saveConfig`, `buildManifest`, `handleCatalog`, `normalizeTmdbList`, `migrateConfig`
- Route handlers prefixed `handle`: `handleSaveConfig`, `handleTriggerRefresh`, `handleRunsPost` (`src/routes.js`)
- Row-to-meta mappers suffixed by module: `rowToMeta`, `rowToMetaOfficial`, `rowToMetaSimkl`, `rowToMetaTmdb` (`src/routes.js:118-167`)
- Predicate helpers prefixed `passes`/`matches`: `passesRatingTiers`, `matchesCountry` (`scripts/simkl.mjs:123-152`)

**Variables/constants:**
- Module-level constants UPPER_SNAKE_CASE: `RUNS_MAX`, `CONFIG_KEY`, `MAX_ITEMS`, `TMDB_SORTS`, `SEED_LISTS` (`src/config.js`, `scripts/tmdb.mjs`)
- Regex constants also UPPER_SNAKE: `CATALOG_RE`, `ID_RE`, `SANE_SLUG`, `SANE_KIND` (`src/routes.js:46`, `scripts/tmdb.mjs:37`, `scripts/simkl.mjs:396`)
- Local helpers camelCase: `arg()`, `sleep()`, `chunkArray()`, `jsonOf()`

**IDs (string formats, load-bearing):**
- Scraper lists: `mdb_scrape_<8 alnum>`; official catalogs: `mdboff_<slug>_<movie|show>`; simkl: `simkl_arriving_today_<slug>`; tmdb: `tmdb_discover_<movie|series>_<8 base36>`
- KV keys colon-namespaced: `runs:scraper`, `runs:official`, `runs:simkl`, `runs:tmdb`, `healed`, `config` (`src/config.js:9-16`)

## Code Style

**Formatting:**
- No formatter or linter configured (no eslint/prettier/biome config anywhere)
- De facto style: double quotes for strings, semicolons, 2-space indent, template literals for HTML/URLs
- Long lines accepted (URL seed constants are single lines hundreds of chars long, `src/config.js:146`)

**Linting:** None. Correctness is guarded by tests + regex validation, not static analysis.

## Import Organization

**Order:**
1. Node builtins with `node:` prefix: `node:crypto`, `node:fs`, `node:path`, `node:url`
2. npm packages (puppeteer family, jsdom in tests)
3. Relative modules `./x.js` / `../src/x.js`

**Path Aliases:** None - relative paths only.

## Function Design

**Dependency-injected `main()` - THE core pattern for all scripts:**

Every GitHub Actions script exports a `main()` whose collaborators are overridable via one destructured object parameter:

```javascript
// scripts/tmdb.mjs:353
export async function main({
  idsArg = arg("ids"),
  actionArg = arg("action") || "generate",
  fetchCfg = getLists,
  build = buildDiscoverItems,
  write = writeCatalog,
  remove = deleteCatalog,
  recordRuns = postRuns,
} = {}) { ... }
```

Same shape in `scripts/scrape.mjs:371`, `scripts/simkl.mjs:380`, `scripts/official.mjs:168`. Tests import the module and pass fakes without mocking frameworks. **Follow this for any new script.**

**`isMain` guard - fresh each run, exported for testing:**

```javascript
// scripts/simkl.mjs:449
export const isMain = typeof process !== "undefined" && !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!SIMKL_CLIENT_ID) { console.error("Missing SIMKL_CLIENT_ID env var."); process.exit(1); }
  main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
}
```

Env-var presence checks live inside the `isMain` block so importing for tests never exits. `scripts/tmdb.mjs:449` uses an async `pathToFileURL` variant - both forms exist.

**Small pure helpers exported alongside main flow:** `buildPageUrl`, `chunkArray`, `writeCatalog`, `deleteCatalog`, `computeSourceHash`, `precompute` - all exported so tests hit them directly.

## Module Design

**Exports:** Named exports only, except the worker entry (`export default { fetch }` in `src/index.js:21`). `src/configure.js` exports exactly one function (`buildConfigurePage`) - the entire admin UI is one template-literal string.

**No barrel files.** Consumers import from the specific module.

**Pure-function normalization layer:** All untrusted config passes through `migrate*`/`normalize*` functions that return brand-new objects with known fields only:
- `migrateConfig`, `migrateOfficial`, `migrateSimkl`, `migrateTmdb` (`src/config.js:184-314`)
- Unknown fields dropped, types coerced (`Number(t[k])`), lengths clamped (`Math.min(50, Math.max(1, ...))`), name sliced to 200 chars
- Malformed entries dropped (`filter(Boolean)`), never thrown

## Input Validation (trust boundaries)

Hand-rolled regex allowlists - no zod. Every boundary has one:

| Boundary | Guard | File |
|----------|-------|------|
| Workflow filename into GH API URL | `/^[a-zA-Z0-9_.-]+\.yml$/` | `src/dispatch.js:17` |
| Config list ids | `/^mdb_scrape_[A-Za-z0-9_-]{1,32}$/` | `src/config.js:247` |
| TMDB discover ids | `/^[a-z0-9]{8}$/`, `/^tmdb_discover_(movie\|series)_[a-z0-9]{8}$/` | `src/config.js:272`, `scripts/tmdb.mjs:37` |
| CLI `--lists`/`--delete-ids` before file `join()` | same scraper id regex | `scripts/scrape.mjs:377-385` |
| CLI `--slugs` / `--kinds` | `SANE_SLUG`, `SANE_KIND` | `scripts/official.mjs:179`, `scripts/simkl.mjs:396` |
| Workflow inputs before bash | `tr -cd 'a-zA-Z0-9,_-'` sanitize step | `.github/workflows/scrape.yml` |
| Inline `<script>` state blob | `JSON.stringify(config).replace(/</g, "\\u003c")` + `escapeAttr()` | `src/configure.js:10-14` |

**Rule: validate/allowlist at every boundary where a string reaches a filesystem `join()` or URL path. Never trust workflow_dispatch inputs, KV contents, or request bodies.**

## Error Handling

**Worker routes (`src/`):** try/catch returning JSON envelopes; never throw to the client.

```javascript
// src/routes.js:364
} catch (e) {
  return json({ error: "Save failed." }, 500);
}
```

- Client-error responses carry specific messages (`400` invalid body, `404` unknown/disabled list, `502` upstream GH/TMDB failure, `501` unconfigured secrets)
- Deliberate silent catches carry a comment explaining why: corrupt KV falls back to seeds (`src/config.js:359-361`), failed catalog fetch returns `{ metas: [] }` with HTTP 200 so Stremio chains don't break (`src/routes.js:187-189`)
- Dispatch-before-persist ordering: all GitHub dispatches must succeed before `saveConfig` writes KV, else the save is rejected and nothing persisted (`src/routes.js:300-350`)

**Scripts (`scripts/`):** per-item try/catch recording failures into run records instead of crashing the loop:

```javascript
// scripts/tmdb.mjs:420-435 - failure becomes a structured run record
} catch (e) {
  runs.push({ catalog_id, status: "failed", error_message: e.message.slice(0, 500), ... });
}
```

- Empty results never overwrite the last good data file (`if (items.length > 0) write(...)` in `scripts/tmdb.mjs:403`, `scripts/official.mjs:196`, `scripts/scrape.mjs:344`) - exception: simkl empty day IS written (`scripts/simkl.mjs:423`)
- Failures set `process.exitCode = 1` rather than exiting mid-loop; non-fatal POST failures use `console.warn` + exitCode
- Fetches always carry `signal: AbortSignal.timeout(...)` (15s config, 30s API)

## Logging

**Framework:** bare `console` - no library.

**Patterns:**
- `src/` (worker): zero console calls; responses ARE the output
- Scripts: `[<catalog_id>] <status> - N items` per item (`console.log`), `console.warn` for recoverable failures, `console.error` for per-item fatal errors, final `Summary:` JSON dump
- Debug artifacts gated behind `--debug` flag writing HTML/screenshots to `debug/` (`scripts/scrape.mjs:127-139`)

## Comments

**When to comment:** Extensive *why*-comments on every non-obvious decision - race conditions, security rationale, rollback ordering, bot-detection workarounds. Examples: dispatch-order rationale (`src/routes.js:299-309`), concurrency `queue: max` explanation (`.github/workflows/scrape.yml`), warm-up session purpose (`scripts/scrape.mjs:167-172`). If a line looks weird, there is a comment above it explaining the bug it prevents.

**Section dividers:** `// ── Section Name ──...` (box-drawing) in tests and mid-file regions; `// ===== NAME =====` banner blocks in `scripts/scrape.mjs`.

**JSDoc:** Only on script file headers (`scripts/*.mjs` open with `/** ... */` blocks documenting env vars, usage flags, and behavioral rules). No per-function JSDoc.

## State Management

- Config is a single KV JSON blob read through `loadConfig(kv)` on every request (no caching layer); `kv` binding always passed as parameter, never imported globally
- Content hashes decide re-scrapes: `listContentHash` / `tmdbContentHash` (`src/config.js:319-353`) deliberately exclude `name` so renames don't trigger regeneration - keep any new hash field-set in sync with `computeSourceHash` in `scripts/tmdb.mjs`
- One-shot migrations stamped with a sentinel KV key (`healed`, `src/config.js:421-430`)

---

*Convention analysis: 2026-08-21*
