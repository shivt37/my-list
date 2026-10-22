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
| 2c | **the widened fingerprint** — poster SET, or the overview | 0–1 |
| 3 | **hard gates** | 0 |
| 3b | **ambiguity gate** | 0 |
| 4 | ranking | 0 |
| 4b | **IMDb kind gate on the shipped id** | 0–1 |
| 5 | the id (TMDB `/external_ids`) | 0–1 |
| HOLD | nothing survived → confidence NONE, held out | — |

### The fingerprint (why it is exact)

TV Stats copies TMDB's `poster_path` onto its own pages. A poster file name is unique to
one title, so **poster hash equality is identity** — no title matching, no ranking, no
popularity tiebreak.

Proven live: TV Stats `/xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg` == TMDB movie 27205 (Inception)
`og:image`; same for War Machine, The Diplomat, The Reluctant Vampire.
The Diplomat is the proof of value: title + year + kind leaves **3** candidates, the
poster hash picks **1**.

### The widened fingerprint (rung 2c) — the stale-poster recovery

TV Stats copies **one** poster path at ingest time. When TMDB later promotes a different
upload, the fingerprint goes stale — the old file is still a live TMDB asset and is still
in that title's own poster set, so the strict match fails. That happened to **4 of 199
rows (2.0 %)**.

TV Stats also copies TMDB's **own synopsis text** (`overview` for movies, `description`
for shows) verbatim. So a row can be identified by matching any of these against the
candidate's TMDB record:

| key | grades | notes |
|---|---|---|
| the poster, current | primary | what the strict check already does |
| the poster, in the title's poster set | strong | recovers a stale poster |
| the **overview** | strong | TMDB's own text, byte-identical — independent of the poster |
| the **backdrop** (shows only) | **corroboration only** | backdrops are shared across a franchise, so it never identifies a work and never rejects one |

The guard counts **distinct works, not candidate records** — the candidate list can hold
two records for the same work, and counting records makes every relaxed row look ambiguous
(measured: 0 of 4 recovered; counting works recovers 4 of 4). Two or more owners ⇒ the row
is **held out**, never decided by popularity.

The set check runs **after** the title/year/kind gates, so it can only ever *raise* a row
that already passed every correctness gate. It can never promote a wrong work, because the
ambiguity check sits on top of it.

**These keys may only ever RAISE a row, never REJECT one.** `runtime` collides across
68 % of TMDB movies and a strict `(budget, revenue)` equality rejects every movie (TV
Stats serialises `revenue` as a string, TMDB returns a number), so neither is used as a
gate.

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

The id is the **IMDb id** from the candidate's `/external_ids`. If the title has no IMDb id
anywhere, the **TMDB id is the fallback** (`tmdb:<id>`) — exactly what the RT pipeline
does. A TMDB id carries its own record type (a tv id *is* a series record), so the kind
gate that protects the IMDb path — where TMDB can point a *series* record at an *episode's*
IMDb id — does not apply to it: there is no episode-level ambiguity in a TMDB id, and the
hard gate has already checked the record's media type against the list kind. A row with
neither an IMDb id nor a TMDB id is held out.

Confidence comes from the **evidence**, never from the rung:

