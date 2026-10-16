#!/usr/bin/env node
/**
 * my-list Rotten Tomatoes - runs on GitHub Actions, fetches
 * rottentomatoes.com browse charts for the operator's enabled lists,
 * resolves per-title IMDb IDs by 2-of-3 majority vote (TMDB search,
 * IMDb suggestion API, Cinemeta search), writes data/rt_<id>.json
 * (served via GitHub Pages), and POSTs run records to /runs.
 *
 * Chart/detail HTML flows through the worker's /ts-fetch proxy
 * (RT_FETCH_BASE): the worker's egress passes RT's protection (verified
 * live) where datacenter IPs are challenged. IMDb-suggest, Cinemeta and
 * TMDB are key/CDN APIs built for servers - fetched direct, never proxied.
 *
 * Identity cache: data/rt_cache.json maps slug -> { type, imdb, tmdb }.
 * A title's identity never changes, so each slug resolves once ever;
 * steady-state runs only fetch new slugs. Committed by the workflow
 * alongside the data files (data/*.json).
 *
 * Unlike official.mjs, an EMPTY chart is a failure (these charts always
 * carry rows) and never overwrites the previous file.
 *
 * Required env (GitHub repo secrets / workflow env):
 *   TMDB_READ_ACCESS_TOKEN - TMDB API bearer (resolution)
 *   WORKER_ORIGIN           - worker base URL (run records + config)
 *   RT_FETCH_BASE           - worker base URL (chart/detail proxy; = WORKER_ORIGIN)
 *
 * Usage:
 *   node rt.mjs                        # refresh all enabled lists
 *   node rt.mjs --ids=rt_ab12cd34      # refresh listed ids only
 *   node rt.mjs --action=delete --delete_ids=rt_ab12cd34
 */

import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const DATA_DIR = join(ROOT, "data");
export const CACHE_FILE = join(DATA_DIR, "rt_cache.json");

const WORKER_ORIGIN = process.env.WORKER_ORIGIN;
const TMDB_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;

// ── page fetching: worker proxy for RT HTML, direct for APIs ──

export async function fetchProxyHtml(url, base = process.env.RT_FETCH_BASE) {
  if (!base) throw new Error("RT_FETCH_BASE is not set - point it at the worker origin.");
  const endpoint = `${String(base).replace(/\/+$/, "")}/ts-fetch?url=${encodeURIComponent(url)}`;
  // Retry transient upstream blips (429/502/503/504 + one cold-IP 403:
  // the egress probe saw a single first-hit 403 then stable 200s).
  // Anything else fails loud.
  const RETRYABLE = new Set([403, 429, 502, 503, 504]);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`proxy fetch ${res.status} for ${url}`);
      return res.text();
    } catch (e) {
      lastError = e;
      // Fail fast on client errors (4xx except 429/408/403: a 404 bad slug
      // will never heal on retry). Everything else gets two more attempts.
      const m = /proxy fetch (\d+)/.exec(String((e && e.message) || e));
      const fatal = m && +m[1] < 500 && +m[1] !== 429 && +m[1] !== 408 && +m[1] !== 403;
      if (fatal || attempt === 3) throw e;
      console.warn(`  [retry] ${url} attempt ${attempt}: ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
  throw lastError;
}

// Whole-day distance between two YYYY-MM-DD dates (null when unparsable).
export function dateDiffDays(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a || ""));
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b || ""));
  if (!pa || !pb) return null;
  const da = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]);
  const db = Date.UTC(+pb[1], +pb[2] - 1, +pb[3]);
  return Math.abs(Math.round((da - db) / 86400000));
}

export function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const idsArg = arg("ids");
const actionArg = arg("action") || "generate";
const deleteIdsArg = arg("delete_ids");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TMDB calls share one global pace (<= ~3/s): the tiered pmap would
// otherwise burst past the 40/10s budget and eat 60s backoffs.
let lastTmdbAt = 0;
async function tmdbPace() {
  const gap = 350 - (Date.now() - lastTmdbAt);
  if (gap > 0) await sleep(gap);
  lastTmdbAt = Date.now();
}

export async function tmdbGet(path, params = {}, fetchFn = fetch) {
  if (!TMDB_TOKEN) throw new Error("TMDB_READ_ACCESS_TOKEN is not set - cannot resolve IDs.");
  const url = `https://api.themoviedb.org/3${path}?${new URLSearchParams(params)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await tmdbPace();
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429) {
      await sleep(60000);
      continue;
    }
    if (!res.ok) throw new Error(`TMDB ${path} -> HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`TMDB ${path} -> repeated 429, giving up`);
}

// ── normalization + matching ──

// Exact-match normalization (shared by all three sources): lowercase,
// diacritics folded, & -> and, roman numerals folded (II vs 2),
// punctuation/whitespace collapsed. Dashes (hyphen + unicode variants)
// fold to SPACE, other punctuation deletes: sources disagree as
// "18-Year-Old" vs "18 Year Old" (common), while possessives agree as
// "marvels" both sides (so apostrophes must keep deleting, and V/H/S
// keeps collapsing to "vhs"). No fuzzy/contains - exact only.
export function normRtTitle(s) {
  let x = String(s || "").toLowerCase().trim();
  x = x.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  x = x.replace(/&/g, " and ");
  // Roman numerals II-IV fold to digits (sources disagree: "II" vs "2").
  // Single V/VI deliberately NOT folded: "V" is also a letter (V/H/S),
  // and folding it manufactures collisions; II-IV have no such dual use.
  x = x.replace(/\bii\b/g, "2").replace(/\biii\b/g, "3").replace(/\biv\b/g, "4");
  x = x.replace(/[‐‑‒–—―−-]/g, " ").replace(/[^a-z0-9 ]/g, "");
  return x.replace(/\s+/g, " ").trim();
}

// Trailing _YYYY disambiguation suffix on RT slugs (/m/dune_2024): a
// strong year hint the chart year can't give (listing vs film year).
export function slugYearOf(slug) {
  const m = /_([0-9]{4})$/.exec(String(slug || ""));
  return m ? +m[1] : null;
}

// Title variants for recall (ADDITIVE - exact always tried first):
// de-articled ("The House..." vs "House..."), de-possessive
// ("Marvel's Daredevil" vs "Daredevil"), article-stripped throughout
// ("Wuthering Heights: THE House..." vs "...House..."). Shared by the
// corroboration ladder AND the suggest/Cinemeta verdicts; verdicts keep
// their year/kind gates, so variants add recall without adding risk.
export function titleKeys(t) {
  const full = normRtTitle(t);
  const keys = [full];
  const noArt = full.replace(/^(the|a|an) /g, "");
  if (noArt && noArt !== full) keys.push(noArt);
  const noPoss = full.replace(/^\w+s /, "");
  if (noPoss && noPoss !== full && noPoss !== noArt) keys.push(noPoss);
  const noArts = full.split(" ").filter((w) => !["the", "a", "an"].includes(w)).join(" ");
  if (noArts && !keys.includes(noArts)) keys.push(noArts);
  return [...new Set(keys.filter(Boolean))];
}

// ── parsing ──

// Page-1 browse HTML: nested ItemList JSON-LD (flat Movie/TVSeries) +
// tile-DOM audience scores zipped by index (JSON-LD lacks them).
// Returns { rows, endCursor, hasNext }.
export function parseBrowsePage(html) {
  const blobs = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean);
  const itemList = blobs.find((b) => b && b["@type"] === "ItemList");
  if (!itemList) throw new Error("browse page has no ItemList JSON-LD");
  let items = itemList.itemListElement;
  if (items && !Array.isArray(items)) items = items.itemListElement;
  if (!Array.isArray(items)) throw new Error("unexpected ItemList shape");
  const aud = [...html.matchAll(/slot="audienceScore"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
  const cri = [...html.matchAll(/slot="criticsScore"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
  const rows = items.map((m, i) => {
    const slug = String(m.url || "").replace(/^https:\/\/www\.rottentomatoes\.com\//, "").replace(/^\//, "");
    if (!slug) throw new Error("chart row without slug");
    const yearM = String(m.dateCreated || "").match(/([0-9]{4})/);
    return {
      slug,
      title: m.name || "",
      year: yearM ? +yearM[1] : null,
      fulldate: (m.dateCreated && /^\d{4}-\d{2}-\d{2}/.test(m.dateCreated)) ? m.dateCreated.slice(0, 10) : null,
      tomato: (m.aggregateRating && String(m.aggregateRating.ratingValue)) || cri[i] || null,
      audience: aud[i] === "--" ? null : (aud[i] || null),
      poster: unwrapPoster(m.image),
    };
  });
  const pi = html.match(/<script type="application\/json" id="pageInfo">(.+?)<\/script>/);
  const info = pi ? JSON.parse(pi[1]) : {};
  return { rows, endCursor: info.endCursor || null, hasNext: info.hasNextPage === true };
}

// /cnapi/browse/... follow-up pages: { grid: { list[] }, pageInfo }.
export function parseCnapi(text) {
  const j = JSON.parse(text);
  const list = (j.grid && j.grid.list) || [];
  const rows = list.map((it) => {
    const slug = String(it.mediaUrl || "").replace(/^\//, "");
    if (!slug) throw new Error("cnapi row without mediaUrl");
    const yM = String(it.releaseDateText || "").match(/([0-9]{4})/);
    return {
      slug,
      title: it.title || "",
      year: yM ? +yM[1] : null,
      fulldate: null,
      tomato: (it.criticsScore && it.criticsScore.scorePercent) || null,
      audience: (it.audienceScore && it.audienceScore.scorePercent) || null,
      poster: unwrapPoster(it.posterUri),
    };
  });
  const info = j.pageInfo || {};
  return { rows, endCursor: info.endCursor || null, hasNext: info.hasNextPage === true };
}

// cnapi posterUris wrap the stable asset URL in a resize-proxy signature
// (<sig>/164x246/v2/<inner>) that breaks Stremio's image pipeline - keep
// the inner direct URL, identical to the JSON-LD image form (verified:
// inner returns full-size 200, wrapper is a fragile 13KB thumbnail).
export function unwrapPoster(url) {
  const u = String(url || "");
  const i = u.indexOf("/v2/http");
  return i === -1 ? (u || null) : u.slice(i + 4);
}

// RT detail pages carry the TRUE film/premiere date (dateCreated) - the
// chart only carries listing dates. Tiebreak for same-title collisions.
export function detailYearFromHtml(html) {
  const m = /"dateCreated":"([0-9]{4})/.exec(String(html || ""));
  return m ? +m[1] : null;
}

// Movie Info release rows ("Release Date (Theaters)", "(Streaming)",
// "Release Date") - premiere years that beat dateCreated when it holds
// a RERELEASE date (Halloween: dateCreated 2018-09-27, Theaters row
// Oct 25 1978). "Rerelease Date" rows are DELIBERATELY excluded (the
// regex needs a capital-R "Release Date"): rereleases date the listing,
// premieres date the film. Returns unique years in page order.
export function detailReleaseYears(html) {
  const out = [];
  // Anchored to the label start (after the <rt-text> open tag): a bare
  // "Release Date" substring also matches hyphenated "Re-Release Date",
  // whose year would pollute premiere years with a relisting year.
  // "Rerelease Date" (no hyphen) misses by case accident; the anchor
  // removes the accident-dependency. Premiere labels all match the
  // anchored form (census-verified); strictly narrowing, zero recall cost.
  const re = /<rt-text[^>]*>\s*Release Date[^<]*<\/rt-text>\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    const y = /((?:19|20)\d{2})/.exec(m[1].replace(/<[^>]+>/g, " "));
    if (y && !out.includes(+y[1])) out.push(+y[1]);
  }
  return out;
}

export function detailUrlFor(slug) {
  return `https://www.rottentomatoes.com/${String(slug || "").replace(/^\//, "")}`;
}

// Split a browse URL into cnapi vanity + pathFilters
// (/browse/movies_at_home/sort:popular -> ["movies_at_home", "sort:popular"]).
export function splitBrowseUrl(rawUrl) {
  const u = new URL(String(rawUrl || ""));
  const parts = u.pathname.replace(/^\/browse\/?/, "").split("/").filter(Boolean);
  return { vanity: parts[0] || "", filters: parts.slice(1).join("/") };
}

export function cnapiUrl(vanity, filters, after) {
  const base = `https://www.rottentomatoes.com/cnapi/browse/${vanity}/${filters ? filters + "/" : ""}`;
  return after ? `${base}?after=${encodeURIComponent(after)}` : base;
}

// ── resolution: strength-weighted vote ──

// candidates: [{ id, weak }...] from the three sources. Strong evidence
// counts 10, weak 1; highest total wins; ties return null (caller:
// director, arbiter, holdout).
export function scoreVote(cands) {
  const totals = new Map();
  for (const c of cands) {
    if (!c || !c.id) continue;
    totals.set(c.id, (totals.get(c.id) || 0) + (c.weak ? 1 : 10));
  }
  if (totals.size === 0) return null;
  let best = null;
  let bestScore = -1;
  let tied = false;
  for (const [id, s] of totals) {
    if (s > bestScore) { best = id; bestScore = s; tied = false; }
    else if (s === bestScore) { tied = true; }
  }
  return tied ? null : best;
}

function imdbSuggestSlug(title) {
  // Chart/detail titles sometimes carry a year suffix ("Hope (2026)") -
  // the suggestion files are keyed by bare title ("hope.json"), so a
  // suffixed query 404s. Strip it before slugging.
  const clean = String(title || "").replace(/\s*\(\d{4}[^)]*\)\s*$/, "").trim() || String(title || "");
  return clean.toLowerCase().replace(/ /g, "_").replace(/[^a-z0-9_]/g, "");
}

