#!/usr/bin/env node
/**
 * my-list MDBList official lists - runs on GitHub Actions. The slug
 * universe comes from the worker's /export-config (operators add/delete
 * officials in /configure; MDBList's live catalog feeds the picker), so
 * this script never hardcodes one. For each enabled slug it fetches both
 * mediatypes via the MDBList API, writes data/mdboff_<slug>_<movie|show>.json
 * (served via GitHub Pages), and POSTs run records to the worker's /runs
 * endpoint (status page).
 *
 * Required env (GitHub repo secrets / workflow env):
 *   MDBLIST_API_KEY - mdblist.com API key (not needed for action=delete)
 *   WORKER_ORIGIN   - worker base URL (config source; required)
 *
 * Usage:
 *   node official.mjs                 # refresh all enabled slugs x 2 media types
 *   node official.mjs --slugs=popular,trending-x
 *   node official.mjs --action=delete --delete-ids=mdboff_x_movie,mdboff_x_show
 */

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const DATA_DIR = join(ROOT, "data");

const MDBLIST_API_KEY = process.env.MDBLIST_API_KEY;
const WORKER_ORIGIN = process.env.WORKER_ORIGIN;
const API = "https://api.mdblist.com";

export const MEDIATYPES = ["movie", "show"];

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const slugsArg = arg("slugs");
const actionArg = arg("action");
const deleteIdsArg = arg("delete-ids");

// Slug universe comes from the OPERATOR'S CONFIG (/export-config), never a
// frozen constant - officials are added/deleted from /configure now. The
// fail-open-on-outage behavior of the old hardcoded trio is intentionally
// gone: with an open slug set, guessing during a worker outage would
// scrape the wrong catalog. No worker = nothing to refresh (logged loudly).
export async function enabledSlugs() {
  if (!WORKER_ORIGIN) {
    console.error("WORKER_ORIGIN missing - cannot read official slug config. Refresh skipped.");
    return [];
  }
  try {
    const res = await fetch(`${WORKER_ORIGIN}/export-config`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`Worker /export-config HTTP ${res.status} - cannot read official slug config. Refresh skipped.`);
      return [];
    }
    const cfg = await res.json();
    return (cfg.official?.lists || []).filter((l) => l.enabled).map((l) => l.slug);
  } catch (e) {
    console.error(`Worker unreachable (${e.message}) - official refresh skipped.`);
    return [];
  }
}

