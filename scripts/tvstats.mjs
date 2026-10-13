#!/usr/bin/env node
/**
 * my-list Television Stats - runs on GitHub Actions, fetches
 * televisionstats.com Attention charts for the operator's enabled lists,
 * resolves per-title IMDb IDs (movies: TS detail page; shows: TS detail
 * dates + TMDB search gated on exact first_air_date), writes
 * data/tvstats_<id>.json (served via GitHub Pages), and POSTs run records
 * to the worker's /runs endpoint.
 *
 * Page fetching goes through the worker's /ts-fetch proxy (TS_FETCH_BASE):
 * the worker's Cloudflare egress is unchallenged where datacenter IPs are
 * not, so no browser machinery is needed anywhere in this script.
 *
 * Identity cache: data/ts_cache.json maps slug -> { kind, imdb, tmdb }.
 * A title's identity never changes, so each slug resolves once ever;
 * steady-state runs only fetch new slugs. Committed by the workflow
 * alongside the data files (data/*.json).
 *
 * Unlike official.mjs, an EMPTY chart is a failure (these charts always
 * carry rows) and never overwrites the previous file.
 *
 * Required env (GitHub repo secrets / workflow env):
 *   TMDB_READ_ACCESS_TOKEN - TMDB API bearer (show resolution only)
 *   WORKER_ORIGIN           - worker base URL (run records + config)
 *
 * Usage:
 *   node tvstats.mjs                        # refresh all enabled lists
 *   node tvstats.mjs --ids=tvstats_ab12cd34 # refresh listed ids only
 *   node tvstats.mjs --action=delete --delete_ids=tvstats_ab12cd34
 */

import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const DATA_DIR = join(ROOT, "data");
export const CACHE_FILE = join(DATA_DIR, "ts_cache.json");

const WORKER_ORIGIN = process.env.WORKER_ORIGIN;
const TMDB_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;

// ── page fetching: worker proxy only ──
// All chart/detail HTML flows through GET <TS_FETCH_BASE>/ts-fetch?url=.
// The worker's Cloudflare egress is unchallenged where datacenter IPs are
// not, so no browser machinery is needed anywhere in this script.