| | meaning | published |
|---|---|---|
| **HIGH** | a poster fingerprint (the current poster **or** one of the title's other posters, **or** an exact overview match) + the year leg + a confirmed kind | yes |
| **MEDIUM** | every gate green but no fingerprint, or the IMDb kind unconfirmed | no, at `high` |
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

`data/*.json` holds real TMDB records (numeric `id` + a `poster_path`) for the operator's
TMDB discover lists — 6 files, ~170 records. Those give a poster-hash → TMDB-id index
built at startup, so those rows resolve with **no search call**.

Only genuine TMDB records are used: `ts_cache.json` and `rt_cache.json` are excluded, a
file whose ids are strings (`tt…`, the TV Stats and RT catalogues) or absent (the
JustWatch and most-watched-week snapshots) contributes nothing, and a hash that maps to more
than one TMDB id is treated as ambiguous and is not used.

**How much it actually saves is small.** The daily charts are mostly titles the operator's
discover lists do not contain, so the index serves **~8 of the top 100 movie rows and ~3 of
the top 100 show rows** (measured 2026-10-20). It is a free lookup on the rows that happen
to overlap, not a way to skip the search. The run log says so per chart:

```
[index] the offline join can serve 8 of these 100 rows
```

## Reading the log

The run log answers "what happened, and what did it cost" in a few lines — the same
shape as the RT pipeline's log.

```
[index] the offline join can serve 8 of these 100 rows
[chart] https://televisionstats.com/topmovies
[chart] 100 rows, resolving IDs...
[progress] 25/100 rows
[slow] sacrifice: 21 requests - several candidates had to be checked
[id] matchbox: tt28498219 (2026) - matched by the synopsis
[id] monster-the-lizzie-borden-story: tmdb:299939 (2026) - this title has no IMDb id
[holdout] bleach-thousand-year-blood-war: a film in the shows chart
[progress] 100/100 rows
[tvstats_ffbhahjg] success - 100 items, 0 held out, 761 requests (7.6/row)
[summary] 199 items, 1 held out, 1264 requests (6.3/row), 1 tmdb: fallback
```

| tag | when |
|---|---|
| `[chart]` | the chart being fetched, and how many rows it has |
| `[index]` | how many of this chart's rows the offline join can already answer |
| `[progress]` | every 25 rows — a heartbeat, so a long run never looks frozen |
| `[id]` | a row that resolved but is worth a note: a non-primary fingerprint, a premiere drift, a TMDB fallback, or an unconfirmed IMDb kind |
| `[holdout]` | a row that was **not** published, with the reason |
| `[slow]` | a row that cost more than 12 requests (several same-name candidates had to be checked) |
| `[recheck]` / `[upgrade]` | a cached `tmdb:` entry re-checked, and upgraded if an IMDb id appeared |
| `[probe]` | a host was unreachable, so that rung was switched off for the run |
| `[tvstats_<id>]` | one line per list: items, held out, requests, requests per row |
| `[summary]` | the run totals |

**By default only the rows that need a note are printed** — the clean rows are silent, so
a 200-row run is ~15 lines instead of 200. `TVSTATS_LOG=full` prints one `[id]` line per
resolved row. `TVSTATS_SLOW_ROWS=<n>` moves the `[slow]` threshold (default 12).

The per-row request count is **not** printed any more: the cost belongs in the summary,
and a line that says only "this row cost 5 requests" tells you nothing about the id.

## Cache

`data/ts_cache.json` → `{kind, imdb, tmdb, title, date, poster, stableId, rung, confidence, v:2}`.
A v1 entry (no `v`) migrates on read and is treated as MEDIUM.

**The key is TV Stats' own stable per-title id** (`i:<id>`, present on 200/200 chart rows of
both kinds; the movie *detail* page has no id, so it comes from the chart row). A slug can
be reused for a different work — a stable id cannot. A row with no stable id falls back to
the slug key.

**Every hit is re-validated against the row** (title + poster must still match). A stale
entry falls through to the online path instead of publishing an old id under a new title.

**A remembered miss** (`{miss: true, at}`) holds an unresolvable row out for 7 days at
**0 HTTP calls** — before this, the held-out rows were re-resolved on every run, forever
(50 calls/run).

**A cache hit costs 0 HTTP calls** — a warm run of both charts makes **0 requests**
(measured).

## Run behaviour

- Empty chart ⇒ failure; the previous data file is kept.
- A row that cannot be proven is held out. **More than 10% held out ⇒ the list is refused**
  and the previous data file is kept.
- **A failed TMDB search is a failure, not an empty result.** The row is held out and
  retried next run, rather than being answered from the weaker IMDb-suggestion rung
  (which can return a *different* id). The log says which failure it was.
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

Measured on the live 200-row corpus (100 movies + 100 shows, 2026-10-22):

| | result |
|---|---|
| published | **199 / 200** |
| held out | **1** (deliberately — see below) |
| wrong ids | **0** (every id re-checked against IMDb `titleType` + title + year) |
| cold run | 1257 requests, 6.29/row, 440 s |
| warm run | **0 requests**, 0.0 s |

The 1 row that stays out on purpose:

- **`bleach-thousand-year-blood-war`** — a FILM in the shows chart. TV Stats' own metadata
  contradicts itself (the `(MOVIE)` marker says film, the date and the Wikipedia slug say
  the 2022 series), and relaxing the title gate to "fix" it publishes the 2022 **series**
  for a film row. The `(MOVIE)` marker is read as a kind hint, never stripped.

A title with no IMDb id is published with its TMDB id as the fallback — e.g.
`monster-the-lizzie-borden-story` → `tmdb:299939` (TMDB: "Monster: The Lizzie Borden
Story", tv, 2026 — the same title, kind and year as the chart row).

The job timeout is 45 minutes against a ~7-minute cold run.

## Known limits

- The **IMDb GraphQL is load-bearing for HIGH**. If it is down every row caps at MEDIUM,
  so under `TVSTATS_PUBLISH_MIN=high` nothing publishes and the list aborts (fail closed,
  a day of stale data). It warns and keeps going rather than failing fast.
- The ladder depends on TV Stats continuing to copy TMDB poster paths. If that stops, the
  fingerprint rung goes empty and the fallbacks carry the load. The poster-SET rung makes
  that failure much softer: a stale poster is still found, and a *missing* poster is the
  only case that costs the row.
- Wikipedia/Wikidata are **not** used in production. They agree with the resolver
  (98/98 measured) but recover nothing the poster-SET does not, and their rate limiting
  is a User-Agent policy, not a rate limit.
- The chart pages carry 200 rows but a list is capped by `maxItems` (default 100).
- A row whose IMDb kind cannot be confirmed is never published, and a title with no IMDb
  id at all is never published — the catalogue is shorter than the chart by design, and
  the run log says how many rows were held out and why.
