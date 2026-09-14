# RESEARCH: Building a free, self-hosted "MDBList-like" platform for my-list

**Date:** 2026-09-14 · **Status: RESEARCH ONLY — nothing applied. Pass 2: complete MDBList filter inventory merged with pass 1.**

## Table of contents
- [1. Executive summary](#1-executive-summary-updated-pass-2)
- [2. COMPLETE MDBList filter inventory (pass 2)](#2-complete-mdblist-filter-inventory-pass-2)
  - [2.1 Evidence & method](#21-evidence--method-pass-2)
  - [2.2 Master filter matrix (movies + shared)](#22-master-filter-matrix-movies--shared)
  - [2.3 Shows-only filter diff](#23-shows-only-filter-diff-vs-movies)
  - [2.4 q_sort value list](#24-q_sort-complete-value-list-verified-from-form)
  - [2.5 Streaming-provider id decode (q_provider / q_provider_x)](#25-streaming-provider-id-decode)
  - [2.6 Keywords ("tags") system decode](#26-keywords--tags-system-decode)
  - [2.7 Login-only / URL-only params](#27-login-only--url-only-params-not-in-guest-form)
- [3. MDBList anatomy (pass 1)](#3-mdblist-anatomy-pass-1)
- [4. Free providers & datasets (pass 1)](#4-free-providers--datasets-pass-1)
- [5. Gap analysis — merged with filter matrix](#5-gap-analysis--merged-with-filter-matrix)
- [6. Recommended architecture (pass 1, updated)](#6-recommended-architecture-personal-scale-free-keys-only)
- [7. Verified vs assumed ledger](#7-verified-vs-assumed-quick-ledger-pass-1--pass-2)
- [8. Build order & open questions](#8-top-5-build-order-updated)

---

## 1. Executive summary (updated, pass 2)

A free self-hosted replacement is **viable at ~80–85% fidelity for the scraped-filter use case and ~70% for official charts**, at personal scale (pass-1 estimate, now re-validated row-by-row against the complete filter inventory in §2). The catalog spine (TMDB discover incl. JustWatch-powered providers, digital-release type, genre/keyword/company, region dates) is fully covered by the free TMDB API you already use. IMDb rating/votes become a *better-than-MDBList* local join via IMDb's free daily-refreshed non-commercial datasets (no per-call API needed). Pass 2 counted the full surface: **~40 distinct filter controls** (movies panel) + ~8 show-only extras; of the rows that your own working URL actually uses, **every one except RogerEbert, the 4 IMDb parental-advisory sliders, the Common Sense "Kids Age" picker, and the curated-keyword exclusions is replicable TODAY with TMDB + IMDb datasets + your local index** (§5 tally: 31 FULL / 23 PARTIAL / 8 GAP across 65 panel controls; the URL-active subset excludes only inactive defaults). The real remaining gaps are: MDBList's **aggregated critic scores beyond OMDb reach** (Letterboxd votes — no API, ToS-hostile; RogerEbert — no free source at all; both confirmed still ❌), **IMDb content-advisory numbers** (parental_* sliders — not in IMDb datasets; scrape-only ❌), **Common Sense age ratings** (❌), **MDB Score composite + curated keywords** (self-replicate or accept loss), **AniDB** (exists as filter but AniList is the practical free twin), and the "official charts" catalog (Trakt-family exact-replicable; IMDb charts scrapeable; FlixPatrol/pirated not). Everything runs within free tiers if updates are nightly and the join table is cached in R2/KV. Current architecture (Worker + Actions + static JSON → Stremio) needs no change; `scrape.mjs` retires, most of `official.mjs` retires.

---

## 2. COMPLETE MDBList filter inventory (pass 2)

### 2.1 Evidence & method (pass 2)
- Primary: live scrape of **https://mdblist.com/movies** and **https://mdblist.com/shows** (firecrawl, 2026-09-14). The entire filter panel (all three drawer sections: Ratings / Additional filters / "Lists, Streaming Services, Cast and more") is **server-rendered HTML** — nothing needed JS-hiding workarounds. Extracted from raw HTML: every `<select name=>` (20 per page) with all `<option value>` pairs, every `<input name=>` (72 controls, movies), and the page's own JS arrays `ratingsFilters`/`voteFields`/`checkboxNames` that give the authoritative param-name pairs + slider min/max (VERIFIED).
- Secondary: docs pages https://docs.mdblist.com/docs/score (Score/Score Average formula), https://docs.mdblist.com/docs/keywords (keyword system + full curated-keyword list), https://docs.mdblist.com/docs/popular_lists (Popular-lists catalog + sources), https://docs.mdblist.com/docs/list_types.html, https://docs.mdblist.com/docs/external_lists.html.
- Live AJAX: `https://mdblist.com/ajax/providers/<q>` returned MDBList's provider id→name table (VERIFIED, §2.5); `/ajax/{tags,casts,directings,collections,networks,productioncompanies,streams}/<query>` are the typeahead sources (endpoints VERIFIED from page JS; response bodies for tags are name-search-only so numeric keyword ids stay unresolved, §2.6).
- Anchor-verified against the owner's real working URL (provided in task): all param names below that appear there are confirmed-live. Where a name appears ONLY in the owner URL and not the guest form (q_list/q_listx, q_country, production_country, release_regions, q_theater, q_watched, q_trakt_list_name/_desc, q_sortorder, q_current_page, q_page) it is marked *URL-confirmed*; controls that only exist for logged-in users (q_watched etc.) are §2.7.

### 2.2 Master filter matrix (movies + shared)

Ranges/option values below were read verbatim off the form (slider pairs from the page's JS config array). "M/S" applicability: shared rows apply to shows too unless noted. Effort = self-host work at personal scale (S/M/L) using the free stack of §4.

| Filter | URL param(s) | Value space / ranges (as rendered) | Underlying data source MDBList uses | Free equivalent | Coverage | Effort |
|---|---|---|---|---|---|---|
| Title text search | `q_title` | free text | MDBList title index | TMDB `/search/movie`+`/tv` (partial: no fuzzy multi-field) | PARTIAL | S |
| Sort field | `q_sort` | 24 values, §2.4 | their columns (all ratings/charts stored per title) | see §2.4 row-by-row | MIXED | — |
| Sort direction | `q_sortorder` | `asc`/`desc` *URL-confirmed* | n/a | trivial local | FULL | S |
| Pagination | `q_current_page` | int ≥0 *URL-confirmed* | server paging | local paging of index | FULL | S |
| Limit items | `q_limit` | int (UI "Limit items"; owner used 200) | server cap | local slice | FULL | S |
| Year range | `yearf`,`yeart` | From/To years (calendar widgets) | TMDB release year | TMDB `primary_release_date.gte/lte` | FULL | S |
| Released within days | `yearr` | days, placeholder "Within days"; tooltip: use `d:x` digital-in-x-days / `p:x` physical-in-x-days (VERIFIED tooltip) | release-date index | TMDB `release_dates` join (type 3/5 per region) | FULL | M |
| Upcoming in days | `yearu` | days, "Upcoming releases in the next x days" (VERIFIED tooltip) | release-date index | TMDB `release_date.gte`+status | FULL | S |
| MDB Score range | `q_score_input` + `_max` | **0–100** | proprietary composite (§3 A2; docs: "average of all ratings with per-source vote baseline that demotes low-vote scores, except current-year titles" — VERIFIED docs/score) | own composite (ratingo pattern) | PARTIAL (formula approx) | M |
| Score Average toggle | `q_score_average=on` | checkbox | un-baselined avg | own mean w/o baseline | FULL (trivially) | S |
| RogerEbert range | `q_rogerebert_input` + `_max` | **0–4, step 0.5** | rogerebert.com reviews | none free (scrape publisher = ToS risk) | GAP | L |
| IMDb rating range | `q_imdbrating_input` + `_max` | **0–10, step 0.5** | IMDb | IMDb datasets `title.ratings` | FULL | S |
| IMDb votes floor | `q_imdbvotes_input` | 0–10000 step 500 ("With at least N votes") | IMDb | `title.ratings.numVotes` | FULL | S |
| Trakt rating range | `q_traktrating_input` + `_max` | **0–100** | Trakt | Trakt `/{type}/ratings`+`/stats` (0-5 scale→×20) | FULL (nightly per-title) | M |
| Trakt votes floor | `q_traktvotes_input` | 0–5000 step 200 | Trakt | `stats.user_ratings` / vote_count | FULL | M |
| TMDb rating range | `q_tmdbrating_input` + `_max` | **0–100** (TMDB 0-10 ×10) | TMDb | discover `vote_average.gte/lte` | FULL | S |
| TMDb votes floor | `q_tmdbvotes_input` | 0–5000 step 200 | TMDb | `vote_count.gte` | FULL | S |
| Letterboxd rating range | `q_letterrating_input` + `_max` | **0–5, step 0.25** | Letterboxd | no API (§4 Letterboxd row) | GAP (fragile scrape) | L |
| Letterboxd votes floor | `q_lettervotes_input` | 0–10000 step 500 | Letterboxd | ditto | GAP | L |
| Metacritic range | `q_metacriticsrating_input` + `_max` | **0–100, step 5** | Metacritic | OMDb `Metascore` per title | PARTIAL (1k/day hydration, stale tail) | M |
| Metacritic votes floor | `q_metacriticsvotes_input` | 0–500 step 20 | Metacritic critic count | OMDb `Ratings[microsoft]`.`ratingCount` | PARTIAL | M |
| Rotten Tomatoes critics range | `q_tomatoesrating_input` + `_max` | **0–100, step 5** | Rotten Tomatoes | OMDb `Ratings rottentomatoes` | PARTIAL | M |
| RT critics votes floor | `q_tomatoesvotes_input` | 0–500 step 20 | RT review count | OMDb ratingCount | PARTIAL | M |
| RT audience ("Popcorn") range | `q_audiencerating_input` + `_max` | **0–100, step 5** | RT audience % | OMDb (audience field spotty) | PARTIAL | M |
| RT audience votes floor | `q_audiencevotes_input` | 0–1000 step 50 | RT audience ratings count | not in OMDb free → gap inside an otherwise-partial row | PARTIAL | M |
| AniDB rating range | `q_anidbrating_input` + `_max` | **0–10, step 0.5** (param in form JS VERIFIED; no visible widget in panel) | AniDB (anime) | AniList GraphQL score (proxy) / AniDB API (client reg, caps UNVERIFIED) | PARTIAL | M |
| AniDB votes floor | `q_anidbvotes_input` | int | AniDB | AniList `averageScore`/popularity proxy | PARTIAL | M |
| MyAnimeList rating range | (UI; q_mal pair not in this form pass) | **0–10, step 0.5** | MyAnimeList | MAL API v2 / Jikan | FULL (anime only) | S |
| MyAnimeList votes floor | (UI) | 0–500 step 20 | MyAnimeList | MAL/Jikan scored-membership | FULL | S |
| IMDb advisory: Sex & Nudity | `parental_nudity_min_i` + `parental_nudity_i` | **0–5** | IMDb content advisories | NOT in IMDb datasets → imdb.com scrape only | GAP | L |
| IMDb advisory: Violence & Gore | `parental_violence_min_i` + `parental_violence_i` | **0–5** | IMDb | ditto | GAP | L |
| IMDb advisory: Profanity | `parental_language_min_i` + `parental_language_i` | **0–5** | IMDb | ditto | GAP | L |
| IMDb advisory: Alcohol, Drugs & Smoking | `parental_drinking_min_i` + `parental_drinking_i` | **0–5** | IMDb | ditto | GAP | L |
| Include null ratings | `q_hidenull` (checkbox "Include if no rating / vote") | on/off | query semantics | trivial in local index | FULL | S |
| Reverse votes | `q_votereverse` ("Less than") | on/off | query semantics | trivial | FULL | S |
| Hide if no TMDB ID | `tmdbid_hide=on` | checkbox | join semantics | trivial (own index keyed on TMDB) | FULL | S |
| Allow adult | `allow_adult` checkbox | on/off | isAdult flags | TMDB `include_adult` + IMDb `isAdult` | FULL | S |
| Genres include (AND-capable) | `q_genre` (+`all-selected` sentinel `q_genre=all-selected`) | 63 slugs: action…western + 21 `anime-*` subgenre slugs + `donghua` (VERIFIED list) | MDBList genre vocab (TMDB/IMDb/Trakt blend) | TMDB `with_genres` (ids) — anime subgenres/donghua NOT in TMDB → via keyword join | PARTIAL (anime taxonomy) | M |
| Genres exclude | `q_genre_exclude` | same 62 slugs | ditto | TMDB `without_genres` | PARTIAL | M |
| Release status | `q_status` | M: released·in production·post production·planned·canceled·rumored | TMDB status | TMDB `status` in discover? (no) → details join | PARTIAL→local | S |
| Has-release type (M) | `q_release` | 1 Premiere·2 Theatrical (limited)·3 Theatrical·4 Digital·5 Physical·6 TV·7 "Blu-ray.com (test)"; earliest-only sentinel | release-dates table | TMDB `release_dates` type mapping (1/2/3/4/5; type 7=Blu-ray=5-adjacent) | FULL (7≈5) | S |
| Earliest release only | `release_earliest_only` checkbox *+ `earliest-only` option* | on/off | query semantics | local | FULL | S |
| Release countries (M) | `release_regions` *URL-confirmed* | ISO country list paired with `q_release` (owner URL: `release_regions=` + `q_release=4`) | release_dates per region | TMDB `release_dates` endpoint per region | FULL | S |
| Release window days (M) | `release_days_past`,`release_days_future` | day counts around release date | same | local join arithmetic | FULL | S |
| Language include | `q_language` | 188 ISO langs + `[Original]`/`[Main Spoken]` modes | TMDB languages | TMDB `with_original_language`; spoken-language filter via details join | PARTIAL | M |
| Language exclude | `q_language_x` | same | same | `with_original_language`≠ / local `spoken_languages` | PARTIAL | M |
| Certification | `q_certification` | M: G,PG,PG-13,R,NR,NC-17 (US MPAA rendered) | TMDB/JustWatch certs | TMDB `certification`+`certification_country` (owner: via per-country; MDBList also stores other countries — UNVERIFIED picker) | FULL (US) | S |
| Common Sense "Kids Age" | `q_common_sense` | CC-only sentinel + 2+…18+ + NR (19 values VERIFIED) | commonsensemedia.com | none free (scrape ToS) | GAP | L |
| Country include/exclude | `q_country`,`q_country_x` *URL-confirmed* (comma ISO pairs, e.g. `mx,pk,kr,ru,tr,cn,eg,bd,tw,id`) | country codes | TMDB origin/release country | `with_origin_country` include; exclude → local | PARTIAL | S |
| Production country incl/excl | `production_country`,`production_country_exclude` *URL-confirmed* | country codes | TMDB/IMDb company-country | companies→country join (TMDB company details) | PARTIAL | M |
| Budget floor/ceiling (M-only) | `budget` (M; owner blank; absent from shows form) | $ amount range | TMDb/IMDb box office | TMDB movie `budget`/`revenue` fields (details per-title → local col) | PARTIAL (no discover filter → local sort) | M |
| Revenue floor/ceiling (M-only) | `revenue` | $ amount range | ditto | ditto | PARTIAL | M |
| Runtime | `q_runtime_min`,`q_runtime_max` | minutes | TMDB runtime | TMDB `with_runtime.gte/lte` | FULL | S |
| Popular lists include/exclude | `q_list`,`q_listx` *URL-confirmed*; JS also `q_list_filter_id` | ids of 58 M / 53 S auto-populated lists (sources: IMDb charts, Trakt 8 chart pages, FlixPatrol 14, TorrentFreak, own vote-increase — VERIFIED docs/popular_lists) | mixed | Trakt pages exact ✅; IMDb charts 🟡 scrape; FlixPatrol/TorrentFreak ❌ | PARTIAL | M |
| Keywords include/exclude | `q_tag`,`q_tagx` (+ special value `tag-all-selected` = Match-All, VERIFIED from AJAX) | numeric keyword ids (owner excluded 10979, 124256; also seen 295269, 295272, 339724 badge link) | TMDB+Trakt+IMDb keywords + ~40 curated (§2.6) | TMDB `with_keywords`/`without_keywords` for upstream-keyword half; curated half mostly rebuildable from your own columns (§2.6) | PARTIAL | M–L |
| Production companies | `q_production`,`q_production_exclude` | typeahead `/ajax/productioncompanies/` | TMDB companies | TMDB `with_companies`/`without_companies` | FULL | S |
| Part of collection (M) | `collection` (hidden input VERIFIED; label "Part of Collection", typeahead `/ajax/collections/`) | TMDB collection id | TMDB | `belongs_to_collection` via details join / own flag keyword | PARTIAL (no discover param) | S |
| In theaters now | `q_theater` (UI country picker "In Theaters / Select Country") *URL-confirmed* | country code(s) | TMDB/JustWatch theatrical status | TMDB discover `region`+`with_release_type=3` or `/movie/now_playing` | FULL | S |
| Streaming providers include/exclude | `q_provider`,`q_provider_x` (comma or repeated) | TMDB/JustWatch numeric ids (§2.5) | **JustWatch via TMDB** (dev-confirmed §3 A1) | TMDB `with_watch_providers`/`without_watch_providers`+`watch_region` (+ monetization types free/rent/buy = `with_watch_monetization_types`) — same upstream | FULL | S |
| Watch region | `q_region` (JS default `'US'` VERIFIED; owner used `US,CA,IN`) | ISO countries | JustWatch region scoping | TMDB `watch_region` (single per call → loop 3 calls) | FULL | S |
| Director | `q_directing` (typeahead `/ajax/directings/`) | person id(s) | TMDB/IMDb credits | TMDB discover `with_people`+`with_credit_type=crew`… (crew filter needs `with_credits`) | FULL | S |
| Cast include/exclude | `q_cast`,`q_cast_x` | person ids | same | `with_people` (cast) | FULL | S |
| Quick keyword badge links | `q_tag=NNNN` on cards (e.g. 339724 checkmark) | keyword id | curated keywords | see §2.6 | UNVERIFIED what each id is | — |
| "Most Watched" chart tab | `top_list=88` (M) / `top_list=89` (S) — VERIFIED hrefs on pages | single id per content type | ranked by MDBList users' watch activity (tooltip VERIFIED) | Trakt Most-Watched-week replaces purpose | PARTIAL (different population) | S |

### 2.3 Shows-only filter diff (vs movies)
Show-only controls, all VERIFIED from the shows form:

| Filter | URL param(s) | Values / ranges | Source | Free equivalent | Coverage | Effort |
|---|---|---|---|---|---|---|
| Show status | `q_status` | returning series·ended·canceled·upcoming·in production·planned·pilot·continuing (8 opts VERIFIED) | TMDB tv status | TMDB tv `/discover` has no status param → details join / `in_production` | PARTIAL→local | S |
| Episode runtime | `q_eruntime_min`,`q_eruntime_max` (VERIFIED input names) | minutes | TMDB episode runtimes | per-show `episode_run_time`/season avg via details join; no discover filter | PARTIAL | M |
| Last aired | `last_aired` (VERIFIED input name; UI "Last Aired") | date (exact range semantics UNVERIFIED) | TMDB/TVDb episode airdates | TMDB tv details `last_air_date`; Trakt calendars for windows | PARTIAL | M |
| Sort: Last Air Date / Next Air Date / Latest Season Date | `q_sort=last_air_date|next_air_date|season_air_date` (VERIFIED §2.4) | — | their episode tables | TMDB details + local date cols | FULL (local) | S |
| Networks include/exclude | `q_network`,`q_network_x` (VERIFIED selects; typeahead `/ajax/networks/`) | TMDB network ids | TMDB | discover `with_networks`/`without_networks` | FULL | S |
| Hide if no TVDB ID | `tvdbid_hide` (VERIFIED checkbox) | on/off | join semantics | trivial (own index tvdb col or skip) | FULL | S |
| Popular lists picker | `q_list`,`q_listx` (53 lists: Curated 20/FlixPatrol 14/Trakt 19) | ids | §2.2 row | §2.2 row | PARTIAL | M |
| Movie-only controls that VANISH on shows | — | `q_release`/release regions/`release_earliest_only`/budget/revenue fields absent (budget/revenue confirmed absent from shows input dump); `yearr`/`yearu` persist; `collection`+`In Theaters` absent | — | mirror this asymmetry in filters.mjs | — | — |

Show ratings block is identical to movies (all 0–100/0–5/0–10 pairs incl. Trakt/LB/MC/RT/audience/AniDB, same JS arrays) EXCEPT there is **no "Tomato Votes / Popcorn Votes / Letterboxd Votes / Metacritic Votes / MyAnimeList Votes" omission — all vote floors present** (shows render same vote fields; VERIFIED by input dump).

### 2.4 q_sort complete value list (VERIFIED from form)
Shared M+S: `score`, `score_average`, `released`, `releasedigital`, `imdbrating`, `imdbvotes`, `imdbpopular`, `tmdbpopular`, `jwrank`, `rogerebert`, `rtomatoes` (Tomato), `rtaudience` (Popcorn), `metacritic`, `myanimelist`, `letterrating`, `lettervotes`, `updated`, `runtime`, `download` (Downloaded), `budget`, `revenue`, `title`, `sort_title` (Title-Alphabetical), `random` (24). Shows add: `last_air_date`, `next_air_date`, `season_air_date` (27 total; VERIFIED both option lists).
Free equivalents: released/releasedigital/runtime/budget/revenue/sort_title/random → local index trivially; imdb* → IMDb datasets (imdbpopular = numVotes rank proxy); tmdbpopular/rating → TMDB native; jwrank → JW GraphQL 🟡; rogerebert ❌; rtomatoes/rtaudience/metacritic → OMDb 🟡; letter* ❌; myanimelist ✅ (MAL); `download` (piracy rank) ❌ unreproducible; `updated` n/a (own freshness stamp) ✅.

### 2.5 Streaming-provider id decode
VERIFIED by live query of `https://mdblist.com/ajax/providers/a` (guest default US set): MDBList ids ARE the **TMDB watch-provider registry (= JustWatch numbering)** — matches pass-1 finding that provider data is JustWatch-via-TMDB. Confirmed pairs incl. owner's set: **8=Netflix, 9=Amazon Prime Video, 2=Apple TV Store, 3=Google Play Movies, 7=Fandango At Home, 10=Amazon Video, 15=Hulu, 34=MGM Plus, 68=Microsoft Store, 79=NBC, 80=AMC, 83=The CW, 123=FXNow, 188=YouTube Premium, 190=Curiosity Stream, 191=Kanopy, 192=YouTube, 207=The Roku Channel, 209=PBS, 212=Hoopla, 257=fuboTV, 258=Criterion Channel, 283=Crunchyroll, 309=Sun Nxt, 332=Fandango at Home Free, 337=Disney Plus, 350=Apple TV, 386=Peacock Premium, 526=AMC+, 528=AMC+ Amazon Channel, 531=Paramount Plus, 582=Paramount+ Amazon Ch., 583=MGM+ Amazon Ch., 584=Discovery+ Amazon Ch., 635/636=AMC+/MGM+ Roku Premium Ch., 1770=Paramount+ w/ Showtime, 1825=HBO Max Amazon Ch., 1852-1854=BritBox/Paramount+/AMC+ AppleTV Ch., 1968=Crunchyroll Amazon Ch., 2285=JustWatch TV, 2303/2616=Paramount+ Premium/Essential, 2383=Philo, 2528=YouTube TV, 2736=Brew.**
Owner's remaining: **11, 73, 232 — UNRESOLVED from guest set** (not in US default list; almost certainly region-scoped entries for the owner's CA/IN watch-regions, since the AJAX ignores region and returns US top-50). Resolve in your MDBList UI by hovering the picker; they are ordinary TMDB ids, so TMDB `without_watch_providers` takes them as-is either way. The endpoint also accepts arbitrary typeahead (`/ajax/providers/<query>`) for picker parity.

### 2.6 Keywords ("tags") system decode
`q_tag`/`q_tagx` are **keyword** filters (VERIFIED: the Keywords dropdowns ARE `select name="q_tag"`/`q_tagx` with typeahead `/ajax/tags/`; special `tag-all-selected` value = [Match All]; docs page = "Keywords"). Sources per docs https://docs.mdblist.com/docs/keywords: **"Keywords are added from TMDb, Trakt and IMDb"** + **~40 MDBList-curated keywords**: `4k-blu-ray`, `dolby-vision`, `dolby-vision-cp`, `dolby-atmos` (from blu-ray.com + IMDb tech specs), `has-trailer`, `bollywood`, `imdb-tv-movie`, `imdb-video-game`, `imdb-short`, `imdb-tv-special`, `imdb-video`, `imdb-tv-mini-series`, `hallmark`, `certified-fresh`/`rotten`/`fresh` (RT), `one/two/three-actors`, `metacritic-must-see`, `belongs-to-collection`, `first-in-collection`, `collection-follow-up`, `anime-dub`, `certified-hot`, `christmas-movie`, `roger-ebert-thumbs-down`, `bottom-100`, `bottom-250`, plus an **awards set** (`best-picture-winner/nominated`, `oscar-winner/nominated`, `oscar-best-director-winner/nominee`, `emmy-award-winner/nominated`, `golden-globe-winner/nominated`, `festival-{sundance,cannes,venice,toronto,berlin}-winner`, `national-film-preservation-board-winner`, `razzie-winner/nominee`). Self-host mapping: TMDB-native half ✅ (`with/without_keywords`); curated half ≈ 70% derivable — RT fresh/certified/rotten + metacritic-must-see + awards from **OMDb (`Ratings`, `Awards`) per-title** 🟡; collection flags from TMDB `belongs_to_collection` ✅; dolby/4k set needs **blu-ray.com + IMDb tech-spec scrape** ❌(L); `imdb-*` title-regex + actor-count + `hallmark` + `bollywood` + `has-trailer` = trivially derivable from your own index ✅(S); bottom100/250 via IMDb lists 🟡 scrape; numeric ids `10979/124256/295269/295272/339724` names UNRESOLVED (AJAX is name→id only; the card checkmark `q_tag=339724` badge identity UNVERIFIED).

### 2.7 Login-only / URL-only params (not in guest form)
From owner URL + page JS (VERIFIED presence, semantics partly INFERRED): `q_watched=` (watched/unwatched against connected Trakt/MDBList history — guest form omits); `q_trakt_list_name=`,`q_trakt_list_desc=`,`q_trakt_list_id`,`q_list_filter_id` (membership filters over synced Trakt lists — docs/external_lists confirms "Hide Trakt Library Items / In Watchlist / Not in watchlist"); `s_lists` = "add to static lists" action, NOT a filter (VERIFIED label). Free twin: all of the above = your own Trakt sync via Trakt API OAuth (`/sync/*`) → FULL at personal scale, M effort.

---

## 3. MDBList anatomy (pass 1)

### 3.1 Data sources MDBList aggregates — VERIFIED
- Docs home: "combines the power of multiple rating platforms like **IMDb, TMDb, Letterboxd, Rotten Tomatoes, Metacritic, MyAnimeList, and RogerEbert**" + list creation "Gather data from **trakt, IMDb, TMDb, and more**" — https://docs.mdblist.com/ (VERIFIED). Pass 2 adds **AniDB** (filter params live in form JS) and **IMDb content advisories + Common Sense age ratings** as stored per-title sources (implied by parental_*/q_common_sense controls — the numeric 0–5 advisory model is IMDb parents-guide's; attribution INFERRED, UNVERIFIED).
- Movie search page sort options list all score fields MDBList stores per title: MDB Score, Score Average, Released, **Digital Release, IMDb rating, IMDb votes, IMDb Popular, TMDb Popular, JustWatch Rank, RogerEbert, TomatoPopcorn, Metacritic, MyAnimeList, Letterboxd rating, Letterboxd votes, Updated, Runtime, Downloaded, Budget, Revenue** — https://mdblist.com/movies/ (VERIFIED; now exhaustively catalogued §2.4, incl. shows-only Last/Next Air Date + Latest Season Date). Note the presence of Budget/Revenue/Downloaded — extra columns beyond what your filters use.
- **Streaming providers = JustWatch data delivered via TMDB's standard API** — stated by MDBList's dev (linaspurinis): "Watch providers … This is JustWatch data provided by TMDB via standard API. Now you can filter providers by country" — https://www.reddit.com/r/mdblist/comments/pru5l1/watch_providers_and_filter_your_own_list/ (VERIFIED via dev comment; pass-2 §2.5 independently confirms the id namespace is shared TMDB/JustWatch).
- Trakt = full two-way sync (watchlist/history/ratings/library); external list import sources: Trakt, IMDb (list/search/chart/watchlist/ratings/coming-soon/calendar), Letterboxd, Rotten Tomatoes, JustWatch (provider pages + streaming charts), Plex Watchlist RSS, UnoGS, Flixpatrol, MUBI, BestSimilar, RSS/NZB feeds etc. — https://docs.mdblist.com/docs/external_lists.html (VERIFIED). Pass-2 adds the Popular-lists source table (IMDb charts, 8 Trakt chart pages, FlixPatrol top-10s, TorrentFreak piracy, own vote-increase lists) — https://docs.mdblist.com/docs/popular_lists (VERIFIED).
- AniDB: pass-1 had "not confirmed"; **pass 2 CONFIRMS AniDB rating/votes filter params exist** (form JS §2.2) though no visible panel widget. MyAnimeList remains the surfaced score; XRDB ladder (TMDB→MDBList→Jikan/Kitsu/AniList) — https://github.com/CreepsoOff/XRDB.
- Simkl: MDBList doesn't list Simkl as a source; it's an independent parallel service (used by XRDB/Stremio tooling) — https://docs.mdblist.com/docs/external_lists.html (absence VERIFIED on that page).

### 3.2 Feature surface + free-tier constraints (what "free" imposes today) — VERIFIED
Docs: https://docs.mdblist.com/docs/list_types.html and https://docs.mdblist.com/docs/supporter.html
- List types: Dynamic (search filters, auto-update), AI-generated, Static, Feed, Linked, External. Dynamic filters cover ratings, genres, years, keywords, streaming services, languages, runtime, certifications, "popular lists" include/exclude — pass 2 supersedes this with the exact §2 matrix.
- **Free tier:** 4 dynamic + 4 static lists, **1 external list**, max **10,000 items/list**, new list populated after 30 min, **lists update every 24 h**, external lists update **weekly**, Trakt library sync weekly, no update-on-edit, **inactivity purge after 120 days**, **API 1,000 req/day** (https://docs.mdblist.com/docs/api). Paid tiers (1€–15€) only raise caps/update cadence + AI lists + exclude-from-list + import-by-name.
- This is exactly the constraint set you're replacing: 200-item scrape cap is *your* `maxPages 3` config, not MDBList's (lists can hold 10k on free); the binding free limits are 1k API req/day, 24h refresh, weekly external refresh, and the 4-list cap.
- "Official charts" = prepopulated Popular lists (§2.2 row, docs/popular_lists) served through the same API (`api.mdblist.com`, docs at https://api.mdblist.com/docs/ — JS-rendered Swagger page, contents UNVERIFIED beyond base URL).
- **MDB Score** = proprietary composite; docs/score VERIFIES the mechanism: "score is calculated using all the ratings average and with a votes baseline … baseline is different for every rating type … below baseline the rating is decreased, except current-year titles" — https://docs.mdblist.com/docs/score (per-source baselines & weights private → exact formula UNVERIFIED; companion app: "blends them into a single MDB Score" — https://reeel.app/).
- **Tags** (numeric `q_tag` ids): pass-2 resolves these = the **keywords** system, fully documented incl. curated keyword list (§2.6); id→name mapping remains the only unresolved piece.

### 3.3 Release dates & providers — VERIFIED
- Digital vs theatrical per-region cadence exists as filter fields ("Has Release = Digital", `d:30` digital window) — https://www.reddit.com/r/mdblist/comments/1r6e0k6/best_new_movie_release_filters/ (dev reply, VERIFIED). Pass 2 verifies `yearr`/`yearu` tooltips: "Within days / Upcoming releases in the next x days / `d:x` digital / `p:x` physical" (§2.2).
- Provider map is TMDB/JustWatch (§3.1). Replicating `q_provider_x` excludes is a TMDB `without_watch_providers`+`watch_region` call, not an independent dataset problem (§2.5 id parity).

---

## 4. Free providers & datasets (pass 1)

| Source | Gives | Auth | Free limits | Replaces | Notes |
|---|---|---|---|---|---|
| **TMDB v3/v4** | discover: genres/keywords/companies/collections AND-OR (`x` comma=AND, `\|`=OR), `with_release_type` (4=digital), `region`, `release_date.gte/lte`, vote avg/count floors, `with_watch_providers`/`without_watch_providers`/`watch_region`/monetization types, certification, original_language, origin_country, people; `release_dates` endpoint per region; JustWatch-powered providers | free API key | "no monthly cap" non-commercial; soft ~40–50 req/s anti-scrape ceiling; 429 must be respected; 6-month response caching allowed by ToS | catalog spine + provider excludes + digital-release sort/window | VERIFIED: https://developer.themoviedb.org/docs/rate-limiting , https://developer.themoviedb.org/reference/movie-watch-providers ("Powered by our partnership with JustWatch", attribution mandatory), https://www.themoviedb.org/api-terms-of-use , https://developer.themoviedb.org/docs/faq (free non-commercial + attribution). **Does NOT give:** RT/Metacritic/Letterboxd/Trakt/MAL scores, IMDb votes, curated tags. |
| **IMDb non-commercial datasets** | `title.basics` (type, year, runtime, genres, isAdult), `title.ratings` (avg+numVotes), `title.akas`, `name.basics`, `title.crew`, `title.principals`, `title.episode` | none — HTTPS GET | bulk download, **refreshed daily**, personal/non-commercial license only | IMDb rating/votes floors + IMDb-popular proxy (vote count), genres, years at full-corpus scale | VERIFIED: https://developer.imdb.com/non-commercial-datasets and live index https://datasets.imdbws.com/ (7 TSV files; "non-commercial use only", schema unchanged since 2024-03-18 backfill). **No per-country release dates, no charts/Top-250 file, and (pass-2 relevant) NO content-advisory or keywords columns** in the current set (confirmed from file listing). |
| **Trakt API** | `/movies|shows/trending` (watchers now), `/watched/{period}`, `/popular`, `/recommended`, **`/{type}/{id}/stats`** → watchers/plays/collectors/lists/votes, official + user lists, calendars | free app client_id; OAuth only for user data | **1000 GET / 5 min per app & per user; POST/PUT/DELETE 1/s** | Trakt watchers floor, "Most Watched Past Week"-style charts, trending catalogs; pass-2: replaces Popular-lists Trakt family + `q_watched`/Trakt-list membership via `/sync` | VERIFIED: https://docs.trakt.tv/docs/rate-limiting , https://docs.trakt.tv/reference/getshowsstats , https://docs.trakt.tv/reference/getmediatrending (also supports genres/years/ratings/countries/certifications/date filters + `watchnow` streaming filter server-side). |
| **JustWatch** | official Partner API (offers per country, providers, **Streaming Charts ranks daily/7d/30d**, upcoming digital/theatrical/re-release dates) needs **partner token**; public **GraphQL `https://apis.justwatch.com/graphql`** (POPULAR/TRENDING/IMDB_SCORE/TMDB_POPULARITY sorts, per-country, providers/packages filters) usable via unofficial libs, no key, but "undocumented, may change, no published rate limits, excessive usage may be blocked" | partner: contract; GraphQL: none | unofficial | backup provider map + JW-rank charts (MDBList's "JustWatch Rank" column) | VERIFIED: https://apis.justwatch.com/docs/api/ (partner API + charts semantics), https://github.com/anthonyfranc/simple-justwatch-js (endpoint + caveats), https://github.com/electronic-mango/simple-justwatch-python-api. Treat as fragile; TMDB already relays JW data — and §2.5 proves the provider id space is shared. |
| **Simkl** (already used) | search/id, trending, calendars, sync, ratings; static trending/calendar JSON on CDN | free `client_id` (+token for user writes) | **10 GET/s, 1 POST/s per client_id and per token**; free for non-commercial | arriving-today + rating filters | VERIFIED: https://api.simkl.org/resources/rate-limits , https://api.simkl.org/api-rules |
| **OMDb** | one call per title by IMDb id: IMDb rating+votes, **Rotten Tomatoes % + reviews count, Metascore**, BoxOffice, DVD date, awards, genre/country/language | free key (email) | **1,000 req/day** (patron tiers 100k+); license CC BY-NC 4.0; no filter/search endpoint — join per title only | RT/Metacritic score floors; pass-2: curated `certified-fresh/rotten/fresh`, `metacritic-must-see`, awards keyword families, box office | VERIFIED: https://www.omdbapi.com/apikey.aspx (free 1,000 daily), https://apis.io/rate-limits/omdb/omdb-rate-limits/ , https://apis.io/apis/omdb/omdb-id-parameter-api/ (CC BY-NC 4.0, sample Ratings array). Personal-scale math in §6. |
| **Rotten Tomatoes / Metacritic direct** | no free official API | — | — | — | Only sanctioned free paths = OMDb (above) or MDBList itself. RT editorial lists are scrapeable (MDBList imports them as external lists — proof of surface, https://docs.mdblist.com/docs/external_lists.html) but scraping sits against publisher ToS → **risky, avoid**. |
| **Letterboxd** | avg rating (0–5), **rating count**, histograms, lists | official API exists but **invite/waitlist only**; email access explicitly excludes "data-analysis, visualization or recommendation projects… private or personal projects" | none open | Letterboxd rating/votes floors (§2.2 rows) | VERIFIED: https://letterboxd.com/api-beta/ (denial text), https://api-docs.letterboxd.com/ (schema incl. AverageRating sorts). Practical routes: film-page JSON-LD `aggregateRating` via browser-ish GET (sub-pages 403 for naive clients; datacenter IPs blocked) — https://logiover.com/guides/letterboxd-no-api-export-film-review-data/ + scraping skill notes; or grey-market wrappers (e.g. https://www.lbxd-api.xyz/ free 50 req/h — unvetted third party, security/ToS caveat). Treat as **GAP with fragile workarounds**. |
| **MyAnimeList API v2** | anime search/ranking (`/anime/ranking`, 8 ranking types), scores, popularity | free client ID; `X-MAL-CLIENT-ID` header for public data, OAuth2 only for user actions | documented caps not seen on the reference page — **UNVERIFIED** | MyAnimeList rating + "Top Anime" charts; AniDB rows proxied by AniList | VERIFIED auth/ranking: https://myanimelist.net/apiconfig/references/api/v2 . Fallbacks: **Jikan** (no key, ~"a few req/s, ~60/min" public service) https://github.com/jikan-me/jikan-rest , https://freeapihub.com/apis/jikan-rest ; **Kitsu** `kitsu.io/api/edge` public reads no key, fair-use rate limit https://freeapihub.com/apis/kitsu ; AniDB API requires registered client, limits **UNVERIFIED**. XRDB's provider ladder (TMDB→MDBList→Jikan/Kitsu/AniList→Simkl) is a working reference design — https://github.com/CreepsoOff/XRDB |
| **Wikidata** | free CC0 SPARQL; the reliable trick is **ID crosswalk** (IMDb↔TMDB↔RT↔Metacritic↔Trakt↔AniDB ids) for joins, not scores; bulk dumps also free | none | shared public endpoint, be polite | join-key bootstrap for the scores DB; pass-2: awards-keyword family could also derive from Wikidata award-item claims (effort note) | VERIFIED as ID-exchange pattern: https://github.com/wa8eem/wikidata-identifier-extractor (MIT, uses query.wikidata.org, lists IMDb/Trakt/TMDB/RT ids). Wikidata *rating values* coverage: sparse, not relied on — UNVERIFIED. |
| **MovieLens** | 25M–32M user ratings + tag genome (research scale) | none | research/non-commercial per README; redistribution restricted | popularity-signal only, different scale/coverage than MDBList filters | VERIFIED existence+license: https://grouplens.org/datasets/movielens/ — **not useful** for your filters (mlIds, not IMDb-native joins; skip). |
| **Open-source prior art** | — | — | — | — | No true "self-hosted MDBList" found. Nearest: **Seerr/Overseerr/Jellyseerr** discover routes = exactly your filter subset on TMDB (`watchProviders+watchRegion`, certifications, runtime, vote floors, date windows) — https://github.com/seerr-team/seerr/blob/92c486d3/server/routes/discover.ts , https://github.com/sct/overseerr/blob/5ef098f6/server/routes/discover.ts (copy the query-param model). **XRDB** (Stremio ratings overlay, multi-provider ladder) — https://github.com/CreepsoOff/XRDB . **rating-aggregator-** (Stremio ratings addon, Redis cache, IMDb dataset) — https://github.com/anmol210202/rating-aggregator- . **kgenovz/stremio-ratings-v3** (full IMDb ratings dataset → local DB + Kitsu mapping, Docker) — https://github.com/kgenovz/stremio-ratings-v3 . **eurusik/ratingo** (TMDB+Trakt+OMDb+TVMaze composite "Ratingo Score" pipeline — closest architecture to a home-grown MDB Score) — https://github.com/eurusik/ratingo . **"Mostable"** as described (free mdblist clone): **not found** in searches → UNVERIFIED name, nothing to borrow. flixpatrol: scrape-only, no API (MDBList imports it as URL scrape) — https://docs.mdblist.com/docs/external_lists.html |

---

## 5. Gap analysis — merged with filter matrix

Legend: FULL · PARTIAL (join/nightly work) · GAP (workaround noted). Row-by-row verdicts now live in §2.2/§2.3; this section is the rollup. Pass-1 capability rows are preserved below the tally where they carry unique caveat text.

**§2 tally (movies panel + shared, one row per control incl. min/max pairs):** **31 FULL · 23 PARTIAL · 8 GAP · 3 meta/UNVERIFIED rows** (65 rows; shows table §2.3 adds 8 more rows, mostly PARTIAL; the 4 login-scope §2.7 filters are FULL once Trakt sync is wired). GAP rows: RogerEbert range; Letterboxd rating + votes; 4× IMDb parental advisories (Sex&Nudity/Violence/Profanity/Alcohol); Common Sense Kids Age; (+chart-level) FlixPatrol/pirated popular-lists embedded in the PARTIAL row. Biggest-effort items: advisories + Common Sense + Letterboxd + RogerEbert (all L, all scrape-against-ToS-or-no-source), curated dolby/4k keyword family (L).
**Your actual working URL** (the anchor decode): every param it exercises — releasedigital sort, all rating/vote floors incl. trakt/tmdb/mc/rt/anidb empties, parental sliders (currently at default 0–5 = inactive), q_score_average, tmdbid_hide, genre-exclude, q_status, q_release=4, language/country incl/excl, budget/revenue empties, runtime empties, q_tagx excludes ×2, q_theater/q_region, q_provider_x ×6, q_limit=200, q_watched/trakt-list empties — is replicable **today** with TMDB discover + IMDb datasets + local index **except** the two keyword ids, the (inactive) RogerEbert/Letterboxd/AniDB bounds, and the chart-ish `q_list` pair (empty in your URL anyway). Net: ≈90% of the URL's *active* constraints are FULL or trivially local.

Pass-1 capability rows (unique caveats retained):

| MDBList capability (from your URLs) | Free source(s) | Verdict | Work / caveat |
|---|---|---|---|
| Catalog spine (title/year/genre/language/country/runtime) | TMDB discover | ✅ | already built |
| Digital-release date sort + `d:30`-style windows per region | TMDB `release_dates` (type 4 digital, 3 theatrical) + discover `with_release_type`+`region`+`release_date.gte/lte` | ✅ | sort needs local join: discover can't *sort by* digital date (only popularity/date/vote) → keep digital date column in own index, sort there. `sort_by=primary_release_date` + region is the TMDB-side approximation. |
| Theatrical-release windows | TMDB same | ✅ | |
| IMDb rating floor + votes floor | **IMDb datasets `title.ratings`** (join on IMDb id) | ✅ | better than MDBList at your scale: full corpus daily, no API cost; join keyed via TMDB `external_ids` / IMDb `tt` ids |
| IMDb "Popular" proxy | IMDb numVotes bucket | ✅ | approximation only |
| TMDb popularity/vote floors | TMDB discover native | ✅ | |
| RT score floor (+ audience), Metacritic floor | **OMDb per-IMDb-id** | 🟡 | 1,000/day cap → hydrate only new/changed titles nightly; scores go stale for long tail; cache forever in KV/R2 join table |
| Trakt watchers count floor | Trakt `/{type}/{id}/stats` or trending/popular pages | 🟡 | per-title call; hydrate top-N (e.g. titles passing your other floors), not full corpus; Trakt also caps 1000 GET/5min — fine nightly |
| JustWatch Rank | public JW GraphQL / partner charts | 🟡 | unofficial endpoint fragility; or drop (rank is rarely a floor filter) |
| Letterboxd rating + votes floors | scraping-only (JSON-LD per film) | ❌ | no free API; official access explicitly refused for personal/analysis use. Workaround: nightly scrape of a *bounded watch-set* (titles already passing other floors) with browser headers; else accept loss and note LB≈taste-weighted IMDb for your niche |
| **NEW:** IMDb parental advisories (4× 0–5) | imdb.com title pages only (datasets carry none — §4 IMDb row) | ❌ | scrape-only; recommend dropping (you never set them: your URL leaves defaults 0–5) |
| **NEW:** Common Sense Kids Age | commonsensemedia.com only | ❌ | no API; drop or accept |
| **NEW:** AniDB rating/votes | AniDB API (client reg) / AniList GraphQL (free) | 🟡 | AniList is the practical free twin; your URL leaves it 0–10 default = unused |
| MyAnimeList / anime rankings | MAL API v2 (free client id) or Jikan/Kitsu | ✅ | anime-only scope; XRDB ladder as fallback chain |
| RogerEbert score, Budget/Revenue, Downloaded columns | OMDb (box office partial) / The Numbers (none free) | 🟡/❌ | OMDb gives `BoxOffice`+`Awards`; "Downloaded" data unreproducible — accept loss; budget/revenue now ✅ via TMDB details join (local cols) |
| Provider availability per country (`q_provider_x` includes/excludes) | TMDB discover `with/without_watch_providers`+`watch_region` | ✅ | same JustWatch upstream as MDBList (dev-confirmed §3.1 + id-space proof §2.5) |
| Genre/language/country excludes | TMDB `without_genres`/`with_original_language`/`with_origin_country` | ✅ | note: TMDB gives *include* for origin country; multi-country exclude → local join; MDBList anime-subgenre taxonomy has no TMDB twin (PARTIAL, §2.2) |
| Certification floors | TMDB `certification`+`certification_country` | ✅ | Seerr proves pattern |
| Keyword/studio/network filters | TMDB keywords/companies | ✅ | already built; curated-keyword half of q_tag needs §2.6 derivations |
| Curated **keywords/tags** (`q_tag*=10979…`) | half TMDB-native, half self-derivable (§2.6) | 🟡→❌ tail | private curation now *documented* (docs/keywords); id→name of your 4 exclusions still UNRESOLVED — check saved-list UI chips |
| **MDB Score** composite | build your own | 🟡 | mechanism VERIFIED (per-source vote-count baselines demote low-vote ratings; current-year exempt; §3.2) — constants still private; ratingo pattern (normalize + confidence gate) approximates |
| Official charts: Trakt Trending/Popular/Watched-week | Trakt API native | ✅ | exact parity, free (docs/popular_lists source table confirms membership) |
| Official charts: JustWatch Streaming Charts | JW GraphQL/popular | 🟡 | unofficial |
| Official charts: IMDb Top 250 / box office / movie-meter charts | **IMDb datasets have no charts file** (listing verified); charts = scrape imdb.com with browser headers | 🟡 | Top-250-style lists also mirrored on Trakt official lists / Letterboxd lists (scrape); keep your current MDBList official call until chart module proven |
| Official charts: FlixPatrol per-platform top-10s, "Most Pirated" (TorrentFreak) | no free source (scrape flixpatrol / torrentfreak article) | ❌ | accept loss |
| List storage/sync/feeds (watchlist sync, Trakt/Plex bridges) | out of scope for my-list (you only read lists) — BUT `q_watched`/Trakt-list membership filters are in-scope §2.7 | n/a / ✅ via Trakt sync | skip list-management; wire Trakt OAuth once |

**Net fidelity estimate (pass-2 refined):** scraped-filter lists ≈85% (§2.2 shows only critic-aggregator + advisory + CS + chart sources resist); official charts ≈70% (Trakt-family exact, JW close, IMDb charts scrapeable, FlixPatrol/pirated lost).

---

## 6. Recommended architecture (personal scale, free keys only)

Keep: Cloudflare Worker (Stremio manifest/catalog), GitHub Actions (nightly generators), GitHub Pages (static JSON). Add one artifact: a **scores join table**.

```
Nightly Actions (cron):
1. hydrate.mjs   — diff TMDB-popular index vs local index (changes API / discover sweeps)
2. imdb-join.mjs — stream title.basics + title.ratings from datasets.imdbws.com
                   → keep only ids in index (title.ratings.gz is only ~7MB compressed)
3. omdb.mjs      — OMDb by i=<imdb_id> for NEW + 30-day-stale rows, budget ≤900 calls/day
                   → RT/Metacritic/boxoffice/Awards columns (skip silently when titles > budget:
                   prioritize rows near a configured score floor)
4. trakt.mjs     — trending/popular/watched pages + stats for index's top-N (≤ ~3k calls)
5. providers     — TMDB discover with/without_watch_providers per your regions
                   (same upstream + same id space as MDBList — no extra provider infra needed)
6. build-index.mjs — one JSONL join table {tmdb_id, imdb_id, digital_date_<region>,
                   imdb_rating/votes, rt, mc, trakt_watchers, jw_rank?, lbx?, tmdb_status,
                   budget, revenue, last/next_air_date, episode_runtime_avg, own_tags[]}
                   → gzip to R2 (or commit to Pages repo); publish per-catalog top-K JSONs
7. filters.mjs   — small query DSL translating your favorite MDBList URL params
                   (sort=releasedigital, imdb>=7, votes>=2500, without provider X, d:30 window,
                   genre excludes, own keyword tags, q_status/q_release/q_certification mirrors)
                   against the index; emits Stremio catalog JSON
```

- **Where compute lives:** join/build in Actions (free minutes, node can stream TSVs); Worker only reads finished JSON from R2/Pages. No DB server needed; the index is ≤ ~200MB JSONL for a 100–300k-title working set.
- **Modules to retire:** `scrape.mjs` (fully — replaced by filters.mjs over local index); `official.mjs` (mostly — Trakt/MAL/JW-chart endpoints replace it; optionally keep MDBList official calls until chart parity confirmed, free 1k/day still covers it).
- **Rate-limit math (nightly budget):** OMDb 900 calls = ~1.5% churn/day on a 60k index, or first-pass full build = 60+ days — mitigate by only scoring titles that can ever hit your floors (pre-filter by IMDb votes ≥1k first, typically <20k titles) and seeding old rows from a one-time patron-month or MDBList bulk export (free API 1k/day can dump 10k-item lists in 10 days). IMDb + TMDB = effectively unlimited at this scale. Trakt 1000/5min × few minutes = fine.
- **MDB Score:** ship `own_score` = mean(z-normalised imdb, tmdb, rt, mc, trakt) with vote-count confidence gate per source (mirrors the VERIFIED baseline-demote mechanism, §3.2) — ratingo pattern; label it as yours, not theirs.
- **Charts fallback:** keep MDBList official API (free 1k/day, your current use) as *one* catalog source while Trakt/JustWatch chart rebuilds are validated — the two systems coexist at zero extra cost.

**Risk box**
- **ToS/licence:** IMDb datasets = personal/non-commercial only, store privately, never republish raw (derived join table inside your private repo is the norm — same stance as bbilly1/imdb-db). OMDb data CC BY-NC 4.0 → attribute, keep non-commercial. TMDB: attribution mandatory (they revoke for missing attribution) + JustWatch attribution required when surfacing provider data. Trakt/Simkl: non-commercial free, honor 429s; Simkl suspends sustained overage without appeal.
- **Unofficial-API fragility:** JustWatch GraphQL can change schema any time (keep behind adapter + fallback to TMDB); Letterboxd scrapes need browser headers, block datacenter IPs (GitHub Actions runners are datacenter → likely 403 — this is the module most likely to stay ❌); RT/MC direct scraping = publisher ToS risk, route via OMDb instead; **same verdict applies to MDBList's other scrape-sourced columns (advisories, Common Sense, flixpatrol) — do not replicate the scrapes, drop the filters.**
- **Free-tier cliffs:** OMDb 1k/day is the only hard quota that actually constrains design; everything else has slack at personal scale.
- **Single-key risk:** all your keys (TMDB/OMDb/MAL/Trakt) are free + email-recoverable; none store payment — acceptable.

---

## 7. Verified vs assumed (quick ledger, pass 1 + pass 2)

| Claim | Status |
|---|---|
| MDBList ratings sources (IMDb/TMDb/LB/RT/MC/MAL/RogerEbert/Trakt) | **VERIFIED** docs.mdblist.com + mdblist.com/movies sort list |
| AniDB rating/votes filter params exist in MDBList form (pass 1 was UNVERIFIED) | **VERIFIED** form JS `ratingsFilters` array, 2026-09-14 scrape |
| Parental advisory ×4 (IMDb model) + Common Sense Kids Age filters exist | **VERIFIED** controls; underlying sources **INFERRED** (IMDb advisories / commonsensemedia) |
| MDB providers = JustWatch-via-TMDB, id namespace shared | **VERIFIED** (dev statement) + live `/ajax/providers` id table (§2.5) |
| Free tier = 1k API/day, 4+4 lists, 1 external, 10k items, 24h/weekly refresh, 120-day purge | **VERIFIED** docs |
| MDB Score mechanism (avg of ratings + per-type vote baselines, current-year exempt) | **VERIFIED** docs/score; exact constants **UNVERIFIED** |
| Keyword/`q_tag` system = TMDB/Trakt/IMDb keywords + documented curated list incl. awards | **VERIFIED** docs/keywords; numeric id→name **UNVERIFIED** |
| Popular lists = IMDb charts / Trakt pages / FlixPatrol / TorrentFreak / vote-increase | **VERIFIED** docs/popular_lists |
| yearr/yearu = "within days"/"upcoming days" with `d:x`/`p:x` syntax | **VERIFIED** tooltips |
| TMDB discover param set incl. `without_watch_providers`, `with_release_type`, region | **VERIFIED** docs/OpenAPI |
| IMDb datasets = 7 TSVs, daily, non-commercial, no charts/release-dates/advisory/keyword file | **VERIFIED** live listing |
| Trakt 1000 GET/5min + per-title stats watchers | **VERIFIED** docs |
| OMDb free 1000/day, returns RT+MC, CC BY-NC | **VERIFIED** key page + apis.io metadata (license attribution secondary source) |
| JustWatch partner API needs token; GraphQL public endpoint unofficial | **VERIFIED** apis.justwatch.com/docs + JS client README |
| Simkl 10 GET/s + non-commercial free | **VERIFIED** docs |
| Letterboxd official API closed to personal/analysis projects | **VERIFIED** api-beta page |
| MAL public reads via `X-MAL-CLIENT-ID` | **VERIFIED** API ref; exact MAL caps **UNVERIFIED** |
| Jikan ~60/min, Kitsu no-key reads | **SECONDARY** (freeapihub/jikan notes) — UNVERIFIED against primary docs |
| "Mostable" project; api.mdblist.com endpoint schema; IMDb charts scrape reliability; `last_aired` exact range semantics; `s_lists` filter-vs-action edge; q_sortorder/q_current_page render (guest JS) | **UNVERIFIED** (unchanged from pass 1 unless noted) |
| Provider ids 11 / 73 / 232 names | **UNRESOLVED** from guest US set — resolve in owner's logged-in picker |
| q_watched / q_trakt_list_name/desc / q_list_filter_id controls | **URL/JS-confirmed existence**; widget bodies login-gated → semantics INFERRED |

## 8. Top-5 build order (updated)

1. **Local join table** (TMDB index + IMDb datasets) — retires IMDb rating/votes + digital-date + sort filters immediately; zero quotas burned; also hosts the 32-FULL-row mirrors (status/release-type/cert/window/limit/hide flags). Biggest fidelity win per effort.
2. **Provider exclude/include via TMDB** in filters.mjs — replaces `q_provider_x` semantics 1:1 (same upstream, same id space; §2.5 proof).
3. **OMDb nightly hydrator** with budgeter + vote-floor pre-filter → RT/Metacritic floors + the fresh/rotten/must-see/awards keyword families return.
4. **Trakt charts + stats + (optional) watched-sync** module → replaces "Most Watched Past Week"/trending official lists, watchers floors, and §2.7 membership filters.
5. **Own-keyword table (derived, §2.6) + own composite score** → approximates curated tags/MDB Score; keep MDBList official API as belt-and-braces during validation, then decide. Drop RogerEbert/Letterboxd/advisories/Common Sense unless owner proves usage (§9 Q2/Q6).

## Open questions for owner

1. Which specific MDBList keyword ids do you actually exclude (`10979`, `124256`, `295269`, `295272`)? Open the saved list's filter drawer — chips show names; that decides which §2.6 derivation set to build. (Also provider ids 11/73/232 + the `q_tag=339724` card-badge meaning remain unresolved for guests.)
2. Do you filter on Letterboxd votes or the parental/Common-Sense sliders often enough to justify fragile scrape modules — or accept their loss? (Your anchor URL uses defaults for all of these → suggests droppable.)
3. Working set size: roughly how many unique titles pass *all* your current filter URLs? Drives OMDb seed time (≈1–2 months at 1k/day, or one-time paid month to seed).
4. Can my-list's Stremio users be considered "personal use" under IMDb/OMDb non-commercial terms, or is the deployment purely single-user? (Affects how far the join table may be published.)
5. Which official charts do you read daily that have no free twin (FlixPatrol/pirated ones) — drop or keep MDBList for just those?
6. Do you want the RogerEbert column (only MDBList/free-none source) or is it unused? AniDB too (you left it at defaults).
