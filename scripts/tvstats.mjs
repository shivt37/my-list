#!/usr/bin/env node
/**
 * my-list Television Stats - runs on GitHub Actions, fetches
 * televisionstats.com Attention charts for the operator's enabled lists,
 * resolves per-title IMDb IDs through the ladder in tvstats-ladder.mjs,
 * writes data/tvstats_<id>.json (served via GitHub Pages), and POSTs run
 * records to the worker's /runs endpoint.
 *
 * Page fetching goes through the worker's /ts-fetch proxy (TS_FETCH_BASE):
 * the worker's Cloudflare egress is unchallenged where datacenter IPs are
 * not, so no browser machinery is needed anywhere in this script.
 *
 * Identity cache: data/ts_cache.json maps slug -> v2 entry
 * {kind, imdb, tmdb, title, date, poster, rung, confidence, v:2}. A v1 entry
 * (no `v` key) is migrated on read and treated as MEDIUM. A title's identity
 * never changes, so each slug resolves once ever; steady-state runs only
 * fetch new slugs - a cache hit costs ZERO http calls.
 *
 * Publication: only HIGH and MEDIUM confidence rows are published
 * (TVSTATS_PUBLISH_MIN=high|medium, default medium). LOW and NONE are held
 * out, counted against the 10% hold-out threshold, and never cached - a
 * wrong id in the cache would be served forever.
 *
 * Unlike official.mjs, an EMPTY chart is a failure (these charts always
 * carry rows) and never overwrites the previous file.
 *
 * Required env (GitHub repo secrets / workflow env):
 *   TMDB_READ_ACCESS_TOKEN - TMDB API bearer
 *   WORKER_ORIGIN           - worker base URL (run records + config)
 *   TS_FETCH_BASE           - worker base URL (the /ts-fetch page proxy)
 *
 * Optional env:
 *   TVSTATS_PUBLISH_MIN=high|medium   fail closed (default medium)
 *   TVSTATS_AUDIT=tv|juicewatch|off   the optional second source (default off)
 *
 * Usage:
 *   node tvstats.mjs                        # refresh all enabled lists
 *   node tvstats.mjs --ids=tvstats_ab12cd34 # refresh listed ids only
 *   node tvstats.mjs --action=delete --delete_ids=tvstats_ab12cd34
 */

import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  CONF,
  CONF_RANK,
  TITLE_GATE,
  TT_RE,
  MOVIE_TYPES,
  SHOW_TYPES,
  auditRow,
  buildOfflineIndex,
  cacheKey,
  cacheHitValid,
  canonImdbType,
  CACHE_VERSION,
  confRank,
  detailUrl,
  imdbGqlTitles,
  imdbSuggest,
  kindOk,
  loadJustWatchSnapshot,
  makePacer,
  migrateCacheEntry,
  normTitle,
  normTitleKeepArticle,
  pageProps,
  posterKey,
  probeHost,
  resolveRow,
  resolveMovie as ladderResolveMovie,
  resolveShow as ladderResolveShow,
  rowCacheKey,
  titleScore,
  titleTokens,
  tmdbPosterSet,
  yearOf,
} from "./tvstats-ladder.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const DATA_DIR = join(ROOT, "data");
export const CACHE_FILE = join(DATA_DIR, "ts_cache.json");

const WORKER_ORIGIN = process.env.WORKER_ORIGIN;

// The publish threshold and the optional audit are operator knobs.
export const PUBLISH_MIN = String(process.env.TVSTATS_PUBLISH_MIN || "medium").toLowerCase() === "high"
  ? "high"
  : "medium";
export const AUDIT_MODE = ["tv", "juicewatch", "off"].includes(String(process.env.TVSTATS_AUDIT || "").toLowerCase())
  ? String(process.env.TVSTATS_AUDIT || "off").toLowerCase()
  : "off";

// The run log. By default only the rows that need a note are printed (the
// clean rows are silent); TVSTATS_LOG=full prints one line per resolved row.
// A row that cost far more than usual is flagged - those are the rows where
// several same-name candidates had to be checked.
export const LOG_FULL = String(process.env.TVSTATS_LOG || "").toLowerCase() === "full";
export const SLOW_ROW = Math.max(1, Number(process.env.TVSTATS_SLOW_ROWS || 12));
// Read at call time, so TVSTATS_LOG can be flipped without re-importing.
export const isFullLog = () => String(process.env.TVSTATS_LOG || "").toLowerCase() === "full";

