// Stremio-facing routes: manifest + catalog serving. Catalog data files
// live in the repo's data/ dir (GitHub Pages); the worker is a thin
// fetcher, never touching mdblist itself.

import { loadConfig, migrateConfig, listContentHash, tmdbContentHash, normalizeTmdbList, randomTmdbListId, addRun, getRuns, saveConfig, runsKeyFor, OFFICIAL_CATALOGS, SIMKL_CATALOGS, SIMKL_RUNS_KEY, TMDB_RUNS_KEY } from "./config.js";
import { dispatchScraperWorkflow } from "./dispatch.js";
import { buildConfigurePage } from "./configure.js";

export const ADDON_ID = "com.mylist";
export const ADDON_NAME = "my-list";
export const ADDON_VERSION = "0.1.0";
export const ADDON_DESCRIPTION = "Community-built catalogs: MDBList scraper lists + MDBList official lists.";

// Official module's workflow file - separate cron from the scraper's.
export const OFFICIAL_WORKFLOW = "official.yml";
export const SIMKL_WORKFLOW = "simkl.yml";
export const TMDB_WORKFLOW = "tmdb.yml";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "x-content-type-options": "nosniff", ...corsHeaders, ...extraHeaders },
  });
}

function html(body, extraHeaders = {}) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

// Stremio pagination arrives as /catalog/<type>/<id>/skip=N.json - the
// trailing segment is part of the id token, so handle it like the old
// worker did.
export const CATALOG_RE = /^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.*))?\.json$/;

export function githubPagesCatalogUrl(env, catalogId) {
  return `${env.GITHUB_PAGES_BASE}/data/${catalogId}.json`;
}

// Configure page returns a full Response (html helper lives here too).
export function configureResponse(env, origin, config) {
  return html(buildConfigurePage(origin, config));
}

export function toIST(ms) {
  if (!ms) return null;
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  let h24 = d.getUTCHours();
  const ampm = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(h12)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${ampm}`;
}

export async function buildManifest(env) {
  const cfg = await loadConfig(env.STORE);
  const enabled = cfg.scraper.lists.filter((l) => l.enabled);
  // Scraper lists first, then official lists (only their enabled slugs),
  // then simkl lists. Simkl catalogs declare no skip extra - they're
  // single-shot arrival listings, not paginated.
  // Official/simkl catalog NAMES are the operator's saved name (renamed in
  // /configure), falling back to the constant default. The constants stay
  // the source of id/type/slug and the data-file name on the next regen.
  const officialBySlug = new Map(cfg.official.lists.map((l) => [l.slug, l.name]));
  const enabledOfficial = new Set(cfg.official.lists.filter((l) => l.enabled).map((l) => l.slug));
  const officialCatalogs = OFFICIAL_CATALOGS
    .filter((c) => enabledOfficial.has(c.slug))
    .map((c) => ({ name: officialBySlug.get(c.slug) || c.name, id: c.id, type: c.type, extra: [{ name: "skip", isRequired: false }] }));
  const simklBySlug = new Map(cfg.simkl.lists.map((l) => [l.slug, l.name]));
  const enabledSimkl = new Set(cfg.simkl.lists.filter((l) => l.enabled).map((l) => l.slug));
  const simklCatalogs = SIMKL_CATALOGS
    .filter((c) => enabledSimkl.has(c.slug))
    .map((c) => ({ name: simklBySlug.get(c.slug) || c.name, id: c.id, type: c.type, extra: [] }));
  // TMDB discover lists: one list = one catalog (mediaType baked into the id).
  const tmdbCatalogs = cfg.tmdb.lists
    .filter((l) => l.enabled)
    .map((l) => ({
      name: l.name,
      id: `tmdb_discover_${l.mediaType}_${l.discoverListId}`,
      type: l.mediaType,
      extra: [{ name: "skip", isRequired: false }],
    }));
  const catalogs = [
    ...enabled.map((l) => ({
      name: l.name,
      id: l.id,
      type: l.type,
      extra: [{ name: "skip", isRequired: false }],
    })),
    ...officialCatalogs,
    ...simklCatalogs,
    ...tmdbCatalogs,
  ];
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: ADDON_DESCRIPTION,
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs,
  };
}

function rowToMeta(row) {
  return {
    id: row.imdb_id,
    type: row.first_air_date ? "series" : "movie",
    name: row.title,
    poster: row.poster_path
      ? row.poster_path.startsWith("http")
        ? row.poster_path
        : `https://image.tmdb.org/t/p/w500/${row.poster_path}`
      : undefined,
    releaseInfo: row.year ? String(row.year) : undefined,
    imdbRating: row.score ? (row.score / 10).toFixed(1) : undefined,
  };
}

