#!/usr/bin/env node
/**
 * my-list scraper - runs on GitHub Actions, scrapes mdblist.com listing
 * URLs with headless Chromium (puppeteer-extra + stealth), writes each
 * enabled list's rows as a pretty-printed JSON file into data/<id>.json
 * (served via GitHub Pages), and POSTs run records to the worker's
 * /runs endpoint (status page).
 *
 * Config comes from the worker: GET {WORKER_ORIGIN}/export-config. No
 * local catalogs.json, no Cloudflare credentials, no D1.
 *
 * Required env (GitHub repo secrets / workflow env):
 *   WORKER_ORIGIN   - worker base URL, e.g. https://my-list.workers.dev
 *   MDBLIST_API_KEY - mdblist.com API key (only used for nothing today -
 *                     scraping is DOM-based; kept for parity/tests)
 *
 * Usage:
 *   node scrape.mjs                       # scrape ALL enabled lists
 *   node scrape.mjs --lists=a,b,c         # scrape only ids a,b,c
 *   node scrape.mjs --action=scrape_delete --lists=a --delete-ids=b,c
 *   node scrape.mjs --debug
 *
 * Pagination rule (from the original scraper): page 0 gets
 * q_current_page=0 (no q_page_next); pages 1+ get q_page_next=1 and
 * q_current_page = page - 1. Every other param stays byte-for-byte as
 * mdblist generated it.
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

puppeteer.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const DATA_DIR = join(ROOT, "data");

export const DEBUG = process.argv.includes("--debug");
export const WORKER_ORIGIN = process.env.WORKER_ORIGIN;

export function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

export const listsArg = arg("lists");
export const action = arg("action") || "scrape";
export const deleteIdsArg = arg("delete-ids");
export const requestedIds = listsArg ? listsArg.split(",").filter(Boolean) : null;
export const deleteIds = deleteIdsArg ? deleteIdsArg.split(",").filter(Boolean) : [];

export const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!WORKER_ORIGIN && isMain) {
  console.error("Missing WORKER_ORIGIN env var.");
  process.exit(1);
}

export function authHeaders() {
  return { "Content-Type": "application/json" };
}

export function chunkArray(arr, size = 50) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ====================================================================
// CONFIG (from worker KV via /export-config)
// ====================================================================
export async function fetchConfig() {
  const res = await fetch(`${WORKER_ORIGIN}/export-config`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch config: HTTP ${res.status}`);
  return res.json();
}

// ====================================================================
// RUN RECORDS (POST back to worker KV → /status)
// ====================================================================
async function postRuns(runs) {
  if (runs.length === 0) return;
  for (const chunk of chunkArray(runs)) {
    try {
      const res = await fetch(`${WORKER_ORIGIN}/runs`, {
        method: "POST",
        headers: authHeaders(),
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

// ====================================================================
// PAGE URL BUILDER (same pagination rule as the original scraper)
// ====================================================================
export function buildPageUrl(sourceUrl, page) {
  const url = new URL(sourceUrl);
  const params = url.searchParams;
  if (page === 0) {
    params.set("q_current_page", "0");
    params.delete("q_page_next");
  } else {
    params.set("q_page_next", "1");
    params.set("q_current_page", String(page - 1));
  }
  return url.toString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const DEBUG_DIR = join(ROOT, "debug");
async function debugDump(page, label) {
  if (!DEBUG) return;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const safeName = label.replace(/[^a-z0-9]/gi, "-");
    const html = await page.content();
    writeFileSync(join(DEBUG_DIR, `${safeName}.html`), html);
    await page.screenshot({ path: join(DEBUG_DIR, `${safeName}.png`), fullPage: false });
    console.log(`  [debug] saved ${safeName}.html + .png`);
  } catch (e) {
    console.warn(`  [debug] failed to save ${label}:`, e.message);
  }
}

// ====================================================================
// PUPPETEER (warm-up + scraping, lifted from the original scraper)
// ====================================================================
const REALISTIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const warmedUpTypes = new Set();

async function humanScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 200;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight || totalHeight > 3000) {
          clearInterval(timer);
          resolve();
        }
      }, 100 + Math.random() * 150);
    });
  });
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Mimics a real visitor: homepage → unfiltered /movies/ or /shows/ →
 * scroll → then the filtered URL. Jumping straight to a filtered URL
 * with no browsing history triggers mdblist's bot detection (403).
 * Only runs once per browser launch per type.
 */
