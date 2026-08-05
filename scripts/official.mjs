#!/usr/bin/env node
/**
 * my-list MDBList official lists — runs on GitHub Actions, fetches the 3
 * official lists (popular, justwatch-streaming-charts, moviemeter) for
 * both movie and show via the MDBList API, writes each as a pretty-printed
 * JSON file into data/mdboff_<slug>_<movie|show>.json (served via GitHub
 * Pages), and POSTs run records to the worker's /runs endpoint (status
 * page). Unlike the scraper, official lists are only ever enabled/disabled
 * — no add/edit/delete, so there's no config fetch and no delete path.
 *
 * Required env (GitHub repo secrets / workflow env):
 *   MDBLIST_API_KEY - mdblist.com API key
 *   WORKER_ORIGIN   - worker base URL (run records; optional)
 *
 * Usage:
 *   node official.mjs                 # refresh all 3 lists × 2 media types
 *   node official.mjs --slugs=popular,justwatch-streaming-charts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");

const MDBLIST_API_KEY = process.env.MDBLIST_API_KEY;
const WORKER_ORIGIN = process.env.WORKER_ORIGIN;
const API = "https://api.mdblist.com";

const SLUGS = ["popular", "justwatch-streaming-charts", "moviemeter"];
const MEDIATYPES = ["movie", "show"];

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const slugsArg = arg("slugs");
const slugs = slugsArg ? slugsArg.split(",").filter(Boolean) : SLUGS;

if (!MDBLIST_API_KEY) {
  console.error("Missing MDBLIST_API_KEY env var.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk cursor pages until has_more is false or the cap (50) is hit.
// The API default limit is 100; keep it that way.
async function fetchAllItems(slug, mediatype) {
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

    const res = await fetch(url);
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

function writeCatalog(slug, mediatype, items) {
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

async function postRuns(runs) {
  if (!WORKER_ORIGIN || runs.length === 0) return;
  try {
    const res = await fetch(`${WORKER_ORIGIN}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runs }),
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

async function main() {
  const runs = [];
  const results = [];
  for (const slug of slugs) {
    for (const mediatype of MEDIATYPES) {
      const startedAt = Date.now();
      const run = { catalog_id: `mdboff_${slug}_${mediatype}`, started_at: startedAt, status: "failed" };
      try {
        const { items, pages } = await fetchAllItems(slug, mediatype);
        writeCatalog(slug, mediatype, items);
        run.status = items.length > 0 ? "success" : "failed";
        run.finished_at = Date.now();
        run.pages_scraped = pages;
        run.movies_found = items.length;
        results.push({ catalog: run.catalog_id, moviesFound: items.length });
        console.log(`[${run.catalog_id}] ${run.status} — ${items.length} items`);
      } catch (e) {
        run.finished_at = Date.now();
        run.pages_scraped = pages;
        run.movies_found = 0;
        run.error_message = e.message;
        results.push({ catalog: run.catalog_id, error: e.message });
        console.error(`[${run.catalog_id}] failed: ${e.message}`);
      }
      runs.push(run);
      await sleep(500);
    }
  }

  await postRuns(runs);

  console.log("\nSummary:", JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.error);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});