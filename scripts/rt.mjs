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
      poster: m.image || null,
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
      poster: it.posterUri || null,
    };
  });
  const info = j.pageInfo || {};
  return { rows, endCursor: info.endCursor || null, hasNext: info.hasNextPage === true };
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

// ── resolution: 2-of-3 majority vote ──

// candidates: ["imdb:tt..", "tmdb:123", null...] from the three sources.
// Majority (>=2) wins; a lone unique candidate is accepted (incl. tmdb-only
// fallback); splits hold out - never guess.
export function voteIds(cands) {
  const votes = new Map();
  for (const c of cands) {
    if (!c) continue;
    votes.set(c, (votes.get(c) || 0) + 1);
  }
  if (votes.size === 0) return null;
  let best = null;
  let bestN = 0;
  for (const [id, n] of votes) {
    if (n > bestN) { best = id; bestN = n; }
  }
  if (bestN >= 2) return best;
  if (votes.size === 1) return best;
  return null;
}

function imdbSuggestSlug(title) {
  return String(title || "").toLowerCase().replace(/ /g, "_").replace(/[^a-z0-9_]/g, "");
}

// One TMDB verdict: { id, weak }. id is "imdb:tt.." | "tmdb:<id>" |
// null. weak is true ONLY for the popularity-fallback pick (no year
// anchor) - such a verdict can never win alone (see resolveRow).
// Exact-norm only; year gate (chart year, +/-1, slug suffix); no-year
// exact with detail tiebreak for collisions.
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
  const agreeYear = (r, y) => {
    if (y === sy) return true;
    const ry = (/^([0-9]{4})/.exec(dateOf(r) || "") || [])[1];
    // Candidate must sit within a year of the SEARCHED year (listing year
    // in the first loop, film year in the detail loop) - never the raw
    // chart year, which is a listing date for catalog rows.
    return !ry || Math.abs(+ry - y) <= 1;
  };
  const tried = new Set();
  for (const y of [...new Set(years)]) {
    tried.add(y);
    const s = await ctx.tmdbGet(endpoint, { query: row.title, [yearParam]: y, include_adult: false, language: "en-US", page: 1 });
    const hit = exactIn(s && s.results).find((r) => agreeYear(r, y));
    if (hit) return { id: await idOfTmdbHit(ctx, type, hit), weak: false };
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
      const hit = exactIn(s && s.results).find((r) => agreeYear(r, y));
      if (hit) return { id: await idOfTmdbHit(ctx, type, hit), weak: false };
    }
  }
  const s = await ctx.tmdbGet(endpoint, { query: row.title, include_adult: false, language: "en-US", page: 1 });
  const exact = exactIn(s && s.results);
  if (exact.length === 1) return { id: await idOfTmdbHit(ctx, type, exact[0]), weak: false };
  if (exact.length > 1) {
    // Genuine collision (remakes): the film year decides, not
    // popularity. Reuses the detail year fetched above when present -
    // one extra fetch, ambiguous rows only.
    let dy = detailYear;
    if (!dy) {
      try {
        dy = detailYearFromHtml(await ctx.getDetailHtml(row.slug));
      } catch (e) {
        console.warn(`  [detail-year] ${row.slug}: detail fetch failed (${e.message})`);
        dy = null;
      }
    }
    if (dy) {
      const byYear = exact.filter((r) => String(dateOf(r) || "").startsWith(String(dy)));
      if (byYear.length > 0) {
        console.log(`  [detail-year] ${row.slug}: ${dy} picks from ${exact.length}`);
        const top = byYear.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
        return { id: await idOfTmdbHit(ctx, type, top), weak: false };
      }
    }
    console.log(`  [ambiguous-pop] ${row.slug}: ${exact.length} exact, taking most popular`);
    const top = exact.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
    return { id: await idOfTmdbHit(ctx, type, top), weak: true };
  }
  return null;
}

async function idOfTmdbHit(ctx, type, hit) {
  const extPath = type === "movie" ? `/movie/${hit.id}/external_ids` : `/tv/${hit.id}/external_ids`;
  const ext = await ctx.tmdbGet(extPath);
  if (ext && ext.imdb_id) return `imdb:${ext.imdb_id}`;
  return `tmdb:${hit.id}`;
}

// One IMDb-suggest verdict: exact-norm + year gate, lowest rank wins.
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
  const pick = (yOk.length > 0 ? yOk : pool).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))[0];
  return pick && pick.id && pick.id.startsWith("tt") ? `imdb:${pick.id}` : null;
}

// One Cinemeta verdict: exact-norm on catalog search names.
export async function cinemetaVerdict(row, type, fetchJson) {
  const nt = normRtTitle(row.title);
  const kind = type === "movie" ? "movie" : "series";
  const url = `https://v3-cinemeta.strem.io/catalog/${kind}/imdb/search=${encodeURIComponent(row.title)}.json`;
  const d = await fetchJson(url);
  const hit = ((d && d.metas) || []).find((m) => normRtTitle(m.name) === nt);
  return hit && hit.id ? `imdb:${hit.id}` : null;
}

// Full per-row resolution. Returns "imdb:tt.." | "tmdb:<id>" (never
// throws - callers hold out on null). Rules: 2-of-3 majority wins; a
// weak (popularity-fallback) TMDB verdict needs one corroboration and
// can never win alone; a total split falls back to IMDb's exact match
// (canonical namespace, deepest title variants); else holdout.
export async function resolveRow(row, type, ctx) {
  const tw = await tmdbVerdict(row, type, ctx).catch((e) => {
    console.warn(`  [tmdb] ${row.slug}: ${e.message}`);
    return null;
  });
  const [sug, cin] = await Promise.all([
    suggestVerdict(row, type, ctx.fetchJson).catch(() => null),
    cinemetaVerdict(row, type, ctx.fetchJson).catch(() => null),
  ]);
  const cands = [tw && tw.id, sug, cin];
  const won = voteIds(cands);
  if (won) {
    if (tw && won === tw.id && tw.weak && cands.filter((v) => v === won).length < 2) {
      console.log(`  [weak-lone] ${row.slug}: popularity pick ${won} uncorroborated - holding out`);
      return null;
    }
    console.log(`  [vote] ${row.slug}: tmdb=${tw && tw.id} sug=${sug} cine=${cin} -> ${won}`);
    return won;
  }
  if (sug) {
    console.log(`  [imdb-arbiter] ${row.slug}: total split, IMDb exact ${sug} wins`);
    return sug;
  }
  console.log(`  [holdout] ${row.slug}: tmdb=${tw && tw.id} sug=${sug} cine=${cin}`);
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
    id = await resolveRow(row, t.type, ctx);
    if (id && id.startsWith("imdb:")) id = id.slice(5);
    if (id) cache[key] = { type: t.type, imdb: id.startsWith("tmdb:") ? null : id, tmdb: id.startsWith("tmdb:") ? id.slice(5) : null, title: row.title, date };
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
    const page = parseCnapi(await getHtml(cnapiUrl(vanity, filters, cursor)));
    if (page.rows.length === 0) {
      console.warn(`  [paginate] empty page at cursor ${cursor} - stopping`);
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
