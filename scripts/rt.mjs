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
// punctuation/whitespace collapsed. No fuzzy/contains - exact only.
export function normRtTitle(s) {
  let x = String(s || "").toLowerCase().trim();
  x = x.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  x = x.replace(/&/g, " and ");
  // Roman numerals II-IV fold to digits (sources disagree: "II" vs "2").
  // Single V/VI deliberately NOT folded: "V" is also a letter (V/H/S),
  // and folding it manufactures collisions; II-IV have no such dual use.
  x = x.replace(/\bii\b/g, "2").replace(/\biii\b/g, "3").replace(/\biv\b/g, "4");
  x = x.replace(/[^a-z0-9 ]/g, "");
  return x.replace(/\s+/g, " ").trim();
}

// Trailing _YYYY disambiguation suffix on RT slugs (/m/dune_2024): a
// strong year hint the chart year can't give (listing vs film year).
export function slugYearOf(slug) {
  const m = /_([0-9]{4})$/.exec(String(slug || ""));
  return m ? +m[1] : null;
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
  return String(title || "").toLowerCase().replace(/ /g, "_").replace(/[^a-z0-9_]/g, "");
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
  const exactIn = (results) => (results || []).filter((r) => normRtTitle(nameOf(r)) === nt || (origOf(r) && normRtTitle(origOf(r)) === nt));
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
  // film/premiere year - search with it before going year-blind. Bounded:
  // one extra fetch, drift rows only.
  let detailYear = null;
  try {
    detailYear = detailYearFromHtml(await ctx.getDetailHtml(row.slug));
  } catch {
    detailYear = null; // fall through to no-year below
  }
  if (detailYear) {
    for (const y of [detailYear, detailYear - 1, detailYear + 1]) {
      if (!y || tried.has(y)) continue;
      tried.add(y);
      console.log(`  [detail-search] ${row.slug}: listing year failed, trying film year ${y}`);
      const s = await ctx.tmdbGet(endpoint, { query: row.title, [yearParam]: y, include_adult: false, language: "en-US", page: 1 });
      const hits = exactIn(s && s.results).filter((r) => agreeDetail(r, y));
      if (hits.length === 1) return await idOfTmdbHit(ctx, type, hits[0], false);
      if (hits.length > 1) break;
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
    // Evidence rung: score every remaining candidate on RT detail year
    // + director/crew + top-5 cast. Unique max wins strong; ties fall
    // through to popularity (weak). One detail fetch served year + crew.
    const rtEv = {
      year: dy,
      dirs: [],
      creators: [],
      prods: [],
      cast: dHtml ? rtCastFromHtml(dHtml) : [],
    };
    if (dHtml) {
      const card = rtCrewFromHtml(dHtml);
      const normSet = (arr) => [...new Set((arr || []).map(normRtTitle).filter(Boolean))];
      rtEv.dirs = normSet(card["Director"]);
      rtEv.creators = normSet(card["Creator"]);
      rtEv.prods = normSet([...(card["Executive Producer"] || []), ...(card["Producer"] || [])]);
    }
    let evBest = null;
    let evBestScore = -1;
    let evTied = false;
    for (const r of pool) {
      const candEv = await tmdbEvidenceFor(type, r.id, ctx);
      if (!candEv.date) {
        const dd = (type === "movie" ? r.release_date : r.first_air_date) || null;
        if (dd) candEv.date = dd;
      }
      const sc = evidenceScore({ ...rtEv, year: rtEv.year }, candEv);
      if (sc.total > evBestScore) { evBest = r; evBestScore = sc.total; evTied = false; }
      else if (sc.total === evBestScore) { evTied = true; }
    }
    if (evBest && !evTied) {
      console.log(`  [evidence] ${row.slug}: TMDB ${evBest.id} wins (${evBestScore}) from ${pool.length}`);
      return await idOfTmdbHit(ctx, type, evBest, false);
    }
    // Popularity over the YEAR-NARROWED pool (not the full exact list -
    // picking outside the matching year would defeat the narrowing above).
    console.log(`  [ambiguous-pop] ${row.slug}: ${pool.length} in-year, taking most popular`);
    const top = pool.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
    return await idOfTmdbHit(ctx, type, top, true);
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
export async function suggestVerdict(row, type, fetchJson) {
  const nt = normRtTitle(row.title);
  const url = `https://v3.sg.media-imdb.com/suggestion/x/${imdbSuggestSlug(row.title)}.json`;
  const d = await fetchJson(url);
  const cands = ((d && d.d) || []).filter((c) => normRtTitle(c.l) === nt);
  if (cands.length === 0) return null;
  const wantQid = type === "movie" ? ["movie", "tvMovie", "video"] : ["tvSeries", "tvMiniSeries"];
  const typed = cands.filter((c) => wantQid.includes(c.qid));
  const pool = typed.length > 0 ? typed : cands;
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
  const nt = normRtTitle(row.title);
  const kind = type === "movie" ? "movie" : "series";
  const url = `https://v3-cinemeta.strem.io/catalog/${kind}/imdb/search=${encodeURIComponent(row.title)}.json`;
  const d = await fetchJson(url);
  const hit = ((d && d.metas) || []).find((m) => normRtTitle(m.name) === nt);
  if (!hit || !hit.id) return null;
  const rel = String(hit.releaseInfo || hit.year || "");
  const dm = rel.match(/([0-9]{4})(?:-([0-9]{2})-([0-9]{2}))?/);
  return { id: `imdb:${hit.id}`, weak: true, date: dm ? dm[0] : null };
}

// RT detail crew card: generic label -> names parse over the Series/Movie
// Info section ({Creator, Director, Executive Producer, Producer}).
// Pages differ (Monster has Creator, Matlock only EPs, some have
// Director) so every present label is collected - never one hardcoded
// field. Multiline-aware: section HTML spans lines ([\s\S], never dot).
// Merges the JSON-LD director form above. Returns { label: [names] }.
export function rtCrewFromHtml(html) {
  const h = String(html || "");
  const out = {};
  const add = (label, name) => {
    const n = String(name || "").trim();
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
    if (label !== "Creator" && label !== "Director" && label !== "Executive Producer" && label !== "Producer") continue;
    const nm = /data-qa="item-value">([^<]+)</g;
    let n;
    while ((n = nm.exec(m[2])) !== null) add(label, n[1]);
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

// Person-name agreement for decisive roles: exact normalized match, or
// same last name + same first initial (stage names and nicknames:
// "Oz Perkins" vs "Osgood Perkins", "Bob Smith" vs "Robert Smith").
// Single-token names must match exactly (no initials to compare).
// Distinct first names never agree ("John Smith" vs "Anna Smith").
export function namesAgree(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = String(a).split(" ").filter(Boolean);
  const pb = String(b).split(" ").filter(Boolean);
  if (pa.length < 2 || pb.length < 2) return false;
  return pa[pa.length - 1] === pb[pb.length - 1] && pa[0][0] === pb[0][0];
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
export function rtEvidenceFromHtml(html) {
  const h = String(html || "");
  const dy = detailYearFromHtml(h);
  const card = rtCrewFromHtml(h);
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
  if (rtP.length > 0 && tmP.length > 0 && rtP.some((n) => tmP.includes(n))) p = 2;
  let c = 0;
  for (const n of ((candEv && candEv.cast) || [])) {
    if (n && ((rtEv && rtEv.cast) || []).includes(n)) c++;
  }
  if (c > 3) c = 3;
  return { total: y + d + p + c, parts: { y, d, p, c } };
}

// RT detail director (JSON-LD Person array or plain string form).
// Null when the page carries none (most series rows - use rtCrewFromHtml
// for the full card instead).
export function directorFromHtml(html) {
  const h = String(html || "");
  let m = /"director":\[\{"@type":"Person","name":"([^"]+)"/.exec(h);
  if (m) return m[1];
  m = /"director":"([^"]+)"/.exec(h);
  return m ? m[1] : null;
}

// Cinemeta evidence for one imdb id: director (+writer as creators on
// series only - series writers ARE the creators, verified 5/5; movie
// writers are excluded, director alone decides). Empty on failure.
async function cineEvidenceFor(type, ctx, ttId) {
  const out = { date: null, dirs: [], creators: [], prods: [], cast: [] };
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
    const rel = String(m.released || m.year || m.releaseInfo || "");
    const dm = rel.match(/([0-9]{4})(?:-([0-9]{2})-([0-9]{2}))?/);
    out.date = dm ? dm[0] : null;
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
  const card = rtCrewFromHtml(dHtml);
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
          const nm = a && a.name ? normRtTitle(a.name) : "";
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
  if (d.failed || !d.v) return { ok: true, reason: "fetch-failed" };
  const rtEv = rtEvidenceFromHtml(d.v);
  const rtDC = [...rtEv.dirs, ...rtEv.creators];
  const rtHasDecisive = rtDC.length > 0;
  const rtHasAny = rtHasDecisive || rtEv.prods.length > 0;
  if (!rtHasAny) {
    console.log(`  [verify-skip] ${row.slug}: no RT crew to compare`);
    return { ok: true, reason: "no-rt-crew" };
  }
  // Resolve winner to its TMDB record (direct numeric, or /find by imdb).
  let num = null;
  if (won.startsWith("tmdb:")) {
    num = won.slice(5);
  } else {
    const f = await tryTwice(() => ctx.tmdbGet(`/find/${won.slice(5)}`, { external_source: "imdb_id" }), row, "find");
    if (f.failed || !f.v) return { ok: true, reason: "fetch-failed" };
    const hits = type === "movie" ? (f.v.movie_results || []) : (f.v.tv_results || []);
    if (hits.length > 0) num = String(hits[0].id);
  }
  if (!num || !/^[0-9]+$/.test(num)) return { ok: true, reason: "fetch-failed" };
  const candEv = await tmdbEvidenceFor(type, num, ctx);
  const tmDC = [...candEv.dirs, ...candEv.creators];
  if (tmDC.length === 0) {
    console.log(`  [verify-skip] ${row.slug}: no TMDB crew to compare`);
    return { ok: true, reason: "no-tmdb-crew" };
  }
  if (!rtHasDecisive) {
    // Producer-level overlap only: corroboration, never a veto - but the
    // check ran clean, so record the pass explicitly.
    console.log(`  [verify-ok] ${row.slug}: ${won} crew matches RT page`);
    return { ok: true, reason: "crew-match" };
  }
  if (rtDC.some((a) => tmDC.some((b) => namesAgree(a, b)))) {
    console.log(`  [verify-ok] ${row.slug}: ${won} crew matches RT page`);
    return { ok: true, reason: "crew-match" };
  }
  console.log(`  [verify-veto] ${row.slug}: ${won} crew contradicts RT page - re-scoring`);
  return { ok: false, reason: "contradiction" };
}
// Full-evidence rescore after a verification veto: every same-name TMDB
// candidate scored on RT detail year + director/crew + top-5 cast
// overlap. Returns { id, date } for the best non-vetoed candidate, else
// null (the veto stands - holdout). Bounded: rare path only.
export async function evidenceRescore(row, type, ctx, vetoedId) {
  let html = null;
  try {
    html = await ctx.getDetailHtml(row.slug);
  } catch {
    return null;
  }
  const rtEv = rtEvidenceFromHtml(html);
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
  const exact = results.filter((r) => normRtTitle(nameOf(r)) === nt || (origOf(r) && normRtTitle(origOf(r)) === nt));
  let best = null;
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
    if (!best || sc.total > best.total) best = { id, date: candEv.date, total: sc.total };
  }
  if (best) {
    console.log(`  [rescore] ${row.slug}: ${best.id} wins evidence (${best.total}) after veto`);
    return best;
  }
  return null;
}

// Full per-row resolution. Returns { id, date } (never throws - callers
// hold out on null). Acceptance: any strong backing, or >=2 weak
// backers agreeing, or a tmdb-only fallback, or a lone Cinemeta exact
// (proven gap-filler); popularity picks (TMDB-pop, suggest-pool) need a
// friend. Accepted winners pass verification (crew cross-check, vetoes
// RT-contradictions into a full evidence rescore). Then director,
// IMDb arbiter, holdout. Date is the WINNER's date (TMDB full date
// preferred) - never RT's listing date.
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
      const rescored = await evidenceRescore(row, type, ctx, won).catch(() => null);
      if (rescored) return { id: rescored.id, date: rescored.date };
      console.log(`  [holdout] ${row.slug}: vetoed ${won}, rescore failed`);
      return null;
    }
    console.log(`  [weak-lone] ${row.slug}: popularity pick ${won} uncorroborated - holding out`);
    return null;
  }
  // No winner: director match decides first (rare rows only), then
  // the IMDb exact arbiter (itself verified - all voted results get
  // checked), else holdout.
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