function rowToMetaOfficial(row) {
  return {
    id: row.imdb_id,
    type: row.type,
    name: row.title,
    poster: row.poster || undefined,
    releaseInfo: row.year ? String(row.year) : undefined,
    imdbRating: row.imdb_rating ? (row.imdb_rating / 10).toFixed(1) : undefined,
  };
}

// Simkl data files (simkl_arriving_today_*.json) carry { id, name } per
// item, not the scraper's imdb_id/title shape - id/name pass through.
function rowToMetaSimkl(row) {
  return {
    id: row.id || row.imdb_id,
    type: "series",
    name: row.name || row.title,
    poster: row.poster || undefined,
    description: row.description || undefined,
  };
}

// TMDB discover data files store raw TMDB result objects (parts shape from
// the old tmdb worker, plus series title/release_date aliases). Stremio
// metas use tmdb:<id> ids.
function rowToMetaTmdb(row, type) {
  return {
    id: `tmdb:${row.id}`,
    type: type === "series" ? "series" : "movie",
    name: row.title || row.name,
    poster: row.poster_path ? `https://image.tmdb.org/t/p/w500${row.poster_path}` : undefined,
    releaseInfo: row.release_date ? String(row.release_date).slice(0, 4) : undefined,
  };
}

export async function handleCatalog(env, catalogType, catalogId, skip) {
  const cfg = await loadConfig(env.STORE);
  const official = OFFICIAL_CATALOGS.find((c) => c.id === catalogId);
  const simkl = SIMKL_CATALOGS.find((c) => c.id === catalogId);
  const list = cfg.scraper.lists.find((l) => l.id === catalogId);
  const tmdbList = cfg.tmdb.lists.find((l) => `tmdb_discover_${l.mediaType}_${l.discoverListId}` === catalogId);
  const metaOf = official ? rowToMetaOfficial : simkl ? rowToMetaSimkl : tmdbList ? rowToMetaTmdb : rowToMeta;

  // Unknown id / an id whose module is disabled → empty, but still 200.
  // (The manifest controls what Stremio can reach; a stale request after a
  // disable must not 404 the whole chain.)
  if (!official && !simkl && !list && !tmdbList) return json({ metas: [] });

  let data;
  try {
    const res = await fetch(githubPagesCatalogUrl(env, catalogId));
    if (!res.ok) return json({ metas: [] });
    data = await res.json();
  } catch {
    return json({ metas: [] });
  }

  const rows = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
  const slice = rows.slice(skip, skip + 100);
  return json({ metas: slice.map((r) => metaOf({ ...r, type: catalogType })) }, 200);
}

