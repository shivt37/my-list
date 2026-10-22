#!/usr/bin/env node
/**
 * tvstats-ladder.mjs - the Television Stats -> IMDb/TMDB identity ladder.
 *
 * Why this file exists: Television Stats removed `imdb_id` from its movie
 * detail pages between 2026-10-07 and 2026-10-18 (Wayback proof), so the old
 * `resolveMovie` (which read `pp.movie.imdb_id`) throws for every movie it has
 * not already cached. This module holds the replacement: a gated ladder that
 * resolves a row to an id or holds it out. It never guesses.
 *
 * THE LADDER (per row, production path):
 *   rung 0    cache hit (data/ts_cache.json, v2 schema)      0 HTTP
 *   rung 0a   the tmdb: -> tt re-check (a cached fallback)   0-1 HTTP
 *   rung 0b   OFFLINE JOIN (the repo's own TMDB records)     0-1 HTTP
 *   rung 1    TS detail page (through the worker's proxy)    1 HTTP
 *   rung 2    TMDB /search/{movie|tv} (+ a year variant)     1-2 HTTP
 *   rung 2b   IMDb suggestion API -> TMDB /find/<tt>         0-2 HTTP
 *   rung 3    the HARD gates (kind / title / year)           0 HTTP
 *   rung 3b   the AMBIGUITY gate (D5)                        0 HTTP
 *   rung 4    the ranking (the poster fingerprint wins)      0 HTTP
 *   rung 4b   the IMDb KIND gate on the shipped id (D1)      0-1 HTTP
 *   rung 5    the id (TMDB /external_ids)                    0-1 HTTP
 *   HOLD      nothing survived -> confidence NONE, held out
 *
 * HARD GATES (a candidate failing ANY of them is discarded, never scored
 * partially):
 *   kind    WHITELIST. movie row -> movie|tvMovie|video|documentary
 *           show row  -> tvSeries|tvMiniSeries|podcastSeries
 *           an UNKNOWN kind is REJECTED (never a partial pass).
 *           AND the IMDb titleType of the id that is ABOUT TO SHIP must
 *           pass the same whitelist (D1): TMDB sometimes links a SERIES
 *           record to an EPISODE's imdb id, and a TMDB media type cannot
 *           see that class of error.
 *   title   >= 0.95 after the shared normalisation.
 *   year    candidate year == TS year, OR the candidate's TMDB release_dates
 *           carry a TS-year date (movies only - TMDB has no release_dates for
 *           TV), OR |dy| == 1 with a title score of 1.0 AND no other surviving
 *           candidate matching the title in the TS year.
 *   proof   two candidates that are equal on EVERY piece of evidence
 *           (poster, runtime, year, title score, suggestion rank) are
 *           AMBIGUOUS -> the row is held out, never decided by popularity.
 *
 * CONFIDENCE is derived from the EVIDENCE, never from the rung:
 *   HIGH   poster fingerprint + every gate green (incl. the year leg)
 *           + a CONFIRMED IMDb kind on the shipped id
 *   MEDIUM every gate green, no fingerprint, or an unconfirmed IMDb kind
 *   LOW    the title score is < 0.95  -> NEVER published, and never handed
 *           back as an id (D6)
 *   NONE   held out
 *
 * Node built-ins only. The CI workflow installs no dependencies.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- constants

export const TITLE_GATE = 0.95;
export const CONF = Object.freeze({ HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW", NONE: "NONE" });
export const CONF_RANK = Object.freeze({ NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 });

/** The rank of a confidence string (case-insensitive). */
export function confRank(c) {
  return CONF_RANK[String(c || "").toUpperCase()] || 0;
}
export const MOVIE_TYPES = new Set(["movie", "tvmovie", "video", "documentary"]);
export const SHOW_TYPES = new Set(["tvseries", "tvminiseries", "podcastseries"]);
export const TT_RE = /^tt\d{7,9}$/;
// The cache schema version. Bumped to 3 when a `tmdb:`-only row became
// publishable again: a remembered MISS written under the old policy is
// dropped, so the row is re-evaluated instead of staying held out for
// the whole TTL.
export const CACHE_VERSION = 3;

const REQ_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 4;
const WALL_CAP_MS = 25000;
const BACKOFF_CAP_MS = 2000;

const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const IMDB_SUGGEST_URL = "https://v3.sg.media-imdb.com/suggestion/x/";
const IMDB_GQL_URL = "https://api.graphql.imdb.com/";
// The exact header set rt.mjs already uses from CI (rt.mjs:1563-1570).
// api.graphql.imdb.com answers HTTP 403 without Origin + Referer.
const IMDB_GQL_HEADERS = {
  "User-Agent": UA_BROWSER,
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://www.imdb.com",
  Referer: "https://www.imdb.com/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A RESERVATION pacer.
 *
 * The old pacer read the last-request timestamp, slept, and only THEN wrote
 * it: N concurrent workers all read the same value, all slept the same gap
 * and all fired together (measured: ~14 req/s against TMDB's published 40
 * req / 10 s). Here the slot is RESERVED before the wait, so N concurrent
 * callers get N DIFFERENT slots. JS is single threaded, so the read-then-set
 * inside this function cannot interleave.
 *
 * @param {number} gapMs the minimum gap between two calls
 * @returns {() => Promise<void>} a pacer to await before every call
 */
export function makePacer(gapMs) {
  let nextAt = 0;
  return function pace() {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + gapMs;
    const wait = at - now;
    return wait > 0 ? sleep(wait) : Promise.resolve();
  };
}

// The IMDb GraphQL is a shared, undocumented, keyless host: it is paced too
// (5 calls/s = 50 per 10 s), which is far below anything it enforces but
// far above what a 5-way concurrent run would fire at once.
const IMDB_GQL_MIN_GAP_MS = 200;
const imdbGqlPace = makePacer(IMDB_GQL_MIN_GAP_MS);

// ---------------------------------------------------------------- title rules

// Digit runs 0-10 become their English word, so "Se7en" -> "seven" and
// "The Fantastic 4" -> "The Fantastic Four". A run above 10 keeps its digits
// ("2049" stays "2049").
const NUM_WORDS = {
  0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
  6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
};

function numRunToWord(run) {
  const n = Number(run);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? NUM_WORDS[n] : run;
}

/** Is `short` a subsequence of `long`? */
function isSubsequence(short, long) {
  let i = 0;
  for (const ch of long) {
    if (i < short.length && short[i] === ch) i++;
  }
  return i === short.length;
}

/**
 * Expand the digit run inside one alphanumeric chunk.
 *
 *   "4"      -> "four"      (a standalone digit run)
 *   "se7en"  -> "seven"     (a leet spelling: the chunk's letters ARE the
 *                            word with the digit's own letter removed)
 *   "f1"     -> "fone"      (not a leet spelling - the letters do not spell
 *                            the word, so the word is substituted in place)
 *   "2049"   -> "2049"      (a run above 10 keeps its digits)
 */
function expandDigitChunk(chunk) {
  const m = /^([a-z]*)(\d+)([a-z]*)$/.exec(chunk);
  if (!m) return chunk;
  const n = Number(m[2]);
  if (!(n >= 0 && n <= 10)) return chunk;
  const word = NUM_WORDS[n];
  const rest = m[1] + m[3];
  if (!rest) return word;
  if (word.length - rest.length === 1 && isSubsequence(rest, word)) return word;
  return m[1] + word + m[3];
}

/** Alphanumeric chunks, lowercased, with the digit runs expanded. */
export function titleTokens(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(expandDigitChunk);
}

const ARTICLES = new Set(["the", "a", "an"]);
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "in", "on", "at", "to", "for", "with",
  "by", "from", "as", "is", "it", "its", "this", "that",
]);

function joinTokens(toks, stripArticle) {
  const out = toks.slice();
  if (stripArticle && out.length && ARTICLES.has(out[0])) out.shift();
  return out.join("");
}

/**
 * The canonical comparison key: lowercase -> digit runs 0-10 to words ->
 * strip every non-alphanumeric -> strip a leading the/a/an.
 */
export function normTitle(s) {
  return joinTokens(titleTokens(s), true);
}

/** The same transform WITHOUT the leading-article strip (the 0.95 tier). */
export function normTitleKeepArticle(s) {
  return joinTokens(titleTokens(s), false);
}

function sigTokens(toks) {
  return toks.filter((w) => w && !STOPWORDS.has(w));
}

/**
 * Title score:
 *   1.00  exact after the shared transform
 *   0.95  exact before the leading-article strip (still passes the gate)
 *   0.60  containment either way, or a >= 6 char prefix
 *   0.55  two or more shared significant tokens
 *   0.20  exactly one shared significant token
 *   0.00  unrelated
 * Only 1.00 and 0.95 pass the 0.95 gate; 0.60/0.55 are the documented lower
 * tier and are NEVER published.
 */
export function titleScore(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  const x = joinTokens(ta, true);
  const y = joinTokens(tb, true);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (joinTokens(ta, false) === joinTokens(tb, false)) return 0.95;
  if (x.length > 4 && y.includes(x)) return 0.6;
  if (y.length > 4 && x.includes(y)) return 0.6;
  if (Math.min(x.length, y.length) >= 6 && (x.startsWith(y) || y.startsWith(x))) return 0.6;
  const sx = sigTokens(ta);
  const sy = sigTokens(tb);
  let inter = 0;
  for (const w of sx) if (sy.includes(w)) inter++;
  if (inter >= 2) return 0.55;
  if (inter === 1) return 0.2;
  return 0;
}