// Raw suggestion candidates for a row across query variants (shared by
// the verdict + corroboration so both see the same pool). Variants:
// clean-title slug, slug minus trailing _YYYY (RT slugs like
// the_furious_2025 resolve under the_furious.json), each tried flat then
// first-letter path. Returns { cands, query } - exact-norm + kind
// filtered like the verdict, plus the unfiltered exact list as `all`.
// Never throws (miss = empty lists).
export async function suggestCandidates(row, type, fetchJson) {
  const queries = [];
  const slugPart = String(row.slug || "").split("/")[1] || "";
  const noYear = slugPart.replace(/_\d{4}$/, "");
  if (noYear) queries.push(noYear);
  const qt = imdbSuggestSlug(row.title);
  if (qt && !queries.includes(qt)) queries.push(qt);
  if (slugPart && !queries.includes(slugPart)) queries.push(slugPart);
  const stripped = row.title.replace(/\s*\(\d{4}[^)]*\)\s*$/, "");
  const keys = titleKeys(stripped);
  // De-possessive/de-articled file queries ("ricky gervais alley cats"
  // lives under alley_cats.json): slug forms of every key, tried after
  // the slug-derived queries above - additive, 404-safe.
  for (const k of keys) {
    const qs = k.replace(/ /g, "_");
    if (qs && !queries.includes(qs)) queries.push(qs);
  }
  const wantQid = type === "movie" ? ["movie", "tvMovie", "video"] : ["tvSeries", "tvMiniSeries"];
  for (const q of [...new Set(queries)].filter(Boolean)) {
    const urls = [
      `https://v3.sg.media-imdb.com/suggestion/x/${q}.json`,
      `https://v3.sg.media-imdb.com/suggestion/${q[0]}/${q}.json`,
    ];
    for (const u of urls) {
      let d = null;
      try {
        d = await fetchJson(u);
      } catch {
        continue; // 404 variant - try next form
      }
      // Candidates may match any title key ("Daredevil" for a "Marvel's
      // Daredevil" row): the verdict's year gate + kind filter + verify
      // still decide, so variants add recall without adding risk.
      const exact = ((d && d.d) || []).filter((c) => c && c.id && /^tt/.test(c.id) && keys.includes(normRtTitle(c.l)));
      if (exact.length === 0) continue;
      const typed = exact.filter((c) => wantQid.includes(c.qid));
      return { cands: typed.length > 0 ? typed : exact, all: exact, query: q };
    }
  }
  return { cands: [], all: [], query: null };
}

// One TMDB verdict: { id, weak, date }. id is "imdb:tt.." | "tmdb:<id>" |
// null, date the candidate's release/first-air date (full YYYY-MM-DD).
// weak marks verdicts without a year anchor (popularity picks,
// dateless accepts, no-year singles, unlinked tmdb-only fallbacks) -
// such verdicts can never win alone (see resolveRow). Exact-norm only;
// listing gate EXACT, detail gate +/-1, no-year with detail tiebreak.
export async function tmdbVerdict(row, type, ctx) {
  const nt = normRtTitle(row.title);
  const years = [];
  if (row.year) years.push(row.year, row.year - 1, row.year + 1);
  const sy = slugYearOf(row.slug);
  if (sy && !years.includes(sy)) years.push(sy);
  const endpoint = type === "movie" ? "/search/movie" : "/search/tv";
  const yearParam = type === "movie" ? "year" : "first_air_date_year";
  const nameOf = (r) => (type === "movie" ? r.title : r.name);
  const origOf = (r) => (type === "movie" ? r.original_title : r.original_name);
  const dateOf = (r) => (type === "movie" ? r.release_date : r.first_air_date);
  // Strip a trailing " (YYYY...)" suffix BEFORE normalization (TMDB
  // result names like "Monster (2022)" must match bare "monster";
  // post-norm the parens are already gone, so stripping must come
  // first). Row titles strip the same class (titleKeys callers).
  const bare = (s) => normRtTitle(String(s || "").replace(/\s*\(\d{4}[^)]*\)\s*$/, ""));
  const exactIn = (results) => (results || []).filter((r) => bare(nameOf(r)) === nt || (origOf(r) && bare(origOf(r)) === nt));
  // Listing loop demands EXACT year equality: TMDB's year filter matches
  // ANY release (re-releases included), so ±1 here admits different films
  // wearing the same name (Carrie 2013 surfacing for a 2015 listing).
  // Genuine drift is covered by the detail loop below, which owns ±1.
  const agreeListing = (r, y) => {
    if (y === sy) return true;
    const ry = (/^([0-9]{4})/.exec(dateOf(r) || "") || [])[1];
    return !!ry && +ry === y;
  };
  const agreeDetail = (r, y) => {
    const ry = (/^([0-9]{4})/.exec(dateOf(r) || "") || [])[1];
    return !!ry && Math.abs(+ry - y) <= 1;
  };
  const tried = new Set();
  for (const y of [...new Set(years)]) {
    tried.add(y);
    const s = await ctx.tmdbGet(endpoint, { query: row.title, [yearParam]: y, include_adult: false, language: "en-US", page: 1 });
    const hits = exactIn(s && s.results).filter((r) => agreeListing(r, y));
    // Single year-anchored hit: decisive. Several same-year exacts (same
    // slug suffix shared by two films): break to detail + crew below -
    // first-match would be an arbitrary popularity pick.
    if (hits.length === 1) return await idOfTmdbHit(ctx, type, hits[0], false);
    if (hits.length > 1) break;
  }
  // Listing-year failed (catalog/listing drift: RT charts print streaming
  // years, not film years). The RT detail page carries the TRUE
  // film/premiere year - search with it before going year-blind.
  // Bounded: Movie-Info years then dateCreated (±1 each), drift rows only.
  let detailYear = null;
  let detailHtml = null;
  try {
    detailHtml = await ctx.getDetailHtml(row.slug);
    detailYear = detailYearFromHtml(detailHtml);
  } catch {
    detailYear = null; // fall through to no-year below
  }
  // Movie Info release rows beat a rerelease-dated dateCreated
  // (Halloween: dateCreated 2018, Theaters row 1978) - try them first.
  const infoYears = detailHtml ? detailReleaseYears(detailHtml) : [];
  const filmYears = [...new Set([...infoYears, ...(detailYear ? [detailYear] : [])])];
  if (filmYears.length > 0) {
    for (const base of filmYears) {
      for (const y of [base, base - 1, base + 1]) {
        if (!y || tried.has(y)) continue;
        tried.add(y);
        console.log(`  [detail-search] ${row.slug}: listing year failed, trying film year ${y}`);
        const s = await ctx.tmdbGet(endpoint, { query: row.title, [yearParam]: y, include_adult: false, language: "en-US", page: 1 });
        const hits = exactIn(s && s.results).filter((r) => agreeDetail(r, y));
        if (hits.length === 1) return await idOfTmdbHit(ctx, type, hits[0], false);
        if (hits.length > 1) break;
      }
    }
  }
  const s = await ctx.tmdbGet(endpoint, { query: row.title, include_adult: false, language: "en-US", page: 1 });
  const exact = exactIn(s && s.results);
  // Single exact with no usable year: accepted but WEAK (unverifiable) -
  // needs corroboration, never wins solo.
  if (exact.length === 1) return await idOfTmdbHit(ctx, type, exact[0], true);
  if (exact.length > 1) {
    // Genuine collision: year rung, then crew rung, never popularity
    // alone. One detail fetch serves year + crew (ambiguous rows only).
    let dHtml = null;
    try {
      dHtml = await ctx.getDetailHtml(row.slug);
    } catch (e) {
      console.warn(`  [detail] ${row.slug}: detail fetch failed (${e.message})`);
    }
    const dy = dHtml ? detailYearFromHtml(dHtml) : null;
    let pool = exact;
    if (dy) {
      const byYear = exact.filter((r) => String(dateOf(r) || "").startsWith(String(dy)));
      if (byYear.length > 0) {
        pool = byYear;
        if (pool.length === 1) {
          console.log(`  [detail-year] ${row.slug}: ${dy} picks from ${exact.length}`);
          return await idOfTmdbHit(ctx, type, pool[0], false);
        }
      }
    }
    // Evidence rung: TMDB-only pass first (today's behavior, zero new
    // calls) - unique max > 0 ships strong. Escalation (tie / dateless /
    // unlinked-weak only): per-rival TMDB + Cinemeta + GQL evidence with
    // REQUIRED kind + year gates; tie -> HOLDOUT (null), never
    // popularity. One detail fetch served year + crew.
    const rtEv = {
      year: dy,
      filmYears,
      dirs: [],
      creators: [],
      prods: [],
      cast: dHtml ? rtCastFromHtml(dHtml) : [],
    };
    if (dHtml) {
      const card = rtCrewFromHtml(dHtml, row.slug);
      const normSet = (arr) => [...new Set((arr || []).map(normRtTitle).filter(Boolean))];
      rtEv.dirs = normSet(card["Director"]);
      rtEv.creators = normSet(card["Creator"]);
      rtEv.prods = normSet([...(card["Executive Producer"] || []), ...(card["Producer"] || [])]);
    }
    const tm = [];
    for (const r of pool) {
      const candEv = await tmdbEvidenceFor(type, r.id, ctx);
      if (!candEv.date) {
        const dd = (type === "movie" ? r.release_date : r.first_air_date) || null;
        if (dd) candEv.date = dd;
      }
      tm.push({ r, ev: candEv, ...evidenceScore({ ...rtEv, year: rtEv.year }, candEv) });
    }
    const tmBest = uniqueMax(tm);
    if (tmBest && tmBest.total > 0) {
      console.log(`  [evidence] ${row.slug}: TMDB ${tmBest.r.id} wins (${tmBest.total}) from ${pool.length}`);
      return await idOfTmdbHit(ctx, type, tmBest.r, false);
    }
    // Combined escalation: every pooled rival (R<=6) scored on TMDB +
    // Cinemeta + GQL with kind + film-year gates. Bounded: ext_ids per
    // rival + GQL/Cine per tt-linked rival only (memoized); rare path.
    // Vetoed ids stay excluded downstream (this rung runs pre-vote;
    // verify/rescore still apply). Tie or all-gated-out -> HOLDOUT.
    const scored = [];
    for (const e of tm.slice(0, 6)) {
      let tt = null;
      try {
        const ext = await ctx.tmdbGet(type === "movie" ? `/movie/${e.r.id}/external_ids` : `/tv/${e.r.id}/external_ids`);
        if (ext && ext.imdb_id) tt = String(ext.imdb_id);
      } catch {
        tt = null;
      }
      let gEv = null;
      let cEv = null;
      if (tt && typeof ctx.gqlFetch === "function") {
        try {
          gEv = await ctx.gqlFetch(tt, ctx._gqlMemo || (ctx._gqlMemo = {}));
        } catch {
          gEv = null;
        }
      }
      if (tt) {
        try {
          cEv = await cineEvidenceFor(type, ctx, `imdb:${tt}`);
        } catch {
          cEv = null;
        }
      }
      const gate = kindGate(type, gEv) && yearGate(rtEv, e.ev, cEv, dateOf(e.r));
      const sC = cEv ? evidenceScore(rtEv, cEv) : { total: 0, parts: { y: 0, d: 0, p: 0, c: 0 } };
      const gConf = gqlConfirm(type, rtEv, gEv);
      const total = gate ? e.total + sC.total + gConf : -1;
      scored.push({ r: e.r, tt, total, parts: { tmdb: e.total, cine: sC.total, gql: gConf } });
    }
    const best = uniqueMax(scored.filter((s) => s.total >= 0));
    if (best && best.total > 0) {
      console.log(`  [evidence-combined] ${row.slug}: TMDB ${best.r.id} wins (${best.total} tmdb=${best.parts.tmdb} cine=${best.parts.cine} gql=${best.parts.gql}) from ${pool.length}`);
      return await idOfTmdbHit(ctx, type, best.r, false);
    }
    console.log(`  [ambiguous-holdout] ${row.slug}: ${pool.length} rivals tie at combined evidence - holding out`);
    return null;
  }
  return null;
}

async function idOfTmdbHit(ctx, type, hit, weak) {
  const extPath = type === "movie" ? `/movie/${hit.id}/external_ids` : `/tv/${hit.id}/external_ids`;
  const ext = await ctx.tmdbGet(extPath);
  // Unlinked tmdb-only ids are ALWAYS weak (no external corroboration
  // possible by construction) - but still accepted lone (day-0 titles).
  // The candidate's own release/first-air date rides along - the winner's
  // date wins over RT's listing date (see resolveRow).
  const date = (type === "movie" ? hit.release_date : hit.first_air_date) || null;
  if (ext && ext.imdb_id) return { id: `imdb:${ext.imdb_id}`, weak, date };
  return { id: `tmdb:${hit.id}`, weak: true, date };
}

// One IMDb-suggest verdict: { id, weak }. Exact-norm + year gate,
// lowest rank wins. Pool fallback (no year match) is WEAK - the
// Disciple/Social-Network misfires proved popularity alone misleads.
// Shape unchanged (tests + callers rely on { id, weak, date }).
export async function suggestVerdict(row, type, fetchJson) {
  const { cands: pool } = await suggestCandidates(row, type, fetchJson);
  if (pool.length === 0) return null;
  const years = row.year ? [row.year, row.year - 1, row.year + 1] : [];
  const sy = slugYearOf(row.slug);
  if (sy && !years.includes(sy)) years.push(sy);
  const yOk = pool.filter((c) => c.y && years.includes(+c.y));
  const strong = yOk.length > 0;
  const pick = (strong ? yOk : pool).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))[0];
  if (!pick || !pick.id || !pick.id.startsWith("tt")) return null;
  return { id: `imdb:${pick.id}`, weak: !strong, date: pick.y ? String(pick.y) : null };
}

// One Cinemeta verdict: { id, weak }. Exact-norm on catalog search names.
// Ungated by year (search metas carry no reliable year) - always WEAK,
// corroboration only, never decisive alone.
export async function cinemetaVerdict(row, type, fetchJson) {
  const keys = titleKeys(row.title);
  const kind = type === "movie" ? "movie" : "series";
  const url = `https://v3-cinemeta.strem.io/catalog/${kind}/imdb/search=${encodeURIComponent(row.title)}.json`;
  const d = await fetchJson(url);
  // Any title key may match ("The Golden Ticket" for a "Wonka's the
  // Golden Ticket" row): the verdict stays weak/corroboration-only.
  const hit = ((d && d.metas) || []).find((m) => keys.includes(normRtTitle(m.name)));
  if (!hit || !hit.id) return null;
  const rel = String(hit.releaseInfo || hit.year || "");
  const dm = rel.match(/([0-9]{4})(?:-([0-9]{2})-([0-9]{2}))?/);
  return { id: `imdb:${hit.id}`, weak: true, date: dm ? dm[0] : null };
}

