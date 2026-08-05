// Config + scrape-run-history storage in KV (binding STORE).
// Scraper module: each list = { id, name, url, type, maxPages, enabled }.
// id = mdb_scrape_<8 random alnum chars>, generated once at creation, permanent.
// Official module: 3 fixed MDBList official lists, never editable/deletable,
// only enabled-toggled. Their catalog files live in data/mdboff_*_*.json.

import { createHash } from "node:crypto";

const CONFIG_KEY = "config";
const RUNS_SCRAPER_KEY = "runs:scraper";
const RUNS_OFFICIAL_KEY = "runs:official";
const RUNS_MAX = 30;
const HEALED_KEY = "healed";
const RANDOM_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function runsKeyFor(catalogId) {
  return catalogId.startsWith("mdboff_") ? RUNS_OFFICIAL_KEY : RUNS_SCRAPER_KEY;
}

export const OFFICIAL_RUNS_KEY = RUNS_OFFICIAL_KEY;

// Seeded IDs are derived from the listing URL (first 8 hex of sha256),
// so the ID the config shows is the ID the scraper writes under - even
// on a fresh KV that has never seen the seed list before.
export function randomScraperId(seedUrl) {
  const seed = seedUrl || Math.random().toString(36).slice(2);
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += RANDOM_ID_CHARS[parseInt(hex[i], 16) % RANDOM_ID_CHARS.length];
  }
  return "mdb_scrape_" + out;
}

export function emptyConfig() {
  return { scraper: { lists: [] }, official: { lists: [] } };
}

// The three MDBList official lists. Slugs are fixed forever - they produce
// the catalog / data file ids mdboff_<slug>_<movie|show>. Users can only
// enable/disable; there is no delete, edit, or add.
export const OFFICIAL_LISTS = [
  { slug: "popular", name: "Popular" },
  { slug: "justwatch-streaming-charts", name: "JustWatch Streaming Charts" },
  { slug: "moviemeter", name: "MovieMeter" },
];

export const OFFICIAL_CATALOGS = OFFICIAL_LISTS.flatMap((o) => [
  { id: `mdboff_${o.slug}_movie`, slug: o.slug, name: `${o.name} - Movies`, type: "movie" },
  { id: `mdboff_${o.slug}_show`, slug: o.slug, name: `${o.name} - Shows`, type: "series" },
]);

