# tvstats — Television Stats → IMDb/TMDB ids

`scripts/tvstats.mjs` (wiring) + `scripts/tvstats-ladder.mjs` (the resolver).
Runs on GitHub Actions, writes `data/tvstats_<id>.json`, served via GitHub Pages.

## What it does

1. Reads the operator's enabled TV Stats lists from the worker (`/export-config`).
2. Fetches each chart page (`/top`, `/topmovies`, `/top/year`, `/reddit`, …).
3. Resolves every row to an IMDb id (or a `tmdb:<id>` when IMDb genuinely has none).
4. Writes `data/tvstats_<id>.json` and POSTs a run record to the worker.

**It never guesses.** A row that cannot be proven is held out, counted, and the previous
good data file is kept.

## Why the ladder exists

Television Stats **removed `imdb_id` from its movie pages** between 2026-10-07 and
2026-10-18 (Wayback proof: `"imdb_id":"tt0472043"` → gone). The old `resolveMovie` read
that field, so it threw for every movie it had not already cached — 7 of the top 100
movies were silently dropped while the run still reported "success". Shows never had an
`imdb_id`, so they already used a search.

## How the id is selected

### The ladder (per row)

| rung | what | cost |
|---|---|---|
| 0 | cache hit (`data/ts_cache.json`, v2) | **0 HTTP** |
| 0a | `tmdb:` → `tt` re-check on a cached fallback | 0–1 |
| 0b | **offline join** — the repo's own TMDB records, poster hash → TMDB id | 0–1 |
| 1 | TV Stats detail page (worker `/ts-fetch` proxy) | 1 |
| 2 | TMDB `/search/{movie,tv}` (+ a year-filtered variant) | 1–2 |
| 2b | IMDb suggestion API → TMDB `/find/<tt>` | 0–2 |
| 3 | **hard gates** | 0 |
| 3b | **ambiguity gate** | 0 |
| 4 | ranking | 0 |
| 4b | **IMDb kind gate on the id about to ship** | 0–1 |
| 5 | the id: TMDB `/external_ids` | 0–1 |
| HOLD | nothing survived → held out | — |

### The fingerprint (why it is exact)

TV Stats copies TMDB's `poster_path` onto its own pages. A poster file name is unique to
one title, so **poster hash equality is identity** — no title matching, no ranking, no
popularity tiebreak.

Proven live: TV Stats `/xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg` == TMDB movie 27205 (Inception)
`og:image`; same for War Machine, The Diplomat, The Reluctant Vampire.
The Diplomat is the proof of value: title + year + kind leaves **3** candidates, the
poster hash picks **1**.

### The hard gates (a candidate failing any of them is discarded, never partially scored)

- **kind — whitelist.** movie row → `movie|tvMovie|video|documentary`; show row →
  `tvSeries|tvMiniSeries|podcastSeries`. An **unknown kind is rejected**.
  Plus: the IMDb `titleType` of the id **about to ship** must pass the same whitelist.
  TMDB sometimes links a *series* record to an *episode's* imdb id and a TMDB media type
  cannot see that class of error — so the shipped id is checked against IMDb itself.
- **title — ≥ 0.95** after the shared normalisation: lowercase → digit-runs 0-10 to words
  → strip non-alphanumerics → strip a leading `the`/`a`/`an`. (So TV Stats "Se7en" matches
  IMDb "Seven", and "The Fantastic 4: First Steps" matches "The Fantastic Four: …".)
- **year.** candidate year == TV Stats year, **or** the candidate's TMDB `release_dates`
  carry a TS-year date (movies only — TMDB has no `release_dates` for TV), **or** |Δyear| = 1
  with a title score of 1.0 and no other candidate matching the title in the TS year.
  A show row always takes its year from the **detail page** (`first_air_date`); the chart
  only carries `last_air_date`.
- **ambiguity.** Two candidates equal on *every* piece of evidence (poster, runtime, year,
  title score, suggestion rank) ⇒ ambiguous ⇒ the row is **held out**, never decided by
  popularity.

### The id, and the confidence

The id is the IMDb id from the candidate's `/external_ids`; if there is none but there is a
TMDB id, it is `tmdb:<id>` (the deployed consumer accepts it — `src/routes.js:218`).