// RT detail crew card: generic label -> names parse over the Series/Movie
// Info section ({Creator, Director, Executive Producer, Producer,
// Screenwriter}). Pages differ (Monster has Creator, Matlock only EPs,
// Terror: Devil in Silver only Screenwriter, some have Director) so every
// present label is collected - never one hardcoded field. Multiline-aware:
// section HTML spans lines ([\s\S], never dot).
// Merges the JSON-LD director form above. "Screenwriter" folds into
// Creator: series writers ARE the creators (proven 5/5 on Cinemeta; the
// terror row's LaValle sits under this label), and for movies the merge
// is veto-safe (agreement is existential - extra names can only add
// matches, never manufacture a contradiction). Returns { label: [names] }.
export function rtCrewFromHtml(html, slug = null) {
  const h = String(html || "");
  const out = {};
  const add = (label, name) => {
    const n = decodeHtmlEntities(String(name || "").trim());
    if (!n) return;
    out[label] = out[label] || [];
    if (!out[label].includes(n)) out[label].push(n);
  };
  const jd = directorFromHtml(h);
  if (jd) add("Director", jd);
  const sec = /<dt class="key">\s*<rt-text[^>]*>([^<]+)<\/rt-text>\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
  let m;
  while ((m = sec.exec(h)) !== null) {
    const label = m[1].trim();
    if (label !== "Creator" && label !== "Director" && label !== "Executive Producer" && label !== "Producer" && label !== "Screenwriter") {
      // Unknown-label tripwire (log-only, still skipped): person-ish
      // labels we never fold today (Showrunner, Co-Creator, Writer...)
      // become visible in run logs instead of silently dropped. No fold:
      // folding generic Writer risks false crewHits; a real synonym needs
      // its own live row + test before joining the allowlist above.
      if (/creator|showrunner|writer|teleplay|story\s*by|director|producer/i.test(label)) {
        console.warn(`  [crew-label] ${slug || "?"}: unmapped person-label "${label}" - ignoring`);
      }
      continue;
    }
    const nm = /data-qa="item-value">([^<]+)</g;
    let n;
    while ((n = nm.exec(m[2])) !== null) add(label === "Screenwriter" ? "Creator" : label, n[1]);
  }
  return out;
}

// Flat normalized name set from an rtCrewFromHtml card.
export function rtCrewNames(crew) {
  const all = [];
  for (const k of Object.keys(crew || {})) for (const n of crew[k]) all.push(normRtTitle(n));
  return [...new Set(all.filter(Boolean))];
}

// TMDB crew set for one numeric id: movies -> credits Directors +
// Producers; series -> details created_by + credits crew
// Directors/Producers. Null when unresolvable - never throws.
export async function tmdbCrewFor(type, numericId, ctx) {
  try {
    const names = [];
    if (type === "series") {
      const det = await ctx.tmdbGet(`/tv/${numericId}`);
      for (const p of (det && det.created_by) || []) if (p && p.name) names.push(p.name);
    }
    const credPath = type === "movie" ? `/movie/${numericId}/credits` : `/tv/${numericId}/credits`;
    const c = await ctx.tmdbGet(credPath);
    for (const p of ((c && c.crew) || []).filter((p) => p && (p.job === "Director" || p.job === "Producer" || p.job === "Executive Producer"))) {
      if (p.name) names.push(p.name);
    }
    return [...new Set(names.map(normRtTitle).filter(Boolean))];
  } catch {
    return [];
  }
}

// Person-name agreement for decisive roles, tolerant in four measured
// ways (each proven on live rows, each bounded against false positives):
// exact normalized match; same last name + same first initial (stage
// names: "Oz Perkins" vs "Osgood Perkins"); token order-swap
// ("Tanigaki Kenji" vs "Kenji Tanigaki", East-Asian name order);
// spacing variants ("McCarthy" vs "Mc Carthy", Cinemeta typo class);
// surname extension ("Raamla Mohamed" vs "Raamla Mohamed Hunter",
// married names - shorter token sequence contained in order + same
// first token, max 2 extra tokens).
// Single-token names must match exactly (no initials to compare).
// Distinct first names never agree ("John Smith" vs "Anna Smith");
// different-initial nicknames ("Bob" vs "Robert Smith") stay out of scope.
export function namesAgree(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = String(a).split(" ").filter(Boolean);
  const pb = String(b).split(" ").filter(Boolean);
  if (pa.length < 2 || pb.length < 2) return false;
  if (pa[pa.length - 1] === pb[pb.length - 1] && pa[0][0] === pb[0][0]) return true;
  // Order-swap: same token multiset, e.g. family-name-first credits.
  if (pa.length === pb.length && pa.length <= 4) {
    const sa = [...pa].sort().join(" ");
    const sb = [...pb].sort().join(" ");
    if (sa === sb) return true;
  }
  // Spacing variants: one side splits a token ("Mc Carthy").
  if (String(a).replace(/ /g, "") === String(b).replace(/ /g, "")) return true;
  // Surname extension: shorter contained in order, same first token.
  if (pa[0] === pb[0]) {
    const [sh, lo] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
    if (lo.length - sh.length <= 2) {
      let j = 0;
      for (const t of lo) if (t === sh[j]) j++;
      if (j === sh.length) return true;
    }
  }
  return false;
}

// Transliteration second-chance (oo<->u ONLY): romanization variants of
// the same name ("Nam Dae-jung" vs "Nam Dae-joong", same ㅜ vowel).
// eo<->o, eu, ou mappings are EXCLUDED (Seong/Song are different
// families - proven false-equate). VETO POINTS ONLY: confirms stay
// strict; a translit lift additionally needs exact-year + 3 shared
// leads + existing vote backing (see translitLift).
export function translitKey(s) {
  return String(s || "").replace(/oo/g, "u");
}
export function namesAgreeTranslit(a, b) {
  return namesAgree(translitKey(a), translitKey(b));
}
// The single shared veto predicate: both sides present + pairwise
// disjoint under tolerant (incl. translit) agreement. Used at
// corroborate contradicted + fallback block (bare); verify branches
// use the gated translitLift instead (vote-backed winners only).
export function vetoDisjoint(A, B) {
  const a = (A || []).filter(Boolean);
  const b = (B || []).filter(Boolean);
  return a.length > 0 && b.length > 0 && !a.some((x) => b.some((y) => namesAgreeTranslit(x, y)));
}
// Gated translit lift for veto points: a strict miss rescued by oo<->u
// still needs exact-year (not ±1) + 3 strict shared leads. Vote backing
// holds by construction (verify only sees voted winners).
export function translitLift(rtDec, tmDec, rtEv, candEv) {
  const a = (rtDec || []).filter(Boolean);
  const b = (tmDec || []).filter(Boolean);
  if (a.length === 0 || b.length === 0) return false;
  if (!a.some((x) => b.some((y) => !namesAgree(x, y) && namesAgreeTranslit(x, y)))) return false;
  const yM = /^([0-9]{4})/.exec(String((candEv && candEv.date) || ""));
  if (!rtEv || !rtEv.year || !yM || +yM[1] !== rtEv.year) return false;
  const shared = ((candEv.cast || []).filter((c) => (rtEv.cast || []).includes(c))).length;
  return shared >= 3;
}

// Crew agreement: >=1 shared normalized full name between RT's card and
// a TMDB crew set. Full-name exact keeps false positives ~nil (same
// title + same year + same person twice is practically nonexistent).
export function crewAgrees(rtNames, tmdbNames) {
  const tm = new Set(tmdbNames || []);
  return (rtNames || []).some((n) => tm.has(n));
}

// ── unified evidence scoring ──

// RT-side evidence from a detail page: true year + role-split crew +
// top-billed cast. Missing pieces stay empty (abstain downstream).
export function rtEvidenceFromHtml(html, slug = null) {
  const h = String(html || "");
  const dy = detailYearFromHtml(h);
  const card = rtCrewFromHtml(h, slug);
  const normSet = (arr) => [...new Set((arr || []).map(normRtTitle).filter(Boolean))];
  return {
    year: dy || null,
    dirs: normSet(card["Director"]),
    creators: normSet(card["Creator"]),
    prods: normSet([...(card["Executive Producer"] || []), ...(card["Producer"] || [])].map(normRtTitle)),
    cast: rtCastFromHtml(h),
  };
}

// TMDB-side evidence for one numeric id: date + role-split crew + top-5
// cast. Empty sets on any failure (abstain downstream, never throws).
export async function tmdbEvidenceFor(type, numericId, ctx) {
  const out = { date: null, dirs: [], creators: [], prods: [], cast: [] };
  // Details and credits fetch independently: either may fail while the
  // other succeeds, and partial evidence still decides (a missing
  // created_by must not erase known directors).
  try {
    const det = await ctx.tmdbGet(type === "movie" ? `/movie/${numericId}` : `/tv/${numericId}`);
    if (type === "movie") out.date = det.release_date || null;
    else out.date = det.first_air_date || null;
    if (type === "series") {
      for (const p of ((det && det.created_by) || [])) if (p && p.name) out.creators.push(normRtTitle(p.name));
    }
  } catch {
    // date/created_by unavailable - crew below may still match
  }
  try {
    const cred = await ctx.tmdbGet(type === "movie" ? `/movie/${numericId}/credits` : `/tv/${numericId}/credits`);
    for (const p of ((cred && cred.crew) || [])) {
      if (!p || !p.name) continue;
      const n = normRtTitle(p.name);
      if (p.job === "Director") out.dirs.push(n);
      else if (p.job === "Producer" || p.job === "Executive Producer") out.prods.push(n);
      // Series-only: staff Writers join creators (reluctant class: TMDB
      // created_by can name an episode director while the actual writers
      // carry the show). Movies untouched. Staff/Story/Assistant jobs
      // stay excluded (room-noise, not authorship).
      else if (type === "series" && p.job === "Writer") out.creators.push(n);
    }
    for (const p of (((cred && cred.cast) || []).slice(0, 5))) {
      const n = normRtTitle(p && p.name);
      if (n) out.cast.push(n);
    }
  } catch {
    // credits unavailable - date/created_by above may still match
  }
  return out;
}

// Score one candidate against RT evidence. Weights (live-tested 20/20):
// year exact 4 / +-1 2; Director/Creator-role match 6 (decisive);
// producer-level overlap 2 (corroboration only - franchise producers
// recur across installments, e.g. RT-EP Carpenter vs 2018-EP Carpenter,
// so EP overlap must never outrank a role match); cast overlap cap 3.
export function evidenceScore(rtEv, candEv) {
  let y = 0;
  const ryM = /^([0-9]{4})/.exec(String((candEv && candEv.date) || ""));
  if (rtEv && rtEv.year && ryM) {
    const d = Math.abs(+ryM[1] - rtEv.year);
    if (d === 0) y = 4;
    else if (d <= 1) y = 2;
  }
  // Series ranges ("2018–2026", open "2018–"): an RT year covered by the
  // run counts as a year hit (partial 2 - the start year is unknown for
  // open ranges, so never the full 4).
  if (y < 2 && rtEv && rtEv.year && candEv && candEv.yearStart) {
    const end = candEv.yearEnd == null ? Infinity : candEv.yearEnd;
    if (rtEv.year >= candEv.yearStart - 1 && rtEv.year <= end + 1) y = Math.max(y, 2);
  }
  const normSetOf = (arr) => [...new Set((arr || []).map(normRtTitle).filter(Boolean))];
  const rtDC = normSetOf([...((rtEv && rtEv.dirs) || []), ...((rtEv && rtEv.creators) || [])]);
  const tmDC = normSetOf([...((candEv && candEv.dirs) || []), ...((candEv && candEv.creators) || [])]);
  const rtP = normSetOf((rtEv && rtEv.prods) || []);
  const tmP = normSetOf([...((candEv && candEv.dirs) || []), ...((candEv && candEv.creators) || []), ...((candEv && candEv.prods) || [])]);
  let d = 0;
  // Alias-aware: stage names and nicknames ("Oz Perkins" vs "Osgood
  // Perkins") agree by last name + first initial; distinct first names
  // never agree ("John Smith" vs "Anna Smith").
  if (rtDC.length > 0 && tmDC.length > 0 && rtDC.some((a) => tmDC.some((b) => namesAgree(a, b)))) d = 6;
  let p = 0;
  // Tolerant like crewHit (matthew/matt murray class): producer overlap is
  // corroboration-only (+2, never decisive alone), so alias breadth here
  // cannot flip an id by itself.
  if (rtP.length > 0 && tmP.length > 0 && rtP.some((a) => tmP.some((b) => namesAgree(a, b)))) p = 2;
  let c = 0;
  for (const n of ((candEv && candEv.cast) || [])) {
    if (n && ((rtEv && rtEv.cast) || []).some((m) => namesAgree(m, n))) c++;
  }
  if (c > 3) c = 3;
  return { total: y + d + p + c, parts: { y, d, p, c } };
}

// Unique max over scored entries ({ total }): ties and empties yield
// null (holdout), never a pick. Shared by the TMDB-only pass and the
// combined escalation (and mirrors directorArbiter/rescore semantics).
function uniqueMax(arr) {
  let b = null;
  let tied = false;
  for (const s of arr) {
    if (!b || s.total > b.total) { b = s; tied = false; }
    else if (s.total === b.total) { tied = true; }
  }
  return tied ? null : b;
}