// Source URLs for the three pre-seeded scraper lists - lifted verbatim
// from the old repo's scraper/catalogs.json (filters stay byte-identical;
// only pagination params get overridden at scrape time).
const SEED_LISTS = [
  {
    // Pinned to the ID the data file was first committed under - once a
    // scraper write lands in data/<id>.json that id is forever.
    id: "mdb_scrape_1djyii3b",
    name: "Latest Movie(digital releases)",
    url: "https://mdblist.com/movies/?q_title=&q_sort=releasedigital&q_sortorder=asc&q_current_page=0&actor=&director=&yearf=&yeart=&yearr=365&yearu=0&q_score_input=1&q_score_input_max=100&q_rogerebert_input=0.0&q_rogerebert_input_max=4.0&q_imdbrating_input=4.0&q_imdbrating_input_max=10.0&q_imdbvotes_input=400&q_traktrating_input=0&q_traktrating_input_max=100&q_traktvotes_input=0&q_tmdbrating_input=0&q_tmdbrating_input_max=100&q_tmdbvotes_input=1&q_letterrating_input=0.0&q_letterrating_input_max=5.0&q_lettervotes_input=0&q_metacriticsrating_input=0&q_metacriticsrating_input_max=100&q_metacriticsvotes_input=0&q_tomatoesrating_input=0&q_tomatoesrating_input_max=100&q_tomatoesvotes_input=0&q_audiencerating_input=0&q_audiencerating_input_max=100&q_audiencevotes_input=0&q_anidbrating_input=0.0&q_anidbrating_input_max=10.0&q_anidbvotes_input=0&parental_nudity_min_i=0&parental_nudity_i=5&parental_violence_min_i=0&parental_violence_i=5&parental_language_min_i=0&parental_language_i=5&parental_drinking_min_i=0&parental_drinking_i=5&q_score_average=on&tmdbid_hide=on&q_genre_exclude=documentary&q_genre_exclude=game-show&q_genre_exclude=home-and-garden&q_genre_exclude=news&q_genre_exclude=reality&q_genre_exclude=reality-tv&q_genre_exclude=special-interest&q_genre_exclude=sporting-event&q_genre_exclude=talk-show&q_genre_exclude=tv-movie&q_status=released&q_release=4&release_regions=&release_days_past=&release_days_future=&q_language_x=ml&q_language_x=ta&q_language_x=te&q_country=&q_country_x=mx%2Cpk%2Ckr%2Cru%2Ctr%2Ccn%2Ceg%2Cbd%2Ctw%2Cid&budget=&revenue=&production_country=&production_country_exclude=&q_runtime_min=&q_runtime_max=&q_list=&q_listx=&q_tagx=10979&q_tagx=124256&q_tagx=295269&q_tagx=295272&q_theater=&q_region=US%2CCA%2CIN&q_provider_x=11&q_provider_x=73&q_provider_x=212&q_provider_x=232&q_provider_x=257&q_provider_x=528&q_limit=200&q_watched=&q_trakt_list_name=&q_trakt_list_desc=",
    type: "movie",
    maxPages: 3,
    enabled: true,
  },
  {
    id: "mdb_scrape_cwqwfd58",
    name: "r/movieleaks Movie",
    url: "https://mdblist.com/movies/?q_title=&q_sort=&q_sortorder=asc&q_current_page=0&actor=&director=&yearf=&yeart=&yearr=&yearu=&q_score_input=0&q_score_input_max=100&q_rogerebert_input=0.0&q_rogerebert_input_max=4.0&q_imdbrating_input=0.0&q_imdbrating_input_max=10.0&q_imdbvotes_input=0&q_traktrating_input=0&q_traktrating_input_max=100&q_traktvotes_input=0&q_tmdbrating_input=0&q_tmdbrating_input_max=100&q_tmdbvotes_input=0&q_letterrating_input=0.0&q_letterrating_input_max=5.0&q_lettervotes_input=0&q_metacriticsrating_input=0&q_metacriticsrating_input_max=100&q_metacriticsvotes_input=0&q_tomatoesrating_input=0&q_tomatoesrating_input_max=100&q_audiencerating_input=0&q_audiencerating_input_max=100&q_anidbrating_input=0.0&q_anidbrating_input_max=10.0&q_anidbvotes_input=0&parental_nudity_min_i=0&parental_nudity_i=5&parental_violence_min_i=0&parental_violence_i=5&parental_language_min_i=0&parental_language_i=5&parental_drinking_min_i=0&parental_drinking_i=5&release_regions=&release_days_past=&release_days_future=&q_country=&q_country_x=&budget=&revenue=&production_country=&production_country_exclude=&q_runtime_min=&q_runtime_max=&q_list=79&q_listx=&q_theater=&q_region=US&q_limit=&q_watched=&q_trakt_list_name=&q_trakt_list_desc=",
    type: "movie",
    maxPages: 3,
    enabled: true,
  },
  {
    id: "mdb_scrape_ogu4jkeo",
    name: "Latest Shows",
    url: "https://mdblist.com/shows/?q_title=&q_sort=released&q_sortorder=asc&q_current_page=0&actor=&director=&yearf=&yeart=&yearr=&yearu=0&q_score_input=1&q_score_input_max=100&q_rogerebert_input=0.0&q_rogerebert_input_max=4.0&q_imdbrating_input=4.0&q_imdbrating_input_max=10.0&q_imdbvotes_input=400&q_traktrating_input=0&q_traktrating_input_max=100&q_traktvotes_input=0&q_tmdbrating_input=0&q_tmdbrating_input_max=100&q_tmdbvotes_input=0&q_letterrating_input=0.0&q_letterrating_input_max=5.0&q_lettervotes_input=0&q_metacriticsrating_input=0&q_metacriticsrating_input_max=100&q_metacriticsvotes_input=0&q_tomatoesrating_input=0&q_tomatoesrating_input_max=100&q_audiencerating_input=0&q_audiencerating_input_max=100&q_anidbrating_input=0.0&q_anidbrating_input_max=10.0&q_anidbvotes_input=0&parental_nudity_min_i=0&parental_nudity_i=5&parental_violence_min_i=0&parental_violence_i=5&parental_language_min_i=0&parental_language_i=5&parental_drinking_min_i=0&parental_drinking_i=5&q_score_average=on&q_genre_exclude=anime&q_genre_exclude=children&q_genre_exclude=holiday&q_genre_exclude=home-and-garden&q_genre_exclude=music&q_genre_exclude=musical&q_genre_exclude=news&q_genre_exclude=reality&q_genre_exclude=reality-tv&q_genre_exclude=short&q_genre_exclude=soap&q_genre_exclude=special-interest&q_genre_exclude=sport&q_genre_exclude=sporting-event&q_genre_exclude=talk-show&q_status=returning+series&q_status=ended&q_status=canceled&q_status=pilot&q_status=continuing&last_aired=&q_language_x=ml&q_language_x=te&q_country=&q_country_x=pk%2Csa&production_country=&production_country_exclude=&q_runtime_min=&q_runtime_max=&q_eruntime_min=&q_eruntime_max=&q_list=&q_listx=&q_network_x=YouTube&q_region=US%2CCA%2CIN&q_provider_x=11&q_provider_x=192&q_provider_x=232&q_limit=200&q_watched=&q_trakt_list_name=&q_trakt_list_desc=",
    type: "series",
    maxPages: 3,
    enabled: true,
  },
];