// ── page fetching: worker proxy only ──
// All chart/detail HTML flows through GET <TS_FETCH_BASE>/ts-fetch?url=.
// The worker's Cloudflare egress is unchallenged where datacenter IPs are
// not, so no browser machinery is needed anywhere in this script.

export async function fetchProxyHtml(url, base = process.env.TS_FETCH_BASE, ctx = null) {
  if (!base) throw new Error("TS_FETCH_BASE is not set - point it at the worker origin.");
  const endpoint = `${String(base).replace(/\/+$/, "")}/ts-fetch?url=${encodeURIComponent(url)}`;
  // Retry transient upstream blips (502/503/429/504): one hiccup across
  // ~200 fetches must not fail a run. Anything else fails loud.
  // Bounded: 3 attempts, a 25 s wall-clock cap, a backoff capped at 2 s.
  const deadline = Date.now() + 25000;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (Date.now() > deadline) throw lastError || new Error(`proxy fetch timed out for ${url}`);
    try {
      if (ctx && ctx.counts) ctx.counts.attempted++;
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`proxy fetch ${res.status} for ${url}`);
      return res.text();
    } catch (e) {
      lastError = e;
      // Fail fast on client errors (4xx except 429/408: a 404 bad slug or
      // 403 block will never heal on retry). Everything else - 5xx,
      // connection resets, timeouts - gets two more attempts.
      const m = /proxy fetch (\d+)/.exec(String((e && e.message) || e));
      const fatal = m && +m[1] < 500 && +m[1] !== 429 && +m[1] !== 408;
      if (fatal || attempt === 3) throw e;
      console.warn(`  [retry] ${url} attempt ${attempt}: ${e.message}`);
      await sleep(Math.min(2000, 2000 * attempt));
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

// ── atomic write ──
// A temp file + renameSync: a crashed run never leaves a half-written file.
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}

// ── TMDB ──
// The pacer: 3 requests/second = 30 requests per 10 s, the same rate the
// sibling pipeline (rt.mjs) uses. TMDB publishes 40/10 s.
//
// A RESERVATION pacer, not the old read-then-set one. The old pacer read
// `lastTmdbAt`, slept, and only THEN wrote it: with N concurrent workers
// all N read the same timestamp, all N slept the same gap and all N fired
// together (measured: ~14 req/s against TMDB's published 4 req/s). Here the
// slot is RESERVED before the wait, so N concurrent callers get N different
// slots (D2).
export const TMDB_MIN_GAP_MS = 340;
export const tmdbPace = makePacer(TMDB_MIN_GAP_MS);