// GQL confirm for the combined rung: GQL writers vs RT decisive crew
// (movies: dirs; series: creators) with namesAgree - parity with the
// evidenceScore decisive-role weight (d=6) for the same role predicate.
// Empty either side abstains (0, never vetoes); disjoint contradicts
// (-6) but stays inside the gated sum (never a solo veto).
function gqlConfirm(type, rtEv, g) {
  if (!g || ((g.writers || []).length === 0 && (g.directors || []).length === 0)) return 0;
  // Defensive: inputs arrive normalized from parseImdbGqlCredits, but
  // norm is idempotent so normalize again rather than trust callers.
  const normSet = (arr) => [...new Set((arr || []).map(normRtTitle).filter(Boolean))];
  const gw = normSet(g.writers);
  const gd = normSet(g.directors);
  const dec = type === "movie" ? rtEv.dirs : rtEv.creators;
  const cand = type === "movie" ? [...gw, ...gd] : gw;
  if (dec.length === 0 || cand.length === 0) return 0;
  return dec.some((a) => cand.some((b) => namesAgree(a, b))) ? 6 : -6;
}

// Kind gate for the combined rung: unknown kind passes (abstain-safe).
function kindGate(type, g) {
  return !g || !g.kind || kindOkFor(type, g.kind);
}

// Year gate for the combined rung: any candidate-side date (TMDB detail,
// Cinemeta detail/range-start, search hit) within ±1 of an RT film year
// (detail Movie-Info rows + dateCreated - NOT the listing year, per the
// Halloween rule). No RT year claim -> no gate (abstain-safe).
function yearGate(rtEv, tEv, cEv, searchDate) {
  const yrs = [...(rtEv.filmYears || []), rtEv.year].filter(Boolean);
  const cands = [tEv && tEv.date, cEv && cEv.date, cEv && cEv.yearStart && String(cEv.yearStart), searchDate].filter(Boolean);
  if (yrs.length === 0) return true;
  return cands.some((d) => {
    const m = /^([0-9]{4})/.exec(String(d));
    return m && yrs.some((y) => Math.abs(+m[1] - y) <= 1);
  });
}

// HTML-entity decode for RT page text. Card labels carry entities
// ("Rachel O&#39;Connor") that must decode BEFORE normRtTitle, which
// would otherwise fold the & into " and " ("rachel o and 39connor" vs
// TMDB "rachel oconnor" - proven live). Single-pass: no double-decode.
export function decodeHtmlEntities(s) {
  return String(s || "").replace(/&#([0-9]+);|&#x([0-9a-fA-F]+);|&(amp|lt|gt|quot|apos|nbsp);/g, (m, dec, hex, named) => {
    if (dec) return String.fromCharCode(parseInt(dec, 10));
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[named] || m;
  });
}

// RT detail director (JSON-LD Person array or plain string form).
// Null when the page carries none (most series rows - use rtCrewFromHtml
// for the full card instead).
export function directorFromHtml(html) {
  const h = String(html || "");
  let m = /"director":\[\{"@type":"Person","name":"([^"]+)"/.exec(h);
  if (m) return decodeHtmlEntities(m[1]);
  m = /"director":"([^"]+)"/.exec(h);
  return m ? decodeHtmlEntities(m[1]) : null;
}

// Cinemeta evidence for one imdb id: director (+writer as creators on
// series only - series writers ARE the creators, verified 5/5; movie
// writers are excluded, director alone decides). Empty on failure.
// yearStart/yearEnd parse series ranges ("2018–2026", open "2018–") so
// anthology/multi-season rows match any covered year, not just the start.
export async function cineEvidenceFor(type, ctx, ttId) {
  const out = { date: null, yearStart: null, yearEnd: null, dirs: [], creators: [], prods: [], cast: [] };
  try {
    const clean = ttId.startsWith("imdb:") ? ttId.slice(5) : ttId;
    const kind = type === "movie" ? "movie" : "series";
    const meta = await ctx.fetchJson(`https://v3-cinemeta.strem.io/meta/${kind}/${clean}.json`);
    const m = meta && meta.meta;
    if (!m) return out;
    const normSet = (v) => {
      const arr = Array.isArray(v) ? v : (v ? [v] : []);
      return [...new Set(arr.map(normRtTitle).filter(Boolean))];
    };
    out.dirs = normSet(m.director);
    if (type === "series") out.creators = normSet(m.writer);
    out.cast = [...new Set((Array.isArray(m.cast) ? m.cast : []).map((n) => normRtTitle(n)).filter(Boolean))].slice(0, 8);
    const rel = String(m.released || m.year || m.releaseInfo || "");
    const dm = rel.match(/([0-9]{4})(?:-([0-9]{2})-([0-9]{2}))?/);
    out.date = dm ? dm[0] : null;
    // Range dash is en/em dash only: an ASCII hyphen here means an ISO
    // full date ("1978-10-08T00:00:00.000Z"), which must fall through to
    // the single-year parse below - not become an open-ended range (that
    // misparse granted every later RT year a free year credit via the
    // null/Infinity end in evidenceScore and yearOkFor).
    const rm = /((?:19|20)\d{2})\s*[–—]\s*((?:19|20)\d{2})?/.exec(rel);
    if (rm) {
      out.yearStart = +rm[1];
      out.yearEnd = rm[2] ? +rm[2] : null;
    } else if (dm) {
      out.yearStart = +dm[1];
      out.yearEnd = +dm[1];
    }
  } catch {
    // miss - empty evidence abstains downstream
  }
  return out;
}

// Total-split arbiter, first chair: every distinct id scored on full
// evidence (year + director/creator + cast) against RT's own card.
// Unique max wins; ties abstain (caller falls back to the IMDb arbiter).
// Rare rows only: bounded extra lookups.
export async function directorArbiter(row, type, ctx, ids) {
  const distinct = [...new Set(ids.filter(Boolean))];
  // Lone verdicts keep their existing path (accept/holdout) - the
  // director chair only convenes on genuine splits.
  if (distinct.length < 2) return null;
  let dHtml = null;
  try {
    dHtml = await ctx.getDetailHtml(row.slug);
  } catch {
    return null;
  }
  const card = rtCrewFromHtml(dHtml, row.slug);
  const normSet = (arr) => [...new Set((arr || []).map(normRtTitle).filter(Boolean))];
  const rtEv = {
    year: detailYearFromHtml(dHtml),
    dirs: normSet(card["Director"]),
    creators: normSet(card["Creator"]),
    prods: normSet([...(card["Executive Producer"] || []), ...(card["Producer"] || [])]),
    cast: rtCastFromHtml(dHtml),
  };
  if (!rtEv.year && rtEv.dirs.length === 0 && rtEv.creators.length === 0 && rtEv.cast.length === 0) return null;
  const scored = [];
  for (const id of distinct) {
    let candEv;
    if (id.startsWith("tmdb:")) {
      const n = id.slice(5);
      candEv = /^[0-9]+$/.test(n) ? await tmdbEvidenceFor(type, n, ctx) : { date: null, dirs: [], creators: [], prods: [], cast: [] };
    } else {
      candEv = await cineEvidenceFor(type, ctx, id);
    }
    scored.push({ id, ...evidenceScore(rtEv, candEv) });
  }
  let best = null;
  let bestScore = -1;
  let tied = false;
  for (const s of scored) {
    if (s.total > bestScore) { best = s; bestScore = s.total; tied = false; }
    else if (s.total === bestScore) { tied = true; }
  }
  if (best && !tied && bestScore > 0) {
    console.log(`  [evidence-arbiter] ${row.slug}: ${best.id} wins evidence (${bestScore}) from ${distinct.length}`);
    return best.id;
  }
  return null;
}

// Top-billed cast from RT detail JSON-LD (first 8, normalized). The
// cast list is long-tail; only the head carries signal (leads rarely
// recur across remakes, extras do).
export function rtCastFromHtml(html, n = 8) {
  const h = String(html || "");
  const m = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/g;
  let out = [];
  let b;
  while ((b = m.exec(h)) !== null) {
    try {
      const j = JSON.parse(b[1]);
      const actors = j && j.actor;
      if (Array.isArray(actors)) {
        for (const a of actors.slice(0, n)) {
          const nm = a && a.name ? normRtTitle(decodeHtmlEntities(a.name)) : "";
          if (nm) out.push(nm);
        }
      }
    } catch {
      // ignore unparsable blobs, keep scanning
    }
  }
  return [...new Set(out)];
}

// One retry around verify-path fetches: a single transient blip must
// not silently downgrade a check to "couldn't verify". Returns
// { v, failed } - failed only after both attempts.
async function tryTwice(fn, row, label) {
  try {
    return { v: await fn(), failed: false };
  } catch (e) {
    console.log(`  [verify-retry] ${row.slug} ${label}: ${String((e && e.message) || e).slice(0, 120)}`);
    await sleep(3000);
    try {
      return { v: await fn(), failed: false };
    } catch (e2) {
      return { v: null, failed: true };
    }
  }
}

// IMDb-vs-RT agreement (pure): does anyone on RT's own card tolerantly
// match IMDb's writers (series) or directors (movies)? Series checks both
// creators AND directors against writers (Crook class: the director IS
// the creator). Returns the agreeing pair or null. Confirm-only: callers
// log agreement; disagreement never vetoes (GraphQL principalCredits is
// often cast-only, so a miss proves nothing).
export function gqlRtAgreement(rtEv, type, g) {
  if (!g || !rtEv) return null;
  // Defensive: norm is idempotent; never trust caller normalization.
  const normSet = (arr) => [...new Set((arr || []).map(normRtTitle).filter(Boolean))];
  if (type === "series") {
    const creators = normSet(rtEv.creators);
    const gw = normSet(g.writers);
    for (const c of [...creators, ...normSet(rtEv.dirs)]) {
      for (const w of gw) {
        if (namesAgree(c, w)) return { rt: c, imdb: w, role: creators.includes(c) ? "creator" : "director-creator" };
      }
    }
    return null;
  }
  const dirs = normSet(rtEv.dirs);
  for (const d of dirs) {
    for (const m of normSet(g.directors)) {
      if (namesAgree(d, m)) return { rt: d, imdb: m, role: "director" };
    }
  }
  return null;
}

// Best-effort confirm note for verify abstains: fetches the winner's
// IMDb credits (memoized per run - the kind gate reuses it, so this is
// usually free) and logs RT∩IMDb agreement. Return values untouched:
// agreement is logged, anything else stays silent, failures swallowed.
async function logGqlRtConfirm(row, type, ctx, won, rtEv) {
  try {
    if (typeof ctx.gqlFetch !== "function" || !/^imdb:tt[0-9]+$/.test(won || "")) return;
    const g = await ctx.gqlFetch(won.slice(5), ctx._gqlMemo || (ctx._gqlMemo = {}));
    const m = gqlRtAgreement(rtEv, type, g);
    if (m) console.log(`  [verify-gql-confirm] ${row.slug}: RT ${m.rt} == IMDb ${m.imdb} (${m.role})`);
  } catch {
    // confirm is best-effort only - never affects the verdict
  }
}

