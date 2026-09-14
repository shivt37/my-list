# RESEARCH: TMDB Networks include/exclude filter (series-only) — PARKED 2026-09-14

Status: researched, NOT built. Owner parked this to work on a releaseInfo question first.

## What TMDB supports (verified against official discover-tv OpenAPI + community usage)

1. `with_networks` — INCLUDE only, **TV only**. `/discover/movie` has no network param
   (networks are a TV concept on TMDB - confirmed by TMDB forum). Mirror of
   collections but inverted: collections = movie-only, networks = series-only.
2. **No `without_networks`** — exclusion not native, same gap as collection
   membership. Workaround = identical to existing `excludeCollections` machinery:
   for each excluded network run `discover/tv?with_networks={id}`, page it,
   collect show ids into a veto set, filter client-side in `passesFilters`.
3. Param semantics: comma = AND, pipe = OR (official AND/OR logic section).
   Existing code always pipes => `with_networks=213|49` = "Netflix OR HBO".
   Across params (genres/keywords/companies/networks) TMDB ANDs — the existing
   AND-fragment + OR-source architecture folds networks in with ~zero new
   logic in `buildDiscoverSources`.
4. **Catch: discover TV rows carry NO network_ids** (only genre_ids,
   origin_country...). Can't vet a row's network from the row itself => the
   veto-set enumeration (point 2) is required for BOTH excludes and AND-mode
   post-filter.
5. No `/search/network` in v3. Picker options: `GET /network/{id}` resolves
   id->name+logo; curated static popular list like TMDB_GENRES
   (Netflix 213, HBO 49, AMC 174, BBC One 354, Hulu 453, Prime Video 1024,
   Disney+ 2709, Apple TV 2552...) + "enter TMDB id" escape hatch.
   Possible v4 `GET /4/network/all` full dump (our token is v4-bearer - untested).

## Costs / limitations accepted

- Exclude-set paging: a big network (Netflix ~9k+ titles) costs hundreds of
  API calls to enumerate; GH Actions tolerates (cron, no interactive timeout).
  Cap scan pages + warning when veto set hits cap (long tail slips past).
- Exclusions take effect only after next Actions run (not instant), like
  excludeCollections today.
- Networks (who made/aired it) vs watch providers `with_watch_providers`
  (where it streams NOW, region-scoped) are different axes — chose network.

## Proposed design (mirrors existing dimensions exactly)

- Fields: `includeNetworks`+`includeNetworkNames`, `excludeNetworks`+
  `excludeNetworkNames`, `includeModes.network` (AND/OR)
- Series-only: movie lists clear network fields on mediaType switch (B4
  mirror); `tmdbContentHash` includes all 4 arrays; export-config carries them
- Generator (`scripts/tmdb.mjs`): include -> AND fragment (`&with_networks=...`)
  or own OR-source (buildDiscoverSources 4th dim); exclude -> per-network
  discover-enumeration veto set consumed by `passesFilters`
- Preview (`src/routes.js handleTmdbPreviewDiscover`): mirror BOTH paths —
  parity rule from the 2026-09 OR-collection bug family
- UI (`src/configure.js`): "Networks" dimension section beside Companies —
  chips + picker (curated list + TMDB-id input), AND/OR tag, series lists only
- Tests: normalize/hash/source-plan units in verify-tmdb.mjs + live E2E like
  testing/tmdb-exclude-e2e.mjs
