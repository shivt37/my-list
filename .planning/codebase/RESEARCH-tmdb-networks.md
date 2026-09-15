# RESEARCH: TMDB Networks include/exclude filter (series-only) — 2026-09-14, FINALIZED approach, NOT built

Status: researched + code-audited, parked. Owner to green-light before any code changes.

## Live-verified API facts (probes against our own v4 token, 2026-09-14)

| Probe | Result | Consequence |
|---|---|---|
| `/discover/tv?with_networks=213` | works (1096 with votes>=50) | native INCLUDE, TV only |
| `with_networks=213\|49` | 1233 = superset union | pipe = OR within param (matches our join style) |
| `with_networks=213,49` | 1 | comma = AND (show aired on BOTH) — never emit commas |
| `/discover/movie?with_networks=213` | **200, ignored** (total=20001 = unfiltered) | TMDB does NOT reject it on movies — server-side strip is the only guard |
| `/3/network/213`, `/3/network/49` | 200 "Netflix", "HBO" | id->name+logo resolution works (escape-hatch picker) |
| `/3/search/network` | 404 | no network search |
| `/3/network/all` | 404 "Invalid id" (parsed as id) | no v3 dump |
| `/4/network/all` | 404 | no v4 dump either |
| `without_networks` | **does not exist** in discover-tv OpenAPI | exclusion needs workaround (P1) |
| `/discover/tv?with_companies=184898` | 8 of 18 page-1 rows have NULL first_air_date | `include_null_first_air_dates` default filters inconsistently across param paths; moot now — generator drops undated from files (owner 2026-09-14), preview sinks them |

## Problems brainstormed -> decision

### P1. No native network EXCLUDE (biggest issue)
- (a) Enumerate each excluded network wholesale (`with_networks=X`, all pages): Netflix = tens of thousands of shows = hundreds of calls. **REJECTED** (unbounded cost).
- (b) Per-candidate `/tv/{id}` detail lookup to read `networks`: up to 500 extra calls per list. **REJECTED** (heavy, slow).
- (c) **Intersection re-scan — CHOSEN.** Re-run the *same* query the list already runs, plus `&with_networks=e1|e2|...` (pipe-OR folds all excluded networks into one scan). TMDB ANDs that param onto the base filters, so the result set IS exactly "base candidates that belong to an excluded network" = the veto set. Cost = (1 + number of OR-sources) extra paginations of a *small* window (same early stops as the main scan: MAX_ITEMS cap, page cap 25). Correct by construction: veto members are ⊆ what would have entered the window; items outside the window can't leak in regardless.
  - singleQueryMode lists: 1 extra call-chain; multi-source lists (e.g. DC-Shows: keyword-OR + company-OR): 2 extra chains. Worst case +25×3 pages = +75 calls, ~fine under Actions budget (P6).
  - carry identical excludeQs/voteFloor params on veto scans (subset semantics stay correct either way; identical params minimize result size).
- (d) Limit excludes to small networks / warn on big ones — unnecessary once (c) is window-bounded.

### P2. Include: pure native fit
Fold `with_networks` into `andQs` for AND-mode, fan out as own OR-source for OR-mode — exact companies/keywords pattern in `buildDiscoverSources` (tmdb.mjs:87-142, routes.js mirror). Mode: new 5th `includeModes.network`.

### P3. Picker — REVISED 2026-09-14: network SEARCH is possible (web route, not v3 API)
- **DISCOVERY: `https://www.themoviedb.org/search/remote/tv_network?query=<q>`** — the route powering TMDB's own discover-page Networks typeahead (found embedded in the site JS: `/search/remote/tv_network`). Public GET, no auth, no api_key; returns `{"total_results":N,"results":[{id, logo_path, name, origin_country}]}` — the exact shape our `/ajax/{keyword,company,collection}`-style pickers already speak. Verified live 2026-09-14: bbc->64 (incl. BBC Two 332, CBBC 15), netflix->213, crunchy->1112 (Crunchyroll IS a network after all), peacock->3353, colors->524 [IN].
  - Caveats: undocumented site route (can change anytime) -> (1) call it SERVER-side via new worker proxy `GET /tmdb/search-network?query=` (UA/Referer set there, CORS-free, cache 10min KV like the official-catalog cache pattern), (2) graceful fallback = curated static list below, (3) ultimate escape hatch = id-input.