// Winner verification: the decided ID's TMDB crew must not contradict
// RT's own page (which once carried a wrong date with right content).
// ROLE-AWARE: Director/Creator-role agreement decides; producer-level
// overlap only corroborates (franchise producers recur across
// installments, so EP overlap must never pass or veto alone).
// Returns { ok, reason }: reason is crew-match (verified), no-rt-crew /
// no-tmdb-crew (nothing to compare - pass), or fetch-failed (could not
// check - caller decides by backing strength). Only a proven
// role-level contradiction vetoes (ok:false). Bounded: ~3 calls per row.
export async function verifyWinner(row, type, ctx, won) {
  const d = await tryTwice(() => ctx.getDetailHtml(row.slug), row, "detail");
  if (d.failed || !d.v) {
    console.log(`  [verify-skip] ${row.slug}: detail fetch failed - unverifiable win`);
    return { ok: true, reason: "fetch-failed" };
  }
  const rtEv = rtEvidenceFromHtml(d.v, row.slug);
  const rtDC = [...rtEv.dirs, ...rtEv.creators];
  const rtHasDecisive = rtDC.length > 0;
  const rtHasAny = rtHasDecisive || rtEv.prods.length > 0;
  if (!rtHasAny) {
    console.log(`  [verify-skip] ${row.slug}: no RT crew to compare`);
    return { ok: true, reason: "no-rt-crew" };
  }
  if (type === "series" && rtEv.creators.length === 0 && rtEv.dirs.length > 0) {
    // Director-only series card: RT names episode/pilot directors while
    // candidate crews carry series creators - disjointness here is not
    // proof of contradiction (proven: 12 correct tt's in the 100-series
    // test). Abstain to the IMDb chair / corroboration, never veto.
    console.log(`  [verify-abstain] ${row.slug}: Director-only series card - abstaining (ships on vote backing, kind-gated at ship)`);
    await logGqlRtConfirm(row, type, ctx, won, rtEv);
    return { ok: true, reason: "series-director-abstain" };
  }
  // Resolve winner to its TMDB record (direct numeric, or /find by imdb).
  let num = null;
  if (won.startsWith("tmdb:")) {
    num = won.slice(5);
  } else {
    const f = await tryTwice(() => ctx.tmdbGet(`/find/${won.slice(5)}`, { external_source: "imdb_id" }), row, "find");
    if (f.failed || !f.v) {
      console.log(`  [verify-skip] ${row.slug}: TMDB find failed - unverifiable win`);
      return { ok: true, reason: "fetch-failed" };
    }
    const hits = type === "movie" ? (f.v.movie_results || []) : (f.v.tv_results || []);
    if (hits.length > 0) num = String(hits[0].id);
  }
  if (!num || !/^[0-9]+$/.test(num)) {
    console.log(`  [verify-skip] ${row.slug}: winner has no TMDB record - unverifiable win`);
    return { ok: true, reason: "fetch-failed" };
  }
  const candEv = await tmdbEvidenceFor(type, num, ctx);
  if (type === "series") {
    // Series creators are the decisive role; episode/pilot directors on
    // either side never prove or disprove identity (AHS class: RT
    // episode-director vs candidate series-creators, tt proven correct).
    // Veto only on creator-vs-creator disjointness with both sides
    // present; anything else abstains to corroboration/the IMDb chair.
    const tmC = candEv.creators;
    if (tmC.length === 0) {
      console.log(`  [verify-skip] ${row.slug}: no TMDB creator to compare`);
      await logGqlRtConfirm(row, type, ctx, won, rtEv);
      return { ok: true, reason: "no-tmdb-creator" };
    }
    if (rtEv.creators.length === 0) {
      // EP-only card (catalog-series shape): RT makes no creator claim -
      // an empty set is absence of a claim, not contradiction (proven: 19
      // false-vetoed winners in the 100-series test, every one correct).
      // Winner stands; never diverted to rescore.
      console.log(`  [verify-ok] ${row.slug}: ${won} no RT creator claim to contradict`);
      await logGqlRtConfirm(row, type, ctx, won, rtEv);
      return { ok: true, reason: "no-rt-creator" };
    }
    if (rtEv.creators.some((a) => tmC.some((b) => namesAgree(a, b)))) {
      console.log(`  [verify-ok] ${row.slug}: ${won} creator matches RT page`);
      return { ok: true, reason: "crew-match" };
    }
    // Source-author class (One Piece: manga author Oda EPs the 2023
    // adaptation while showrunners Owens/Maeda differ) - a creator
    // sitting as EP on the candidate corroborates the pick instead of
    // contradicting it, so abstain rather than veto. Series-only: movie
    // EPs recur across installments (Halloween rule), where producer
    // overlap must never rescue a pick. Translit-aware like the lift.
    if (rtEv.creators.some((a) => candEv.prods.some((b) => namesAgreeTranslit(a, b)))) {
      console.log(`  [verify-abstain] ${row.slug}: RT creator EPs ${won} - needs corroboration, not a veto`);
      await logGqlRtConfirm(row, type, ctx, won, rtEv);
      return { ok: true, reason: "creator-as-ep" };
    }
    // Transliteration second-chance (kim class): strict miss rescued by
    // oo<->u still needs exact-year + 3 shared leads (translitLift).
    if (translitLift(rtEv.creators, tmC, rtEv, candEv)) {
      console.log(`  [verify-ok] ${row.slug}: ${won} translit crew matches RT page`);
      return { ok: true, reason: "translit-match" };
    }
    console.log(`  [verify-veto] ${row.slug}: ${won} creator contradicts RT page - re-scoring`);
    return { ok: false, reason: "contradiction" };
  }
  const tmDC = [...candEv.dirs, ...candEv.creators];
  if (tmDC.length === 0) {
    console.log(`  [verify-skip] ${row.slug}: no TMDB crew to compare`);
    return { ok: true, reason: "no-tmdb-crew" };
  }
  if (!rtHasDecisive) {
    // Producer-level overlap only: corroboration, never a veto - but the
    // check ran clean, so record the pass explicitly.
    console.log(`  [verify-ok] ${row.slug}: ${won} producer-only RT card - no decisive crew to contradict`);
    await logGqlRtConfirm(row, type, ctx, won, rtEv);
    return { ok: true, reason: "crew-match" };
  }
  if (rtDC.some((a) => tmDC.some((b) => namesAgree(a, b)))) {
    console.log(`  [verify-ok] ${row.slug}: ${won} crew matches RT page`);
    return { ok: true, reason: "crew-match" };
  }
  // Transliteration second-chance, same gates as series (exact-year +
  // 3 shared leads + vote backing by construction).
  if (translitLift(rtDC, tmDC, rtEv, candEv)) {
    console.log(`  [verify-ok] ${row.slug}: ${won} translit crew matches RT page`);
    return { ok: true, reason: "translit-match" };
  }
  console.log(`  [verify-veto] ${row.slug}: ${won} crew contradicts RT page - re-scoring`);
  return { ok: false, reason: "contradiction" };
}
// Full-evidence rescore after a verification veto: every same-name TMDB
// candidate scored on RT detail year + director/crew + top-5 cast
// overlap. Returns { id, date } for the best non-vetoed candidate, else
// null (the veto stands - holdout). Bounded: rare path only.
// extraIds (rival suggest/Cinemeta ids from the vote) are scored on
// Cinemeta evidence too - the vetoed pick's rivals may live outside
// TMDB's exact list (Halloween 1978 won this way).
export async function evidenceRescore(row, type, ctx, vetoedId, extraIds = []) {
  let html = null;
  try {
    html = await ctx.getDetailHtml(row.slug);
  } catch {
    return null;
  }
  const rtEv = rtEvidenceFromHtml(html, row.slug);
  const endpoint = type === "movie" ? "/search/movie" : "/search/tv";
  const nameOf = (r) => (type === "movie" ? r.title : r.name);
  const origOf = (r) => (type === "movie" ? r.original_title : r.original_name);
  const dateOf = (r) => (type === "movie" ? r.release_date : r.first_air_date);
  const nt = normRtTitle(row.title);
  let results = [];
  try {
    const s = await ctx.tmdbGet(endpoint, { query: row.title, include_adult: false, language: "en-US", page: 1 });
    results = (s && s.results) || [];
  } catch {
    return null;
  }
  const bare = (s) => normRtTitle(String(s || "").replace(/\s*\(\d{4}[^)]*\)\s*$/, ""));
  const exact = results.filter((r) => bare(nameOf(r)) === nt || (origOf(r) && bare(origOf(r)) === nt));
  // Floor + tie-break (mirrors directorArbiter): a zero-evidence rival
  // must never ship (proven: 6 ancient same-name rivals won with total 0
  // in the 100-series test); ties hold out with the veto standing.
  let best = null;
  let tied = false;
  for (const r of exact) {
    let ext = null;
    try {
      const extPath = type === "movie" ? `/movie/${r.id}/external_ids` : `/tv/${r.id}/external_ids`;
      ext = await ctx.tmdbGet(extPath);
    } catch {
      continue;
    }
    if (!ext || !ext.imdb_id) continue;
    const id = `imdb:${ext.imdb_id}`;
    if (id === vetoedId) continue; // vetoed stays vetoed
    // Shared evidence scorer (role-aware: EP overlap corroborates only).
    const candEv = await tmdbEvidenceFor(type, r.id, ctx);
    if (!candEv.date) {
      const dd = dateOf(r) || null;
      if (dd) candEv.date = dd;
    }
    const sc = evidenceScore(rtEv, candEv);
    if (sc.total > 0) {
      if (!best || sc.total > best.total) { best = { id, date: candEv.date, total: sc.total }; tied = false; }
      else if (sc.total === best.total) { tied = true; }
    }
  }
  if (best && !tied) {
    console.log(`  [rescore] ${row.slug}: ${best.id} wins evidence (${best.total}) after veto`);
    return best;
  }
  // Rival ids from the other verdicts (suggest pool, Cinemeta) may not
  // appear in TMDB's exact list - score them on Cinemeta evidence.
  // Strict: positive total AND a year hit AND a unique max. A crew-only
  // match with no year agreement never flips an id here (One Piece
  // class: shared creator across adaptations must not override the
  // year-anchored pick) - that needs the veto-gated corroboration path.
  // Cast overlap substitutes for the year hit (Halloween class: the
  // rerelease-dated page shares a lead with the 1978 original).
  let xBest = null;
  let xTied = false;
  for (const xid of [...new Set((extraIds || []).filter(Boolean))].slice(0, 5)) {
    if (xid === vetoedId || xid.startsWith("tmdb:")) continue;
    let candEv = null;
    try {
      candEv = await cineEvidenceFor(type, ctx, xid);
    } catch {
      continue;
    }
    if (!candEv || (candEv.dirs.length === 0 && candEv.creators.length === 0 && !candEv.date)) continue;
    const sc = evidenceScore(rtEv, candEv);
    if (sc.total > 0 && (sc.parts.y > 0 || sc.parts.c > 0)) {
      if (!xBest || sc.total > xBest.total) { xBest = { id: xid, date: candEv.date, total: sc.total }; xTied = false; }
      else if (sc.total === xBest.total) { xTied = true; }
    }
  }
  if (xBest && !xTied) {
    console.log(`  [rescore] ${row.slug}: ${xBest.id} wins evidence (${xBest.total}) after veto`);
    return xBest;
  }
  return null;
}

// Parse an IMDb title page (headless-capable fetch) for series/movie
// credits: Creator(s) bullets, "Created by" / "Directed by" meta text,
// top Stars. Returns { creators, directors, stars } (normalized).
// Missing blocks stay empty (doc/anime pages often lack Creator).
export function parseImdbCredits(html) {
  const h = String(html || "");
  const unesc = (s) => String(s || "").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c)).replace(/&amp;/g, "&").trim();
  const out = { creators: [], directors: [], stars: [] };
  // Robust pass: any "- Creator"/"- Creators"/"- Director" bullet
  // list followed by "  - [Name]" link lines.
  const bul = /^-\s*(Creators?|Director)\s*$/gm;
  let b;
  while ((b = bul.exec(h)) !== null) {
    const rest = h.slice(b.index);
    const lines = rest.split("\n").slice(1, 12);
    for (const ln of lines) {
      if (ln.trim() === "") continue; // headless markdown pads blank lines
      const lm = /^\s*-\s*\[([^\]]+)\]/.exec(ln);
      if (!lm) break;
      const v = normRtTitle(unesc(lm[1]));
      if (!v) continue;
      const key = /Director/.test(b[1]) ? "directors" : "creators";
      if (!out[key].includes(v)) out[key].push(v);
    }
  }
  const meta = (re) => {
    const m = re.exec(h);
    return m ? m[1].split(/,\s*/).map((n) => normRtTitle(unesc(n))).filter(Boolean) : [];
  };
  for (const n of meta(/Created by ([^.|\n<]+)/)) if (!out.creators.includes(n)) out.creators.push(n);
  for (const n of meta(/Directed by ([^.|\n<]+)/)) if (!out.directors.includes(n)) out.directors.push(n);
  // Stars fallback: top-cast links when no Stars section parsed.
  if (out.stars.length === 0) {
    const sm = /Top Cast\d+\**([\s\S]{0,2000})/.exec(h);
    if (sm) {
      const nm = /\[([^\]]+)\]\(https:\/\/www\.imdb\.com\/name\//g;
      let n;
      while ((n = nm.exec(sm[1])) !== null) {
        const v = normRtTitle(unesc(n[1]));
        if (v && !out.stars.includes(v)) out.stars.push(v);
        if (out.stars.length >= 5) break;
      }
    }
  }
  return out;
}

// ── IMDb GraphQL (keyless) ──
//
// Plain IMDb title pages sit behind an AWS WAF JS challenge (HTTP 202),
// but api.graphql.imdb.com answers keyless POSTs with titleText,
// titleType and principalCredits (Writer/Director/Actor groups) - the
// exact crew + kind signals the chair needs, at ~1KB and ~0.6s each.
// (Proven live 2026-10-15: writers for Monster/AHS/Ted Lasso, director
// for Shawshank, kinds tvEpisode for tt31186255 / tvSeries for
// tt2708480.) Public/non-commercial use only per the response
// disclaimer; flagged-rows-only, <=5-wide, no retry storms.
// Every function here is abstain-on-failure: null means "unknown", and
// callers must pass unknown through, never block or veto on it.
const IMDB_GQL_URLS = ["https://api.graphql.imdb.com/", "https://graphql.imdb.com/"];
const IMDB_GQL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://www.imdb.com",
  Referer: "https://www.imdb.com/",
};
const imdbGqlQuery = (tt) => `{ title(id: "${tt}") { id titleText { text } titleType { id text } principalCredits { credits { name { nameText { text } } category { text } } } } }`;

// Adapter: GraphQL title -> { title, kind, writers, directors } with the
// repo's normalization (Writer ~= series creators, Director ~= film
// directors - same mapping the ladder already uses for Cinemeta).
// Null on missing/empty/error payloads (abstain downstream).
export function parseImdbGqlCredits(data) {
  const t = data && data.data && data.data.title;
  if (!t) return null;
  const normSet = (arr) => [...new Set((arr || []).map(normRtTitle).filter(Boolean))];
  const writers = [];
  const directors = [];
  for (const g of (t.principalCredits || [])) {
    for (const c of (g.credits || [])) {
      const nm = c && c.name && c.name.nameText && c.name.nameText.text;
      if (!nm) continue;
      const cat = String((c.category && c.category.text) || "").toLowerCase();
      if (cat === "writer" || cat === "writers" || cat === "creator" || cat === "creators") writers.push(nm);
      else if (cat === "director" || cat === "directors") directors.push(nm);
    }
  }
  const kind = (t.titleType && t.titleType.id) || null;
  return { title: (t.titleText && t.titleText.text) || null, kind, writers: normSet(writers), directors: normSet(directors) };
}

