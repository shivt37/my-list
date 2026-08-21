#!/usr/bin/env node
/**
 * my-list TMDB Discover lists - runs on GitHub Actions. Reads the tmdb
 * module's discover lists from the worker's /export-config, calls the TMDB
 * API for each enabled list, and writes data/<id>.json in the same wrapper
 * shape the other modules use ({ catalog_id, name, type, scraped_at,
 * sourceHash, items }) so routes.js serves it unchanged.
 *
 * Ported from "my worker/tmdb" scripts/generate.js (Discover page only):
 * per-dimension AND/OR include modes (genre/keyword/company/collection),
 * release-type movie-only, collection as post-filter (TMDB /discover has
 * no native belongs-to-collection param), 500-item cap, series title/
 * release_date aliasing. Sort is baked into the TMDB query at generation
 * time (the old worker sorted client-side; here items are stored pre-sorted).
 *
 * Required env:
 *   TMDB_READ_ACCESS_TOKEN - TMDB v4 read access token (bearer)
 *   WORKER_ORIGIN          - worker base URL (config + run records)
 *
 * Usage:
 *   node tmdb.mjs                 # generate every enabled list
 *   node tmdb.mjs --ids=tmdb_discover_movie_abc12345,...
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, "..", "data");

const TMDB_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;
const WORKER_ORIGIN = process.env.WORKER_ORIGIN;
const API = "https://api.themoviedb.org/3";
const MAX_ITEMS = 500;
const ID_RE = /^tmdb_discover_(movie|series)_[a-z0-9]{8}$/;

const SORT_BY_MOVIE = {
  release_desc: "primary_release_date.desc",
  release_asc: "primary_release_date.asc",
  popularity_desc: "popularity.desc",
  vote_desc: "vote_average.desc",
  title_asc: "original_title.asc",
};
const SORT_BY_TV = {
  release_desc: "first_air_date.desc",
  release_asc: "first_air_date.asc",
  popularity_desc: "popularity.desc",
  vote_desc: "vote_average.desc",
  title_asc: "popularity.desc",
};

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

// Order-independent fingerprint of everything that changes what gets
// fetched. Name/enabled/sort deliberately excluded - a rename or sort-only
// edit must not trigger a regenerate (sort is baked in at generation time,
// but a sort change only reorders stored items, which fill-mode skips are
// fine to defer to the next full regen... no: sort IS baked into the query,
// so it must be hashed. Kept in.)
export function computeSourceHash(list) {
  const modes = list.includeModes || {};
  const inputs = {
    mediaType: list.mediaType,
    sort: list.sort || "release_asc",
    includeModeGenre: modes.genre === "or" ? "or" : "and",
    includeModeKeyword: modes.keyword === "or" ? "or" : "and",
    includeModeCompany: modes.company === "or" ? "or" : "and",
    includeModeCollection: modes.collection === "or" ? "or" : "and",
    includeGenres: list.includeGenres || [],
    excludeGenres: list.excludeGenres || [],
    includeKeywords: list.includeKeywords || [],
    excludeKeywords: list.excludeKeywords || [],
    includeCompanies: list.includeCompanies || [],
    excludeCompanies: list.excludeCompanies || [],
    includeReleaseTypes: list.includeReleaseTypes || [],
    includeCollections: list.includeCollections || [],
    excludeCollections: list.excludeCollections || [],
  };
  const normalized = JSON.stringify(inputs, (key, value) =>
    Array.isArray(value) ? [...value].sort() : value
  );
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function readExistingHash(catalogId) {
  const file = join(DATA_DIR, `${catalogId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")).sourceHash || null;
  } catch {
    return null;
  }
}

async function tmdbFetch(pathAndQuery) {
  const res = await fetch(`${API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} on ${pathAndQuery}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Every dimension marked 'and' folds into one shared query fragment that
// rides on every 'or' dimension's own /discover query; nothing OR-marked →
// the AND fragment alone is the single query. Collection can't ride a
// /discover query at all: 'or' fetches members directly as a source,
// 'and' post-filters combined results. Release type always narrows.
export function buildDiscoverSources(list, mediaType) {
  const includeGenres = list.includeGenres || [];
  const includeKeywords = list.includeKeywords || [];
  const includeCompanies = list.includeCompanies || [];
  const includeReleaseTypes = list.includeReleaseTypes || [];
  const includeCollections = list.includeCollections || [];
  const modes = list.includeModes || {};
  const isAnd = (dim) => modes[dim] !== "or";

  const releaseTypeQs =
    mediaType !== "series" && includeReleaseTypes.length > 0
      ? `&with_release_type=${encodeURIComponent([...new Set(includeReleaseTypes)].join("|"))}&region=US`
      : "";

  let andQs = "";
  if (isAnd("genre") && includeGenres.length > 0) {
    andQs += `&with_genres=${encodeURIComponent([...new Set(includeGenres)].join("|"))}`;
  }
  if (isAnd("keyword") && includeKeywords.length > 0) {
    andQs += `&with_keywords=${encodeURIComponent([...new Set(includeKeywords)].join("|"))}`;
  }
  if (isAnd("company") && includeCompanies.length > 0) {
    andQs += `&with_companies=${encodeURIComponent([...new Set(includeCompanies)].join("|"))}`;
  }
  andQs += releaseTypeQs;

  const sources = [];
  if (!isAnd("genre") && includeGenres.length > 0) {
    sources.push({ kind: "discover", qs: `&with_genres=${encodeURIComponent([...new Set(includeGenres)].join("|"))}${andQs}` });
  }
  if (!isAnd("keyword") && includeKeywords.length > 0) {
    sources.push({ kind: "discover", qs: `&with_keywords=${encodeURIComponent([...new Set(includeKeywords)].join("|"))}${andQs}` });
  }
  if (!isAnd("company") && includeCompanies.length > 0) {
    sources.push({ kind: "discover", qs: `&with_companies=${encodeURIComponent([...new Set(includeCompanies)].join("|"))}${andQs}` });
  }
  if (mediaType !== "series" && !isAnd("collection") && includeCollections.length > 0) {
    sources.push({ kind: "collection", ids: includeCollections });
  }

  // If collection is the ONLY OR-marked dimension, its source can't carry
  // andQs - emit the AND fragment as its own discover source or the
  // genre/keyword/company values would silently vanish.
  const hasDiscoverSource = sources.some((s) => s.kind === "discover");
  const hasCollectionSource = sources.some((s) => s.kind === "collection");
  if (andQs && hasCollectionSource && !hasDiscoverSource) {
    sources.push({ kind: "discover", qs: andQs });
  }

  return {
    sources,
    singleQueryMode: sources.length === 0,
    singleQueryQs: andQs,
    collectionIsPostFilter: mediaType !== "series" && isAnd("collection") && includeCollections.length > 0,
  };
}

function excludeQsFor(list) {
  let qs = "";
  const eg = list.excludeGenres || [];
  const ek = list.excludeKeywords || [];
  const ec = list.excludeCompanies || [];
  if (eg.length > 0) qs += `&without_genres=${encodeURIComponent([...new Set(eg)].join("|"))}`;
  if (ek.length > 0) qs += `&without_keywords=${encodeURIComponent([...new Set(ek)].join("|"))}`;
  if (ec.length > 0) qs += `&without_companies=${encodeURIComponent([...new Set(ec)].join("|"))}`;
  return qs;
}

async function collectionIdSet(collectionIds) {
  if (!collectionIds || collectionIds.length === 0) return new Set();
  const results = await Promise.allSettled(
    [...new Set(collectionIds)].map((id) => tmdbFetch(`/collection/${id}`))
  );
  const ids = new Set();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const p of r.value.parts || []) ids.add(p.id);
  }
  return ids;
}

async function collectionParts(collectionIds) {
  if (!collectionIds || collectionIds.length === 0) return [];
  const results = await Promise.allSettled(
    [...new Set(collectionIds)].map((id) => tmdbFetch(`/collection/${id}`))
  );
  const parts = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    if (Array.isArray(r.value.parts)) parts.push(...r.value.parts);
  }
  return parts;
}

// Client-side sort matching the preview's sortPreviewItems. Empty dates
// (unreleased titles) sort to the end regardless of direction.
export function sortItems(items, sortKey, mediaType) {
  const dateField = mediaType === "series" ? "first_air_date" : "release_date";
  const hasDate = (i) => Boolean(i[dateField] || i.release_date || i.first_air_date);
  const cmp = {
    release_asc: (a, b) => String(a[dateField] || "9999").localeCompare(String(b[dateField] || "9999")),
    release_desc: (a, b) => String(b[dateField] || "0000").localeCompare(String(a[dateField] || "0000")),
    popularity_desc: (a, b) => (b.popularity || 0) - (a.popularity || 0),
    vote_desc: (a, b) => (b.vote_average || 0) - (a.vote_average || 0),
    title_asc: (a, b) => String(a.title || a.name || "").localeCompare(String(b.title || b.name || "")),
  }[sortKey] || ((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return items.sort((a, b) => {
    if (hasDate(a) !== hasDate(b)) return hasDate(a) ? -1 : 1;
    return cmp(a, b);
  });
}

export async function buildDiscoverItems(list, mediaType) {
  const endpoint = mediaType === "series" ? "/discover/tv" : "/discover/movie";
  const sortMap = mediaType === "series" ? SORT_BY_TV : SORT_BY_MOVIE;
  const sortBy = sortMap[list.sort] || SORT_BY_MOVIE.release_asc;
  const excludeQs = excludeQsFor(list);
  const maxPages = Math.ceil(MAX_ITEMS / 20);
  const { sources, singleQueryMode, singleQueryQs, collectionIsPostFilter } =
    buildDiscoverSources(list, mediaType);

  const dedup = new Map();
  const excludeSet = await collectionIdSet(list.excludeCollections);

  if (singleQueryMode) {
    let page = 1;
    let totalPages = 1;
    do {
      const path = `${endpoint}?${singleQueryQs.replace(/^&/, "")}&sort_by=${encodeURIComponent(sortBy)}&page=${page}${excludeQs}`;
      const data = await tmdbFetch(path);
      for (const item of data.results || []) if (!dedup.has(item.id)) dedup.set(item.id, item);
      totalPages = Number.isFinite(data.total_pages) ? data.total_pages : page;
      page++;
    } while (page <= totalPages && page <= maxPages && dedup.size < MAX_ITEMS);
  } else {
    for (const src of sources) {
      if (src.kind === "collection") {
        for (const p of await collectionParts(src.ids)) {
          if (!dedup.has(p.id)) dedup.set(p.id, p);
        }
      }
    }
    const discoverSources = sources.filter((s) => s.kind === "discover");
    let page = 1;
    let totalPages = 1;
    do {
      const round = await Promise.all(
        discoverSources.map((src) =>
          tmdbFetch(`${endpoint}?${src.qs.replace(/^&/, "")}&sort_by=${encodeURIComponent(sortBy)}&page=${page}${excludeQs}`)
        )
      );
      let maxTotal = page;
      for (const data of round) {
        maxTotal = Math.max(maxTotal, Number.isFinite(data.total_pages) ? data.total_pages : page);
        for (const item of data.results || []) if (!dedup.has(item.id)) dedup.set(item.id, item);
      }
      totalPages = maxTotal;
      page++;
    } while (page <= totalPages && page <= maxPages && dedup.size < MAX_ITEMS);
  }

  let items = [...dedup.values()];
  if (excludeSet.size > 0) items = items.filter((p) => !excludeSet.has(p.id));
  if (collectionIsPostFilter) {
    const includeSet = await collectionIdSet(list.includeCollections);
    if (includeSet.size > 0) items = items.filter((p) => includeSet.has(p.id));
  }

  // Multi-source unions lose TMDB's server-side order, and unreleased titles
  // (empty release_date, e.g. 2028 entries) would sort first on asc. Re-sort
  // client-side; no-date items always go last.
  items = sortItems(items, list.sort, mediaType);

  items = items.slice(0, MAX_ITEMS);

  // Series items get movie-style field aliases so downstream consumers
  // reading title/release_date work uniformly (originals kept too).
  if (mediaType === "series") {
    items = items.map((item) => ({
      ...item,
      title: item.name,
      release_date: item.first_air_date,
    }));
  }
  return items;
}

export function writeCatalog(list, mediaType, items, sourceHash) {
  mkdirSync(DATA_DIR, { recursive: true });
  const catalogId = `tmdb_discover_${mediaType}_${list.discoverListId}`;
  const out = {
    catalog_id: catalogId,
    name: list.name,
    type: mediaType === "series" ? "series" : "movie",
    scraped_at: Date.now(),
    sourceHash,
    items,
  };
  const file = join(DATA_DIR, `${catalogId}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return file;
}

export function deleteCatalog(catalogId) {
  const file = join(DATA_DIR, `${catalogId}.json`);
  if (existsSync(file)) unlinkSync(file);
}

// /runs caps at 50 records per POST - chunk larger batches.
export function chunkArray(arr, size = 50) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function postRuns(runs) {
  if (!WORKER_ORIGIN || runs.length === 0) return;
  for (const chunk of chunkArray(runs)) {
    try {
      const res = await fetch(`${WORKER_ORIGIN}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runs: chunk }),
      });
      if (!res.ok) {
        console.warn(`  [runs] POST failed: HTTP ${res.status}`);
        process.exitCode = 1;
      }
    } catch (e) {
      console.warn(`  [runs] POST failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

export async function main({
  idsArg = arg("ids"),
  actionArg = arg("action") || "generate",
  deleteIdsArg = arg("delete_ids"),
  fetchCfg = getLists,
  build = buildDiscoverItems,
  write = writeCatalog,
  remove = deleteCatalog,
  recordRuns = postRuns,
} = {}) {
  const cfg = await fetchCfg();
  const all = cfg.tmdb?.lists || [];

  // Deletes run first (also alongside generation - a save can delete one
  // list and edit another in the same dispatch).
  if (deleteIdsArg) {
    const ids = deleteIdsArg.split(",").filter(Boolean).filter((id) => ID_RE.test(id));
    for (const id of ids) {
      remove(id);
      console.log(`deleted ${id}`);
    }
    if (actionArg === "delete") return { deleted: ids };
  } else if (actionArg === "delete") {
    console.log("action=delete but no --delete_ids given - nothing to do.");
    return { deleted: [] };
  }

  // CLI ids arrive from workflow_dispatch inputs; whitelist before they
  // reach writeCatalog's join() - blocks path traversal via crafted --ids.
  const requested = idsArg
    ? idsArg.split(",").filter(Boolean).filter((id) => ID_RE.test(id))
    : null;

  const targets = all.filter((l) => {
    if (!l.enabled) return false;
    if (!requested) return true;
    return requested.includes(`tmdb_discover_movie_${l.discoverListId}`) ||
           requested.includes(`tmdb_discover_series_${l.discoverListId}`);
  });

  const runs = [];
  const results = [];
  for (const list of targets) {
    const startedAt = Date.now();
    const triggeredBy = process.env.GITHUB_EVENT_NAME === "schedule" ? "scheduled" : "manual";
    try {
      const sourceHash = computeSourceHash(list);
      const items = await build(list, list.mediaType);
      // Empty result may mean a legitimate empty filter combo or a fetch
      // gone silent - don't overwrite the last good file with an empty one.
      if (items.length > 0) {
        write(list, list.mediaType, items, sourceHash);
      }
      const catalogId = `tmdb_discover_${list.mediaType}_${list.discoverListId}`;
      const ok = items.length > 0;
      runs.push({
        catalog_id: catalogId,
        started_at: startedAt,
        finished_at: Date.now(),
        pages_scraped: Math.ceil(items.length / 20),
        movies_found: items.length,
        status: ok ? "success" : "failed",
        error_message: ok ? null : "0 items returned",
        triggered_by: triggeredBy,
      });
      results.push({ catalog: catalogId, items: items.length, status: ok ? "success" : "failed" });
      console.log(`[${catalogId}] ${ok ? "success" : "failed"} - ${items.length} items`);
    } catch (e) {
      const catalogId = `tmdb_discover_${list.mediaType}_${list.discoverListId}`;
      runs.push({
        catalog_id: catalogId,
        started_at: startedAt,
        finished_at: Date.now(),
        pages_scraped: 0,
        movies_found: 0,
        status: "failed",
        error_message: e.message.slice(0, 500),
        triggered_by: triggeredBy,
      });
      results.push({ catalog: catalogId, error: e.message });
      console.error(`[${catalogId}] failed: ${e.message}`);
    }
  }

  await recordRuns(runs);
  console.log("\nSummary:", JSON.stringify(results, null, 2));
  return { generated: results };
}

async function getLists() {
  if (!WORKER_ORIGIN) throw new Error("WORKER_ORIGIN is not set.");
  const res = await fetch(`${WORKER_ORIGIN}/export-config`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`/export-config returned HTTP ${res.status}`);
  return res.json();
}

export const isMain =
  typeof process !== "undefined" &&
  !!process.argv[1] &&
  (await import("node:url")).pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  if (!TMDB_TOKEN) {
    console.error("Missing TMDB_READ_ACCESS_TOKEN env var.");
    process.exit(1);
  }
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
