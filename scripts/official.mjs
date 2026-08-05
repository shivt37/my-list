#!/usr/bin/env node
/**
 * my-list MDBList official lists - runs on GitHub Actions, fetches the 3
 * official lists (popular, justwatch-streaming-charts, moviemeter) for
 * both movie and show via the MDBList API, writes each as a pretty-printed
 * JSON file into data/mdboff_<slug>_<movie|show>.json (served via GitHub
 * Pages), and POSTs run records to the worker's /runs endpoint (status
 * page). Unlike the scraper, official lists are only ever enabled/disabled
 * - no add/edit/delete, no delete path. Disabled slugs are skipped when
 * the worker serves config.
 *
 * Required env (GitHub repo secrets / workflow env):
 *   MDBLIST_API_KEY - mdblist.com API key
 *   WORKER_ORIGIN   - worker base URL (run records + config; required)
 *   WORKER_SECRET   - worker shared secret for /runs + /export-config
 *
 * Usage:
 *   node official.mjs                 # refresh all enabled (default 3) slugs × 2 media types
 *   node official.mjs --slugs=popular,justwatch-streaming-charts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const DATA_DIR = join(ROOT, "data");

const MDBLIST_API_KEY = process.env.MDBLIST_API_KEY;
const WORKER_ORIGIN = process.env.WORKER_ORIGIN;
const WORKER_SECRET = process.env.WORKER_SECRET;
const API = "https://api.mdblist.com";

export const SLUGS = ["popular", "justwatch-streaming-charts", "moviemeter"];
export const MEDIATYPES = ["movie", "show"];

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

// Worker is the source of truth for enabled slugs - a disabled list is not
// refreshed. Falls back to all slugs when the worker is unreachable so a
// worker outage can't silently stop the refresh.
export async function enabledSlugs() {
  if (!WORKER_ORIGIN) return SLUGS;
  try {
    const res = await fetch(`${WORKER_ORIGIN}/export-config`, {
      headers: WORKER_SECRET ? { "X-Admin-Secret": WORKER_SECRET } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return SLUGS;
    const cfg = await res.json();
    const enabled = new Set((cfg.official?.lists || []).filter((l) => l.enabled).map((l) => l.slug));
    if (enabled.size === 0) return SLUGS;
    return SLUGS.filter((s) => enabled.has(s));
  } catch {
    return SLUGS;
  }
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

export function writeCatalog(slug, mediatype, items) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `mdboff_${slug}_${mediatype}.json`);
  const out = {
    catalog_id: `mdboff_${slug}_${mediatype}`,
    name: `${slug} ${mediatype}`,
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
          ...(WORKER_SECRET ? { "X-Admin-Secret": WORKER_SECRET } : {}),
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
  fetchConfig = enabledSlugs,
  fetchApi = fetchAllItems,
  recordRuns = postRuns,
} = {}) {
  const slugs = rawSlugs ? rawSlugs.split(",").filter(Boolean) : await fetchConfig();
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
        if (items.length > 0) writeCatalog(slug, mediatype, items);
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
  if (!MDBLIST_API_KEY) {
    console.error("Missing MDBLIST_API_KEY env var.");
    process.exit(1);
  }
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}