async function warmUpSession(browser, basePath) {
  const warmUpKey = basePath === "show" || basePath === "series" ? "shows" : "movies";
  if (warmedUpTypes.has(warmUpKey)) return;
  const page = await browser.newPage();
  try {
    await page.setUserAgent(REALISTIC_USER_AGENT);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    console.log("[warmUp] Visiting homepage...");
    try {
      await page.goto("https://mdblist.com/", { waitUntil: "networkidle2", timeout: 60000 });
    } catch (navErr) {
      console.warn("[warmUp] Homepage visit failed:", navErr.message);
      return;
    }
    await sleep(3000 + Math.random() * 2000);
    await debugDump(page, `warmup-${warmUpKey}-homepage`);

    const listingUrl = warmUpKey === "shows" ? "https://mdblist.com/shows/" : "https://mdblist.com/movies/";
    console.log(`[warmUp] Visiting ${listingUrl}...`);
    await page.goto(listingUrl, { waitUntil: "networkidle2", timeout: 30000, referer: "https://mdblist.com/" });
    await sleep(2000 + Math.random() * 2000);
    await debugDump(page, `warmup-${warmUpKey}-listing`);

    console.log("[warmUp] Scrolling...");
    await humanScroll(page);
    await sleep(1500 + Math.random() * 1500);
    await debugDump(page, `warmup-${warmUpKey}-scrolled`);

    warmedUpTypes.add(warmUpKey);
    console.log("[warmUp] Done.");
  } finally {
    await page.close();
  }
}

