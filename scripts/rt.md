# rt — Rotten Tomatoes → IMDb/TMDB ids

`scripts/rt.mjs`. Runs on GitHub Actions, writes `data/rt_<id>.json`, served via
GitHub Pages.

## What it does

1. Reads the operator's enabled Rotten Tomatoes lists from the worker (`/export-config`).
2. Fetches each RT browse chart, following the cursor pagination to `maxItems` rows.
3. Resolves every row to an IMDb id by a **2-of-3 majority vote**, then verifies the
   winner against RT's own page before shipping it.
4. Writes `data/rt_<id>.json` and POSTs a run record to the worker.

**It never guesses.** An unresolved row is held out, counted, and the previous good data
file is kept.

## How the id is selected

RT never publishes an IMDb id, so an id has to be *derived* and then *proved*.

### 1. Three verdicts, one vote

| verdict | source | strong? |
|---|---|---|
| TMDB search | `api.themoviedb.org/3/search/{movie,tv}` | strong when the title matches exactly |
| IMDb suggestion | `v3.sg.media-imdb.com/suggestion/…` | strong on an exact title match, otherwise weak |
| Cinemeta | `v3-cinemeta.strem.io/meta/…` | strong on an exact title match, otherwise weak |

`scoreVote` adds **10** for a strong backer and **1** for a weak one. **A tie returns
`null`** — no winner, not a coin flip.

### 2. Acceptance

The vote is accepted only if **one** of these holds:

- at least one **strong** backer,
- **two or more** weak backers agreeing,
- the winner is a `tmdb:` fallback, or
- the winner is a lone **exact Cinemeta** match.

A thin single-verdict win goes down the corroboration ladder instead of shipping blind.

### 3. Winner verification — RT against the candidate

`verifyWinner` compares **RT's own detail page** with the candidate's TMDB record,
role-aware: **movies → directors**, **series → creators/writers**. The crew comparison
tolerates name variants (`namesAgree`: last name + first initial, token order, spacing,
surname extension) and transliterations (`namesAgreeTranslit`, `oo`↔`u`); a *disjoint*
crew set is a **veto** (`vetoDisjoint`). A strict transliteration miss can still be
rescued by `translitLift` — but only with an exact year **and** three shared lead names.

If the winner is vetoed:

- `evidenceRescore` re-scores every candidate against RT's evidence (the "Frankenstein
  page" case: right content, wrong date),
- then `imdbChair` asks for a **triple confirmation** — IMDb GraphQL credits ⟂ Cinemeta
  credits ⟂ RT's own page — and only a *unique* confirmation wins,
- otherwise the row is **held out**.

### 4. Corroboration ladder

When the vote is thin, split, or empty, `corroborateRow` looks for independent proof,
in tiers: `crew` → `cast` → `cross` → `noyear` → `identity` → `season`. A contradicted
candidate can only win via the `season` tier (a separately-listed season of a series).

### 5. Last resorts

- `directorArbiter` — for rare rows only, RT's director vs the candidates'.
- The **IMDb exact arbiter** — when the vote split, the IMDb exact match wins, but it is
  itself run through `verifyWinner` first.
- Otherwise: **hold out**.

### 6. Ship-time gates

- **kind gate** (`kindOkFor`) — an **episode** id must never ship for a series row, and a
  series/film id must never ship for a movie row. TMDB sometimes mislinks a series record
  to an episode id and no crew comparison can catch that, so the **IMDb `titleType`** is
  checked (keyless GraphQL, one request per flagged row). An unknown kind **abstains** —
  it never blocks and never vetoes.
- **year gate** — the candidate's year must line up with RT's year (±1 for listing-vs-
  premiere drift).
- **runtime rail** — a runtime **mismatch vetoes** the winner (three call sites in
  `verifyWinner`); a runtime match is extra corroboration.
- **duplicate id** — the same id written twice is held out.

## Title matching

`normRtTitle` is **exact only — no fuzzy, no "contains"**. Recall comes from *additive*
variants (`titleKeys`: de-articled, de-possessive, article-stripped), each still compared
for equality. So "Below" can never match "Five Feet Below", and "Monster: The Lizzie
Borden Story" can never match "Monster".

## Chart pagination

RT's browse charts are cursor-paginated (`cnapiUrl`: a base64 numeric offset). The pager:

- follows the cursor until `maxItems` rows are collected, **de-duplicating repeated
  slugs** and stopping if a cursor repeats,
- on `403/404/408/429/5xx` retries with a jittered ladder: **3 s → 6 s → 12 s → 20 s →
  30 s** (±20% jitter),
- on an **empty page** double-checks once after 10 s — an empty page can be a glitch
  (observed live returning 30 full rows on re-check, sometimes even claiming
  `hasNext:false`); only a second empty page ends the chart. A re-check whose fetch
  ladder is exhausted rethrows, so the list fails loudly rather than shipping short.

## Cache

`data/rt_cache.json` → `{type, imdb, tmdb, title, date}`, keyed by slug, plus a `kind`
field added **only after** the kind gate passed (store-on-pass, so a blocked kind is never
written). A title's identity never changes, so each slug resolves once ever; steady-state
runs only fetch new slugs. `kind` is the **IMDb-proven** title type.

## Run behaviour

- Empty chart ⇒ failure; the previous data file is kept.
- A row that cannot be proven is held out. **More than 10% held out ⇒ the list is refused**
  and the previous data file is kept.
- Writes are atomic (temp file + `renameSync`) — a crashed run never leaves a half-written
  file.
- TMDB is paced to **~3 requests/s**; every retry is bounded.
- The worker `/ts-fetch` proxy is the only sanctioned RT egress (RT challenges
  datacenter IPs); a cold first hit may return one 403, which is retried.

## Configuration

| env | default | meaning |
|---|---|---|
| `TMDB_READ_ACCESS_TOKEN` | — | TMDB API bearer (required) |
| `WORKER_ORIGIN` | — | worker base URL: run records + config (required) |
| `RT_FETCH_BASE` | = `WORKER_ORIGIN` | the `/ts-fetch` chart/detail proxy (required) |

CLI: `node rt.mjs`, `--ids=rt_ab12cd34`, `--action=delete --delete_ids=…`.

## Reading the logs

| line | meaning |
|---|---|
| `[vote]` | a winner was accepted, with its score |
| `[vote-corroborated]` | a thin win was confirmed by the corroboration ladder (tier named) |
| `[holdout]` | the row was **not** published, with the reason |
| `[weak-lone]` | a popularity pick with no corroboration — held out on purpose |
| `[imdb-arbiter]` | the vote split; the IMDb exact match won (and was verified) |
| `[kind-ok]` / `[kind-block]` / `[kind-fallback]` | the kind gate's decision |
| `[paginate]` | a cursor retry or an empty-page double-check |
| `[dedupe]` | a repeated slug was skipped |

## Known limits

- A wrong id in the cache is served forever — the cache trusts the ladder's output and
  never re-verifies it.
- The `logVerifyPoints` and `gqlRtAgreement` checks are **telemetry only**: they log, they
  do not gate a verdict. (The runtime rail is different — it vetoes.)
- The `season` / `variant` / `drift` tiers exist for rare row shapes and are the least
  exercised paths.
- The IMDb GraphQL and Cinemeta legs are third-party and can change shape without notice;
  every failure there abstains (never vetoes), so a silent API change degrades coverage
  rather than correctness.