- (a) **CHOSEN: search-first** — `/tmdb/search-network` proxy -> inline typeahead identical UX to Keywords/Companies/Part of Collection; logo_path renders as chip/thumb via image.tmdb.org base (attribution stays: data is TMDB's).
- (b) **Fallback offline seed (curated 36, LIVE-VERIFIED ids)** used when search route fails or returns empty: US broadcast ABC 2, CBS 16, NBC 6, FOX 19, The CW 71, PBS 14; US cable FX 88, AMC 174, Adult Swim 80, Cartoon Network 56, Nickelodeon 13, Comedy Central 47, TBS 68, USA Network 30, Syfy 77, History 65, National Geographic 43, Disney Channel 54, Discovery 64, Hallmark 384, Star One 540, StarPlus 159, Sony SAB 1708, Zee TV 526; streaming HBO 49, HBO Max 3186, Showtime 67, Paramount+ w/ Showtime 6631, STARZ 318, Netflix 213, Prime Video 1024, Hulu 453, Disney+ 2739, Paramount+ 4330, Apple TV 2552, Peacock 3353, Disney+ Hotstar 3919; UK BBC One 4, BBC Two 332, ITV1 9, Channel 4 26
- (c) **Escape hatch (keep): id-input + resolve** via proxy `GET /tmdb/network/{id}` -> `/3/network/{id}` (verified: 526->Zee TV etc), shows name+logo before accepting chip.
- (d) Scrape/reuse approaches rejected: /search/company ids = different space; note provider ids (8=Netflix) vs network ids (213=Netflix) are separate namespaces — site search returns the correct (network) ones; probe confirmed 283 was provider-Crunchyroll vs 1112 network-Crunchyroll.

### P4. Movie lists must never keep network values
Movie endpoint ACCEPTS-AND-IGNORES the param (probe E) — a stale value silently poisons nothing on TMDB but breaks preview/file parity assumptions and lies in the config. Enforce B4-mirror everywhere:
- `normalizeTmdbList` (config.js:334-336 pattern): `includeNetworks/excludeNetworks = isSeries ? vals : []`
- configure.js `updateTmdb` mediaType-switch clear block (~1895-1901): clear network fields + names when switching to movie
- generator defensive gate mirrors the collection one (`mediaType === "series" &&` on both include fold and veto scan)

### P5. Preview/file parity (this codebase's bug family: Joker 35-vs-2, undated rules)
Veto scan + OR-fan-out implemented identically in routes.js preview; unit asserts `buildDiscoverSources` plan with network dims; live e2e (pattern: testing/undated-live.mjs, tmdb-exclude-e2e.mjs) compares preview count vs generator count on a network-excluded list.

### P6. GH Actions budget
tmdb.yml: timeout 15 min, concurrency queue, full regen daily 00:00 UTC + per-save dispatch. P1(c) worst case ≈ +75 calls/list (each ~100-300ms) => +10-30s. Safe. No workflow change.

### P7. Hash + dispatch (regen trigger)
Add `includeNetworks`/`excludeNetworks` sorted arrays to `tmdbContentHash` (config.js:388-413) + it is already mirrored 1:1 by generator via F16 import — no duplicate-hash risk. Names not hashed (pattern of keyword/company names).

### P8. AND/OR pills copy
`TMDB_MODE_KINDS` grows genre/keyword/company/collection -> +network (configure.js:1720, setTmdbAllModes:1919-1923 iterates the map); pill hint strings (1745-1748) + dim-mode-tag tooltip (2075-2079) mention "Genres, Keywords, Companies, and Part of Collection" — reword to include Networks. Note: tag label for collection is "ANY OF"; network AND means "aired on ALL selected networks" (rare) — same tooltip pattern as companies.

### P9. "No filters yet" footgun check
`renderTmdb` empty-note (1795-1799) + `saveAll` veto (2373-2380) enumerate include dims — add networks or a network-only list is wrongly called unfiltered.

### P10. Series rows and null dates (probe I)
Excluded-network veto sets scan with the SAME query flags as base; undated rows that TMDB leaks are dropped from files by today's sortItems rule — no interaction with networks work. Not a blocker.

## Concrete change map (once approved — nothing applied)

| File | Spot | Change |
|---|---|---|
| src/config.js | normalizeTmdbList 318-373 | +includeNetworks/Names, excludeNetworks/Names (numArr/nameArr), includeModes.network, isSeries-carry/movie-strip |
| src/config.js | tmdbContentHash 388-413 | +2 sorted id arrays |
| scripts/tmdb.mjs | buildDiscoverSources 87-142 | network AND-fold fragment + OR-source fan-out (series-only) |
| scripts/tmdb.mjs | buildDiscoverItems 220-349 | veto scan (P1c) feeding passesFilters; new helper near collectionIdSet |
| src/routes.js | handleTmdbPreviewDiscover 814-957 | mirror fan-out + veto scan |
| src/routes.js + index.js | ~758-778 / ~105-114 | `GET /tmdb/search-network?query=` proxy (site route, 10min KV cache) + `GET /tmdb/network/{id}` detail proxy (P3) |
| src/configure.js | ~1644-1697 | TMDB_NETWORKS fallback seed (36 verified) + FIELD_KEYS/NAME_KEYS/DIMS (seriesOnly flag, searchKind 'network') + render filter at 1741 |
| src/configure.js | 1701-1706, 1895-1901, 1720, 1745-1748, 1919-1923, 2373-2380 | empty-list fields, switch-clear, 5-kind pill loop + copy, footgun check |
| src/configure.js | new ~60 lines | id-input adder row for non-curated networks (uses P3b proxy) |
| testing | verify-tmdb.mjs + e2e | normalize/hash/source-plan units + live preview-vs-file count check |

Est. ~250 lines total, no schema breaks (old configs normalize to empty network arrays).

## Open questions for owner
1. Curated ~30 network list good enough for v1, or want bigger seed set first?
2. Exclude-veto applies to BOTH preview and file (recommended) — confirm.
3. Name chips for curated picks can render instantly from the static table; id-input ones resolve via proxy before adding — ok?