async function scrapeOnePage(browser, url, type = "movie", pageIdx = 0) {
  await warmUpSession(browser, type);

  const page = await browser.newPage();
  try {
    await page.setUserAgent(REALISTIC_USER_AGENT);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 120000,
      referer: type === "show" || type === "series" ? "https://mdblist.com/shows/" : "https://mdblist.com/movies/",
    });

    const linkSelector = type === "show" || type === "series" ? 'a[href^="/show/"]' : 'a[href^="/movie/"]';
    try {
      await page.waitForSelector(linkSelector, { timeout: 20000 });
    } catch (e) {
      throw new Error(`${type} links not found within 20s - page may be blocked or slow`);
    }

    const label = `page-${type}-p${pageIdx}`;
    await debugDump(page, label);

    const title = await page.title();
    if (/just a moment|attention required|checking your browser/i.test(title)) {
      await debugDump(page, `${label}-cloudflare-blocked`);
      throw new Error(`Blocked by Cloudflare challenge (page title: "${title}")`);
    }
    if (response?.status() === 403) {
      await debugDump(page, `${label}-403`);
      throw new Error(`Blocked by mdblist.com (HTTP 403, page title: "${title}")`);
    }

    const movies = await page.evaluate((type) => {
      const rows = [];
      const containers = document.querySelectorAll(".search-results-list > .card, .ui.cards.search-results-list > .card, .card");
      const linkPrefix = type === "show" || type === "series" ? "/show/" : "/movie/";

      containers.forEach((container) => {
        try {
          const itemLink = container.querySelector(`a[href^="${linkPrefix}"]`);
          const imdbLink = container.querySelector('.idtext a[href*="imdb.com/title/"]');
          const titleEl = container.querySelector(".header.movie-title, .header.show-title, .movie-title, .show-title");
          const scoreEl = container.querySelector(".idscore.search-score-main");
          const releaseDateEl = container.querySelector('[data-action="watched"][data-release-date]');
          const posterEl = container.querySelector("img.poster-card");
          const descEl = container.querySelector(".description.collapsible-description");

          if (!itemLink) return;

          const href = itemLink.getAttribute("href") || "";
          const slug = href.split(linkPrefix)[1]?.replace(/\/$/, "") || null;

          const imdbHref = imdbLink?.getAttribute("href") || "";
          const imdbMatch = imdbHref.match(/tt\d+/);
          const imdb_id = imdbMatch ? imdbMatch[0] : null;

          const titleText = (titleEl?.textContent || "").trim();
          const yearMatch = titleText.match(/\((\d{4})\)\s*$/);
          const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
          const title = titleText.replace(/\s*\(\d{4}\)\s*$/, "").trim();

          const scoreText = (scoreEl?.textContent || "").trim();
          const score = scoreText && scoreText !== "?" ? parseInt(scoreText, 10) : null;

          const releaseDate = releaseDateEl?.getAttribute("data-release-date") || null;

          const posterSrc = posterEl?.getAttribute("src") || "";
          const posterMatch = posterSrc.match(/\/([A-Za-z0-9]+\.jpg)$/);
          const poster_path = posterMatch ? posterMatch[1] : posterSrc || null;

          const description = (descEl?.textContent || "").trim() || null;

          if (!imdb_id || !slug) return;
          const row = { slug, imdb_id, title, year, score, poster_path, description };
          if (type === "show" || type === "series") {
            row.first_air_date = releaseDate;
          } else {
            row.digital_release_date = releaseDate;
          }
          rows.push(row);
        } catch (e) {
          // never let one malformed card break the whole page
        }
      });

      return rows;
    }, type);

    return movies;
  } catch (err) {
    await debugDump(page, `error-${type}-p${pageIdx}`);
    throw err;
  } finally {
    await page.close();
  }
}

export async function scrapeList(sourceUrl, browser, maxPages, type = "movie") {
  const allMovies = [];
  const errors = [];
  let pagesScraped = 0;

  for (let i = 0; i < maxPages; i++) {
    const url = buildPageUrl(sourceUrl, i);
    try {
      const movies = await scrapeOnePage(browser, url, type, i);
      pagesScraped++;
      if (movies.length === 0) break;
      allMovies.push(...movies);
    } catch (err) {
      errors.push(`Page ${i}: ${err.message}`);
      break;
    }
    if (i < maxPages - 1) await sleep(1500 + Math.random() * 2000);
  }

  return { movies: allMovies, pagesScraped, errors };
}