// Assign each seeded list its pinned id (matching the data file already
// committed under that id). On subsequent loads the existing config
// wins, so the ids never change.
export function seedScraperDefaults(cfg) {
  if (cfg.scraper && Array.isArray(cfg.scraper.lists) && cfg.scraper.lists.length > 0) return cfg;
  return { ...cfg, scraper: { lists: SEED_LISTS.map((s) => ({ ...s })) } };
}

export function officialDefaults() {
  return OFFICIAL_LISTS.map((o) => ({ slug: o.slug, name: o.name, enabled: true }));
}

// Persisted official section: only the 3 fixed slugs, only their enabled
// flag survives. Slug must be one of the knowns or it's dropped (extras,
// renames, stale entries all fall away here).
export function migrateOfficial(raw) {
  const rawLists = Array.isArray(raw?.official?.lists) ? raw.official.lists : [];
  const map = new Map(OFFICIAL_LISTS.map((o) => [o.slug, true]));
  return rawLists
    .filter((l) => l && typeof l.slug === "string" && map.has(l.slug))
    .map((l) => ({ slug: l.slug, name: l.name, enabled: l.enabled !== false }));
}

export function migrateConfig(raw) {
  const src = (raw && raw.scraper) || {};
  const lists = Array.isArray(src.lists) ? src.lists : [];
  const migrated = lists.map((l) => ({
    // No path separators or traversal - a crafted id like
    // "mdb_scrape_a/../../../x" would otherwise reach scrape.mjs and
    // writeCatalog/deleteCatalog's join() and escape data/. Looseness
    // on the tail keeps legacy ids (healing) intact while blocking / \ ..
    id: typeof l.id === "string" && /^mdb_scrape_[A-Za-z0-9_-]{1,32}$/.test(l.id) ? l.id : randomScraperId(l.url || l.name || "unnamed"),
    name: String(l.name || "").trim().slice(0, 200) || "Untitled",
    url: String(l.url || "").slice(0, 2000),
    type: l.type === "series" ? "series" : "movie",
    maxPages: Number.isFinite(l.maxPages) ? Math.min(50, Math.max(1, Math.floor(l.maxPages))) : 3,
    enabled: l.enabled !== false,
  }));
  return { scraper: { lists: migrated }, official: { lists: migrateOfficial(raw) } };
}