// Keyless fetch of one tt's GraphQL credits+kind. fetchFn is explicit
// (never defaulted: unit tests must stay offline). memo is an optional
// per-run object cache (ctx-owned). Null on any failure (abstain).
export async function imdbGqlCredits(ttId, fetchFn, memo = null) {
  const clean = String(ttId || "");
  if (!/^tt[0-9]+$/.test(clean)) return null;
  if (memo && Object.hasOwn(memo, clean)) return memo[clean];
  if (typeof fetchFn !== "function") return null;
  const body = JSON.stringify({ query: imdbGqlQuery(clean) });
  let out = null;
  for (const url of IMDB_GQL_URLS) {
    try {
      const res = await fetchFn(url, { method: "POST", headers: IMDB_GQL_HEADERS, body, signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.errors) break; // validation/schema drift - fallback shares the schema
      out = parseImdbGqlCredits(j);
      break;
    } catch {
      continue; // try fallback host, else abstain below
    }
  }
  if (memo) memo[clean] = out;
  return out;
}

// Kind compatibility: an episode id must never ship for a series row
// (terror class: TMDB mislinks series records to episode imdb_ids) and
// a series/film id must never ship for a movie row. Unknown kind
// passes (abstain - never block on missing data).
export function kindOkFor(type, kind) {
  const k = String(kind || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!k) return true;
  if (type === "series") return k === "tvseries" || k === "tvminiseries";
  return k === "movie" || k === "tvmovie" || k === "video" || k === "documentary";
}

// Rung-2 IMDb chair (flagged rows only): IMDb Creator/Director credits
// cross-checked against Cinemeta writers/directors. Two fetch paths:
// keyless GraphQL (ctx.gqlFetch - works in CI, proven live) first, then
// the legacy headless-HTML path (ctx.imdbFetch - Firecrawl/JS render).
// CI (node builtins) has neither -> null (fall through, behavior
// unchanged) unless main wires gqlFetch. Returns { id, tier: "imdb" }
// on a UNIQUE confirmation, else null. Never vetoes: a missing block
// abstains (documentary/anime pages often lack Creator), and an RT
// episode-director legitimately differs from series creators.
export async function imdbChair(row, type, ctx, ids) {
  const distinct = [...new Set((ids || []).filter((id) => id && id.startsWith("imdb:")))];
  if (distinct.length === 0) return null;
  // Keyless GraphQL path: unique crew confirmation wins, else abstain.
  if (typeof ctx.gqlFetch === "function") {
    const memo = ctx._gqlMemo || (ctx._gqlMemo = {});
    const confirmed = [];
    for (const id of distinct.slice(0, 6)) {
      let g = null;
      try {
        g = await ctx.gqlFetch(id.slice(5), memo);
      } catch {
        continue;
      }
      if (!g || (g.writers.length === 0 && g.directors.length === 0)) continue; // abstain, never veto
      const imdbCrew = type === "movie" ? g.directors : [...g.writers, ...g.directors];
      if (imdbCrew.length === 0) continue;
      let cine = null;
      try {
        cine = await cineEvidenceFor(type, ctx, id);
      } catch {
        continue;
      }
      const cineCrew = type === "movie" ? cine.dirs : [...cine.creators, ...cine.dirs];
      if (cineCrew.length > 0 && imdbCrew.some((a) => cineCrew.some((b) => namesAgree(a, b)))) {
        console.log(`  [imdb-chair] ${row.slug}: ${id} confirmed (IMDb GraphQL ∩ Cinemeta crew)`);
        confirmed.push(id);
      }
    }
    if (confirmed.length === 1) return { id: confirmed[0], tier: "imdb" };
    if (confirmed.length > 1) return null; // ambiguous - abstain
    // Zero confirmations: fall through to the HTML path below (which may
    // still abstain) rather than returning early.
  }
  if (typeof ctx.imdbFetch !== "function") {
    console.log(`  [imdb-chair-skip] ${row.slug}: no IMDb fetch available (GraphQL + headless both absent)`);
    return null;
  }
  const confirmed = [];
  for (const id of distinct.slice(0, 6)) {
    const tt = id.slice(5);
    let html = null;
    try {
      html = await ctx.imdbFetch(`https://www.imdb.com/title/${tt}/`);
    } catch {
      continue;
    }
    if (!html) continue;
    const imdb = parseImdbCredits(html);
    const imdbCrew = type === "movie" ? imdb.directors : [...imdb.creators, ...imdb.directors];
    if (imdbCrew.length === 0) continue; // abstain, never veto
    let cine = null;
    try {
      cine = await cineEvidenceFor(type, ctx, id);
    } catch {
      continue;
    }
    const cineCrew = type === "movie" ? cine.dirs : [...cine.creators, ...cine.dirs];
    if (cineCrew.length > 0 && imdbCrew.some((a) => cineCrew.some((b) => namesAgree(a, b)))) {
      console.log(`  [imdb-chair] ${row.slug}: ${id} confirmed (IMDb ∩ Cinemeta crew)`);
      confirmed.push(id);
    }
  }
  if (confirmed.length === 1) return { id: confirmed[0], tier: "imdb" };
  return null;
}

// Tiered corroboration for thin/split rows (runs where the vote cannot
// decide alone). One RT detail fetch serves all candidates; per-id
// evidence via TMDB (tmdb:) / Cinemeta (imdb:). Returns
// { id, date, tier } or null. Tiers: crew (decisive person + year),
// cast (≥3 shared leads + year), cross (≥2 corroborations + year),
// identity (exact title + year + 2 shared cast + top-1000 rank, no
// crew anywhere), season (same-series season entry: title-base +
// covering range + rank). A proven crew contradiction on EITHER side
// blocks every tier below it (franchise EPs recur - corroboration must
// never override proof). Bounded: distinct ids only.
export async function corroborateRow(row, type, ctx, cands) {
  const ids = [...new Set((cands || []).map((v) => v && v.id).filter(Boolean))];
  let pool = [];
  try {
    const s = await suggestCandidates(row, type, ctx.fetchJson);
    pool = s.cands || [];
  } catch {
    pool = [];
  }
  const byId = new Map(pool.map((c) => [`imdb:${c.id}`, c]));
  let html = null;
  try {
    html = await ctx.getDetailHtml(row.slug);
  } catch {
    return null;
  }
  if (!html) return null;
  const rtEv = rtEvidenceFromHtml(html, row.slug);
  const infoYears = detailReleaseYears(html);
  const years = [...new Set([rtEv.year, row.year, slugYearOf(row.slug), ...infoYears].filter(Boolean))];
  const decisive = type === "movie" ? rtEv.dirs : [...rtEv.creators, ...rtEv.dirs];
  const rtCast = rtEv.cast;
  const yearOkFor = (cine) => {
    const cy = cine.yearStart ?? null;
    if (cy && years.some((y) => Math.abs(cy - y) <= 1)) return true;
    if (cine.yearStart && years.some((y) => y >= cine.yearStart - 1 && (cine.yearEnd == null || y <= cine.yearEnd + 1))) return true;
    return false;
  };
  const evs = [];
  for (const id of ids) {
    let candEv = null;
    try {
      if (id.startsWith("tmdb:")) {
        const n = id.slice(5);
        candEv = /^[0-9]+$/.test(n) ? await tmdbEvidenceFor(type, n, ctx) : null;
      } else {
        candEv = await cineEvidenceFor(type, ctx, id);
      }
    } catch {
      candEv = null;
    }
    if (candEv) evs.push({ id, candEv, entry: byId.get(id) || null });
  }
  // NOTE: no early return on empty evs - the season-entry block below
  // discovers its own candidate.
  const dateOf = (id, candEv) => {
    const v = (cands || []).find((x) => x && x.id === id);
    const ds = [candEv.date, v && v.date].filter(Boolean);
    ds.sort((a, b) => String(b).length - String(a).length);
    return ds[0] || null;
  };
  // Title variants for recall (module-level titleKeys): de-articled,
  // de-possessive, article-stripped throughout.
  const artStrip = (s) => String(s || "").split(" ").filter((w) => !["the", "a", "an"].includes(w)).join(" ");
  const rowKeys = titleKeys(String(row.title || "").replace(/\s*\(\d{4}[^)]*\)\s*$/, ""));
  const scored = evs.map(({ id, candEv, entry }) => {
    // Kind-aware decisive roles: movies -> directors (film directors are
    // decisive); series -> creators (episode/pilot directors on either
    // side prove nothing - AHS class). Series directors only corroborate.
    const decC = type === "movie" ? rtEv.dirs : rtEv.creators;
    const canC = type === "movie" ? candEv.dirs : candEv.creators;
    const crewHit = decC.length > 0 && canC.length > 0 && decC.some((a) => canC.some((b) => namesAgree(a, b)));
    // Director-only series card vs candidate creators: the same person
    // often directs + creates (Crook class: RT Director == writer).
    // Counts as a T1 hit, never as a contradiction (contradicted stays
    // creators-only above).
    const dirOnlyHit = !crewHit && type === "series" && rtEv.creators.length === 0 && rtEv.dirs.length > 0 &&
      canC.length > 0 && rtEv.dirs.some((a) => canC.some((b) => namesAgree(a, b)));
    const contradicted = vetoDisjoint(decC, canC);
    const yGate = yearOkFor(candEv);
    // Tolerant person equality throughout (vicky/victoria luengo class):
    // same blessed namesAgree as decisive crewHit - exact title + year
    // gate already constrain the pool, and these points corroborate only.
    const castHit = (candEv.cast || []).filter((c) => rtCast.some((r) => namesAgree(r, c))).length;
    const stars = normRtTitle(entry ? entry.s || "" : "").split(" ").filter((w) => w.length > 2);
    const starHit = rtCast.filter((c) => stars.some((s) => c.includes(s))).length;
    const starCrewHit = decisive.length > 0 && rtCast.length > 0 &&
      stars.some((s) => decisive.some((d) => d.includes(s) || s.includes(d)));
    const rtEP = rtEv.prods;
    const candEP = [...candEv.creators, ...candEv.dirs, ...candEv.prods];
    const epHit = rtEP.length > 0 && candEP.length > 0 && rtEP.some((a) => candEP.some((b) => namesAgree(a, b)));
    // Series-director agreement (episode-level): corroboration only.
    const sdirHit = type === "series" && rtEv.dirs.length > 0 && candEv.dirs.length > 0 &&
      rtEv.dirs.some((a) => candEv.dirs.some((b) => namesAgree(a, b)));
    let corrobor = 0;
    const why = [];
    if (epHit) { corrobor++; why.push("ep"); }
    if (castHit >= 2) { corrobor++; why.push(`cast${castHit}`); }
    if (starHit >= 1 && castHit >= 1) { corrobor++; why.push("stars"); }
    if (starCrewHit) { corrobor++; why.push("starcrew"); }
    if (sdirHit) { corrobor++; why.push("sdir"); }
    if ((entry && (entry.rank ?? 1e9) <= 150)) { corrobor++; why.push("rank"); }
    // Ghost hygiene: zero-evidence candidates (no crew/cast/date) can
    // neither win nor tie-break (tt4537986 class) - except via the
    // season-entry block below, which re-derives everything.
    const ghost = canC.length === 0 && (candEv.dirs || []).length === 0 &&
      (candEv.cast || []).length === 0 && !candEv.date;
    return { id, candEv, entry, crewHit, dirOnlyHit, contradicted, yGate, castHit, corrobor, why, ghost };
  });
  // Season entry (same-series separately-listed season, e.g. Terror S3):
  // slug/title base + covering range (open-ended ok) + top-1500 rank,
  // no better-claimed rival. Checked only for contradicted-or-thin ids.
  const slugBase = normRtTitle(String(row.slug.split("/")[1] || "").replace(/_\d{4}$/, "").replace(/_/g, " "));
  const titleBase = normRtTitle(String(row.title || "").replace(/\s*\(\d{4}[^)]*\)\s*$/, "").split(":")[0]);
  const baseKeys = [...new Set([slugBase, titleBase, ...rowKeys].filter(Boolean))];
  // Season-shaped rows only (suffixed slug + title longer than the base):
  // same-title remake rows must never take the season path.
  const seasonShaped = /_\d{4}$/.test(String(row.slug.split("/")[1] || "")) &&
    normRtTitle(row.title).length > slugBase.length + 3;
  for (const s of scored) {
    if ((s.crewHit || s.dirOnlyHit) && s.yGate) continue; // T1 handles below
    const candNorm = normRtTitle((s.entry && s.entry.l) || "");
    const baseHit = (candNorm && (baseKeys.includes(candNorm) || baseKeys.includes(artStrip(candNorm)))) || false;
    const rankOk = (s.entry && (s.entry.rank ?? 1e9) <= 1500) || false;
    // Season-shaped rows only: same-title remake rows must never take
    // the season path (a crew contradiction there is proof, not a level
    // mismatch) - the independent block below enforces the same gate.
    if (baseHit && s.yGate && rankOk && seasonShaped) {
      s.season = true;
    }
  }
  const tierOf = (s) => {
    if (s.ghost) return null;
    if ((s.crewHit || s.dirOnlyHit) && s.yGate) return "crew";
    if (!s.contradicted && s.castHit >= 3 && s.yGate) return "cast";
    if (!s.contradicted && s.corrobor >= 2 && s.yGate) return "cross";
    // No-year crew+title: exact title + crew match + no years on either
    // side + single candidate + sane rank. Same exact title and same
    // director with no conflicting year anywhere is one work.
    if (!s.contradicted && (s.crewHit || s.dirOnlyHit) && years.length === 0 && evs.length === 1 && s.entry && (s.entry.rank ?? 1e9) <= 2000) return "noyear";
    if (!s.contradicted && s.castHit === 2 && s.yGate && s.entry && (s.entry.rank ?? 1e9) <= 1000) return "identity";
    if (s.season && s.yGate) return "season";
    return null;
  };
  const ranked = scored.map((s) => ({ ...s, tier: tierOf(s) })).filter((s) => s.tier);
  // Contradicted ids can only win via season-entry with a base match;
  // otherwise the veto stands (caller holds out / seeks the IMDb chair).
  const viable = ranked.filter((s) => !s.contradicted || s.tier === "season");
  if (viable.length === 0) {
    // Season entry (same-series separately-listed season, e.g. Terror S3
    // under its own slug): runs ONLY on season-shaped rows (suffixed slug
    // + title longer than the base, i.e. a subtitled season entry).
    // Same-title remake rows (Halloween) are never season-shaped, so a
    // crew contradiction there can never be laundered through this path.
    const slugBaseU = String(row.slug.split("/")[1] || "").replace(/_\d{4}$/, "");
    if (seasonShaped && slugBase) {
      try {
        const sj = await ctx.fetchJson(`https://v3.sg.media-imdb.com/suggestion/x/${slugBaseU}.json`);
        const wantQid = type === "movie" ? ["movie", "tvMovie", "video"] : ["tvSeries", "tvMiniSeries"];
        const hits = ((sj && sj.d) || [])
          .filter((c) => c && /^tt/.test(c.id) && normRtTitle(c.l) === slugBase && wantQid.includes(c.qid))
          .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))
          .slice(0, 3);
        for (const h of hits) {
          if ((h.rank ?? 1e9) > 1500) continue;
          const ce = await cineEvidenceFor(type, ctx, `imdb:${h.id}`);
          if (yearOkFor(ce)) {
            console.log(`  [corroborate] ${row.slug}: imdb:${h.id} via season (title-base + range)`);
            return { id: `imdb:${h.id}`, date: ce.date, tier: "season" };
          }
        }
      } catch {
        // suggestion miss - stays unresolved below
      }
    }
    // Variant titles ("Marvel's Daredevil" vs "Daredevil", article
    // insertions): rowKeys files, key match + evidence (crew, or EP +
    // cast, or >=3 cast) + year + sane rank. Evidence is mandatory here -
    // unlike season entries, nothing about the row shape excuses its absence.
    const keys = [...new Set([slugBase, ...rowKeys])].filter(Boolean);
    const triedFiles = new Set([slugBaseU]);
    for (const key of rowKeys.slice(0, 3)) {
      const q = key.replace(/ /g, "_");
      if (!q || triedFiles.has(q)) continue;
      triedFiles.add(q);
      let vd = null;
      try {
        vd = await ctx.fetchJson(`https://v3.sg.media-imdb.com/suggestion/x/${q}.json`);
      } catch {
        continue;
      }
      const wantQid = type === "movie" ? ["movie", "tvMovie", "video"] : ["tvSeries", "tvMiniSeries"];
      const hits = ((vd && vd.d) || [])
        .filter((c) => c && /^tt/.test(c.id) && (keys.includes(normRtTitle(c.l)) || keys.includes(artStrip(normRtTitle(c.l)))) && wantQid.includes(c.qid))
        .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))
        .slice(0, 3);
      for (const h of hits) {
        if ((h.rank ?? 1e9) > 1500) continue;
        let ce = null;
        try {
          ce = await cineEvidenceFor(type, ctx, `imdb:${h.id}`);
        } catch {
          continue;
        }
        if (!yearOkFor(ce)) continue;
        const crew = type === "movie" ? ce.dirs : ce.creators;
        const crewHit = decisive.length > 0 && crew.length > 0 && decisive.some((a) => crew.some((b) => namesAgree(a, b)));
        const castN = (ce.cast || []).filter((c) => rtCast.includes(c)).length;
        const epHit = rtEv.prods.length > 0 && [...ce.creators, ...ce.dirs, ...ce.prods].length > 0 &&
          rtEv.prods.some((n) => [...ce.creators, ...ce.dirs, ...ce.prods].includes(n));
        if (crewHit || (epHit && castN >= 1) || castN >= 3) {
          console.log(`  [corroborate] ${row.slug}: imdb:${h.id} via variant (title-key + evidence)`);
          return { id: `imdb:${h.id}`, date: ce.date, tier: "variant" };
        }
      }
    }
    // Drift tier (listing-vs-film year gaps, e.g. chart 2020 vs film
    // 2009): exact-pool candidate + crew match + >=3 shared cast + the
    // ONLY crew-claimant in the pool. Same exact title, same director,
    // same leads with no conflicting claimant is one work - the year
    // records just disagree. No rank gate (obscure films rank badly).
    const driftCands = pool.filter((c) => c && /^tt/.test(c.id)).slice(0, 4);
    if (driftCands.length > 0) {
      const driftEv = [];
      for (const pc of driftCands) {
        let ce = null;
        try {
          ce = await cineEvidenceFor(type, ctx, `imdb:${pc.id}`);
        } catch {
          continue;
        }
        const crew = type === "movie" ? ce.dirs : ce.creators;
        const hit = decisive.length > 0 && crew.length > 0 && decisive.some((a) => crew.some((b) => namesAgree(a, b)));
        const castN = (ce.cast || []).filter((c) => rtCast.includes(c)).length;
        driftEv.push({ id: `imdb:${pc.id}`, hit, castN });
      }
      const claimants = driftEv.filter((d) => d.hit);
      if (claimants.length === 1 && claimants[0].castN >= 3) {
        console.log(`  [corroborate] ${row.slug}: ${claimants[0].id} via drift (crew+cast${claimants[0].castN}, year records disagree)`);
        return { id: claimants[0].id, date: null, tier: "drift" };
      }
    }
    return null;
  }
  const order = { crew: 0, cast: 1, cross: 2, noyear: 3, identity: 4, season: 5, variant: 5, drift: 3 };
  viable.sort((a, b) => order[a.tier] - order[b.tier]);
  const win = viable[0];
  console.log(`  [corroborate] ${row.slug}: ${win.id} via ${win.tier} (${win.why.join("+") || "base"})`);
  return { id: win.id, date: dateOf(win.id, win.candEv), tier: win.tier };
}