export async function tmdbGet(path, params = {}, fetchFn = fetch, ctx = null) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN; // lazy: tests can set it per call
  if (!token) throw new Error("TMDB_READ_ACCESS_TOKEN is not set - cannot resolve IDs.");
  const url = `https://api.themoviedb.org/3${path}?${new URLSearchParams(params)}`;
  // Bounded: 4 attempts, a 25 s wall-clock cap, a backoff capped at 2 s and
  // exponential on 429 (never a 60 s sleep per row).
  const deadline = Date.now() + 25000;
  let last = "unknown";
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (Date.now() > deadline) throw new Error(`TMDB ${path} -> wall-clock cap (${last})`);
    await tmdbPace();
    let res;
    try {
      if (ctx && ctx.counts) ctx.counts.attempted++;
      res = await fetchFn(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      last = String((e && e.message) || e).slice(0, 140);
      if (attempt === 4 || Date.now() > deadline) throw new Error(`TMDB ${path} -> ${last}`);
      await sleep(Math.min(2000, 500 * attempt));
      continue;
    }
    if (res.status === 429) {
      last = "HTTP 429";
      if (attempt === 4) throw new Error(`TMDB ${path} -> repeated 429`);
      await sleep(Math.min(2000, 500 * Math.pow(2, attempt - 1)));
      continue;
    }
    if (!res.ok) throw new Error(`TMDB ${path} -> HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`TMDB ${path} -> ${last}`);
}

// ── parsing ──

export { pageProps, normTitle, normTitleKeepArticle, titleScore, titleTokens, kindOk, canonImdbType, confRank, posterKey, yearOf, detailUrl, buildOfflineIndex, cacheKey, cacheHitValid, rowCacheKey, migrateCacheEntry, loadJustWatchSnapshot, probeHost, imdbSuggest, imdbGqlTitles, tmdbPosterSet, TT_RE, MOVIE_TYPES, SHOW_TYPES, CONF, CONF_RANK, TITLE_GATE };

/**
 * Chart rows in rank order: { slug, title, poster, date }.
 * Movies and shows share the envelope ({movies|shows: [{movie|show, value}]})
 * with differently-named inner fields - normalized here.
 *
 * A SHOW chart row carries `last_air_date`, NOT `first_air_date`: the show
 * premiere year comes from the show DETAIL page (the ladder reads it there).
 */
export function chartRows(kind, html) {
  const pp = pageProps(html);
  const rows = kind === "movie" ? pp.movies || [] : pp.shows || [];
  return rows.map((r) => {
    const it = kind === "movie" ? r.movie : r.show;
    if (!it || !it.slug) throw new Error("chart row without slug");
    return {
      slug: it.slug,
      // TV Stats' STABLE per-title id (present on 200/200 chart rows of both
      // kinds). The identity cache is keyed on it: a slug can be reused for a
      // different work, a stable id cannot.
      stableId: it.id || null,
      title: (kind === "movie" ? it.title : it.name) || "",
      poster: kind === "movie" ? it.poster_path || null : it.poster_image || it.poster_path || null,
      date: (kind === "movie" ? it.release_date : it.first_air_date) || null,
    };
  });
}

/** The title gate: exact after the shared normalisation. */
export function titlesMatch(a, b) {
  return titleScore(a, b) >= TITLE_GATE;
}

// ── cache (schema v2) ──

/**
 * Load the identity cache. A v1 entry (no `v` key) is migrated to the v2
 * schema on read and treated as MEDIUM - it is published under the default
 * threshold but it is never promoted to the fingerprint tier.
 * A corrupt cache heals to {} and never crashes a run.
 */
export function loadCache(read = null) {
  try {
    const raw = read ? read() : existsSync(CACHE_FILE) ? readFileSync(CACHE_FILE, "utf8") : null;
    if (!raw) return {};
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(d)) {
      const m = migrateCacheEntry(v);
      if (m) out[k] = m;
    }
    return out;
  } catch {
    return {}; // corrupt cache re-resolves naturally, never crashes a run
  }
}

export function saveCache(cache, write = null) {
  const body = JSON.stringify(cache, null, 2) + "\n";
  if (write) write(body);
  else {
    mkdirSync(DATA_DIR, { recursive: true });
    writeAtomic(CACHE_FILE, body);
  }
}

// ── resolution (the ladder) ──

/**
 * Movies: the ladder. TS no longer ships `imdb_id` on its movie pages, so
 * the id comes from the poster fingerprint / TMDB / IMDb suggestion legs.
 * The name and the argument shape are unchanged.
 */
export async function resolveMovie(row, getHtml, tmdbGetFn = null, ctx = null) {
  return ladderResolveMovie(row, getHtml, tmdbGetFn, ctx);
}

/**
 * Shows: the ladder. The show detail page carries first_air_date (the chart
 * row does not), so the year leg has a real input.
 */
export async function resolveShow(row, getHtml, tmdbGetFn = null, ctx = null) {
  return ladderResolveShow(row, getHtml, tmdbGetFn, ctx);
}

/**
 * The published item. The name and the releaseInfo come from the TV Stats
 * row (the chart row, refined by the TS detail page) - never from the
 * candidate (V5). The id is the IMDb id, or `tmdb:<id>` when TMDB has no
 * IMDb id for the record.
 *
 * D6: a LOW (or NONE) row must never mint an id. The exported resolve
 * functions no longer hand back a LOW id, but this is the last line of
 * defence: a bad call fails loudly instead of publishing a guess.
 */
export function rowToItem(kind, resolved, row) {
  const conf = String((resolved && resolved.confidence) || "").toUpperCase();
  if (conf === "LOW" || conf === "NONE") {
    throw new Error(
      `refusing to mint an id from a ${conf} row (${row.slug}): ${(resolved && resolved.reason) || "no confidence"}`
    );
  }
  const id = resolved.imdb || (resolved.tmdb ? `tmdb:${resolved.tmdb}` : null);
  if (!id) throw new Error(`unresolvable slug ${row.slug}`);
  return {
    id,
    type: kind === "movie" ? "movie" : "series",
    name: row.title || resolved.title,
    poster: row.poster ? `https://image.tmdb.org/t/p/w500${row.poster}` : "https://simkl.in/poster_no_pic_c.png",
    releaseInfo: row.date || resolved.date || undefined,
  };
}