export async function handleStatus(env, request) {
  const page = request && new URL(request.url).searchParams.get("page");
  const official = page === "official";
  const simkl = page === "simkl";
  const tmdb = page === "tmdb";
  const cfg = await loadConfig(env.STORE);
  const runs = official
    ? await getRuns(env.STORE, "runs:official")
    : simkl
      ? await getRuns(env.STORE, SIMKL_RUNS_KEY)
      : tmdb
        ? await getRuns(env.STORE, TMDB_RUNS_KEY)
        : await getRuns(env.STORE, "runs:scraper");
  const listById = new Map(cfg.scraper.lists.map((l) => [l.id, l.name]));
  // Official/simkl runs are keyed by catalog id (mdboff_<slug>_<movie|show>),
  // but the operator-renamed name lives on the config list - resolve the
  // run's catalog id back through the slug so a rename in /configure shows
  // here too, instead of the stale constant.
  const cfgoffNames = new Map(cfg.official.lists.map((l) => [l.slug, l.name]));
  const cfgSimNames = new Map(cfg.simkl.lists.map((l) => [l.slug, l.name]));
  const officialByName = new Map(OFFICIAL_CATALOGS.map((c) => [c.id, cfgoffNames.get(c.slug) || c.name]));
  const simklByName = new Map(SIMKL_CATALOGS.map((c) => [c.id, cfgSimNames.get(c.slug) || c.name]));
  const tmdbByName = new Map(cfg.tmdb.lists.map((l) => [`tmdb_discover_${l.mediaType}_${l.discoverListId}`, l.name]));
  const nameFor = (r) => listById.get(r.catalog_id) ?? officialByName.get(r.catalog_id) ?? simklByName.get(r.catalog_id) ?? tmdbByName.get(r.catalog_id) ?? r.catalog_id;
  const out = runs.slice(0, 30).map((r) => ({
    catalog_name: nameFor(r),
    catalog_id: r.catalog_id,
    ...(official || simkl || tmdb ? { api_pages: r.pages_scraped } : { pages_scraped: r.pages_scraped }),
    triggered_by: r.triggered_by === "scheduled" ? "scheduled" : "manual",
    movies_found: r.movies_found,
    status: r.status,
    error_message: r.error_message ?? null,
    started_at_ist: toIST(r.started_at),
    finished_at_ist: toIST(r.finished_at),
    duration_seconds: r.started_at && r.finished_at ? Math.round((r.finished_at - r.started_at) / 1000) : null,
  }));
  return json(out);
}