// ====================================================================
// OUTPUT - pretty-printed JSON into data/<id>.json
// ====================================================================
export function writeCatalog(list, movies) {
  // Empty result may mean a legitimate empty list or a silent scrape
  // failure - don't overwrite the last good file with an empty one.
  if (movies.length === 0) return null;
  mkdirSync(DATA_DIR, { recursive: true });
  const out = {
    catalog_id: list.id,
    name: list.name,
    type: list.type,
    scraped_at: Date.now(),
    items: movies,
  };
  const file = join(DATA_DIR, `${list.id}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return file;
}

export function deleteCatalog(id) {
  const file = join(DATA_DIR, `${id}.json`);
  try {
    rmSync(file, { force: true });
    console.log(`[${id}] deleted ${file}`);
  } catch (e) {
    console.warn(`[${id}] failed to delete ${file}: ${e.message}`);
  }
}

// ====================================================================
// MAIN
// ====================================================================
export async function main({ getConfig = fetchConfig, write = writeCatalog, recordRuns = postRuns } = {}) {
  // Delete ids arrive from workflow_dispatch inputs - reject anything
  // outside the id alphabet before join() can be exploited for path
  // traversal. Server config ids go through the same regex in
  // config.js:migrateConfig, so this only matters for CLI-direct calls.
  for (const id of deleteIds) {
    if (!/^mdb_scrape_[A-Za-z0-9_-]{1,32}$/.test(id)) {
      throw new Error(`Refusing to delete: "${id}" is not a valid list id.`);
    }
    deleteCatalog(id);
  }
  // Same guard for --lists ids; the worker only ever sees them after this.
  if (requestedIds && requestedIds.some((id) => !/^mdb_scrape_[A-Za-z0-9_-]{1,32}$/.test(id))) {
    throw new Error(`Refusing to scrape: --lists contained an invalid id.`);
  }

  const config = await fetchConfig();
  const lists = config.scraper && config.scraper.lists ? config.scraper.lists : [];
  const targets = requestedIds ? lists.filter((l) => requestedIds.includes(l.id)) : lists;
  const enabledTargets = targets.filter((l) => l.enabled);

  // Pure delete (action=scrape_delete with no --lists) must not also
  // re-scrape every enabled list - the empty list arg races the workflow
  // into "all lists".
  if (action === "scrape_delete" && !requestedIds) {
    console.log("Delete-only run - no lists to scrape.");
    process.exit(0);
  }

  if (enabledTargets.length === 0) {
    console.log("No enabled lists to scrape.");
    process.exit(0);
  }

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--window-size=1920,1080",
    ],
  });

  const runs = [];
  const results = [];
  try {
    for (const list of enabledTargets) {
      const startedAt = Date.now();
      const run = { catalog_id: list.id, started_at: startedAt, status: "failed", triggered_by: process.env.GITHUB_EVENT_NAME === "schedule" ? "scheduled" : "manual" };
      try {
        // Sanity check: must be an mdblist.com listing URL matching the type.
        const expectedPath = list.type === "series" ? "/shows/" : "/movies/";
        let parsed;
        try {
          parsed = new URL(list.url);
        } catch {
          throw new Error(`List "${list.name}" has an invalid URL - check the configure page.`);
        }
        if (parsed.hostname !== "mdblist.com" || !parsed.pathname.startsWith(expectedPath)) {
          throw new Error(
            `List "${list.name}" has type="${list.type}" but url isn't mdblist.com${expectedPath} (got ${parsed.hostname}${parsed.pathname}) - check the configure page.`
          );
        }

        const { movies, pagesScraped, errors } = await scrapeList(list.url, browser, list.maxPages, list.type);

        // De-dupe by imdb_id in case pagination overlaps.
        const seen = new Set();
        const deduped = movies.filter((m) => {
          if (seen.has(m.imdb_id)) return false;
          seen.add(m.imdb_id);
          return true;
        });

        write(list, deduped);

        run.status = deduped.length > 0 && !errors.length ? "success" : "failed";
        run.finished_at = Date.now();
        run.pages_scraped = pagesScraped;
        run.movies_found = deduped.length;
        run.error_message = errors.length ? errors.join(" | ") : null;
        results.push({ catalog: list.id, pagesScraped, moviesFound: deduped.length, errors });
        console.log(
          `[${list.id}] ${run.status} - ${deduped.length} ${list.type === "series" ? "shows" : "movies"} across ${pagesScraped} page(s)` +
            (errors.length ? ` (errors: ${errors.join("; ")})` : "")
        );
      } catch (err) {
        run.finished_at = Date.now();
        run.pages_scraped = 0;
        run.movies_found = 0;
        run.error_message = err.message;
        results.push({ catalog: list.id, error: err.message });
        console.error(`[${list.id}] failed: ${err.message}`);
      }
      runs.push(run);
    }
  } finally {
    await browser.close();
  }

  await postRuns(runs);

  console.log("\nSummary:", JSON.stringify(results, null, 2));

  const failed = results.filter((r) => r.error || (r.errors && r.errors.length));
  if (failed.length && isMain) process.exit(1);
}

if (isMain) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