export async function fetchProxyHtml(url, base = process.env.TS_FETCH_BASE) {
  if (!base) throw new Error("TS_FETCH_BASE is not set - point it at the worker origin.");
  const endpoint = `${String(base).replace(/\/+$/, "")}/ts-fetch?url=${encodeURIComponent(url)}`;
  // Retry transient upstream blips (502/503/429/504): one hiccup across
  // ~200 fetches must not fail a run. Anything else fails loud.
  const RETRYABLE = new Set([429, 502, 503, 504]);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(endpoint);
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

export async function tmdbGet(path, params = {}, fetchFn = fetch) {
  if (!TMDB_TOKEN) throw new Error("TMDB_READ_ACCESS_TOKEN is not set - cannot resolve show IDs.");
  const url = `https://api.themoviedb.org/3${path}?${new URLSearchParams(params)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
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

// ── parsing ──

export function pageProps(html) {
  const m = html.match(/__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error("page has no __NEXT_DATA__ blob");
  return JSON.parse(m[1]).props.pageProps;
}

// Chart rows in rank order: { slug, title, poster, date } + raw score.
// Movies and shows share the envelope ({movies|shows: [{movie|show, value}]})
// with differently-named inner fields - normalized here.
export function chartRows(kind, html) {
  const pp = pageProps(html);
  const rows = kind === "movie" ? pp.movies || [] : pp.shows || [];
  return rows.map((r) => {
    const it = kind === "movie" ? r.movie : r.show;
    if (!it || !it.slug) throw new Error("chart row without slug");
    return {
      slug: it.slug,
      title: (kind === "movie" ? it.title : it.name) || "",
      poster: kind === "movie" ? it.poster_path || null : it.poster_image || it.poster_path || null,
      date: (kind === "movie" ? it.release_date : it.first_air_date) || null,
    };
  });
}

export function normTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function titlesMatch(a, b) {
  const x = normTitle(a);
  const y = normTitle(b);
  return (x === y) || (x.length > 4 && y.includes(x)) || (y.length > 4 && x.includes(y));
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

// ── resolution (the smart-TMDB rule: movies never touch TMDB) ──

export function detailUrl(kind, slug) {
  return kind === "movie" ? `https://televisionstats.com/m/${slug}` : `https://televisionstats.com/s/${slug}`;
}

// Movies: imdb_id comes from TS's own detail record - exact by
// construction. Verified by format + chart/detail title agreement.
// getHtml(url) returns page HTML (proxy-backed in prod, stub in tests).
export async function resolveMovie(row, getHtml) {
  const pp = pageProps(await getHtml(detailUrl("movie", row.slug)));
  const mv = pp.movie || {};
  const imdb = mv.imdb_id || null;
  if (!imdb || !/^tt\d{7,8}$/.test(imdb)) throw new Error(`no imdb_id for movie slug ${row.slug}`);
  if (!titlesMatch(mv.title, row.title)) throw new Error(`title mismatch for movie slug ${row.slug}`);
  return { imdb, tmdb: null, title: mv.title || row.title, date: mv.release_date || row.date };
}

// Shows: TS carries no IDs, so one TMDB tv-search (year-filtered) plus
// one external_ids call, accepted ONLY on title agreement + first_air_date
// within +/-1 day (premiere-day drift). imdb missing on the TMDB record ->
// tmdb:<id> fallback id.
export async function resolveShow(row, getHtml, tmdbGetFn = tmdbGet) {
  const pp = pageProps(await getHtml(detailUrl("series", row.slug)));
  const sh = pp.show || {};
  const title = sh.name || row.title;
  const firstAir = sh.first_air_date || row.date;
  const year = (firstAir || "").split("-")[0];
  if (!year) throw new Error(`no first_air_date for show slug ${row.slug}`);
  const search = await tmdbGetFn("/search/tv", { query: title, first_air_date_year: year });
  // Title must agree exactly; the date gets a +/-1 day window (US premiere
  // vs UTC-midnight drift between the two databases). Anything further
  // apart is a different title wearing the same name.
  const hit = ((search && search.results) || []).find((r) => {
    if (!titlesMatch(r.name, title)) return false;
    const drift = dateDiffDays(r.first_air_date, firstAir);
    return drift !== null && drift <= 1;
  });
  if (!hit) throw new Error(`no exact TMDB match for show slug ${row.slug}`);
  const ext = await tmdbGetFn(`/tv/${hit.id}/external_ids`);
  return { imdb: ext.imdb_id || null, tmdb: ext.imdb_id ? null : String(hit.id), title, date: firstAir };
}

export function rowToItem(kind, resolved, row) {
  const id = resolved.imdb || (resolved.tmdb ? `tmdb:${resolved.tmdb}` : null);
  if (!id) throw new Error(`unresolvable slug ${row.slug}`);
  return {
    id,
    type: kind === "movie" ? "movie" : "series",
    name: resolved.title || row.title,
    poster: row.poster ? `https://image.tmdb.org/t/p/w500${row.poster}` : "https://simkl.in/poster_no_pic_c.png",
    releaseInfo: resolved.date || row.date || undefined,
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
    const res = await fetchFn(`${WORKER_ORIGIN}/export-config`, { signal: AbortSignal.timeout(15000) });
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
  const cache = loadCacheFn();
  const getHtml = (url) => fetchProxyHtml(url);
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
      const rows = chartRows(t.kind, await getHtml(t.url)).slice(0, t.maxItems || 100);
      if (rows.length === 0) throw new Error(`chart ${t.url} returned no rows - refusing to overwrite`);
      console.log(`[chart] ${rows.length} rows, resolving IDs...`);
      // Per-item hold-out: one unresolvable slug skips with a logged
      // reason instead of killing the whole list. The list aborts only
      // when failures exceed 10% (systemic block, not single-title gaps).
      const heldOut = [];
      let done = 0;
      const items = (
        await pmap(rows, async (row) => {
          try {
            const key = `${t.kind === "movie" ? "m" : "s"}:${row.slug}`;
            const hit = cache[key];
            let resolved;
            if (hit && (hit.imdb || hit.tmdb)) {
              resolved = hit;
              // Auto-upgrade: tmdb-only fallback entries get one external_ids
              // re-check per run. Numeric-id lookup is exact (no search), so no
              // re-verification is needed. A fresh imdb_id upgrades the entry
              // in place (persisted by saveCacheFn below); anything else keeps
              // the working fallback and never fails the list.
          if (!hit.imdb && hit.tmdb) {
            try {
              const extPath = hit.kind === "movie" ? `/movie/${hit.tmdb}/external_ids` : `/tv/${hit.tmdb}/external_ids`;
              console.log(`  [recheck] ${row.slug}: tmdb:${hit.tmdb} - checking for imdb...`);
              const ext = await tmdbGetFn(extPath);
              if (ext && ext.imdb_id) {
                hit.imdb = ext.imdb_id;
                console.log(`  [upgrade] ${row.slug}: tmdb:${hit.tmdb} -> ${ext.imdb_id}`);
              } else {
                console.log(`  [recheck] ${row.slug}: still missing, keeping fallback`);
              }
            } catch (e) {
              console.warn(`  [upgrade] ${row.slug}: re-check failed (${e.message}) - keeping fallback`);
            }
          }
            } else if (t.kind === "movie") {
              resolved = await resolveMovie(row, getHtml);
            } else {
              resolved = await resolveShow(row, getHtml, tmdbGetFn);
            }
            cache[key] = { kind: t.kind, imdb: resolved.imdb || null, tmdb: resolved.tmdb || null, title: resolved.title, date: resolved.date || row.date || null };
            return rowToItem(t.kind, resolved, row);
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
    // S8 (mirrored from scrape.mjs): breathe between lists - back-to-back
    // chart + detail bursts are what trips bot detection.
    await sleep(2500 + Math.random() * 2500);
  }

  await recordRuns(runs);

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