export async function handleSaveConfig(env, request) {
  try {
    const body = await request.json();
    if (!body || !body.scraper || !Array.isArray(body.scraper.lists) ||
        !body.official || !Array.isArray(body.official.lists) ||
        !body.simkl || !Array.isArray(body.simkl.lists) ||
        !body.tmdb || !Array.isArray(body.tmdb.lists)) {
      return json({ error: "Invalid config body - expected { scraper, official, simkl, tmdb: { lists: [] } }" }, 400);
    }
    // Note: read-modify-write has no lock - concurrent saves can clobber
    // each other. Accepted for a single-operator admin page.
    const current = await loadConfig(env.STORE);
    const incoming = migrateConfig(body);

    const prevById = new Map(current.scraper.lists.map((l) => [l.id, l]));
    const nextById = new Map(incoming.scraper.lists.map((l) => [l.id, l]));

    const changed = [];
    const added = [];
    const removed = [];

    for (const l of incoming.scraper.lists) {
      const prev = prevById.get(l.id);
      if (!prev) {
        added.push(l);
      } else if (listContentHash(l) !== listContentHash(prev)) {
        changed.push(l);
      }
    }
    for (const l of current.scraper.lists) {
      if (!nextById.has(l.id)) removed.push(l);
    }

    // Detect official + simkl changes BEFORE any persist or dispatch -
    // both gate on the original current, not on `incoming`.
    const prevOffById = new Map(current.official.lists.map((l) => [l.slug, l]));
    const officialChanged = incoming.official.lists
      .filter((l) => prevOffById.has(l.slug) && prevOffById.get(l.slug).enabled !== l.enabled)
      .map((l) => l.name);
    const prevSimById = new Map(current.simkl.lists.map((l) => [l.slug, l]));
    const simklChanged = incoming.simkl.lists.filter((l) => {
      const prev = prevSimById.get(l.slug);
      if (!prev) return true;
      return prev.enabled !== l.enabled || JSON.stringify(prev.filter) !== JSON.stringify(l.filter);
    });
    const simklDispatchKinds = simklChanged.filter((l) => l.enabled).map((l) => l.slug);
    // TMDB diff: content-hash compare (name-only edits don't regenerate).
    // Added/changed enabled lists dispatch generate with their catalog ids;
    // removed lists dispatch delete.
    const prevTmdbById = new Map(current.tmdb.lists.map((l) => [l.discoverListId, l]));
    const tmdbAddedOrChanged = incoming.tmdb.lists.filter((l) => {
      const prev = prevTmdbById.get(l.discoverListId);
      if (!prev) return true;
      return tmdbContentHash(l) !== tmdbContentHash(prev);
    });
    const nextTmdbIds = new Set(incoming.tmdb.lists.map((l) => l.discoverListId));
    const tmdbRemoved = current.tmdb.lists.filter((l) => !nextTmdbIds.has(l.discoverListId));
    const tmdbGenerateIds = tmdbAddedOrChanged.filter((l) => l.enabled)
      .map((l) => `tmdb_discover_${l.mediaType}_${l.discoverListId}`);
    const tmdbDeleteIds = tmdbRemoved.map((l) => `tmdb_discover_${l.mediaType}_${l.discoverListId}`);
    const dispatch = [];
    for (const l of [...changed, ...added]) if (l.enabled) dispatch.push(l);
    const deleteIds = removed.map((l) => l.id);

    // Both dispatches fire before the persist: save is the last step, so
    // no config write happens on any dispatch failure and no workflow
    // has read a config it shouldn't trust yet.
    // Dispatch simkl FIRST, scraper LAST, then persist on success of all.
    // The scraper workflow can be destructive (scrape_delete removes data
    // files); simkl only regenerates arrival listings. If the scraper
    // fired first and the simkl dispatch then failed, the scraper
    // workflow would run deleteCatalog() against a config the roll-back
    // wants to keep. Firing simkl first, scraper last keeps the
    // destructive action adjacent to the persist: any failure before it
    // means no config write and no destructive run.
    let dispatchResult = { dispatched: false, reason: "no dispatch needed" };
    if (simklDispatchKinds.length > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        workflow: env.GH_SIMKL_WORKFLOW || SIMKL_WORKFLOW,
        inputs: { kinds: simklDispatchKinds.join(",") },
      });
      if (!dispatchResult.dispatched) {
        return json({ ok: false, error: "Save rejected - GitHub simkl dispatch failed: " + dispatchResult.reason }, 502);
      }
    }
    const scraperDispatchNeeded = dispatch.length > 0 || deleteIds.length > 0;
    if (scraperDispatchNeeded) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        lists: dispatch.map((l) => l.id),
        action: deleteIds.length > 0 ? "scrape_delete" : "scrape",
        ...(deleteIds.length > 0 && { deleteIds }),
      });
      if (!dispatchResult.dispatched) {
        return json({ ok: false, error: "Save rejected - GitHub dispatch failed: " + dispatchResult.reason }, 502);
      }
    }
    if (tmdbGenerateIds.length > 0 || tmdbDeleteIds.length > 0) {
      // One dispatch carries both: a save that deletes one list and edits
      // another must regenerate AND delete in the same run.
      dispatchResult = await dispatchScraperWorkflow(env, {
        workflow: env.GH_TMDB_WORKFLOW || TMDB_WORKFLOW,
        inputs: {
          ...(tmdbGenerateIds.length > 0 && { ids: tmdbGenerateIds.join(",") }),
          ...(tmdbDeleteIds.length > 0 && { delete_ids: tmdbDeleteIds.join(",") }),
        },
      });
      if (!dispatchResult.dispatched) {
        return json({ ok: false, error: "Save rejected - GitHub tmdb dispatch failed: " + dispatchResult.reason }, 502);
      }
    }

    // Both dispatches accepted - now persist. (Worker fires 204 on GH's
    // accept; the workflow may still fail 5min later, but by then the
    // operator's intent is on disk; this avoids the config/data drift
    // above.)
    await saveConfig(env.STORE, incoming);

    return json({
      ok: true,
      changed: changed.map((l) => l.name),
      added: added.map((l) => l.name),
      removed: removed.map((l) => l.name),
      dispatch: dispatch.map((l) => ({ id: l.id, name: l.name })),
      officialChanged,
      simklChanged: simklChanged.map((l) => l.name),
      tmdbChanged: tmdbAddedOrChanged.filter((l) => l.enabled).map((l) => l.name),
      tmdbRemoved: tmdbRemoved.map((l) => l.name),
      github: dispatchResult,
    });
  } catch (e) {
    return json({ error: "Save failed." }, 500);
  }
}