// Full per-row resolution. Returns { id, date } (never throws - callers
// hold out on null). Acceptance: any strong backing, or >=2 weak
// backers agreeing, or a tmdb-only fallback, or a lone Cinemeta exact
// (proven gap-filler); popularity picks (TMDB-pop, suggest-pool) need a
// friend. Thin/split rows climb the corroboration ladder (crew / cast /
// cross-evidence / identity / season-entry tiers) before the director
// arbiter. Accepted winners pass verification (crew cross-check, vetoes
// RT-contradictions into a full evidence rescore, then the IMDb chair).
// Then director, IMDb arbiter, holdout. Date is the WINNER's date (TMDB
// full date preferred) - never RT's listing date.
export async function resolveRow(row, type, ctx) {
  const tw = await tmdbVerdict(row, type, ctx).catch((e) => {
    console.warn(`  [tmdb] ${row.slug}: ${e.message}`);
    return null;
  });
  const [sug, cin] = await Promise.all([
    suggestVerdict(row, type, ctx.fetchJson).catch(() => null),
    cinemetaVerdict(row, type, ctx.fetchJson).catch(() => null),
  ]);
  const cands = [tw, sug, cin].filter(Boolean);
  const won = scoreVote(cands);
  // Winner's date: fullest available among backers (TMDB full date >
  // year-only), falling back to the row further below in resolveOne.
  const winnerDate = (id) => {
    const backers = cands.filter((v) => v.id === id);
    backers.sort((a, b) => String(b.date || "").length - String(a.date || "").length);
    return (backers[0] && backers[0].date) || null;
  };
  if (won) {
    const backers = cands.filter((v) => v.id === won);
    const strongBacking = backers.some((v) => !v.weak);
    const agreedWeak = backers.length >= 2;
    const isFallback = won.startsWith("tmdb:");
    const isCine = cin && won === cin.id;
    if (strongBacking || agreedWeak || isFallback || isCine) {
      const score = backers.reduce((a, v) => a + (v.weak ? 1 : 10), 0);
      console.log(`  [vote] ${row.slug}: ${won} (score ${score})`);
      // Winner verification: vetoes RT-contradictions into a full
      // evidence rescore (Frankenstein pages: right content, wrong date).
      // An UNVERIFIABLE win (fetch failed mid-check) ships on strong
      // backing, fallback, or 2+ backers - a single thin backer holds
      // out instead of shipping blind.
      const verified = await verifyWinner(row, type, ctx, won).catch(() => ({ ok: true, reason: "fetch-failed" }));
      if (verified.ok) {
        if (verified.reason !== "fetch-failed" || strongBacking || isFallback || backers.length >= 2) {
          return { id: won, date: winnerDate(won) };
        }
        console.log(`  [holdout] ${row.slug}: ${won} unverifiable and thinly backed`);
        return null;
      }
      const rescored = await evidenceRescore(row, type, ctx, won, cands.map((v) => v.id)).catch(() => null);
      if (rescored) return { id: rescored.id, date: rescored.date };
      const chaired = await imdbChair(row, type, ctx, cands.map((v) => v.id)).catch(() => null);
      if (chaired) return { id: chaired.id, date: winnerDate(chaired.id) };
      console.log(`  [holdout] ${row.slug}: vetoed ${won}, rescore failed`);
      return null;
    }
    // Thin single-verdict win: corroboration ladder before holding out
    // (cast-anchor / cross-evidence / season-entry close proven rows).
    const co = await corroborateRow(row, type, ctx, cands).catch(() => null);
    if (co) {
      console.log(`  [vote-corroborated] ${row.slug}: ${co.id} via ${co.tier}`);
      return { id: co.id, date: co.date };
    }
    console.log(`  [weak-lone] ${row.slug}: popularity pick ${won} uncorroborated - holding out`);
    return null;
  }
  // No winner: corroboration ladder first (thin singles, splits, season
  // entries), then director match (rare rows only), then the IMDb exact
  // arbiter (itself verified - all voted results get checked), else holdout.
  const coNone = await corroborateRow(row, type, ctx, cands).catch(() => null);
  if (coNone) {
    console.log(`  [vote-corroborated] ${row.slug}: ${coNone.id} via ${coNone.tier}`);
    return { id: coNone.id, date: coNone.date };
  }
  const dirWin = await directorArbiter(row, type, ctx, cands.map((v) => v.id));
  if (dirWin) return { id: dirWin, date: winnerDate(dirWin) };
  if (sug) {
    console.log(`  [imdb-arbiter] ${row.slug}: total split, IMDb exact ${sug.id} wins`);
    const verified = await verifyWinner(row, type, ctx, sug.id).catch(() => ({ ok: true, reason: "fetch-failed" }));
    if (!verified.ok) {
      console.log(`  [holdout] ${row.slug}: arbiter pick ${sug.id} contradicts RT page`);
      return null;
    }
    return { id: sug.id, date: sug.date || null };
  }
  console.log(`  [holdout] ${row.slug}: tmdb=${tw && tw.id} sug=${sug && sug.id} cine=${cin && cin.id}`);
  return null;
}

// ── cache ──

export function loadCache(read = null) {
  try {
    const raw = read ? read() : existsSync(CACHE_FILE) ? readFileSync(CACHE_FILE, "utf8") : null;
    if (!raw) return {};
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch {
    return {}; // corrupt cache re-resolves naturally, never crashes a run
  }
}

export function saveCache(cache, write = null) {
  const body = JSON.stringify(cache, null, 2) + "\n";
  if (write) write(body);
  else {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, body);
  }
}

export function rowToItem(type, id, row, resolvedTitle, resolvedDate) {
  if (!id) throw new Error(`unresolvable slug ${row.slug}`);
  return {
    id,
    type: type === "series" ? "series" : "movie",
    name: resolvedTitle || row.title,
    poster: row.poster || undefined,
    releaseInfo: resolvedDate || (row.fulldate ? row.fulldate.slice(0, 4) : null) || (row.year ? String(row.year) : undefined),
  };
}

// ── worker config (fail-closed like tvstats.mjs) ──

export async function fetchConfig(fetchFn = fetch) {
  if (!WORKER_ORIGIN) return null;
  try {
    const res = await fetchFn(`${WORKER_ORIGIN}/export-config`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const cfg = await res.json();
    return Array.isArray(cfg?.rt?.lists) ? cfg.rt.lists.filter((l) => l && l.id && l.url) : null;
  } catch {
    return null;
  }
}

export function writeCatalog(list, items) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `${list.id}.json`);
  // list.name already carries the operator rename - /export-config serves
  // the live config, so no separate rename lookup is needed.
  const out = {
    catalog_id: list.id,
    name: list.name,
    type: list.type === "series" ? "series" : "movie",
    scraped_at: Date.now(),
    items,
  };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return file;
}

async function postRuns(runs, fetchFn = fetch) {
  if (!WORKER_ORIGIN || runs.length === 0) return;
  for (let i = 0; i < runs.length; i += 50) {
    const chunk = runs.slice(i, i + 50);
    let posted = false;
    // History recording gets the same retry manners as page fetches: a
    // single blip must not red the job after both lists succeeded.
    // Still exits 1 when truly down - a silent history gap is worse.
    for (let attempt = 1; attempt <= 3 && !posted; attempt++) {
      try {
        const res = await fetchFn(`${WORKER_ORIGIN}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runs: chunk }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        posted = true;
      } catch (e) {
        console.warn(`  [runs] POST attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3) await sleep(5000 * attempt);
      }
    }
    if (!posted) {
      console.warn(`  [runs] POST failed after 3 attempts - history for ${chunk.length} runs not recorded`);
      process.exitCode = 1;
    }
  }
}

export function deleteCatalogs(ids) {
  const removed = [];
  for (const id of ids) {
    const file = join(DATA_DIR, `${id}.json`);
    try {
      rmSync(file, { force: true });
      removed.push(id);
    } catch (e) {
      console.warn(`  [delete] ${id}: ${e.message}`);
    }
  }
  return removed;
}