// Bounded parallel map: 5-way concurrency keeps TS fetches polite and
// TMDB calls an order of magnitude under its rate limit.
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

// ── worker config (fail-closed like simkl.mjs F6) ──

export async function fetchConfig(fetchFn = fetch) {
  if (!WORKER_ORIGIN) return null;
  try {
    const res = await fetchFn(`${WORKER_ORIGIN}/export-config`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const cfg = await res.json();
    return Array.isArray(cfg?.tvstats?.lists) ? cfg.tvstats.lists.filter((l) => l && l.id && l.url) : null;
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
    type: list.kind === "movie" ? "movie" : "series",
    scraped_at: Date.now(),
    items,
  };
  writeAtomic(file, JSON.stringify(out, null, 2) + "\n");
  return file;
}

export async function postRuns(runs, fetchFn = fetch) {
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
          signal: AbortSignal.timeout(20000),
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
  publishMin = PUBLISH_MIN,
  audit = AUDIT_MODE,
  doProbes = true,
  useSuggestion: useSuggestionProp = null,
  useGql: useGqlProp = null,
  imdbGqlTitlesFn: gqlTitlesFnProp = null,
  buildIndex = buildOfflineIndex,
} = {}) {
  const SANE_ID = /^tvstats_[a-z0-9]{8}$/;
  if (action === "delete") {
    const ids = String(deleteIds || "").split(",").map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((id) => !SANE_ID.test(id));
    if (bad.length > 0) throw new Error(`refusing to delete non-tvstats ids: ${bad.join(",")}`);
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
      throw new Error(`No tvstats lists matched --ids="${rawIds}"`);
    }
  } else {
    targets = lists.filter((l) => l.enabled);
  }

  const cacheMap = new Map(Object.entries(loadCacheFn() || {}));
  const runCounts = { logical: 0, attempted: 0 };

  // ── the egress probes ──
  // ONE cheap call to each optional host. A dead optional host must never
  // fail the run: its rung is disabled for the run and logged.
  const probeCtx = { counts: { logical: 0, attempted: 0 } };
  let useSuggestion = useSuggestionProp !== null;
  let useGql = useGqlProp !== null;
  let auditMode = audit;
  if (doProbes) {
    if (useSuggestionProp === null) {
      useSuggestion = await probeHost("https://v3.sg.media-imdb.com/suggestion/x/probe.json", probeCtx);
      if (!useSuggestion) console.warn("[probe] the IMDb suggestion API is unreachable - the suggestion rung is off for this run");
    }
    if (useGqlProp === null) {
      useGql = await probeHost("https://api.graphql.imdb.com/", probeCtx, {
        method: "POST",
        body: JSON.stringify({ query: "{__typename}" }),
        headers: { "Content-Type": "application/json", Origin: "https://www.imdb.com", Referer: "https://www.imdb.com/" },
      });
      if (!useGql) console.warn("[probe] the IMDb GraphQL is unreachable - the suggestion rung uses the suggestion labels only");
    }
    if (auditMode === "tv") {
      const ok = await probeHost("https://api.tvmaze.com/shows/1", probeCtx);
      if (!ok) {
        console.warn("[probe] TVmaze is unreachable - the audit is off for this run");
        auditMode = "off";
      }
    }
  }
  runCounts.logical += probeCtx.counts.logical;
  runCounts.attempted += probeCtx.counts.attempted;

  // ── the offline join index ──
  // The index only holds TMDB records (a numeric id + a poster_path), so it
  // is never the audit's source (V1) and never the legacy cache (V2). The
  // JustWatch snapshot is excluded by name as well, for belt and braces.
  const index = buildIndex(DATA_DIR, {
    excludePrefixes: auditMode === "juicewatch" ? ["mdboff_justwatch"] : [],
  });

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
      const listCtx = { counts: { logical: 0, attempted: 0 } };
      const rows = chartRows(t.kind, await fetchProxyHtml(t.url, undefined, listCtx)).slice(0, t.maxItems || 100);
      if (rows.length === 0) throw new Error(`chart ${t.url} returned no rows - refusing to overwrite`);
      // How much the offline join can do for THIS chart. The index size on
      // its own is a near-constant; what matters is how many of these rows
      // it can already answer without a search call.
      const indexHits = rows.filter((r) => posterKey(r.poster) && index.has(posterKey(r.poster))).length;
      console.log(`[index] the offline join can serve ${indexHits} of these ${rows.length} rows`);
      console.log(`[chart] ${rows.length} rows, resolving IDs...`);
      // Per-item hold-out: one unresolvable slug skips with a logged
      // reason instead of killing the whole list. The list aborts only
      // when failures exceed 10% (systemic block, not single-title gaps).
      const heldOut = [];
      const rowCtxs = new Array(rows.length);
      const rowOut = new Array(rows.length);
      const listKind = t.kind === "movie" ? "movie" : "show";
      let done = 0;
      const items = (
        await pmap(rows, async (row, i) => {
          // A heartbeat, so a long run never looks frozen (rt.mjs does the
          // same every 25 rows).
          if (++done % 25 === 0) console.log(`[progress] ${done}/${rows.length} rows`);
          const rowCtx = {
            counts: { logical: 0, attempted: 0 },
            cache: cacheMap,
            index,
            publishMin,
            useSuggestion,
            useGql,
            imdbGqlTitlesFn: gqlTitlesFnProp,
            audit: auditMode,
            dataDir: DATA_DIR,
            getHtml: (url) => fetchProxyHtml(url, undefined, rowCtx),
            tmdbGetFn: (path, params) => tmdbGetFn(path, params, fetch, rowCtx),
          };
          rowCtxs[i] = rowCtx;
          try {
            const resolved = await resolveRow({ ...row, kind: listKind }, rowCtx);
            rowOut[i] = { resolved };
            // V7: the optional audit can BLOCK. A disagreement holds the row
            // out instead of publishing it.
            if (auditMode !== "off" && resolved.imdb && resolved.confidence !== CONF.NONE) {
              const a = await auditRow(resolved, rowCtx);
              if (a.verdict === "disagree") {
                heldOut.push(`${row.slug} (the ${a.source} audit disagrees: ${a.detail})`);
                rowOut[i] = { resolved, held: true };
                return null;
              }
            }
            if (confRank(resolved.confidence) < confRank(publishMin)) {
              heldOut.push(`${row.slug} (${resolved.confidence}: ${resolved.reason})`);
              rowOut[i] = { resolved, held: true };
              // A row that is unresolvable for a structural reason (no
              // candidate, ambiguous, no IMDb id) is remembered as a MISS so
              // it stops costing requests on every run. A transient failure
              // is NOT remembered - it must be retried.
              if (resolved.negativeCacheable) {
                cacheMap.set(rowCacheKey(listKind, row), {
                  kind: t.kind,
                  miss: true,
                  at: Date.now(),
                  reason: resolved.reason,
                  holdNote: resolved.holdNote || null,
                  stableId: row.stableId || null,
                  v: CACHE_VERSION,
                });
              }
              return null;
            }
            // Only a publishable row is cached: a wrong id in the cache
            // would be served forever (D1).
            cacheMap.set(rowCacheKey(listKind, row), {
              kind: t.kind,
              imdb: resolved.imdb || null,
              tmdb: resolved.tmdb || null,
              title: resolved.title || null,
              date: resolved.date || null,
              poster: resolved.poster || null,
              stableId: row.stableId || null,
              rung: resolved.rung,
              confidence: resolved.confidence,
              v: CACHE_VERSION,
            });
            const item = rowToItem(t.kind, resolved, row);
            rowOut[i] = { resolved, item };
            return item;
          } catch (e) {
            heldOut.push(`${row.slug} (${e.message})`);
            rowOut[i] = { error: e.message };
            return null;
          }
        })
      ).filter(Boolean);
      const listCounts = { logical: listCtx.counts.logical, attempted: listCtx.counts.attempted };
      for (const c of rowCtxs) {
        if (!c) continue;
        listCounts.logical += c.counts.logical;
        listCounts.attempted += c.counts.attempted;
      }
      runCounts.logical += listCounts.logical;
      runCounts.attempted += listCounts.attempted;
      // ---- the run log: what happened, in chart order. A row's request
      // cost belongs in the summary, not on 200 lines that all say the same
      // thing; the per-row line carries the id and what it took.
      for (let i = 0; i < rows.length; i++) {
        const o = rowOut[i];
        const c = rowCtxs[i];
        if (!o) continue;
        if (o.error) {
          console.log(`[holdout] ${rows[i].slug}: ${o.error}`);
          continue;
        }
        const r = o.resolved || {};
        if (o.held || !o.item) {
          console.log(`[holdout] ${rows[i].slug}: ${r.holdNote || (r.reason || "not published").slice(0, 120)}`);
          continue;
        }
        if (isFullLog() || r.note) {
          const year = String(r.date || o.item.releaseInfo || "").slice(0, 4);
          console.log(`[id] ${rows[i].slug}: ${o.item.id}${year ? ` (${year})` : ""}${r.note ? ` - ${r.note}` : ""}`);
        }
        const cost = c ? c.counts.logical : 0;
        if (cost > SLOW_ROW) {
          console.log(`[slow] ${rows[i].slug}: ${cost} requests - several candidates had to be checked`);
        }
      }
      if (items.length === 0) throw new Error(`all ${rows.length} rows unresolvable - refusing to overwrite with empty`);
      // The cache is written BEFORE the hold-out check: a row that resolved
      // must not be re-resolved on the next run just because its LIST
      // aborted. The DATA file is still only written when the list passes.
      saveCacheFn(Object.fromEntries(cacheMap));
      if (heldOut.length / rows.length > 0.1) {
        throw new Error(`${heldOut.length}/${rows.length} rows held out (>10%) - refusing partial overwrite: ${heldOut.slice(0, 3).join("; ")}`);
      }
      write(t, items);
      run.status = "success";
      run.finished_at = Date.now();
      run.pages_scraped = 1;
      run.movies_found = items.length;
      run.held_out = heldOut.length;
      run.requests_logical = listCounts.logical;
      run.requests_attempted = listCounts.attempted;
      const fallbacks = items.filter((i) => String(i.id).startsWith("tmdb:")).length;
      results.push({ catalog: run.catalog_id, moviesFound: items.length, heldOut: heldOut.length, rows: rows.length, fallbacks, requests: listCounts });
      console.log(`[${run.catalog_id}] ${run.status} - ${items.length} items, ${heldOut.length} held out, ${listCounts.logical} requests (${(listCounts.logical / Math.max(1, rows.length)).toFixed(1)}/row)`);
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
    // S8 (mirrored from scrape.mjs): breathe between lists - back-to-back
    // chart + detail bursts are what trips bot detection.
    await sleep(2500 + Math.random() * 2500);
  }

  await recordRuns(runs);

  const totalItems = results.reduce((a, r) => a + (r.moviesFound || 0), 0);
  const totalHeld = results.reduce((a, r) => a + (r.heldOut || 0), 0);
  const totalRows = results.reduce((a, r) => a + (r.rows || 0), 0);
  const totalFallbacks = results.reduce((a, r) => a + (r.fallbacks || 0), 0);
  console.log(`[summary] ${totalItems} items, ${totalHeld} held out, ${runCounts.logical} requests (${(runCounts.logical / Math.max(1, totalRows)).toFixed(1)}/row), ${totalFallbacks} tmdb: fallback`);
  console.log("\nSummary:", JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.error);
  if (failed.length && isMain) process.exit(1);
}

export const isMain = typeof process !== "undefined" && !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