export async function handleExportConfig(env, request) {
  const cfg = await loadConfig(env.STORE);
  return json(cfg);
}

export async function handleTriggerRefresh(env, request) {
  const cfg = await loadConfig(env.STORE);

  // Optional { id } body → refresh a single list instead of all enabled.
  // Optional { page } body → scope the refresh to one module.
  let singleId = null;
  let page = null;
  if (request && request.method === "POST") {
    try {
      const text = await request.text();
      if (text) {
        const parsed = JSON.parse(text);
        singleId = parsed.id ?? null;
        page = parsed.page === "official" || parsed.page === "simkl" || parsed.page === "tmdb" ? parsed.page : null;
      }
    } catch {
      singleId = null;
      page = null;
    }
  }

  // Official page-scoped refresh: one slug refresh → one official list
  // (movies + shows); no id → all enabled official lists.
  if (page === "official") {
    const enabledQ = cfg.official.lists.filter((l) => l.enabled);
    if (singleId) {
      const list = enabledQ.find((l) => l.slug === singleId);
      if (!list) return json({ error: "Unknown or disabled official list." }, 404);
    }
    const slugs = singleId ? [singleId] : enabledQ.map((l) => l.slug);
    const result = await dispatchScraperWorkflow(env, {
      workflow: env.GH_OFFICIAL_WORKFLOW || OFFICIAL_WORKFLOW,
      // official.yml declares a `slugs` input, not lists/action - GitHub
      // rejects inputs that the target workflow doesn't define (422).
      inputs: { slugs: slugs.join(",") },
    });
    if (!result.dispatched) {
      return json({ error: "GitHub Actions dispatch failed: " + result.reason }, 501);
    }
    return json({ ok: true, lists: slugs, workflow: OFFICIAL_WORKFLOW });
  }

  // Simkl page-scoped refresh: one kind refresh → one simkl list; no id →
  // all enabled simkl lists.
  if (page === "simkl") {
    const enabledQ = cfg.simkl.lists.filter((l) => l.enabled);
    if (singleId) {
      const list = enabledQ.find((l) => l.slug === singleId);
      if (!list) return json({ error: "Unknown or disabled simkl list." }, 404);
    }
    const kinds = singleId ? [singleId] : enabledQ.map((l) => l.slug);
    const result = await dispatchScraperWorkflow(env, {
      workflow: env.GH_SIMKL_WORKFLOW || SIMKL_WORKFLOW,
      // simkl.yml declares a `kinds` input, not lists/action.
      inputs: { kinds: kinds.join(",") },
    });
    if (!result.dispatched) {
      return json({ error: "GitHub Actions dispatch failed: " + result.reason }, 501);
    }
    return json({ ok: true, lists: kinds, workflow: SIMKL_WORKFLOW });
  }

  // TMDB page-scoped refresh: one id refresh → one discover list; no id →
  // all enabled tmdb lists.
  if (page === "tmdb") {
    const enabledQ = cfg.tmdb.lists.filter((l) => l.enabled);
    let ids;
    if (singleId) {
      const list = enabledQ.find((l) => `tmdb_discover_${l.mediaType}_${l.discoverListId}` === singleId);
      if (!list) return json({ error: "Unknown or disabled TMDB list." }, 404);
      ids = [singleId];
    } else {
      ids = enabledQ.map((l) => `tmdb_discover_${l.mediaType}_${l.discoverListId}`);
    }
    const result = await dispatchScraperWorkflow(env, {
      workflow: env.GH_TMDB_WORKFLOW || TMDB_WORKFLOW,
      inputs: { ids: ids.join(",") },
    });
    if (!result.dispatched) {
      return json({ error: "GitHub Actions dispatch failed: " + result.reason }, 501);
    }
    return json({ ok: true, lists: ids, workflow: TMDB_WORKFLOW });
  }

  // Scraper page default (no body / no page): all enabled scraper lists.
  let targets;
  if (singleId) {
    const list = cfg.scraper.lists.find((l) => l.id === singleId);
    if (!list) return json({ error: "Unknown list id." }, 404);
    if (!list.enabled) return json({ error: "That list is disabled - enable it first." }, 400);
    targets = [list];
  } else {
    targets = cfg.scraper.lists.filter((l) => l.enabled);
  }

  const result = await dispatchScraperWorkflow(env, {
    lists: targets.map((l) => l.id),
    action: "scrape",
  });
  if (!result.dispatched) {
    return json({ error: "GitHub Actions dispatch failed: " + result.reason }, 501);
  }
  return json({ ok: true, lists: targets.map((l) => l.id) });
}