// Fields that affect the scraped data file: url, maxPages, enabled.
// Name/type only affect the manifest (built live from config), so they
// deliberately don't appear here - renaming a list must not re-scrape.
export function listContentHash(list) {
  return createHash("sha256")
    .update([list.url, list.maxPages, list.enabled ? 1 : 0].join(" "))
    .digest("hex")
    .slice(0, 16);
}

export async function loadConfig(kv) {
  let raw = null;
  try {
    raw = await kv.get(CONFIG_KEY, "json");
  } catch {
    raw = null; // corrupt KV value → fall back to seeds rather than 500
  }
  const migrated = migrateConfig(raw);
  // Seed only when the KV key was genuinely absent - an operator who
  // saved an empty list (deleted every list) must keep it empty, not
  // have the seeds re-appear on the next read.
  const wasSeeded = raw === null;
  const cfg = wasSeeded && migrated.scraper.lists.length === 0
    ? seedScraperDefaults(migrated)
    : migrated;

  // Normalize the official section to exactly the 3 known slugs. Missing
  // official key (old saved configs) → defaults; known slugs keep their
  // persisted enabled flag; unknown/stale slugs get dropped.
  const known = new Map(officialDefaults().map((o) => [o.slug, o]));
  if (!Array.isArray(cfg.official?.lists) || cfg.official.lists.length === 0) {
    cfg.official = { lists: officialDefaults() };
  } else {
    const kept = cfg.official.lists
      .filter((l) => l && typeof l.slug === "string" && known.has(l.slug))
      .map((l) => ({ slug: known.get(l.slug).slug, name: known.get(l.slug).name, enabled: l.enabled !== false }));
    // Always exactly 3 - a truncated/extra list here must not silently
    // drop or duplicate a fixed catalog.
    cfg.official.lists = known.size === kept.length ? kept : officialDefaults();
  }

  // One-shot healing: if any persisted list matches a seed entry by URL
  // but carries a different id (e.g. a random id from before the seed
  // list pinned its ids), rewrite it to the pinned id so it matches the
  // file the scraper wrote to data/. Runs once ever (HEALED_KEY), so a
  // user re-adding a seed URL later keeps their own id and never gets it
  // rewritten mid-save.
  let healed = false;
  const alreadyHealed = !!(await kv.get(HEALED_KEY));
  if (!wasSeeded && !alreadyHealed) {
    const seedByUrl = new Map(SEED_LISTS.map((s) => [s.url, s]));
    cfg.scraper.lists = cfg.scraper.lists.map((l) => {
      const seed = seedByUrl.get(l.url);
      if (!seed) return l;
      if (l.id !== seed.id) { healed = true; return { ...l, id: seed.id }; }
      return l;
    });
  }

  // Persist the seeded defaults on first load so the list IDs are
  // permanent - without this, every read re-seeds new IDs and the
  // catalog data files (committed under the original IDs) never match
  // the config.
  if ((wasSeeded && cfg.scraper.lists.length > 0) || healed) {
    await kv.put(CONFIG_KEY, JSON.stringify(cfg));
    if (healed) await kv.put(HEALED_KEY, "1");
  }
  return cfg;
}

export async function saveConfig(kv, cfg) {
  await kv.put(CONFIG_KEY, JSON.stringify(cfg));
}

// ---- scrape-run history (last 30 per module, most recent first) ----
// Scraper runs live under runs:scraper, official runs under runs:official.

export async function addRun(kv, run, key = RUNS_SCRAPER_KEY) {
  const runs = (await kv.get(key, "json")) || [];
  runs.unshift(run);
  await kv.put(key, JSON.stringify(runs.slice(0, RUNS_MAX)));
}

export async function getRuns(kv, key = RUNS_SCRAPER_KEY) {
  return (await kv.get(key, "json")) || [];
}