export const yearOf = (d) => (d ? String(d).slice(0, 4) : null);

/** The poster FILE name - the fingerprint. ".../abc.jpg?x" -> "abc.jpg". */
export function posterKey(p) {
  if (!p) return null;
  let s = String(p).trim();
  if (!s) return null;
  s = s.split(/[?#]/)[0];
  const seg = s.split("/").filter(Boolean).pop();
  return seg ? seg.toLowerCase() : null;
}

/**
 * The poster SET of a TMDB entry: every poster file name TMDB holds for it.
 *
 * WHY: TV Stats copies ONE poster path at ingest time. TMDB may later promote
 * a different upload, so the fingerprint goes stale - but the old file is
 * normally still in the title's own poster set. "TV Stats' poster is in the
 * set" is a weaker but still exact identity test, and it recovers the rows a
 * stale fingerprint would otherwise drop.
 *
 * ONE call per TMDB id, memoised on the ctx.
 */
export async function tmdbPosterSet(ctx, tmdbKind, tmdbId) {
  const memo = ctx._posterSets || (ctx._posterSets = new Map());
  const key = `${tmdbKind}:${tmdbId}`;
  if (memo.has(key)) return memo.get(key);
  const out = { posters: new Set(), backdrops: new Set() };
  memo.set(key, out);
  try {
    countLogical(ctx);
    const res = await ctx.tmdbGetFn(`/${tmdbKind}/${tmdbId}/images`);
    syncCounts(ctx);
    for (const p of res?.posters || []) {
      const k = posterKey(p.file_path);
      if (k) out.posters.add(k);
    }
    for (const b of res?.backdrops || []) {
      const k = posterKey(b.file_path);
      if (k) out.backdrops.add(k);
    }
  } catch {
    /* the poster set is optional evidence - a failure just means no match */
  }
  return out;
}

/**
 * The full TMDB record for one id: its CURRENT poster, backdrop and overview.
 *
 * The overview is TMDB's own text and TV Stats copies it verbatim, so an
 * exact match is identity evidence that is independent of the poster.
 *
 * ONE call per TMDB id, memoised on the ctx.
 */
export async function tmdbRecord(ctx, tmdbKind, tmdbId) {
  const memo = ctx._records || (ctx._records = new Map());
  const key = `${tmdbKind}:${tmdbId}`;
  if (memo.has(key)) return memo.get(key);
  const out = { poster: null, backdrop: null, overview: null };
  memo.set(key, out);
  try {
    countLogical(ctx);
    const res = await ctx.tmdbGetFn(`/${tmdbKind}/${tmdbId}`);
    syncCounts(ctx);
    out.poster = posterKey(res?.poster_path);
    out.backdrop = posterKey(res?.backdrop_path);
    out.overview = typeof res?.overview === "string" && res.overview.trim() ? res.overview : null;
  } catch {
    /* the record is optional evidence - a failure just means no match */
  }
  return out;
}

// ---------------------------------------------------------------- kind gate

// IMDb's labels -> the canonical vocabulary. "TV Series" folds to "tvseries".
const IMDB_TYPE_MAP = {
  movie: "movie", feature: "movie", film: "movie",
  tvmovie: "tvmovie", video: "video", documentary: "documentary", short: "short",
  tvseries: "tvseries", tvminiseries: "tvminiseries", podcastseries: "podcastseries",
  tvepisode: "tvepisode", podcastepisode: "podcastepisode", tvshort: "tvshort",
  tvspecial: "tvspecial", musicvideo: "musicvideo", videogame: "videogame",
};

/** Canonicalise an IMDb kind string. Empty stays empty (unknown). */
export function canonImdbType(type) {
  const c = String(type ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return IMDB_TYPE_MAP[c] || c;
}

/**
 * The kind gate is a WHITELIST. A movie row accepts
 * movie|tvMovie|video|documentary; a show row accepts
 * tvSeries|tvMiniSeries|podcastSeries. An unknown or empty kind is REJECTED.
 */
export function kindOk(type, wantTv) {
  const c = canonImdbType(type);
  if (!c) return false;
  return wantTv ? SHOW_TYPES.has(c) : MOVIE_TYPES.has(c);
}

/** The TMDB kind a candidate must have for this row kind. */
export const tmdbKindForRow = (rowKind) => (rowKind === "movie" ? "movie" : "tv");
/** Map a TMDB kind onto the canonical vocabulary so ONE whitelist applies. */
export const typeFromTmdbKind = (k) => (k === "movie" ? "movie" : "tvSeries");

// ---------------------------------------------------------------- offline join

const catalogKind = (t) => {
  const c = String(t || "").toLowerCase();
  if (c === "movie") return "movie";
  if (c === "series" || c === "show" || c === "tv") return "tv";
  return null;
};

/**
 * Rung 0b: the OFFLINE JOIN index.
 *
 * A poster hash -> TMDB id index built from the repo's OWN TMDB records: the
 * files under data/ whose items carry a numeric `id` AND a `poster_path`.
 * The pipeline output files (data/ts_cache.json, data/rt_cache.json) are NOT
 * TMDB records and are excluded, and so is every file that does not carry a
 * numeric TMDB id (the JustWatch snapshot, the mdblist scraper rows, the
 * rt_/tvstats_ catalogs) - that is what keeps the join independent of the
 * audit source (V1) and of the legacy cache (V2).
 *
 * index: Map<posterKey, Array<{tmdb, kind, title, date, year, src}>>
 */
export function buildOfflineIndex(dataDir, opts = {}) {
  const idx = new Map();
  const exclude = new Set(["ts_cache.json", "rt_cache.json", ...(opts.excludeFiles || [])]);
  const excludePrefixes = opts.excludePrefixes || [];
  let files = [];
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  } catch {
    return idx;
  }
  for (const f of files) {
    if (exclude.has(f)) continue;
    if (excludePrefixes.some((p) => f.startsWith(p))) continue;
    let j;
    try {
      j = JSON.parse(readFileSync(join(dataDir, f), "utf8"));
    } catch {
      continue;
    }
    const items = Array.isArray(j && j.items) ? j.items : [];
    const catKind = catalogKind(j && j.type);
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const tmdb = Number.isInteger(it.id) && it.id > 0 ? it.id : null;
      if (!tmdb) continue; // a numeric TMDB id is REQUIRED
      const pk = posterKey(it.poster_path || it.poster || it.backdrop_path);
      if (!pk) continue;
      const kind = catalogKind(catKind) || catalogKind(it.type) || catalogKind(it.media_type);
      if (!kind) continue;
      const date =
        it.release_date || it.first_air_date || it.releaseInfo || it.digital_release_date || null;
      const rec = {
        tmdb,
        kind,
        title: it.title || it.name || it.original_title || it.original_name || null,
        date,
        year: it.year ? String(it.year) : yearOf(date),
        src: f,
      };
      if (!idx.has(pk)) idx.set(pk, []);
      const list = idx.get(pk);
      if (!list.some((x) => x.tmdb === rec.tmdb && x.kind === rec.kind)) list.push(rec);
    }
  }
  return idx;
}

/**
 * Look a row up in the offline index with the SAME hard gates as the online
 * path. A poster hash that maps to more than one TMDB id is AMBIGUOUS and is
 * not used at all.
 */
export function offlineLookup(index, facts, wantTv) {
  const rejected = [];
  const wantKind = wantTv ? "tv" : "movie";
  const tsYear = yearOf(facts.date);
  const pk = posterKey(facts.poster);
  if (!pk) return { hit: null, rejected, ambiguous: false, yearAbsent: !tsYear };
  const recs = (index && index.get(pk)) || [];
  const accepted = [];
  for (const r of recs) {
    if (r.kind !== wantKind) {
      rejected.push({ ...r, reason: `kind ${r.kind} != ${wantKind} (offline record)` });
      continue;
    }
    const ts = titleScore(r.title, facts.title);
    if (ts < TITLE_GATE) {
      rejected.push({ ...r, titleScore: ts, reason: `title score ${ts.toFixed(2)} < ${TITLE_GATE}` });
      continue;
    }
    const cy = r.year ? String(r.year) : yearOf(r.date);
    if (tsYear && cy && cy !== tsYear) {
      // a +/-1 premiere drift is only accepted on an EXACT title match
      const drift = Math.abs(Number(cy) - Number(tsYear)) === 1 && ts >= 1;
      if (!drift) {
        rejected.push({ ...r, titleScore: ts, reason: `year ${cy} != TS ${tsYear}` });
        continue;
      }
      accepted.push({ ...r, titleScore: ts, yearDrift: true });
      continue;
    }
    accepted.push({ ...r, titleScore: ts });
  }
  const ids = [...new Set(accepted.map((a) => a.tmdb))];
  if (ids.length > 1) {
    for (const a of accepted) {
      rejected.push({ ...a, reason: `ambiguous: ${ids.length} distinct TMDB ids share poster ${pk}` });
    }
    return { hit: null, rejected, ambiguous: true, yearAbsent: !tsYear };
  }
  if (!accepted.length) return { hit: null, rejected, ambiguous: false, yearAbsent: !tsYear };
  return { hit: accepted[0], rejected, ambiguous: false, yearAbsent: !tsYear };
}

// ---------------------------------------------------------------- TS parsing

export function pageProps(html) {
  const m = html.match(/__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error("page has no __NEXT_DATA__ blob");
  return JSON.parse(m[1]).props.pageProps;
}

/** The TS detail page URL. Movies live under /m/, shows under /s/. */
export function detailUrl(kind, slug) {
  return kind === "movie" ? `https://televisionstats.com/m/${slug}` : `https://televisionstats.com/s/${slug}`;
}

/**
 * The facts one TS detail page carries. TS no longer ships `imdb_id` on the
 * movie pages (V8) - the field is still read so a future TS shape that brings
 * it back is used, but nothing depends on it.
 */
export function detailFacts(kind, pp) {
  const it = kind === "movie" ? pp.movie || {} : pp.show || {};
  return {
    title: it.title ?? it.name ?? null,
    poster: kind === "movie" ? it.poster_path || null : it.poster_image || it.poster_path || null,
    date: kind === "movie" ? it.release_date || null : it.first_air_date || null,
    runtime: it.runtime ?? null,
    episodeRunTime: it.episode_run_time ?? null,
    wikipediaSlug: it.wikipediaSlug ?? null,
    kindHint: it.type ?? null,
    genres: it.genres ?? null,
    imdbId: it.imdb_id ?? null,
    // TV Stats copies TMDB's own text and assets. The overview (movies) /
    // description (shows) is TMDB's synopsis verbatim, so an exact match is
    // identity evidence that does not depend on the poster. The backdrop
    // exists for shows only (movies carry none).
    overview: (kind === "movie" ? it.overview : it.description) ?? null,
    backdrop: kind === "movie" ? it.backdrop_path ?? null : it.backdrop_image ?? null,
  };
}

// ---------------------------------------------------------------- counters

function countLogical(ctx) {
  if (ctx && ctx.counts) ctx.counts.logical++;
}
function countAttempt(ctx) {
  if (ctx && ctx.counts) ctx.counts.attempted++;
}

/**
 * V3: a logical call is never larger than the attempt count. The HTTP layer
 * counts the attempts (one per retry); a stubbed transport counts none, so
 * the floor is enforced here. Without it the run log could claim 42 logical
 * calls and 15 attempts.
 */
function syncCounts(ctx) {
  if (!ctx || !ctx.counts) return;
  if (ctx.counts.attempted < ctx.counts.logical) ctx.counts.attempted = ctx.counts.logical;
}

// ---------------------------------------------------------------- optional hosts

/**
 * A bounded fetch for the OPTIONAL hosts (the IMDb suggestion API, the IMDb
 * GraphQL, the audit host). 4 attempts, 20 s per attempt, a 25 s wall-clock
 * cap, backoff <= 2000 ms, exponential on 429. Never 60 s.
 */
async function httpJson(url, ctx, opts = {}) {
  const { method = "GET", body = null, headers = {} } = opts;
  const deadline = Date.now() + WALL_CAP_MS;
  let last = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (Date.now() > deadline) throw new Error(`wall-clock cap: ${last}`);
    let res;
    try {
      countAttempt(ctx);
      res = await fetch(url, {
        method,
        body: body === null ? undefined : body,
        headers: { "User-Agent": UA_BROWSER, Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
    } catch (e) {
      last = String((e && e.message) || e).slice(0, 140);
      if (attempt === MAX_ATTEMPTS) throw new Error(last);
      await sleep(Math.min(BACKOFF_CAP_MS, 500 * attempt));
      continue;
    }
    if (res.status === 429) {
      last = "HTTP 429";
      if (attempt === MAX_ATTEMPTS) throw new Error(last);
      await sleep(Math.min(BACKOFF_CAP_MS, 500 * Math.pow(2, attempt - 1)));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || !text.trim()) throw new Error("empty body");
    return text;
  }
  throw new Error(last);
}

/** The IMDb suggestion API. It returns non-titles too - the caller filters. */
export async function imdbSuggest(term, ctx) {
  const url = `${IMDB_SUGGEST_URL}${encodeURIComponent(String(term ?? ""))}.json`;
  countLogical(ctx);
  const text = await httpJson(url, ctx);
  const j = JSON.parse(text);
  const d = Array.isArray(j && j.d) ? j.d : [];
  return d.map((x) => ({
    id: x.id,
    l: x.l ?? null,
    q: x.q ?? null,
    y: x.y ?? null,
    rank: Number.isFinite(x.rank) ? x.rank : null,
  }));
}

/** The IMDb GraphQL title facts for up to N ids (one request). */
export async function imdbGqlTitles(ids, ctx) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  const out = new Map();
  if (!uniq.length) return out;
  const parts = uniq.map(
    (id, k) =>
      `t${k}: title(id:"${id}"){ id titleText{text} titleType{id} releaseYear{year} runtime{seconds} }`
  );
  countLogical(ctx);
  await imdbGqlPace();
  const text = await httpJson(IMDB_GQL_URL, ctx, {
    method: "POST",
    body: JSON.stringify({ query: `{ ${parts.join(" ")} }` }),
    headers: IMDB_GQL_HEADERS,
  });
  const j = JSON.parse(text);
  if (!j || !j.data) return out;
  uniq.forEach((id, k) => {
    const t = j.data[`t${k}`];
    if (!t) return;
    out.set(id, {
      id: t.id,
      title: t.titleText ? t.titleText.text : null,
      type: t.titleType ? t.titleType.id : null,
      year: t.releaseYear ? t.releaseYear.year : null,
      runtime: t.runtime ? t.runtime.seconds : null,
    });
  });
  return out;
}

/**
 * The IMDb facts for a batch of ids - ONE GraphQL request.
 *
 * A missing id (not on IMDb), a GraphQL error or a failed call all mean the
 * SAME thing to the caller: the kind of that id is UNKNOWN. The caller must
 * then downgrade the row, never pass it silently.
 */
async function imdbFacts(ctx, ids) {
  const out = new Map();
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return out;
  const fn = typeof ctx.imdbGqlTitlesFn === "function" ? ctx.imdbGqlTitlesFn : imdbGqlTitles;
  try {
    const got = await fn(list, ctx);
    if (got && typeof got.forEach === "function") got.forEach((v, k) => out.set(k, v));
  } catch {
    /* unknown - the caller downgrades the row */
  }
  return out;
}

/** One cheap reachability probe. A dead optional host must not fail the run. */
export async function probeHost(url, ctx, opts = {}) {
  try {
    countLogical(ctx);
    countAttempt(ctx);
    const res = await fetch(url, {
      method: opts.method || "GET",
      body: opts.body || undefined,
      headers: { "User-Agent": UA_BROWSER, Accept: "application/json", ...(opts.headers || {}) },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    return !!res && res.status < 500;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the context

export function makeCtx(partial = {}) {
  return Object.assign(
    {
      cache: new Map(),
      index: new Map(),
      counts: { logical: 0, attempted: 0 },
      publishMin: "medium",
      useSuggestion: true,
      useGql: true,
      // The poster-SET fingerprint (the widened fingerprint). On by default:
      // it is the rung that recovers a row whose TV Stats poster is stale.
      posterSet: true,
      // How long a remembered MISS holds a row out. 7 days.
      negativeTtlMs: 7 * 86400000,
      // The cache key function (TV Stats' stable per-title id by default).
      cacheKeyFn: null,
      // The IMDb facts loader. Overridable so a caller (or a test) can supply
      // its own; the default is the real keyless GraphQL client.
      imdbGqlTitlesFn: null,
      audit: "off",
      getHtml: null,
      tmdbGetFn: null,
    },
    partial || {}
  );
}

// ---------------------------------------------------------------- cache v2

export const cacheKey = (kind, slug) => (kind === "movie" ? "m:" : "s:") + slug;

/**
 * The cache key for a row.
 *
 * TV Stats' chart rows carry a STABLE per-title id (present on 200/200 rows of
 * both kinds - the movie DETAIL page has no id, so it must be taken from the
 * chart row). That id is the work's identity: a slug can be reused for a
 * different work, a stable id cannot. Rows without one fall back to the slug.
 */
export const rowCacheKey = (kind, row) => {
  const id = row && row.stableId;
  if (id) return `i:${id}`;
  return cacheKey(kind, (row && row.slug) || "");
};

/**
 * Is a cached entry still the row it is being served for?
 *
 * An entry keyed by the stable id is the work by construction. A slug-keyed
 * entry (or a legacy v1 entry) must still agree with the row on its title and
 * poster - a stale entry must never republish an old id under a new title.
 */
export function cacheHitValid(hit, row) {
  if (!hit) return false;
  if (hit.stableId && row && row.stableId && hit.stableId === row.stableId) return true;
  const ht = normTitle(hit.title || "");
  const rt = normTitle((row && row.title) || "");
  if (ht && rt && ht !== rt) return false;
  const hp = posterKey(hit.poster);
  const rp = posterKey(row && row.poster);
  if (hp && rp && hp !== rp) return false;
  return true;
}

/**
 * Migrate a v1 cache entry (no `v` key) to the v2 schema. A v1 entry is
 * trusted as MEDIUM, never HIGH: the v1 show path matched titles fuzzily
 * with no kind gate, so it is published (MEDIUM >= the default threshold) but
 * it is never promoted to the fingerprint tier.
 */
export function migrateCacheEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.v === CACHE_VERSION) return entry;
  // A remembered MISS that reaches here was written under an OLDER policy:
  // the reason it was remembered may no longer hold (a title with no IMDb id
  // used to be unpublishable; it now falls back to its TMDB id). Drop it so
  // the row is re-evaluated instead of staying held out for the whole TTL.
  // A miss written under the CURRENT policy returned at the top.
  if (entry.miss) return null;
  const imdb = entry.imdb || null;
  const tmdb = entry.tmdb ? String(entry.tmdb) : null;
  if (!imdb && !tmdb) return null;
  return {
    kind: entry.kind || null,
    imdb,
    tmdb,
    title: entry.title || null,
    date: entry.date || null,
    poster: entry.poster || null,
    stableId: entry.stableId || null,
    rung: "cache-v1",
    confidence: CONF.MEDIUM,
    v: CACHE_VERSION,
  };
}

// ---------------------------------------------------------------- the ladder

function mergeFacts(facts, detail) {
  if (!detail) return facts;
  return {
    title: detail.title || facts.title,
    date: detail.date || facts.date,
    poster: detail.poster || facts.poster,
    runtime: detail.runtime ?? facts.runtime,
    overview: detail.overview ?? facts.overview,
    backdrop: detail.backdrop ?? facts.backdrop,
    wikipediaSlug: detail.wikipediaSlug ?? null,
    kindHint: detail.kindHint ?? null,
    genres: detail.genres ?? null,
  };
}

async function fetchDetail(kind, slug, ctx) {
  if (typeof ctx.getHtml !== "function") throw new Error("no page fetcher wired");
  countLogical(ctx);
  const html = await ctx.getHtml(detailUrl(kind, slug));
  syncCounts(ctx);
  return detailFacts(kind, pageProps(html));
}

function normTmdbResults(res, kind) {
  return ((res && res.results) || []).map((x) => ({
    source: "tmdb-search",
    key: `tmdb:${kind}:${x.id}`,
    tmdbId: x.id,
    tmdbKind: kind,
    imdbId: null,
    title: x.title ?? x.name ?? x.original_title ?? x.original_name ?? null,
    date: x.release_date ?? x.first_air_date ?? null,
    poster: x.poster_path ?? null,
    kind: typeFromTmdbKind(kind),
    runtime: null,
    popularity: Number.isFinite(x.popularity) ? x.popularity : null,
    suggestRank: null,
  }));
}

async function tmdbSearch(ctx, tmdbKind, title, year) {
  const params = { query: String(title ?? "").replace(/^[\s"']+|[\s"']+$/g, ""), language: "en-US" };
  if (year) {
    if (tmdbKind === "tv") params.first_air_date_year = String(year);
    else params.year = String(year);
  }
  countLogical(ctx);
  const res = await ctx.tmdbGetFn(`/search/${tmdbKind}`, params);
  syncCounts(ctx);
  return normTmdbResults(res, tmdbKind);
}

/**
 * The TMDB external_ids lookup.
 *
 * D4(b): `external_ids` intermittently answers with an EMPTY body. That is
 * a TRANSIENT, not a "there is no IMDb id" - every measured empty response
 * recovered on a retry (24 movies + 13 shows). An empty body is therefore
 * retried with a bounded backoff, and only a genuine, successful-but-empty
 * answer concludes "no IMDb id" (and only then may the row be downgraded).
 *
 * A HARD failure (the transport gave up) is NOT a successful answer: it is
 * re-thrown, so the caller holds the row out instead of downgrading it.
 *
 * Bounded: 4 attempts, a backoff capped at 2000 ms.
 */
async function tmdbExternal(ctx, tmdbKind, id) {
  // Memoised: the set-fingerprint rung and the kind gate both need the same
  // external_ids, and a run must not pay for it twice.
  const memo = ctx._extMemo || (ctx._extMemo = new Map());
  const memoKey = `${tmdbKind}:${id}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  let out = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    countLogical(ctx);
    const res = await ctx.tmdbGetFn(`/${tmdbKind}/${id}/external_ids`);
    syncCounts(ctx);
    if (res && typeof res === "object" && Object.keys(res).length) {
      out = res.imdb_id || null;
      break;
    }
    // an EMPTY body: transient - retry (bounded, with backoff)
    if (attempt === MAX_ATTEMPTS) break;
    await sleep(Math.min(BACKOFF_CAP_MS, 500 * attempt));
  }
  memo.set(memoKey, out);
  return out;
}

async function tmdbFind(ctx, imdbId) {
  countLogical(ctx);
  const res = await ctx.tmdbGetFn(`/find/${imdbId}`, { external_source: "imdb_id" });
  syncCounts(ctx);
  const movie = ((res && res.movie_results) || []).map((x) => ({
    source: "imdb-suggestion",
    key: `imdb:${imdbId}`,
    tmdbId: x.id,
    tmdbKind: "movie",
    imdbId,
    title: x.title ?? x.original_title ?? null,
    date: x.release_date ?? null,
    poster: x.poster_path ?? null,
    kind: "movie",
    runtime: null,
    popularity: Number.isFinite(x.popularity) ? x.popularity : null,
    suggestRank: null,
  }));
  const tv = ((res && res.tv_results) || []).map((x) => ({
    source: "imdb-suggestion",
    key: `imdb:${imdbId}`,
    tmdbId: x.id,
    tmdbKind: "tv",
    imdbId,
    title: x.name ?? x.original_name ?? null,
    date: x.first_air_date ?? null,
    poster: x.poster_path ?? null,
    kind: "tvSeries",
    runtime: null,
    popularity: Number.isFinite(x.popularity) ? x.popularity : null,
    suggestRank: null,
  }));
  return { movie, tv };
}

/** The TMDB release_dates evidence (movies only - TMDB has none for TV). */
async function tmdbReleaseDateYears(ctx, tmdbKind, id) {
  countLogical(ctx);
  const res = await ctx.tmdbGetFn(`/${tmdbKind}/${id}/release_dates`);
  syncCounts(ctx);
  const years = new Set();
  const dates = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const m = v.match(/^(\d{4})-\d{2}-\d{2}/);
      if (m) {
        years.add(m[1]);
        dates.push(v.slice(0, 10));
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(res);
  return { years, dates };
}

/**
 * The IMDb suggestion candidates. The query term is the TS TITLE (the slug is
 * only a secondary query - D4). The suggestion API returns non-titles, so
 * only ^tt\d{7,9}$ survives, and the kind + title gates run on the IMDb
 * label before a single TMDB call is spent.
 */
async function suggestionCandidates(ctx, facts, row, wantTv) {
  const out = [];
  if (!ctx.useSuggestion) return out;
  const terms = [];
  if (facts.title) terms.push({ term: facts.title, via: "title" });
  if (row.slug && row.slug !== facts.title) terms.push({ term: row.slug, via: "slug" });
  for (const { term, via } of terms) {
    let hits = [];
    try {
      hits = await imdbSuggest(term, ctx);
    } catch {
      continue;
    }
    const pool = hits.filter((h) => TT_RE.test(String(h.id || "")));
    const usable = [];
    for (const h of pool) {
      const kind = canonImdbType(h.q);
      if (!kindOk(kind, wantTv)) continue; // the kind gate
      const ts = titleScore(h.l, facts.title);
      if (ts < TITLE_GATE) continue; // the title gate
      usable.push({ ...h, kind, titleScore: ts, via });
    }
    for (const h of usable.slice(0, 3)) {
      let found = { movie: [], tv: [] };
      try {
        found = await tmdbFind(ctx, h.id);
      } catch {
        /* the /find leg is optional - the tt id alone is still usable */
      }
      const pool2 = wantTv ? found.tv : found.movie;
      for (const c of pool2) {
        c.imdbId = h.id;
        c.kind = h.kind; // the IMDb label is the precise kind; TMDB only says movie|tv
        c.title = c.title || h.l;
        c.date = c.date || (h.y ? `${h.y}-01-01` : null);
        c.suggestRank = h.rank == null ? null : h.rank;
        c.titleScore = h.titleScore;
        out.push(c);
      }
      if (!pool2.length) {
        // no TMDB record for this tt - keep the tt itself as a candidate
        out.push({
          source: "imdb-suggestion",
          key: `imdb:${h.id}`,
          tmdbId: null,
          tmdbKind: null,
          imdbId: h.id,
          title: h.l,
          date: h.y ? `${h.y}-01-01` : null,
          poster: null,
          kind: h.kind,
          runtime: null,
          popularity: null,
          suggestRank: h.rank == null ? null : h.rank,
          titleScore: h.titleScore,
        });
      }
    }
    if (usable.length) break; // the title query worked
  }
  return out;
}

/** The ranking. The poster fingerprint is decisive. */
function compareCandidates(a, b) {
  if (!!a.posterMatch !== !!b.posterMatch) return a.posterMatch ? -1 : 1;
  if (!!a.runtimeMatch !== !!b.runtimeMatch) return a.runtimeMatch ? -1 : 1;
  if (!!a.yearOk !== !!b.yearOk) return a.yearOk ? -1 : 1;
  if (a.titleScore !== b.titleScore) return b.titleScore - a.titleScore;
  const ra = a.suggestRank == null ? Infinity : a.suggestRank;
  const rb = b.suggestRank == null ? Infinity : b.suggestRank;
  if (ra !== rb) return ra - rb;
  // The popularity is the LAST and WEAKEST discriminator. It may only
  // separate candidates that already differ on the evidence (see
  // evidenceEqual: two candidates that differ on NOTHING are ambiguous and
  // the row is held out).
  return (b.popularity || 0) - (a.popularity || 0);
}

/**
 * D5: are two candidates indistinguishable on every piece of EVIDENCE?
 *
 * The evidence tuple is (posterMatch, runtimeMatch, yearOk, titleScore,
 * suggestRank). If two candidates are equal on ALL of them, the only thing
 * left to separate them is the TMDB popularity - and popularity is not
 * evidence that they are the same work. Such a row is AMBIGUOUS and must be
 * held out rather than decided by a popularity coin-flip.
 */
export function evidenceEqual(a, b) {
  if (!a || !b) return false;
  const ra = a.suggestRank == null ? Infinity : a.suggestRank;
  const rb = b.suggestRank == null ? Infinity : b.suggestRank;
  return (
    !!a.posterMatch === !!b.posterMatch &&
    !!a.runtimeMatch === !!b.runtimeMatch &&
    !!a.yearOk === !!b.yearOk &&
    a.titleScore === b.titleScore &&
    ra === rb
  );
}

/**
 * D1: the kind gate reads the IMDb titleType of the id that will be
 * SHIPPED - not the TMDB media type of the candidate.
 *
 * TMDB sometimes links a SERIES record to an EPISODE's imdb id (live proof:
 * tmdb tv/323903 -> tt31186255, which IMDb calls a tvEpisode, "November in
 * My Soul"), so a TMDB-media-type gate ships the episode id for a show row.
 * The shipped id is therefore verified against IMDb's own titleType with the
 * SAME whitelist (kindOk).
 *
 * One GraphQL request per row, batched over the candidates that could win.
 * A wrong kind REJECTS the candidate (the next survivor may still win). An
 * UNKNOWN kind (the id is not on IMDb, or the call failed) never passes
 * silently: the row is capped at MEDIUM.
 *
 * @returns {{survivors: Array, kinds: Map, rejections: Array<string>}}
 */
async function applyImdbKindGate(survivors, wantTv, ctx) {
  const checked = new Set();
  const kinds = new Map();
  const rejections = [];
  let pool = survivors.slice();
  for (let round = 0; round < 3; round++) {
    const top = pool.filter((c) => !checked.has(c)).slice(0, 3);
    if (!top.length) break;
    // 1. the id each candidate would ship
    const ids = [];
    for (const c of top) {
      checked.add(c);
      if (!c.imdbIdResolved) {
        if (c.imdbId) c.imdbIdResolved = c.imdbId;
        else if (c.tmdbId) {
          try {
            c.imdbIdResolved = await tmdbExternal(ctx, c.tmdbKind, c.tmdbId);
          } catch (e) {
            c.imdbIdError = String((e && e.message) || e).slice(0, 140);
            c.imdbIdResolved = null;
          }
        }
      }
      if (c.imdbIdResolved) ids.push(c.imdbIdResolved);
    }
    // 2. ONE batched GraphQL request for the whole batch
    const facts = ctx.useGql === false ? new Map() : await imdbFacts(ctx, ids);
    // 3. apply the whitelist
    for (const c of top) {
      const id = c.imdbIdResolved;
      const t = id ? facts.get(id) : null;
      const type = canonImdbType(t && t.type) || null;
      kinds.set(c, { type, known: !!type, id: id || null });
      if (type && !kindOk(type, wantTv)) {
        rejections.push(`${id} is a ${type}`);
        c.imdbKindRejected = true;
      }
    }
    const next = pool.filter((c) => !c.imdbKindRejected);
    if (next.length === pool.length) break; // nothing rejected - the top is settled
    pool = next;
  }
  return { survivors: pool, kinds, rejections };
}

/**
 * D3: the `tmdb:` -> `tt` auto-upgrade.
 *
 * A cached entry that has a TMDB id but no IMDb id gets ONE /external_ids
 * re-check per run (a numeric-id lookup is exact - no search, no
 * re-verification needed). If an imdb_id has appeared since, the entry is
 * upgraded in place (persisted by saveCacheFn) and the IMDb id is published;
 * if not, the working `tmdb:` fallback is kept and the row never fails.
 *
 * The upgraded id passes the same IMDb kind gate as every other shipped id.
 */
async function recheckTmdbEntry(hit, wantTv, ctx, slug) {
  const tmdbKind = wantTv ? "tv" : "movie";
  console.log(`  [recheck] ${slug}: tmdb:${hit.tmdb} - checking for imdb...`);
  let imdb = null;
  try {
    imdb = await tmdbExternal(ctx, tmdbKind, hit.tmdb);
  } catch (e) {
    console.warn(`  [upgrade] ${slug}: re-check failed (${e.message}) - keeping fallback`);
    return null;
  }
  if (!imdb) {
    console.log(`  [recheck] ${slug}: still missing, keeping fallback`);
    return null;
  }
  const facts = ctx.useGql === false ? new Map() : await imdbFacts(ctx, [imdb]);
  const t = facts.get(imdb);
  const type = canonImdbType(t && t.type) || null;
  if (type && !kindOk(type, wantTv)) {
    console.warn(`  [upgrade] ${slug}: ${imdb} is a ${type} - keeping the tmdb: fallback`);
    return null;
  }
  console.log(`  [upgrade] ${slug}: tmdb:${hit.tmdb} -> ${imdb}`);
  return imdb;
}

/**
 * Resolve one row.
 *
 * The returned `title`/`date`/`poster` are always the TS facts (the chart row
 * refined by the TS detail page) - never the candidate's (V5). The
 * candidate's own values are kept aside in candidateTitle/candidateDate.
 */
export async function resolveRow(row, ctxIn) {
  const ctx = makeCtx(ctxIn);
  const kind = row.kind === "movie" ? "movie" : "show";
  const wantTv = kind === "show";
  const key = ctx.cacheKeyFn ? ctx.cacheKeyFn(kind, row) : rowCacheKey(kind, row);
  const legacyKey = cacheKey(kind, row.slug);
  const tsTitle = String(row.title || "").trim();
  const out = {
    key,
    slug: row.slug,
    kind,
    tsTitle,
    tsDate: row.date || null,
    tsPoster: row.poster || null,
    imdb: null,
    tmdb: null,
    title: tsTitle,
    date: row.date || null,
    poster: row.poster || null,
    rung: "held-out",
    confidence: CONF.NONE,
    reason: "",
    candidateTitle: null,
    candidateDate: null,
    candidateKind: null,
    // D1: the IMDb kind of the id that was (or would have been) shipped.
    imdbKind: null,
    imdbKindKnown: false,
    // D6: the partial candidate of a LOW row (never an id).
    candidate: null,
    fingerprint: false,
    // "primary" = the poster matched the title's CURRENT TMDB poster;
    // "set" = the poster is one of the title's other TMDB posters (TV Stats
    // holds a stale copy). Both are exact identity evidence.
    posterMatchKind: null,
    // The backdrop agrees with the chosen work (corroboration only - a
    // backdrop is shared across a franchise, so it never identifies a work).
    backdropAgrees: false,
    // A held-out row may be remembered as a MISS for a bounded TTL, so a
    // permanently unresolvable title stops costing requests every run.
    negativeCacheable: false,
    yearPresent: !!yearOf(row.date),
    kindHint: null,
    wikipediaSlug: null,
  };

  // ---- RUNG 0: the cache. 0 HTTP calls.
  // The key is the row's STABLE id when it has one, else the slug. The legacy
  // slug key is also tried, so the existing cache is not orphaned.
  let hit = ctx.cache.get(key) || null;
  if (!hit && legacyKey !== key) hit = ctx.cache.get(legacyKey) || null;
  if (hit && hit.miss) {
    // A remembered MISS: the row was proven unresolvable recently. Holding it
    // out for a bounded TTL costs 0 HTTP calls; a title that becomes
    // resolvable later is picked up when the TTL expires.
    const ttl = ctx.negativeTtlMs ?? 7 * 86400000;
    const age = Date.now() - (hit.at || 0);
    if (age < ttl) {
      out.rung = "negative-cache";
      out.confidence = CONF.NONE;
      out.reason = `a negative cache entry (${hit.reason || "no candidate"}) still holds this row out - 0 HTTP calls`;
      return out;
    }
  }
  if (hit && (hit.imdb || hit.tmdb)) {
    if (!cacheHitValid(hit, row)) {
      // A stale entry: the row now points at a different title. Re-resolve
      // instead of publishing the old id under the new name.
      out.reason = `the cached entry (${hit.imdb || hit.tmdb}) no longer matches this row - re-resolving`;
      hit = null;
    }
  }
  if (hit && (hit.imdb || hit.tmdb)) {
    // D3: a cached entry that has a TMDB id but no IMDb id gets ONE
    // /external_ids re-check per run. If an imdb_id has appeared since, the
    // entry is upgraded in place and the IMDb id is published; if not, the
    // working tmdb: fallback is kept and the row never fails.
    if (!hit.imdb && hit.tmdb) {
      const upgraded = await recheckTmdbEntry(hit, wantTv, ctx, row.slug);
      if (upgraded) hit.imdb = upgraded;
    }
    const c = hit.confidence || CONF.MEDIUM;
    if (confRank(c) >= confRank(ctx.publishMin)) {
      out.imdb = hit.imdb || null;
      out.tmdb = hit.tmdb || null;
      out.title = hit.title || tsTitle;
      out.date = hit.date || row.date || null;
      out.poster = hit.poster || row.poster || null;
      out.rung = "cache";
      out.confidence = c;
      out.reason = `cache hit (v${hit.v || 1}, ${c}) - 0 HTTP calls`;
      return out;
    }
    out.reason = `the cached confidence ${c} is below the publish threshold ${ctx.publishMin} - re-resolving`;
  }

  // TV Stats marks a FILM that appears in a show chart with a "(MOVIE)"
  // suffix. The marker is a KIND HINT, not noise:
  //   - it is NOT stripped from the title, so the title gate can never
  //     accidentally pass on the IMDb label alone, and
  //   - a show row carrying it is HELD OUT, because a film has no place
  //     in a show catalogue (and the show kind whitelist would reject it
  //     anyway - this just says so plainly).
  const movieMarker = /\s*\(MOVIE\)\s*$/i.test(tsTitle);
  if (movieMarker && wantTv) {
    out.rung = "held-out";
    out.confidence = CONF.NONE;
    out.negativeCacheable = true;
    out.kindHint = "movie";
    out.reason = `TV Stats marks this row as a FILM ("(MOVIE)") and this list is a show list - the row is HELD OUT`;
    return out;
  }

  // ---- the TS facts. A SHOW row needs the detail page for first_air_date
  // before ANY year gate can run: the show chart carries last_air_date only
  // (V4). A movie chart row already carries its release date.
  let facts = { title: tsTitle, date: row.date || null, poster: row.poster || null, runtime: null, overview: null, backdrop: null };
  let detail = null;
  if (wantTv) {
    try {
      detail = await fetchDetail(kind, row.slug, ctx);
    } catch (e) {
      out.reason = `the TS show detail page could not be read (${String((e && e.message) || e).slice(0, 120)}) - the row is held out`;
      return out;
    }
    facts = mergeFacts(facts, detail);
  }
  out.title = facts.title;
  out.date = facts.date;
  out.poster = facts.poster;
  out.yearPresent = !!yearOf(facts.date);
  out.kindHint = facts.kindHint || null;
  out.wikipediaSlug = facts.wikipediaSlug || null;

  // ---- RUNG 0b: the OFFLINE JOIN.
  const ol = offlineLookup(ctx.index, facts, wantTv);
  const offline = await finishOfflineJoin(ol, facts, ctx, wantTv);
  if (offline) {
    Object.assign(out, offline);
    return out;
  }

  // ---- RUNG 1: the TS detail page (movies; shows already fetched).
  if (!detail) {
    try {
      detail = await fetchDetail(kind, row.slug, ctx);
    } catch (e) {
      out.reason = `the TS detail page could not be read (${String((e && e.message) || e).slice(0, 120)}) - the row is held out`;
      return out;
    }
    facts = mergeFacts(facts, detail);
    out.title = facts.title;
    out.date = facts.date;
    out.poster = facts.poster;
    out.yearPresent = !!yearOf(facts.date);
    out.kindHint = facts.kindHint || null;
    out.wikipediaSlug = facts.wikipediaSlug || null;
    const ol2 = offlineLookup(ctx.index, facts, wantTv);
    const offline2 = await finishOfflineJoin(ol2, facts, ctx, wantTv);
    if (offline2) {
      Object.assign(out, offline2);
      return out;
    }
  }

  // ---- RUNG 2: the candidates.
  const tmdbKind = tmdbKindForRow(kind);
  const tsYear = yearOf(facts.date);
  const cands = [];
  const seen = new Set();
  const add = (c) => {
    const k = `${c.key}|${c.imdbId || ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    cands.push(c);
  };
  let searchFailed = null;
  try {
    for (const c of await tmdbSearch(ctx, tmdbKind, facts.title, null)) add(c);
    if (tsYear) {
      for (const c of await tmdbSearch(ctx, tmdbKind, facts.title, tsYear)) add(c);
    }
  } catch (e) {
    // A failed TMDB search is NOT an empty result. Continuing would let the
    // weaker IMDb-suggestion rung answer with a DIFFERENT id and a different
    // confidence, and the log would say "no candidate" instead of "TMDB is
    // down". Hold the row out (transient - it is never negatively cached) so
    // the next run retries it.
    searchFailed = String((e && e.message) || e).slice(0, 140);
  }
  if (searchFailed) {
    out.rung = "held-out";
    out.confidence = CONF.NONE;
    out.reason = `the TMDB search failed (${searchFailed}) - the row is HELD OUT and will be retried, not answered from a weaker source`;
    return out;
  }

  // The IMDb suggestion leg runs only when nothing has a poster fingerprint
  // yet: it can only ADD a candidate and the fingerprint is decisive.
  const tsPosterKey = posterKey(facts.poster);
  const hasFingerprint = cands.some((c) => tsPosterKey && posterKey(c.poster) === tsPosterKey);
  if (!hasFingerprint) {
    try {
      for (const c of await suggestionCandidates(ctx, facts, row, wantTv)) add(c);
    } catch {
      /* the suggestion rung is optional - a failure just leaves it empty */
    }
  }

  // ---- RUNG 3: the HARD gates.
  const gated = [];
  for (const c of cands) {
    c.titleScore = titleScore(c.title, facts.title);
    c.posterMatch = !!(tsPosterKey && posterKey(c.poster) === tsPosterKey);
    if (c.posterMatch) c.posterMatchKind = "primary";
    if (!kindOk(c.kind, wantTv)) {
      c.rejected = `the kind "${c.kind}" is not in the ${
        wantTv ? "tvSeries|tvMiniSeries|podcastSeries" : "movie|tvMovie|video|documentary"
      } whitelist`;
      continue;
    }
    if (c.titleScore < TITLE_GATE) {
      c.rejected = `the title score ${c.titleScore.toFixed(2)} < ${TITLE_GATE} ("${c.title}" vs "${facts.title}")`;
      continue;
    }
    gated.push(c);
  }
  // the stale-poster guard: a candidate that already matches the title IN the
  // TS year means a drifted candidate is NOT the TS work.
  const siblings = tsYear ? gated.filter((c) => yearOf(c.date) === tsYear) : [];
  for (const c of gated) {
    if (!tsYear) {
      c.yearOk = true;
      c.yearAbsent = true; // the year leg is EXPLICITLY ABSENT (V4)
      continue;
    }
    const cy = yearOf(c.date);
    if (cy && cy === tsYear) {
      c.yearOk = true;
      continue;
    }
    if (!cy) {
      c.rejected = "the candidate has no year - the year rule cannot pass";
      continue;
    }
    if (c.tmdbKind === "movie" && c.tmdbId) {
      try {
        const rd = await tmdbReleaseDateYears(ctx, c.tmdbKind, c.tmdbId);
        if (rd.years.has(String(tsYear))) {
          c.yearOk = true;
          c.yearDrift = true;
          c.releasedIn = rd.dates.filter((d) => d.startsWith(String(tsYear))).slice(0, 3);
          continue;
        }
      } catch {
        /* the release_dates probe is optional evidence */
      }
    }
    if (Math.abs(Number(cy) - Number(tsYear)) === 1 && c.titleScore >= 1 && siblings.length === 0) {
      c.yearOk = true;
      c.yearDrift = true;
      continue;
    }
    c.rejected =
      Math.abs(Number(cy) - Number(tsYear)) === 1 && siblings.length
        ? `the year ${cy} != TS ${tsYear} - a +/-1 drift, but "${siblings[0].title}" already matches the title in ${tsYear}`
        : `the year ${cy} != TS ${tsYear}`;
  }
  let survivors = gated.filter((c) => c.yearOk);

  // ---- RUNG 2c: the widened fingerprint.
  // Only for rows where the STRICT fingerprint found nothing. TV Stats copies
  // TMDB's own values, so a row can be identified by matching ANY of them
  // against the candidate's TMDB record:
  //   poster    TS poster == the record's CURRENT poster          (primary)
  //             TS poster IN the record's poster set               (set: the
  //             poster may be an old upload TMDB has since replaced)
  //   overview  TS overview == the record's overview               (TMDB's own
  //             synopsis text, copied verbatim - identity evidence that
  //             does not depend on the poster at all)
  //
  // The BACKDROP is CORROBORATION ONLY, never an owner key: backdrops are
  // shared across a franchise, so two different works can own the same one.
  //
  // The guard counts DISTINCT WORKS, not candidate records: the candidate
  // list can hold two records for the same work, and counting records makes
  // every relaxed row look ambiguous (measured: 0 of 4 recovered; counting
  // works recovers 4 of 4).
  if (ctx.posterSet !== false && !survivors.some((c) => c.posterMatch) && tsPosterKey) {
    const byWork = new Map();
    for (const c of survivors) {
      if (!c.tmdbId) continue;
      let imdbId = c.imdbId || null;
      if (!imdbId) {
        try {
          imdbId = await tmdbExternal(ctx, c.tmdbKind, c.tmdbId);
        } catch (e) {
          c.imdbIdError = String((e && e.message) || e).slice(0, 140);
          imdbId = null;
        }
        c.imdbIdResolved = imdbId || c.imdbIdResolved || null;
      }
      const workKey = imdbId ? `imdb:${imdbId}` : `tmdb:${c.tmdbId}`;
      if (!byWork.has(workKey)) byWork.set(workKey, { tmdbId: c.tmdbId, tmdbKind: c.tmdbKind, cs: [] });
      byWork.get(workKey).cs.push(c);
    }
    const tsOverview =
      typeof facts.overview === "string" && facts.overview.trim() ? facts.overview : null;
    const tsBackdrop = posterKey(facts.backdrop);
    const owners = [];
    for (const w of byWork.values()) {
      const rec = await tmdbRecord(ctx, w.tmdbKind, w.tmdbId);
      let how = null;
      if (tsOverview && rec.overview && tsOverview === rec.overview) how = "overview";
      if (!how) {
        const set = await tmdbPosterSet(ctx, w.tmdbKind, w.tmdbId);
        if (set.posters.has(tsPosterKey)) how = "poster-set";
      }
      if (!how) continue;
      w.how = how;
      w.backdropAgrees = !!(tsBackdrop && rec.backdrop && tsBackdrop === rec.backdrop);
      owners.push(w);
    }
    if (owners.length === 1) {
      for (const c of owners[0].cs) {
        c.posterMatch = true;
        c.posterMatchKind = owners[0].how;
        c.backdropAgrees = owners[0].backdropAgrees;
      }
    } else if (owners.length > 1) {
      out.rung = "held-out";
      out.confidence = CONF.NONE;
      out.negativeCacheable = true;
      out.reason = `ambiguous: TV Stats' poster ${tsPosterKey} (or its overview) matches ${owners.length} different works (${owners
        .map((o) => o.cs[0].title)
        .join(" | ")}) - the row is HELD OUT`;
      return out;
    }
  }

  // The runtime tiebreak (movies only) needs the TMDB runtime - the search
  // result does not carry it. Bounded: only when the ranking is otherwise
  // undecided.
  if (!wantTv && survivors.length > 1 && !survivors.some((c) => c.posterMatch)) {
    const tsRuntime = Number.isFinite(facts.runtime) ? facts.runtime : null;
    if (tsRuntime) {
      for (const c of survivors.slice(0, 3)) {
        if (!c.tmdbId) continue;
        try {
          countLogical(ctx);
          const full = await ctx.tmdbGetFn(`/movie/${c.tmdbId}`);
          syncCounts(ctx);
          if (full && Number.isFinite(full.runtime)) c.runtime = full.runtime;
        } catch {
          /* the runtime is a tiebreak only */
        }
      }
      for (const c of survivors) {
        c.runtimeMatch =
          Number.isFinite(c.runtime) && Number.isFinite(tsRuntime)
            ? Math.abs(c.runtime - tsRuntime) <= 3
            : false;
      }
    }
  }

  // ---- RUNG 4/5: the ranking and the id.
  if (survivors.length) {
    survivors.sort(compareCandidates);
    // D5: two candidates that are indistinguishable on every piece of
    // EVIDENCE are AMBIGUOUS. The popularity tiebreak must not decide
    // which work the row is - the row is held out instead.
    if (survivors.length > 1 && evidenceEqual(survivors[0], survivors[1])) {
      out.rung = "held-out";
      out.confidence = CONF.NONE;
      out.reason = `ambiguous: "${survivors[0].title}" and "${survivors[1].title}" are indistinguishable on every piece of evidence (poster, runtime, year, title score, suggestion rank) - the row is HELD OUT`;
      return out;
    }
    // D1: the kind gate reads the IMDb titleType of the id that will be
    // SHIPPED. A wrong kind REJECTS the candidate; an unknown kind caps the
    // row at MEDIUM.
    const gated = await applyImdbKindGate(survivors, wantTv, ctx);
    survivors = gated.survivors;
    if (!survivors.length) {
      out.rung = "held-out";
      out.confidence = CONF.NONE;
      out.reason = `every surviving candidate was rejected by the IMDb kind gate (${gated.rejections[0] || "no detail"}) - the row is HELD OUT`;
      return out;
    }
    const win = survivors[0];
    out.rung = win.posterMatch ? "fingerprint" : win.source;
    out.fingerprint = !!win.posterMatch;
    out.posterMatchKind = win.posterMatchKind || null;
    out.backdropAgrees = !!win.backdropAgrees;
    out.candidateTitle = win.title;
    out.candidateDate = win.date;
    out.candidateKind = win.kind;
    out.tmdb = win.tmdbId ? String(win.tmdbId) : null;
    out.imdb = win.imdbIdResolved || null;
    const kinfo = gated.kinds.get(win) || { type: null, known: false, id: out.imdb };
    out.imdbKind = kinfo.type;
    out.imdbKindKnown = !!kinfo.known;
    if (win.imdbIdError) {
      // the external_ids lookup failed hard: that is not a "no IMDb id" -
      // the row is held out rather than downgraded (D4(b)).
      out.rung = "held-out";
      out.confidence = CONF.NONE;
      out.imdb = null;
      out.reason = `the TMDB external_ids lookup failed (${win.imdbIdError}) - the row is HELD OUT`;
      return out;
    }
    if (!out.imdb && !out.tmdb) {
      out.rung = "held-out";
      out.confidence = CONF.NONE;
      out.negativeCacheable = true;
      out.reason = `the winning candidate has no usable id (${win.rejected || "no id"})`;
      return out;
    }
    if (!out.imdb && out.tmdb) {
      // No IMDb id exists for this title, so the TMDB id is the fallback -
      // exactly what the RT pipeline does. A TMDB id carries its own record
      // type (a tv id IS a series record), so the kind gate that protects
      // the IMDb path - where TMDB can point a SERIES record at an
      // EPISODE's imdb id - does not apply to it: there is no
      // episode/file-level ambiguity in a TMDB id. The hard gate already
      // checked the record's media type against the list kind.
      out.rung = "fingerprint-tmdb";
      out.confidence = CONF.HIGH;
      out.reason = `title ${win.titleScore.toFixed(2)} + the year + the ${
        wantTv ? "show" : "movie"
      } kind whitelist` +
        (out.fingerprint
          ? win.posterMatchKind === "poster-set"
            ? " + a poster-set fingerprint (TV Stats holds an older TMDB poster of the same title)"
            : win.posterMatchKind === "overview"
              ? " + an overview fingerprint (TV Stats' synopsis is TMDB's own text for this title)"
              : " + a poster fingerprint"
          : " (no poster fingerprint)") +
        (out.backdropAgrees ? " + the backdrop agrees" : "") +
        ` + this title has NO IMDb id, so the TMDB id tmdb:${out.tmdb} is the fallback`;
      return out;
    }
    // The confidence comes from the EVIDENCE, not from the rung:
    //   HIGH   a poster fingerprint (the current poster OR one of the title's
    //          other posters) + the year leg + a CONFIRMED IMDb kind
    //   MEDIUM everything else (incl. an unknown IMDb kind - D1)
    out.confidence =
      out.fingerprint && out.yearPresent && out.imdbKindKnown ? CONF.HIGH : CONF.MEDIUM;
    out.reason =
      `title ${win.titleScore.toFixed(2)} + ${win.yearDrift ? "a +/-1 premiere drift" : "the year"} + the ${
        wantTv ? "show" : "movie"
      } kind whitelist` +
      (out.fingerprint
        ? win.posterMatchKind === "poster-set"
          ? " + a poster-set fingerprint (TV Stats holds an older TMDB poster of the same title)"
          : win.posterMatchKind === "overview"
            ? " + an overview fingerprint (TV Stats' synopsis is TMDB's own text for this title)"
            : " + a poster fingerprint"
        : " (no poster fingerprint)") +
      (out.backdropAgrees ? " + the backdrop agrees" : "") +
      (out.imdbKindKnown ? ` + the IMDb kind "${out.imdbKind}"` : " + an UNCONFIRMED IMDb kind (MEDIUM at most)");
    return out;
  }

  // ---- the documented lower tier: a partial title match is NEVER published.
  const partial = cands
    .filter((c) => kindOk(c.kind, wantTv) && c.titleScore >= 0.55 && c.titleScore < TITLE_GATE)
    .sort((a, b) => b.titleScore - a.titleScore);
  if (partial.length) {
    const p = partial[0];
    out.rung = "partial-title";
    out.confidence = CONF.LOW;
    // D6: a LOW row must NOT present a resolved id. The candidate is kept
    // in `candidate` for the caller to inspect, but no id is minted - a LOW
    // id in an exported result is a wrong id waiting to be published.
    out.candidate = {
      imdb: p.imdbId || null,
      tmdb: p.tmdbId ? String(p.tmdbId) : null,
      title: p.title,
      date: p.date,
      kind: p.kind,
      titleScore: p.titleScore,
    };
    out.imdb = null;
    out.tmdb = null;
    out.candidateTitle = p.title;
    out.candidateDate = p.date;
    out.candidateKind = p.kind;
    out.reason = `a partial title match (score ${p.titleScore.toFixed(2)} < ${TITLE_GATE}) - LOW confidence, never published`;
    return out;
  }

  // ---- HOLD: no guess, ever.
  out.rung = "held-out";
  out.confidence = CONF.NONE;
  const why = gated.length
    ? gated.map((c) => c.rejected).filter(Boolean)[0]
    : cands.length
      ? cands[0].rejected || "no candidate matched the title"
      : "no candidate at all";
  out.reason = `no candidate survived the gates (${why}) - the row is HELD OUT`;
  return out;
}

/**
 * Finish an offline-join hit: the IMDb id needs one TMDB external_ids call.
 *
 * D1: the id that is about to ship is verified against IMDb's own
 * titleType with the same whitelist. A wrong kind REJECTS the offline hit
 * (the ladder falls through to the online path); an unknown kind caps the
 * row at MEDIUM.
 */
async function finishOfflineJoin(ol, facts, ctx, wantTv) {
  if (!ol || !ol.hit) return null;
  const rec = ol.hit;
  let imdb = null;
  let hardFail = null;
  if (rec.tmdb) {
    try {
      imdb = await tmdbExternal(ctx, rec.kind, rec.tmdb);
    } catch (e) {
      hardFail = String((e && e.message) || e).slice(0, 140);
      imdb = null;
    }
  }
  if (hardFail) return null; // the ladder falls through to the online path
  if (!imdb && !rec.tmdb) return null;
  let imdbKind = null;
  let imdbKindKnown = false;
  if (imdb) {
    const facts2 = ctx.useGql === false ? new Map() : await imdbFacts(ctx, [imdb]);
    const t = facts2.get(imdb);
    imdbKind = canonImdbType(t && t.type) || null;
    imdbKindKnown = !!imdbKind;
    if (imdbKindKnown && !kindOk(imdbKind, wantTv)) return null; // rejected
  }
  return {
    imdb: imdb || null,
    tmdb: rec.tmdb ? String(rec.tmdb) : null,
    rung: "offline-join",
    fingerprint: true,
    confidence: ol.yearAbsent || !imdbKindKnown ? CONF.MEDIUM : CONF.HIGH,
    imdbKind,
    imdbKindKnown,
    candidateTitle: rec.title,
    candidateDate: rec.date,
    candidateKind: rec.kind,
    reason: `offline join: poster ${posterKey(facts.poster)} -> ${rec.src} (kind + title ${rec.titleScore.toFixed(
      2
    )} + year green${imdbKindKnown ? ` + the IMDb kind "${imdbKind}"` : " + an UNCONFIRMED IMDb kind"})`,
  };
}

/**
 * The movie entry point. The name and the argument shape are unchanged; the
 * internals are the ladder.
 */
export async function resolveMovie(row, getHtml, tmdbGetFn = null, ctxIn = null) {
  const ctx = makeCtx({ ...(ctxIn || {}), getHtml: getHtml || null, tmdbGetFn: tmdbGetFn || null });
  const out = await resolveRow({ ...row, kind: "movie" }, ctx);
  // D6: a LOW row carries NO id (the candidate lives in `out.candidate`), so
  // it is returned - not presented as a resolved id. A row with no id at
  // all is a failure and throws.
  if (!out.imdb && !out.tmdb && out.confidence !== CONF.LOW) {
    throw new Error(out.reason || `no id for movie slug ${row.slug}`);
  }
  return out;
}

/** The show entry point. Same contract as resolveMovie. */
export async function resolveShow(row, getHtml, tmdbGetFn = null, ctxIn = null) {
  const ctx = makeCtx({ ...(ctxIn || {}), getHtml: getHtml || null, tmdbGetFn: tmdbGetFn || null });
  const out = await resolveRow({ ...row, kind: "show" }, ctx);
  if (!out.imdb && !out.tmdb && out.confidence !== CONF.LOW) {
    throw new Error(out.reason || `no id for show slug ${row.slug}`);
  }
  return out;
}

// ---------------------------------------------------------------- the audit

/**
 * The optional audit: a SECOND, INDEPENDENT source that can veto a row.
 *
 * V1: the audit must never read the same file the offline join reads. The
 * offline join only reads TMDB records (a numeric id + a poster_path), and
 * the JustWatch snapshot carries imdb_ids without a numeric TMDB id, so the
 * JustWatch audit is NOT circular in this implementation. TVmaze is the
 * preferred source anyway: it is a live, independent service.
 *
 * V7: a DISAGREEMENT holds the row out. An unknown verdict abstains - it
 * never blocks.
 */
export const AUDIT_MODES = new Set(["off", "tv", "juicewatch"]);

const TVMAZE = "https://api.tvmaze.com";

/** The repo's own JustWatch snapshot (a local file, no network). */
export function loadJustWatchSnapshot(dataDir) {
  const map = new Map();
  let files = [];
  try {
    files = readdirSync(dataDir).filter((f) => f.startsWith("mdboff_justwatch") && f.endsWith(".json"));
  } catch {
    return map;
  }
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(dataDir, f), "utf8"));
    } catch {
      continue;
    }
    for (const it of j.items || []) {
      if (!it || !it.imdb_id) continue;
      map.set(it.imdb_id, { title: it.title || null, year: it.year || null, src: f });
    }
  }
  return map;
}

/**
 * Audit one resolved row.
 * Returns {verdict: "agree"|"disagree"|"unknown", source, detail}.
 */
export async function auditRow(resolved, ctxIn) {
  const ctx = makeCtx(ctxIn);
  const mode = ctx.audit || "off";
  if (mode === "off") return { verdict: "unknown", source: "none", detail: "the audit is off" };
  if (!resolved || !resolved.imdb) {
    return { verdict: "unknown", source: mode, detail: "the row has no IMDb id to audit" };
  }
  if (mode === "juicewatch") {
    const snap = ctx.justwatch || loadJustWatchSnapshot(ctx.dataDir || "");
    const hit = snap.get(resolved.imdb);
    if (!hit) {
      return { verdict: "unknown", source: "justwatch-local", detail: "the JustWatch snapshot does not carry this id" };
    }
    const ts = titleScore(hit.title, resolved.title);
    const yearOk = !resolved.year || !hit.year || String(hit.year) === String(resolved.year);
    return {
      verdict: ts >= TITLE_GATE && yearOk ? "agree" : "disagree",
      source: "justwatch-local",
      detail: `JustWatch "${hit.title}" (${hit.year}) vs TS "${resolved.title}" (${resolved.year}) - title score ${ts.toFixed(2)}`,
    };
  }
  if (mode === "tv") {
    // TVmaze: 1. reverse (does TVmaze know this IMDb id?) 2. forward (find
    // the show by title, then read its externals). TVmaze has no movies, so a
    // movie row abstains.
    if (resolved.kind !== "show") {
      return { verdict: "unknown", source: "tvmaze", detail: "TVmaze has no movies - the row abstains" };
    }
    const detail = [];
    let theirId = null;
    let theirName = null;
    try {
      const url = `${TVMAZE}/lookup/shows?imdb=${encodeURIComponent(resolved.imdb)}`;
      countLogical(ctx);
      const text = await httpJson(url, ctx);
      const j = JSON.parse(text);
      theirName = j.name || null;
      detail.push("the reverse lookup found the id");
    } catch {
      detail.push("the reverse lookup did not find the id");
    }
    if (!theirName && resolved.title) {
      try {
        countLogical(ctx);
        const text = await httpJson(
          `${TVMAZE}/singlesearch/shows?q=${encodeURIComponent(resolved.title)}`,
          ctx
        );
        const j = JSON.parse(text);
        countLogical(ctx);
        const extText = await httpJson(`${TVMAZE}/shows/${j.id}/externals`, ctx);
        const e = JSON.parse(extText);
        theirId = (e && e.imdb) || null;
        theirName = j.name || null;
        detail.push("the forward title lookup found a show");
      } catch {
        detail.push("the forward title lookup failed");
      }
    }
    if (!theirName) {
      return { verdict: "unknown", source: "tvmaze", detail: detail.join("; ") };
    }
    if (theirId) {
      return {
        verdict: theirId === resolved.imdb ? "agree" : "disagree",
        source: "tvmaze",
        detail: `TVmaze "${theirName}" -> ${theirId} vs the resolved ${resolved.imdb}`,
      };
    }
    const ts = titleScore(theirName, resolved.title);
    return {
      verdict: ts >= TITLE_GATE ? "agree" : "disagree",
      source: "tvmaze",
      detail: `TVmaze "${theirName}" (the same imdb id) vs TS "${resolved.title}" - title score ${ts.toFixed(2)}`,
    };
  }
  return { verdict: "unknown", source: mode, detail: "unknown audit mode" };
}