// POST /runs - called by scripts/scrape.mjs (and scripts/official.mjs)
// after each list scrape to record the run in worker KV (status page
// reads from here). Runs are keyed by catalog-id prefix: mdboff_* →
// runs:official, everything else → runs:scraper.
export async function handleRunsPost(env, request) {
  try {
    const body = await request.json();
    if (!body || !Array.isArray(body.runs)) {
      return json({ error: "Expected { runs: [...] }" }, 400);
    }
    if (body.runs.length > 50) {
      return json({ error: "Too many run records in one request (max 50)." }, 400);
    }
    const now = Date.now();
    for (const r of body.runs) {
      // Per-record isolation: one malformed record must not drop its valid
      // siblings (previously any throw here 500'd the whole batch).
      try {
        const run = {
          id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : now + Math.floor(Math.random() * 1000),
          catalog_id: String(r.catalog_id ?? "").slice(0, 64),
          started_at: Number.isFinite(r.started_at) ? r.started_at : now,
          finished_at: Number.isFinite(r.finished_at) ? r.finished_at : now,
          pages_scraped: Number.isInteger(r.pages_scraped) && r.pages_scraped >= 0 ? r.pages_scraped : 0,
          movies_found: Number.isInteger(r.movies_found) && r.movies_found >= 0 ? r.movies_found : 0,
          status: r.status === "success" ? "success" : "failed",
          error_message: typeof r.error_message === "string" ? r.error_message.slice(0, 500) : null,
          triggered_by: r.triggered_by === "scheduled" ? "scheduled" : "manual",
        };
        await addRun(env.STORE, run, runsKeyFor(run.catalog_id));
      } catch {
        // Skip the bad record; keep ingesting the rest of the batch.
      }
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Failed to record runs." }, 500);
  }
}

// ── TMDB live helpers (Discover form) ────────────────────────────────────
// Thin proxies to api.themoviedb.org for the configure page's search
// boxes + preview. Always hit TMDB directly regardless of any list's
// saved state. Fail fast with a clear message when the token isn't set.

function tmdbTokenOrError(env) {
  if (!env.TMDB_READ_ACCESS_TOKEN) {
    return json({ error: "TMDB_READ_ACCESS_TOKEN not configured - set it as a Cloudflare worker secret." }, 500);
  }
  return null;
}

async function tmdbApi(env, pathAndQuery) {
  const res = await fetch(`https://api.themoviedb.org/3${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${env.TMDB_READ_ACCESS_TOKEN}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return json({ error: `TMDB ${res.status}: ${body.slice(0, 200)}` }, 502);
  }
  return res.json();
}

const TMDB_SEARCH_MAX = 12;

export async function handleTmdbSearch(env, kind, query) {
  const guard = tmdbTokenOrError(env);
  if (guard) return guard;
  const q = String(query || "").trim();
  if (!q) return json({ results: [] });
  const paths = {
    keyword: `/search/keyword?query=${encodeURIComponent(q)}`,
    company: `/search/company?query=${encodeURIComponent(q)}`,
    collection: `/search/collection?query=${encodeURIComponent(q)}`,
  };
  const path = paths[kind];
  if (!path) return json({ error: "Unknown search kind." }, 400);
  const data = await tmdbApi(env, path);
  if (data.error) return json(data, 502);
  const results = (data.results || []).slice(0, TMDB_SEARCH_MAX).map((r) => ({
    id: r.id,
    name: r.name || r.title,
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : null,
  }));
  return json({ results });
}

// Port of the old tmdb worker's buildDiscoverSources/fetch logic, live
// variant: same AND/OR fragment plan, collection post-filter, capped at
// 25 pages × 20 = up to 500 items (old worker's MAX_PREVIEW_PAGES). Body is
// a discover list entry (normalizeTmdbList shape) + optional previewMediaType.
const PREVIEW_PAGES = 25;
const PREVIEW_PAGE_SIZE = 20;

// Client-side sort of the unioned multi-source result set - mirrors the old
// worker's sortParts so preview order matches what the generated catalog
// serves. title_asc on series falls back to popularity (TMDB /discover/tv
// has no name sort).
function sortPreviewItems(items, sortKey, mediaType) {
  const dateField = mediaType === "series" ? "first_air_date" : "release_date";
  const hasDate = (i) => Boolean(i[dateField]);
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

export async function handleTmdbPreviewDiscover(env, request) {
  const guard = tmdbTokenOrError(env);
  if (guard) return guard;
  try {
    const body = await request.json();
    const entry = normalizeTmdbList(body || {});
    if (!entry) return json({ error: "Invalid discover list body" }, 400);
    const mediaType = body.previewMediaType === "series" && entry.mediaType !== "series"
      ? "series"
      : entry.mediaType;
    const endpoint = mediaType === "series" ? "/discover/tv" : "/discover/movie";
    const sortMap = mediaType === "series"
      ? { release_desc: "first_air_date.desc", release_asc: "first_air_date.asc", popularity_desc: "popularity.desc", vote_desc: "vote_average.desc", title_asc: "popularity.desc" }
      : { release_desc: "primary_release_date.desc", release_asc: "primary_release_date.asc", popularity_desc: "popularity.desc", vote_desc: "vote_average.desc", title_asc: "original_title.asc" };
    const sortBy = sortMap[entry.sort] || sortMap.release_asc;

    let excludeQs = "";
    if (entry.excludeGenres.length > 0) excludeQs += `&without_genres=${encodeURIComponent(entry.excludeGenres.join("|"))}`;
    if (entry.excludeKeywords.length > 0) excludeQs += `&without_keywords=${encodeURIComponent(entry.excludeKeywords.join("|"))}`;
    if (entry.excludeCompanies.length > 0) excludeQs += `&without_companies=${encodeURIComponent(entry.excludeCompanies.join("|"))}`;

    // Same source plan as scripts/tmdb.mjs buildDiscoverSources.
    const m = entry.includeModes;
    const isAnd = (d) => m[d] !== "or";
    const releaseTypeQs =
      mediaType !== "series" && entry.includeReleaseTypes.length > 0
        ? `&with_release_type=${encodeURIComponent([...new Set(entry.includeReleaseTypes)].join("|"))}&region=US`
        : "";
    let andQs = "";
    if (isAnd("genre") && entry.includeGenres.length > 0) andQs += `&with_genres=${encodeURIComponent(entry.includeGenres.join("|"))}`;
    if (isAnd("keyword") && entry.includeKeywords.length > 0) andQs += `&with_keywords=${encodeURIComponent(entry.includeKeywords.join("|"))}`;
    if (isAnd("company") && entry.includeCompanies.length > 0) andQs += `&with_companies=${encodeURIComponent(entry.includeCompanies.join("|"))}`;
    andQs += releaseTypeQs;

    const sources = [];
    if (!isAnd("genre") && entry.includeGenres.length > 0) sources.push(`&with_genres=${encodeURIComponent(entry.includeGenres.join("|"))}${andQs}`);
    if (!isAnd("keyword") && entry.includeKeywords.length > 0) sources.push(`&with_keywords=${encodeURIComponent(entry.includeKeywords.join("|"))}${andQs}`);
    if (!isAnd("company") && entry.includeCompanies.length > 0) sources.push(`&with_companies=${encodeURIComponent(entry.includeCompanies.join("|"))}${andQs}`);
    const collectionSource = mediaType !== "series" && !isAnd("collection") && entry.includeCollections.length > 0;
    const hasDiscover = sources.length > 0;
    if (andQs && collectionSource && !hasDiscover) sources.push(andQs);

    const dedup = new Map();
    const collectionIdSet = new Set();
    if (collectionSource) {
      const results = await Promise.allSettled(
        [...new Set(entry.includeCollections)].map((id) => tmdbApi(env, `/collection/${id}`))
      );
      for (const r of results) {
        if (r.status !== "fulfilled" || r.value.error) continue;
        for (const p of r.value.parts || []) collectionIdSet.add(p.id);
      }
      for (const id of collectionIdSet) dedup.set(id, { id });
    }
    let page = 1;
    let totalPages = 1;
    do {
      const queries = sources.length > 0 ? sources : [andQs];
      const round = await Promise.all(
        queries.map((qs) =>
          tmdbApi(env, `${endpoint}?${qs.replace(/^&/, "")}&sort_by=${encodeURIComponent(sortBy)}&page=${page}${excludeQs}`)
        )
      );
      let maxTotal = page;
      for (const data of round) {
        if (data.error) return json(data, 502);
        maxTotal = Math.max(maxTotal, Number.isFinite(data.total_pages) ? data.total_pages : page);
        for (const item of data.results || []) if (!dedup.has(item.id)) dedup.set(item.id, item);
      }
      totalPages = maxTotal;
      page++;
    } while (page <= totalPages && page <= PREVIEW_PAGES);

    let items = [...dedup.values()];
    if (entry.excludeCollections.length > 0) {
      const exResults = await Promise.allSettled(
        [...new Set(entry.excludeCollections)].map((id) => tmdbApi(env, `/collection/${id}`))
      );
      const exSet = new Set();
      for (const r of exResults) {
        if (r.status !== "fulfilled" || r.value.error) continue;
        for (const p of r.value.parts || []) exSet.add(p.id);
      }
      if (exSet.size > 0) items = items.filter((p) => !exSet.has(p.id));
    }
    if (mediaType !== "series" && isAnd("collection") && entry.includeCollections.length > 0 && collectionIdSet.size > 0) {
      items = items.filter((p) => collectionIdSet.has(p.id));
    }

    sortPreviewItems(items, entry.sort, mediaType);
    const truncated = totalPages > PREVIEW_PAGES;
    const metas = items.slice(0, PREVIEW_PAGES * PREVIEW_PAGE_SIZE).map((item) => ({
      id: item.id,
      type: mediaType === "series" ? "series" : "movie",
      name: item.title || item.name,
      year: (item.release_date || item.first_air_date || "").slice(0, 4),
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
    }));
    return json({ items: metas, truncated });
  } catch (e) {
    return json({ error: "Invalid request body: " + e.message }, 400);
  }
}