// Returns the full cfg so writeCatalog can read operator-renamed names.
// Same endpoint + secret as enabledSlugs; kept separate so callers who
// only need the slug list don't pay the parse cost.
export async function getFullConfig() {
  if (!WORKER_ORIGIN) return null;
  const res = await fetch(`${WORKER_ORIGIN}/export-config`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  return res.json();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk cursor pages until has_more is false or the cap (50) is hit.
// The API default limit is 100; keep it that way.
export async function fetchAllItems(slug, mediatype) {
  const items = [];
  let cursor = null;
  let pages = 0;
  for (let page = 0; page < 50; page++) {
    pages++;
    const url = new URL(`${API}/lists/official/${slug}/items`);
    url.searchParams.set("apikey", MDBLIST_API_KEY);
    url.searchParams.set("limit", "100");
    url.searchParams.set("mediatype", mediatype);
    url.searchParams.set("append_to_response", "poster");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`MDBList API ${res.status} (${slug}/${mediatype}): ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const key = mediatype === "movie" ? "movies" : "shows";
    const batch = data[key] || [];
    for (const item of batch) {
      items.push({
        imdb_id: item.imdb_id || `tmdb:${item.id}`,
        type: mediatype === "movie" ? "movie" : "series",
        title: item.title,
        year: item.release_year ?? null,
        poster: item.poster ?? null,
        imdb_rating: item.rating?.imdb?.rating ?? null,
      });
    }

    cursor = data.pagination?.next_cursor || null;
    if (!cursor || !data.pagination?.has_more) break;
  }
  return { items, pages };
}

// Name comes from the operator's worker config so a rename in /configure
// reaches the data file on the next refresh. Generic fallback for slugs
// without a config entry (should not happen - config is the source).
const OFFICIAL_DEFAULT_NAMES = new Proxy({}, {
  get: (_t, slug) => ({ movie: `${slug} movie`, show: `${slug} show` }),
});

export function writeCatalog(slug, mediatype, items, cfg) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `mdboff_${slug}_${mediatype}.json`);
  const renamed = cfg?.official?.lists?.find((l) => l.slug === slug)?.name;
  const fallback = OFFICIAL_DEFAULT_NAMES[slug]?.[mediatype] || `${slug} ${mediatype}`;
  const out = {
    catalog_id: `mdboff_${slug}_${mediatype}`,
    name: renamed || fallback,
    type: mediatype === "movie" ? "movie" : "series",
    scraped_at: Date.now(),
    items,
  };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return file;
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
        headers: {
          "Content-Type": "application/json",
        },
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
  slugsArg: rawSlugs = slugsArg,
  actionArg: rawAction = actionArg,
  deleteIdsArg: rawDeleteIds = deleteIdsArg,
  fetchConfig = enabledSlugs,
  fetchCfg = getFullConfig,
  fetchApi = fetchAllItems,
  write = writeCatalog,
  recordRuns = postRuns,
} = {}) {
  // CLI inputs arrive from workflow_dispatch; the same char whitelist as
  // before guards path traversal into writeCatalog's join().
  const SANE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const SANE_ID = /^mdboff_[a-z0-9-]+_(movie|show)$/;

  // ── Delete mode: remove data files for deleted officials. No API calls,
  //    no run records - deletions are silent cleanup.
  if (rawAction === "delete") {
    if (!rawDeleteIds) {
      console.log("action=delete but no --delete-ids given - nothing to do.");
      return;
    }
    const ids = rawDeleteIds.split(",").filter(Boolean).filter((id) => SANE_ID.test(id));
    mkdirSync(DATA_DIR, { recursive: true });
    for (const id of ids) {
      const file = join(DATA_DIR, `${id}.json`);
      try { rmSync(file, { force: true }); console.log(`[delete] ${file}`); }
      catch (e) { console.error(`[delete] ${file}: ${e.message}`); }
    }
    return;
  }

  const enabledSet = new Set(await fetchConfig());
  let slugs;
  if (rawSlugs) {
    // Workflow/CLI override - intersect with config so a stale or crafted
    // input can't resurrect a list the operator deleted.
    slugs = rawSlugs.split(",").filter(Boolean).filter((s) => SANE_SLUG.test(s) && enabledSet.has(s));
  } else {
    slugs = [...enabledSet];
  }
  // Pull cfg separately - writeCatalog needs operator-renamed names. Cheap
  // re-read; same worker endpoint, uses the same secret.
  const cfg = await fetchCfg().catch(() => null);
  const runs = [];
  const results = [];
  for (const slug of slugs) {
    for (const mediatype of MEDIATYPES) {
      const startedAt = Date.now();
      const run = { catalog_id: `mdboff_${slug}_${mediatype}`, started_at: startedAt, status: "failed", triggered_by: process.env.GITHUB_EVENT_NAME === "schedule" ? "scheduled" : "manual" };
      try {
        const { items, pages } = await fetchApi(slug, mediatype);
        // Empty result may mean a legitimate empty list or a scrape gone
        // silent - don't overwrite the last good file with an empty one.
        if (items.length > 0) write(slug, mediatype, items, cfg);
        run.status = items.length > 0 ? "success" : "failed";
        run.finished_at = Date.now();
        run.pages_scraped = pages;
        run.movies_found = items.length;
        results.push({ catalog: run.catalog_id, moviesFound: items.length });
        console.log(`[${run.catalog_id}] ${run.status} - ${items.length} items`);
      } catch (e) {
        run.finished_at = Date.now();
        run.pages_scraped = 0;
        run.movies_found = 0;
        run.error_message = e.message;
        results.push({ catalog: run.catalog_id, error: e.message });
        console.error(`[${run.catalog_id}] failed: ${e.message}`);
      }
      runs.push(run);
      await sleep(500);
    }
  }

  await recordRuns(runs);

  console.log("\nSummary:", JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.error);
  if (failed.length && isMain) process.exit(1);
}

// Fresh check each run (not at module load) so dry tests can import
// official.mjs without exiting.
export const isMain = typeof process !== "undefined" && !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // action=delete never touches the MDBList API - key not required there.
  if (actionArg !== "delete" && !MDBLIST_API_KEY) {
    console.error("Missing MDBLIST_API_KEY env var.");
    process.exit(1);
  }
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}