Confidence comes from the **evidence**, never from the rung:

| | meaning | published |
|---|---|---|
| **HIGH** | poster fingerprint + every gate green + the IMDb kind confirmed | yes |
| **MEDIUM** | every gate green but no fingerprint, or the IMDb kind unconfirmed | yes (`TVSTATS_PUBLISH_MIN=medium`) |
| **LOW** | partial title match | **never** |
| **NONE** | held out | never |

`TVSTATS_PUBLISH_MIN=high` makes it fail closed. The workflow sets `high`, so the legacy
cache is re-resolved through the real path before anything is published.

### What is published

Only publishable rows are cached and published. A wrong id in the cache would be served
forever, so LOW/NONE rows are never cached. The item shape is
`{id, type, name, poster, releaseInfo}` and the catalog is
`{catalog_id, name, type, scraped_at, items}` — unchanged, because `src/routes.js:190`
`rowToMetaTvstats` reads exactly those fields. `name` and `releaseInfo` always come from
the **TV Stats row**, never from the candidate.

## The offline join (rung 0b)

`data/*.json` holds real TMDB records (numeric `id` + a poster) for the discover lists.
Those give a poster-hash → TMDB-id index built at startup, so ~50% of rows resolve with
**no search call**. Only genuine TMDB records are used: `ts_cache.json` and `rt_cache.json`
are excluded, and a file without a numeric TMDB id contributes nothing. A hash that maps to
more than one TMDB id is treated as ambiguous and is not used.

## Cache

`data/ts_cache.json` → `{kind, imdb, tmdb, title, date, poster, rung, confidence, v:2}`,
keyed `m:<slug>` / `s:<slug>`. A v1 entry (no `v`) migrates on read and is treated as
MEDIUM. **A cache hit costs 0 HTTP calls** — steady-state runs only fetch new slugs.

## Run behaviour

- Empty chart ⇒ failure; the previous data file is kept.
- A row that cannot be proven is held out. **More than 10% held out ⇒ the list is refused**
  and the previous data file is kept.
- The cache is written even when the list aborts (only publishable rows are cached) so a
  resolved row is not re-resolved next run; the data file is still only written when the
  list passes.
- Writes are atomic (temp file + `renameSync`).
- Requests are paced to **3/s** with a reservation pacer (correct under concurrency),
  429 backs off exponentially, and every retry is bounded.
- A failed optional host (IMDb suggestion API, the audit) is probed at startup and that
  rung is switched off — it never fails the run.

## Configuration

| env | default | meaning |
|---|---|---|
| `TMDB_READ_ACCESS_TOKEN` | — | TMDB API bearer (required) |
| `WORKER_ORIGIN` | — | worker base URL: run records + config (required) |
| `TS_FETCH_BASE` | = `WORKER_ORIGIN` | the `/ts-fetch` page proxy — the only sanctioned TV Stats egress |
| `TVSTATS_PUBLISH_MIN` | `medium` | `high` = fail closed (the workflow sets `high`) |
| `TVSTATS_AUDIT` | `off` | `tv` (TVmaze) or `juicewatch` — a second source that can **block** a row |

CLI: `node tvstats.mjs`, `--ids=tvstats_ab12cd34`, `--action=delete --delete_ids=…`.

## Cost

~4–6 requests per **new** row; ~0 for a cached row. A cold run of the two default lists
(2 × 100 rows) measured 1016 logical calls in 98 s. The job timeout is 45 minutes.

## Known limits

- The **IMDb GraphQL is load-bearing for HIGH**. If it is down every row caps at MEDIUM,
  so under `TVSTATS_PUBLISH_MIN=high` nothing publishes and the list aborts (fail closed,
  a day of stale data). It warns and keeps going rather than failing fast.
- The ladder depends on TV Stats continuing to copy TMDB poster paths. If that stops, the
  fingerprint rung goes empty and the fallbacks carry the load.
- Wikipedia/Wikidata are **not** used in production (not reachable from CI through the
  sanctioned egress, and not needed for the fingerprint path).
- The chart pages carry 200 rows but a list is capped by `maxItems` (default 100).
