#!/usr/bin/env node
/**
 * my-list SIMKL Arriving Today - runs on GitHub Actions, fetches SIMKL's
 * v2 calendar (tv + anime) for today's entries, applies the operator's
 * per-list filters (genre/country excludes + rating tiers) from the
 * worker config, writes data/simkl_arriving_today_<kind>.json (served via
 * GitHub Pages), and POSTs run records to the worker's /runs endpoint.
 *
 * Unlike official.mjs, an EMPTY result is legitimate (a real day with no
 * airings) and overwrites the previous file. A fetch/filter crash does not.
 *
 * Required env (GitHub repo secrets / workflow env):
 *   SIMKL_CLIENT_ID - SIMKL API client id (data.simkl.in v2 calendar)
 *   WORKER_ORIGIN   - worker base URL (run records + config)
 *   WORKER_SECRET   - worker shared secret for /runs + /export-config
 *
 * Usage:
 *   node simkl.mjs                  # refresh all enabled kinds (series + anime)
 *   node simkl.mjs --kinds=series   # refresh one kind
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const DATA_DIR = join(ROOT, "data");

const SIMKL_CLIENT_ID = process.env.SIMKL_CLIENT_ID;
const WORKER_ORIGIN = process.env.WORKER_ORIGIN;
const WORKER_SECRET = process.env.WORKER_SECRET;
const SIMKL_APP_NAME = "simkl-arriving-today";
const SIMKL_APP_VERSION = "3.9.0";
const CALENDAR = { series: "tv", anime: "anime" };

export const KINDS = ["series", "anime"];

export function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const kindsArg = arg("kinds");

// SIMKL v2 calendar endpoint: data.simkl.in/calendar/v2/{tv,anime}.json
// returns { calendar, metadata }. metadata is keyed by simkl_id and
// already includes genres/country/ratings - no per-title detail calls.
export function simklUrl(kind) {
  const params = new URLSearchParams({
    client_id: SIMKL_CLIENT_ID,
    "app-name": SIMKL_APP_NAME,
    "app-version": SIMKL_APP_VERSION,
  });
  return `https://data.simkl.in/calendar/v2/${CALENDAR[kind]}.json?${params}`;
}

// Worker is the source of truth for enabled simkl kinds AND their filters.
// Falls back to built-in defaults when the worker is unreachable so a
// worker outage can't silently stop the refresh (same as official.mjs).
export const DEFAULT_FILTERS = {
  series: {
    rating_source: "imdb",
    rating_filter_enabled: true,
    exclude_genres: ["Talk Show", "Reality", "Sport", "News", "Soap", "Documentary", "Home and Garden", "Food", "Podcast", "Game Show"],
    include_countries: [],
    exclude_countries: ["cn", "kr", "pt", "jp"],
    rating_tiers: [
      { min_rating: 7.0, min_votes: 500 },
      { min_rating: 6.0, max_rating: 6.9, min_votes: 5000 },
    ],
  },
  anime: {
    rating_source: "mal",
    rating_filter_enabled: true,
    exclude_genres: [],
    include_countries: [],
    exclude_countries: ["cn"],
    rating_tiers: [
      { min_rating: 8.0, min_votes: 0 },
      { min_rating: 7.0, max_rating: 7.9, min_votes: 5000 },
      { min_rating: 7.0, max_rating: 7.9, min_secondary_rating: 8.0 },
    ],
  },
};

export async function enabledKindsAndFilters() {
  if (!WORKER_ORIGIN) return KINDS.map((k) => ({ kind: k, filter: DEFAULT_FILTERS[k] }));
  try {
    const res = await fetch(`${WORKER_ORIGIN}/export-config`, {
      headers: WORKER_SECRET ? { "X-Admin-Secret": WORKER_SECRET } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return KINDS.map((k) => ({ kind: k, filter: DEFAULT_FILTERS[k] }));
    const cfg = await res.json();
    const enabled = new Set((cfg.simkl?.lists || []).filter((l) => l.enabled).map((l) => l.slug));
    if (enabled.size === 0) return KINDS.map((k) => ({ kind: k, filter: DEFAULT_FILTERS[k] }));
    return KINDS.filter((k) => enabled.has(k)).map((k) => {
      const l = (cfg.simkl?.lists || []).find((x) => x.slug === k);
      return { kind: k, filter: l?.filter || DEFAULT_FILTERS[k] };
    });
  } catch {
    return KINDS.map((k) => ({ kind: k, filter: DEFAULT_FILTERS[k] }));
  }
}

// Same /export-config call, returning the full cfg (not just kinds + filters).
// Used so writeCatalog can stamp the operator-renamed name on the data file.
export async function getFullConfig() {
  if (!WORKER_ORIGIN) return null;
  try {
    const res = await fetch(`${WORKER_ORIGIN}/export-config`, {
      headers: WORKER_SECRET ? { "X-Admin-Secret": WORKER_SECRET } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── filter helpers (logic lifted from the legacy mdblist-simkl worker) ──

export function matchesCountry(includelist, excludelist, country) {
  if (excludelist.length > 0 && country && excludelist.some((c) => c.toLowerCase() === country.toLowerCase())) {
    return false;
  }
  if (includelist.length === 0) return true;
  if (!country) return false;
  return includelist.some((c) => c.toLowerCase() === country.toLowerCase());
}

// A title passes if it clears ANY ONE tier; a tier passes only if EVERY
// field it defines holds. Fields left undefined aren't checked. The
// primary rating is the list's rating_source (imdb for series, mal for
// anime); min_secondary_rating always tests the Simkl rating.
export function passesRatingTiers(tiers, primary, secondary) {
  if (!tiers || tiers.length === 0) return true;
  const rating = primary?.rating;
  if (rating == null) return false;
  const votes = Number(primary?.votes ?? 0);
  const secondaryRating = secondary?.rating ?? null;

  return tiers.some((tier) => {
    if (tier.min_rating != null && rating < tier.min_rating) return false;
    if (tier.max_rating != null && rating > tier.max_rating) return false;
    if (tier.min_votes != null && votes < tier.min_votes) return false;
    if (tier.min_secondary_rating != null) {
      if (secondaryRating == null || secondaryRating < tier.min_secondary_rating) return false;
    }
    return true;
  });
}

export function simklPoster(path) {
  return path ? `https://simkl.in/posters/${path}_m.webp` : "https://simkl.in/poster_no_pic_c.png";
}

export function formatRatings(ratings, secondSourceKey, secondSourceLabel) {
  const fmt = (src) => {
    if (!src || src.rating == null) return "n/a";
    const votes = src.votes != null ? ` (${src.votes})` : "";
    return `${src.rating.toFixed(1)}${votes}`;
  };
  const simkl = fmt(ratings?.simkl);
  const second = fmt(ratings?.[secondSourceKey]);
  return `Simkl ${simkl} | ${secondSourceLabel} ${second}`;
}

// ── precompute (group, filter, label, sort) ──

const FINALE_LABEL = {
  1: "🏁 Finale (mid-season)",
  2: "🏁 Finale (season)",
  3: "🏁 Finale (series)",
};
const FINALE_PRIORITY = { 3: 4, 2: 3, 1: 2 };
const LABEL = {
  new_show: "🆕 New Show",
  new_season: "🎬 New Season",
  standard: "📺 New Episode",
};
const PRIORITY = { new_show: 6, new_season: 5, standard: 1 };

export async function precompute(kind, todaysEntries, metadata, filter) {
  const f = filter || DEFAULT_FILTERS[kind];
  const isAnime = kind === "anime";

  const byShow = new Map();
  for (const entry of todaysEntries) {
    const simklId = entry.simkl_id;
    if (!simklId) continue;
    const show = metadata[simklId] ?? metadata[String(simklId)];
    if (!show) continue;

    const imdbId = show.ids?.imdb;
    const tmdbId = show.ids?.tmdb;
    const kitsuId = show.ids?.kitsu;
    const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null) || (kitsuId ? `kitsu:${kitsuId}` : null);
    if (!id) continue;

    if (!byShow.has(simklId)) {
      byShow.set(simklId, { simklId, id, title: show.title, show, episodes: [] });
    }
    byShow.get(simklId).episodes.push({
      season: entry.episode?.season,
      episode: entry.episode?.episode,
      airDate: entry.date,
      finaleType: entry.finale_type ?? null,
    });
  }

  const metas = [];
  for (const item of byShow.values()) {
    // If a finale exists among today's entries, display THAT entry's S/E,
    // not just the highest-numbered one, so the badge and episode match.
    const finaleEntry = item.episodes.find((e) => e.finaleType != null) ?? null;

    const headline = finaleEntry ?? item.episodes.reduce((best, cur) => {
      if (!best) return cur;
      if (!isAnime && (cur.season ?? 0) !== (best.season ?? 0)) return (cur.season ?? 0) > (best.season ?? 0) ? cur : best;
      return (cur.episode ?? 0) > (best.episode ?? 0) ? cur : best;
    }, null);

    const finaleType = finaleEntry?.finaleType ?? null;
    const season = headline?.season;
    const episode = headline?.episode;
    const genres = item.show.genres ?? [];
    const country = item.show.country ?? null;

    if (f.exclude_genres.length > 0 && genres.some((g) => f.exclude_genres.map((x) => x.toLowerCase()).includes(String(g).toLowerCase()))) continue;
    if (!matchesCountry(f.include_countries, f.exclude_countries, country)) continue;

    let type = "standard";
    if (finaleType != null) {
      type = "finale";
    } else if (isAnime ? episode === 1 : season === 1 && episode === 1) {
      type = "new_show";
    } else if (!isAnime && episode === 1 && season > 1) {
      type = "new_season";
    }

    // New shows are exempt from the rating filter - no track record yet.
    // Genre/country filters above still apply.
    if (type !== "new_show" && f.rating_filter_enabled && !passesRatingTiers(f.rating_tiers, item.show.ratings?.[f.rating_source], item.show.ratings?.simkl)) continue;

    const label = finaleType != null ? FINALE_LABEL[finaleType] : LABEL[type];
    const priority = finaleType != null ? FINALE_PRIORITY[finaleType] : PRIORITY[type];

    const s = !isAnime && season != null ? `S${String(season).padStart(2, "0")}` : "";
    const e = episode != null ? `E${String(episode).padStart(2, "0")}` : "";
    const airsUtc = headline?.airDate ? new Date(headline.airDate).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
    const ratingsStr = formatRatings(item.show.ratings, isAnime ? "mal" : "imdb", isAnime ? "MAL" : "IMDb");

    metas.push({
      id: item.id,
      type: "series",
      name: item.title,
      poster: simklPoster(item.show.poster),
      description: `${label} | ${s}${e} | ${airsUtc} | ${country ? country.toUpperCase() : "??"} | genres: ${genres.join(", ") || "none"} | ${ratingsStr}`,
      _pri: priority,
      _rating: (item.show.ratings?.[f.rating_source]?.rating) ?? -1,
    });
  }

  // Within New Episode (priority 1), rank higher-rated shows first.
  // Everything else keeps insertion order within its tier (stable sort).
  return metas
    .sort((a, b) => (b._pri - a._pri) || (b._pri === 1 ? b._rating - a._rating : 0))
    .map(({ _pri, _rating, ...m }) => m);
}

// v2 dates are UTC with a trailing 'Z' - no offset math needed.
export async function fetchTodaysCalendar(kind) {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const res = await fetch(simklUrl(kind), {
    headers: { "User-Agent": `${SIMKL_APP_NAME}/${SIMKL_APP_VERSION}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SIMKL Calendar v2 (${kind}) fetch ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const calendar = data?.calendar || [];
  const metadata = data?.metadata || {};
  const todaysEntries = calendar.filter((entry) => {
    if (!entry?.date) return false;
    const d = new Date(entry.date);
    if (isNaN(d.getTime())) return false;
    return d.toISOString().slice(0, 10) === todayUtc;
  });
  return { todaysEntries, metadata };
}

// hardcoded fallback if worker cfg is unavailable (rename couldn't
// propagate, but the catalog must still write something to stay live).
const SIMKL_DEFAULT_NAMES = Object.fromEntries(
  KINDS.map((k) => [k, k === "anime" ? "Anime Arriving Today - Episodes & Premieres" : "Arriving Today - Episodes & Premieres"])
);

export function writeCatalog(kind, items, cfg) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `simkl_arriving_today_${kind}.json`);
  // Operator rename in /configure is the source of truth for what this
  // list is called. Constant fallback if cfg is missing or the kind
  // disappeared from the saved simkl section.
  const renamed = cfg?.simkl?.lists?.find((l) => l.slug === kind)?.name;
  const out = {
    catalog_id: `simkl_arriving_today_${kind}`,
    name: renamed || SIMKL_DEFAULT_NAMES[kind],
    type: "series",
    scraped_at: Date.now(),
    items,
  };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return file;
}

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
  kindsArg: rawKinds = kindsArg,
  fetchConfig = enabledKindsAndFilters,
  fetchCfg = getFullConfig,
  fetchApi = fetchTodaysCalendar,
  compute = precompute,
  write = writeCatalog,
  recordRuns = postRuns,
} = {}) {
  // CLI kinds arrive from workflow_dispatch - allow only the two known
  // slugs (series, anime) before they reach writeCatalog's join().
  const SANE_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
  let targets;
  if (rawKinds) {
    targets = rawKinds.split(",").filter(Boolean).filter((k) => SANE_KIND.test(k)).map((k) => ({ kind: k, filter: DEFAULT_FILTERS[k] }));
    targets = targets.filter((t) => t.filter);
    if (targets.length === 0) targets = await fetchConfig();
  } else {
    targets = await fetchConfig();
  }
  // Pull cfg separately so writeCatalog can stamp the operator-renamed
  // name onto the data file. Same endpoint as fetchConfig; both are
  // budgeted into the same 30s timeout per-kind elsewhere.
  const cfg = await fetchCfg().catch(() => null);
  const runs = [];
  const results = [];
  for (const t of targets) {
    const startedAt = Date.now();
    const run = { catalog_id: `simkl_arriving_today_${t.kind}`, started_at: startedAt, status: "failed", triggered_by: process.env.GITHUB_EVENT_NAME === "schedule" ? "scheduled" : "manual" };
    try {
      const { todaysEntries, metadata } = await fetchApi(t.kind);
      const items = await compute(t.kind, todaysEntries, metadata, t.filter);
      write(t.kind, items, cfg); // empty IS a valid result here (empty day)
      run.status = "success";
      run.finished_at = Date.now();
      run.pages_scraped = 1;
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

  await recordRuns(runs);

  console.log("\nSummary:", JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.error);
  if (failed.length && isMain) process.exit(1);
}

export const isMain = typeof process !== "undefined" && !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!SIMKL_CLIENT_ID) {
    console.error("Missing SIMKL_CLIENT_ID env var.");
    process.exit(1);
  }
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