// Bounded parallel map for the resolve phase (mixed hosts, TMDB
// self-paced at ~3/s): 5-way concurrency like tvstats.mjs.
export async function pmap(items, fn, concurrency = 5) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Per-row resolve: cache hit (with tmdb-only auto-upgrade) or full
// 3-source vote. Returns the item or null (held out). Bare tt ids out
// (Stremio form, like every other module); the internal "imdb:" prefix
// is stripped here, one place. Exported for tests.
export async function resolveOne(row, t, cache, ctx, tmdbGetFn, writtenIds, heldOut) {
  const key = row.slug;
  const hit = cache[key];
  let id;
  let title = row.title;
  let date = row.fulldate || (row.year ? String(row.year) : null);
  if (hit && (hit.imdb || hit.tmdb)) {
    id = hit.imdb || (hit.tmdb ? `tmdb:${hit.tmdb}` : null);
    if (id && id.startsWith("imdb:")) id = id.slice(5);
    title = hit.title || title;
    date = hit.date || date;
    // Auto-upgrade: tmdb-only fallback entries get one exact
    // external_ids re-check per run. Anything else keeps the
    // working fallback and never fails the list.
    if (!hit.imdb && hit.tmdb) {
      try {
        const extPath = hit.type === "movie" ? `/movie/${hit.tmdb}/external_ids` : `/tv/${hit.tmdb}/external_ids`;
        console.log(`  [recheck] ${row.slug}: tmdb:${hit.tmdb} - checking for imdb...`);
        const ext = await tmdbGetFn(extPath);
        if (ext && ext.imdb_id) {
          hit.imdb = ext.imdb_id;
          id = ext.imdb_id;
          console.log(`  [upgrade] ${row.slug}: tmdb:${hit.tmdb} -> ${ext.imdb_id}`);
        } else {
          console.log(`  [recheck] ${row.slug}: still missing, keeping fallback`);
        }
      } catch (e) {
        console.warn(`  [upgrade] ${row.slug}: re-check failed (${e.message}) - keeping fallback`);
      }
    }
  } else {
    const resolved = await resolveRow(row, t.type, ctx);
    // Resolve verdicts carry the internal "imdb:" prefix - data
    // files (and Stremio) use the bare tt form like every other
    // module, so strip here, one place, both paths.
    id = resolved && resolved.id;
    // Winner's date wins over RT's listing date. Movies show the year
    // only, series the full date (owner decision).
    if (resolved && resolved.date) date = resolved.date;
    if (id && id.startsWith("imdb:")) id = id.slice(5);
    if (id) {
      const shown = t.type === "movie" ? String(date || "").slice(0, 4) || null : date;
      cache[key] = { type: t.type, imdb: id.startsWith("tmdb:") ? null : id, tmdb: id.startsWith("tmdb:") ? id.slice(5) : null, title: row.title, date: shown };
      date = shown;
    }
  }
  if (!id) {
    heldOut.push(`${row.slug} (no majority)`);
    return null;
  }
  // Kind gate (terror class): TMDB sometimes mislinks a series record to
  // an EPISODE imdb_id, and no crew comparison can catch it (the episode
  // shares the season's writer). A proven-wrong kind never ships:
  // episodes for series rows, series/films for movie rows. Unknown or
  // unreachable kind passes through (abstain - never block on missing
  // data). tmdb: fallbacks are TMDB-typed already. No cache write on
  // block, so a later corrected run re-resolves the row.
  if (/^tt[0-9]+$/.test(id || "")) {
    let kind = null;
    if (typeof ctx.gqlFetch === "function") {
      try {
        const g = await ctx.gqlFetch(id, ctx._gqlMemo || (ctx._gqlMemo = {}));
        kind = g && g.kind;
      } catch {
        kind = null;
      }
    }
    if (kind) console.log(`  [kind-ok] ${row.slug}: imdb:${id} is IMDb ${kind}`);
    if (kind && !kindOkFor(t.type, kind)) {
      // Terror fallback: the kind-blocked winner came from a TMDB record
      // whose external_ids mislinks to an episode. Re-derive the numeric
      // via /find (exact imdb_id lookup, type-branched like verifyWinner)
      // and ship the series-typed tmdb: record itself when it is
      // title-anchored (exact titleKeys match - year alone is spoofable
      // by a same-year mislink) and year-anchored (±1, listing/slug
      // convention, no extra detail fetch). Bounded: ≤2 TMDB calls, this
      // path only. Every failure falls through to the holdout below.
      try {
        const f = await tmdbGetFn(`/find/${id}`, { external_source: "imdb_id" });
        const hits = t.type === "movie" ? (f && f.movie_results) || [] : (f && f.tv_results) || [];
        const num = hits.length > 0 ? String(hits[0].id) : null;
        if (num && /^[0-9]+$/.test(num)) {
          const det = await tmdbGetFn(t.type === "movie" ? `/movie/${num}` : `/tv/${num}`);
          const d = t.type === "movie" ? det && det.release_date : det && det.first_air_date;
          const y = (/^([0-9]{4})/.exec(d || "") || [])[1];
          const years = [row.year, slugYearOf(row.slug)].filter(Boolean);
          const names = [det && det.name, det && det.title, det && det.original_name, det && det.original_title]
            .map((n) => normRtTitle(n)).filter(Boolean);
          const titleOk = names.some((n) => titleKeys(row.title).includes(n));
          // Contradiction-block (trespasses class): title+year alone must
          // not ship over proven creator disjointness. Block iff RT
          // creators and the record's created_by are BOTH present and
          // pairwise disjoint, with no author-EP cover (One-Piece class:
          // RT creator EP-ing the record corroborates instead). Either
          // side empty abstains (ship as below); any error abstains.
          // Rare path only: 1 memoized RT fetch + at most 1 credits call.
          let contra = false;
          if (y && years.some((yy) => Math.abs(+y - +yy) <= 1) && titleOk) {
            try {
              const dmem = ctx._detailMemo || (ctx._detailMemo = {});
              if (dmem[row.slug] === undefined) {
                if (typeof ctx.getDetailHtml === "function") {
                  try {
                    dmem[row.slug] = await ctx.getDetailHtml(row.slug);
                  } catch {
                    dmem[row.slug] = null;
                  }
                } else {
                  dmem[row.slug] = null;
                }
              }
              const rtC = dmem[row.slug] ? rtEvidenceFromHtml(dmem[row.slug], row.slug).creators : [];
              const tmC = ((det && det.created_by) || []).map((p) => normRtTitle(p && p.name)).filter(Boolean);
              if (vetoDisjoint(rtC, tmC)) {
                let cover = false;
                try {
                  const cred = await tmdbGetFn(t.type === "movie" ? `/movie/${num}/credits` : `/tv/${num}/credits`);
                  const eps = ((cred && cred.crew) || [])
                    .filter((p) => p && (p.job === "Producer" || p.job === "Executive Producer"))
                    .map((p) => normRtTitle(p.name));
                  cover = rtC.some((a) => eps.some((b) => namesAgreeTranslit(a, b)));
                } catch {
                  cover = false;
                }
                if (!cover) contra = true;
              }
            } catch {
              contra = false;
            }
          }
          if (y && years.some((yy) => Math.abs(+y - +yy) <= 1) && titleOk && !contra) {
            const fb = `tmdb:${num}`;
            if (writtenIds.has(fb)) {
              heldOut.push(`${row.slug} (duplicate of id ${fb})`);
              console.log(`  [dedupe-id] ${row.slug}: ${fb} already written - holding out`);
              return null;
            }
            writtenIds.add(fb);
            const shown = t.type === "movie" ? String(d).slice(0, 4) : d;
            cache[key] = { type: t.type, imdb: null, tmdb: num, title: row.title, date: shown };
            console.log(`  [kind-fallback] ${row.slug}: imdb:${id} is ${kind}, shipping series-typed ${fb} (${d})`);
            return rowToItem(t.type, fb, row, title, shown);
          }
          console.log(`  [kind-fallback-skip] ${row.slug}: tmdb:${num} ${contra ? "creators contradict RT page" : `date ${d || "(none)"} not anchored`}`);
        }
      } catch (e) {
        console.warn(`  [kind-fallback] ${row.slug}: TMDB lookup failed (${e.message}) - holding out`);
      }
      console.log(`  [kind-block] ${row.slug}: imdb:${id} is IMDb ${kind}, not a ${t.type} - holding out`);
      heldOut.push(`${row.slug} (kind mismatch: ${kind})`);
      return null;
    }
  }
  // Same film under two slugs (remake + original sharing a chart,
  // alternate slugs): one meta per id, second occurrence held out.
  if (writtenIds.has(id)) {
    heldOut.push(`${row.slug} (duplicate of id ${id})`);
    console.log(`  [dedupe-id] ${row.slug}: ${id} already written - holding out`);
    return null;
  }
  writtenIds.add(id);
  return rowToItem(t.type, id, row, title, date);
}

export async function main({
  idsArg: rawIds = idsArg,
  action = actionArg,
  deleteIds = deleteIdsArg,
  fetchCfg = fetchConfig,
  tmdbGetFn = tmdbGet,
  write = writeCatalog,
  recordRuns = postRuns,
  loadCacheFn = loadCache,
  saveCacheFn = saveCache,
} = {}) {
  const SANE_ID = /^rt_[a-z0-9]{8}$/;
  if (action === "delete") {
    const ids = String(deleteIds || "").split(",").map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((id) => !SANE_ID.test(id));
    if (bad.length > 0) throw new Error(`refusing to delete non-rt ids: ${bad.join(",")}`);
    const removed = deleteCatalogs(ids);
    console.log(`deleted: ${removed.join(",") || "(none)"}`);
    return { deleted: removed };
  }
  const lists = await fetchCfg();
  if (lists === null) {
    console.error("Aborting: worker config unreachable - refusing to refresh blind.");
    process.exitCode = 1;
    return { refreshed: [] };
  }
  let targets;
  if (rawIds) {
    const wanted = new Set(String(rawIds).split(",").map((s) => s.trim()).filter(Boolean).filter((id) => SANE_ID.test(id)));
    targets = lists.filter((l) => l.enabled && wanted.has(l.id));
    if (targets.length === 0) {
      throw new Error(`No rt lists matched --ids="${rawIds}"`);
    }
  } else {
    targets = lists.filter((l) => l.enabled);
  }
  const cache = loadCacheFn();
  const getHtml = (url) => fetchProxyHtml(url);
  const fetchJson = async (url) => {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`GET ${res.status} for ${url}`);
    return res.json();
  };
  const ctx = {
    tmdbGet: tmdbGetFn,
    fetchJson,
    getDetailHtml: (slug) => getHtml(detailUrlFor(slug)),
    // Keyless IMDb GraphQL (titleType + principalCredits) for the kind
    // gate and the chair. Plain global fetch - proven live from CI-class
    // runners; any failure abstains inside imdbGqlCredits (fail-closed).
    gqlFetch: (tt, memo) => imdbGqlCredits(tt, fetch, memo),
  };
  const runs = [];
  const results = [];
  let consecutiveFailures = 0;
  for (const t of targets) {
    if (consecutiveFailures >= 3) {
      console.error(`Stopping - ${consecutiveFailures} consecutive failed lists (likely blocked); aborting remaining batch.`);
      break;
    }
    const startedAt = Date.now();
    const run = { catalog_id: t.id, started_at: startedAt, status: "failed", triggered_by: process.env.INPUT_ORIGIN === "cron" ? "scheduled" : (process.env.GITHUB_EVENT_NAME === "schedule" ? "scheduled" : "manual") };
    try {
      console.log(`[chart] ${t.url}`);
      const { vanity, filters } = splitBrowseUrl(t.url);
      if (!vanity) throw new Error(`chart ${t.url} is not a /browse/... URL - refusing to fetch blind`);
      const first = parseBrowsePage(await getHtml(t.url));
      const rows = (await paginateChart(t, getHtml, first)).slice(0, t.maxItems || 100);
      if (rows.length === 0) throw new Error(`chart ${t.url} returned no rows - refusing to overwrite`);
      console.log(`[chart] ${rows.length} rows, resolving IDs...`);
      // Per-item hold-out: one unresolvable slug skips with a logged
      // reason instead of killing the whole list. The list aborts only
      // when failures exceed 10% (systemic block, not single-title gaps).
      const heldOut = [];
      const writtenIds = new Set();
      let done = 0;
      const items = (
        await pmap(rows, async (row) => {
          try {
            return await resolveOne(row, t, cache, ctx, tmdbGetFn, writtenIds, heldOut);
          } catch (e) {
            heldOut.push(`${row.slug} (${e.message})`);
            return null;
          } finally {
            done++;
            if (done % 25 === 0 || done === rows.length) console.log(`  [progress] ${done}/${rows.length} rows`);
          }
        })
      ).filter(Boolean);
      if (items.length === 0) throw new Error(`all ${rows.length} rows unresolvable - refusing to overwrite with empty`);
      if (heldOut.length / rows.length > 0.1) {
        throw new Error(`${heldOut.length}/${rows.length} rows unresolvable (>10%) - refusing partial overwrite: ${heldOut.slice(0, 3).join("; ")}`);
      }
      for (const h of heldOut) console.warn(`  [held-out] ${h}`);
      saveCacheFn(cache);
      write(t, items);
      run.status = "success";
      run.finished_at = Date.now();
      run.pages_scraped = 1;
      run.movies_found = items.length;
      results.push({ catalog: run.catalog_id, moviesFound: items.length });
      console.log(`[${run.catalog_id}] ${run.status} - ${items.length} items`);
      consecutiveFailures = 0;
    } catch (e) {
      run.finished_at = Date.now();
      run.pages_scraped = 0;
      run.movies_found = 0;
      run.error_message = e.message;
      results.push({ catalog: run.catalog_id, error: e.message });
      console.error(`[${run.catalog_id}] failed: ${e.message}`);
      consecutiveFailures++;
    }
    runs.push(run);
    // S8 (mirrored from tvstats.mjs): breathe between lists - back-to-back
    // chart + resolve bursts are what trips bot detection.
    await sleep(2500 + Math.random() * 2500);
  }

  await recordRuns(runs);

  console.log("\nSummary:", JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.error);
  if (failed.length && isMain) process.exit(1);
}

// Paginate a chart to maxItems unique rows by following pageInfo cursors
// (cursors chain, so pages fetch sequentially - at ~18KB each this is
// fast). Guards: repeated slugs are skipped (dedupe), an empty page or a
// repeated cursor stops the loop (a stuck "more pages" flag must never
// spin to the workflow timeout). Exported for tests (fetch stubbed).
export async function paginateChart(t, getHtml, first) {
  const { vanity, filters } = splitBrowseUrl(t.url);
  const rows = [];
  const seen = new Set();
  const pushUnique = (r) => {
    if (seen.has(r.slug)) {
      console.log(`  [dedupe] ${r.slug}: repeated, skipping`);
      return;
    }
    seen.add(r.slug);
    rows.push(r);
  };
  for (const r of first.rows) pushUnique(r);
  const seenCursors = new Set();
  let cursor = first.endCursor;
  let hasNext = first.hasNext;
  const want = t.maxItems || 100;
  while (rows.length < want && hasNext && cursor) {
    if (seenCursors.has(cursor)) {
      console.warn(`  [paginate] cursor ${cursor} repeated - stopping`);
      break;
    }
    seenCursors.add(cursor);
    let page = parseCnapi(await getHtml(cnapiUrl(vanity, filters, cursor)));
    if (page.rows.length === 0 && page.hasNext) {
      // Empty yet claims more: transient blip, not list end. One polite
      // retry; a genuine end stays empty and stops below.
      console.warn(`  [paginate] empty page at cursor ${cursor} (hasNext:true) - retrying once...`);
      await sleep(10000);
      try {
        page = parseCnapi(await getHtml(cnapiUrl(vanity, filters, cursor)));
      } catch (e) {
        console.warn(`  [paginate] retry failed (${e.message}) - stopping`);
        break;
      }
    }
    if (page.rows.length === 0) {
      console.warn(`  [paginate] empty page at cursor ${cursor} (hasNext:${page.hasNext}) - stopping`);
      break;
    }
    for (const r of page.rows) pushUnique(r);
    cursor = page.endCursor;
    hasNext = page.hasNext;
  }
  return rows;
}

export const isMain = typeof process !== "undefined" && !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
