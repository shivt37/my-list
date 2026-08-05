// Stremio-facing routes: manifest + catalog serving. Catalog data files
// live in the repo's data/ dir (GitHub Pages); the worker is a thin
// fetcher, never touching mdblist itself.

import { loadConfig, migrateConfig, listContentHash, addRun, getRuns, saveConfig, runsKeyFor, OFFICIAL_CATALOGS, SIMKL_CATALOGS, SIMKL_RUNS_KEY } from "./config.js";
import { dispatchScraperWorkflow } from "./dispatch.js";
import { buildConfigurePage } from "./configure.js";

export const ADDON_ID = "com.mylist";
export const ADDON_NAME = "my-list";
export const ADDON_VERSION = "0.1.0";
export const ADDON_DESCRIPTION = "Community-built catalogs: MDBList scraper lists + MDBList official lists.";

// Official module's workflow file - separate cron from the scraper's.
export const OFFICIAL_WORKFLOW = "official.yml";
export const SIMKL_WORKFLOW = "simkl.yml";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-secret",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "x-content-type-options": "nosniff", ...corsHeaders, ...extraHeaders },
  });
}

// Shared secret gates every mutating route. The configure page embeds it
// (it only blocks scripts on other origins, not determined callers - the
// honest ceiling without Turnstile); the GitHub Actions scripts pass it via
// env. Not a strong security boundary, raises the bar for drive-by abuse.
export function requireAdmin(request, env) {
  const secret = env.ADMIN_SECRET;
  if (!secret) return null;
  if (request && request.headers.get("x-admin-secret") === secret) return null;
  return json({ error: "Unauthorized" }, 401);
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
  return html(buildConfigurePage(origin, config, env.ADMIN_SECRET));
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
  const enabledOfficial = new Set(cfg.official.lists.filter((l) => l.enabled).map((l) => l.slug));
  const officialCatalogs = OFFICIAL_CATALOGS
    .filter((c) => enabledOfficial.has(c.slug))
    .map((c) => ({ name: c.name, id: c.id, type: c.type, extra: [{ name: "skip", isRequired: false }] }));
  const enabledSimkl = new Set(cfg.simkl.lists.filter((l) => l.enabled).map((l) => l.slug));
  const simklCatalogs = SIMKL_CATALOGS
    .filter((c) => enabledSimkl.has(c.slug))
    .map((c) => ({ name: c.name, id: c.id, type: c.type, extra: [] }));
  const catalogs = [
    ...enabled.map((l) => ({
      name: l.name,
      id: l.id,
      type: l.type,
      extra: [{ name: "skip", isRequired: false }],
    })),
    ...officialCatalogs,
    ...simklCatalogs,
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

function rowToMetaSimkl(row) {
  return {
    id: row.imdb_id,
    type: "series",
    name: row.title,
    poster: row.poster || undefined,
    description: row.description || undefined,
  };
}

export async function handleCatalog(env, catalogType, catalogId, skip) {
  const cfg = await loadConfig(env.STORE);
  const official = OFFICIAL_CATALOGS.find((c) => c.id === catalogId);
  const simkl = SIMKL_CATALOGS.find((c) => c.id === catalogId);
  const list = cfg.scraper.lists.find((l) => l.id === catalogId);
  const metaOf = official ? rowToMetaOfficial : simkl ? rowToMetaSimkl : rowToMeta;

  // Unknown id / an id whose module is disabled → empty, but still 200.
  // (The manifest controls what Stremio can reach; a stale request after a
  // disable must not 404 the whole chain.)
  if (!official && !simkl && !list) return json({ metas: [] });

  let data;
  try {
    const res = await fetch(githubPagesCatalogUrl(env, catalogId), { cf: { cacheTtl: 300 } });
    if (!res.ok) return json({ metas: [] });
    data = await res.json();
  } catch {
    return json({ metas: [] });
  }

  const rows = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
  const slice = rows.slice(skip, skip + 100);
  return json({ metas: slice.map((r) => metaOf({ ...r, type: catalogType })) }, 200, { "cache-control": "public, max-age=300" });
}

export async function handleStatus(env, request) {
  const page = request && new URL(request.url).searchParams.get("page");
  const official = page === "official";
  const simkl = page === "simkl";
  const cfg = await loadConfig(env.STORE);
  const runs = official
    ? await getRuns(env.STORE, "runs:official")
    : simkl
      ? await getRuns(env.STORE, SIMKL_RUNS_KEY)
      : await getRuns(env.STORE, "runs:scraper");
  const listById = new Map(cfg.scraper.lists.map((l) => [l.id, l.name]));
  const officialByName = new Map(OFFICIAL_CATALOGS.map((c) => [c.id, c.name]));
  const simklByName = new Map(SIMKL_CATALOGS.map((c) => [c.id, c.name]));
  const nameFor = (r) => listById.get(r.catalog_id) ?? officialByName.get(r.catalog_id) ?? simklByName.get(r.catalog_id) ?? r.catalog_id;
  const out = runs.slice(0, 30).map((r) => ({
    catalog_name: nameFor(r),
    catalog_id: r.catalog_id,
    ...(official || simkl ? { api_pages: r.pages_scraped } : { pages_scraped: r.pages_scraped }),
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
  const guard = requireAdmin(request, env);
  if (guard) return guard;
  try {
    const body = await request.json();
    if (!body || !body.scraper || !Array.isArray(body.scraper.lists)) {
      return json({ error: "Invalid config body - expected { scraper: { lists: [] } }" }, 400);
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

    // Scraper module regenerates via the scraper workflow. Official module
    // has no data files to delete (fixeds slugs) - a toggle just changes
    // the manifest; nothing to dispatch.
    const dispatch = [];
    for (const l of [...changed, ...added]) {
      if (l.enabled) dispatch.push(l);
    }
    const deleteIds = removed.map((l) => l.id);

    let dispatchResult = { dispatched: false, reason: "no dispatch needed" };
    // Persist before dispatching so the workflow's /export-config read
    // sees the new config, then roll back on dispatch failure to preserve
    // the old reject-on-failure semantics.
    await saveConfig(env.STORE, incoming);
    if (dispatch.length > 0 || deleteIds.length > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        lists: dispatch.map((l) => l.id),
        action: deleteIds.length > 0 ? "scrape_delete" : "scrape",
        ...(deleteIds.length > 0 && { deleteIds }),
      });
    }
    if ((dispatch.length > 0 || deleteIds.length > 0) && !dispatchResult.dispatched) {
      // Don't keep a config whose workflow dispatch failed - the on-disk
      // data files would go stale with no way to regenerate them.
      await saveConfig(env.STORE, current);
      return json({ ok: false, error: "Save rejected - GitHub dispatch failed: " + dispatchResult.reason }, 502);
    }

    // Official toggles surface to the UI but never dispatch - a toggle
    // only changes the manifest, no data file to regenerate.
    const prevOffById = new Map(current.official.lists.map((l) => [l.slug, l]));
    const officialChanged = incoming.official.lists
      .filter((l) => prevOffById.has(l.slug) && prevOffById.get(l.slug).enabled !== l.enabled)
      .map((l) => l.name);

    // Simkl: an enabled toggle OR a filter edit changes what the next
    // refresh writes, so both dispatch the simkl workflow. Only the
    // enabled kinds dispatch - a disabled list's filter is inert.
    const prevSimById = new Map(current.simkl.lists.map((l) => [l.slug, l]));
    const simklChanged = incoming.simkl.lists.filter((l) => {
      const prev = prevSimById.get(l.slug);
      if (!prev) return true;
      return prev.enabled !== l.enabled || JSON.stringify(prev.filter) !== JSON.stringify(l.filter);
    });
    const simklDispatchKinds = simklChanged.filter((l) => l.enabled).map((l) => l.slug);

    // Update the shared dispatchResult for the response's `github` field:
    // if only simkl changed, its dispatch is the interesting one.
    if (simklDispatchKinds.length > 0 && dispatch.length === 0 && deleteIds.length === 0) {
      dispatchResult = { dispatched: false, reason: "no dispatch needed" };
    }

    if (simklDispatchKinds.length > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        workflow: env.GH_SIMKL_WORKFLOW || SIMKL_WORKFLOW,
        inputs: { kinds: simklDispatchKinds.join(",") },
      });
      if (!dispatchResult.dispatched) {
        await saveConfig(env.STORE, current);
        return json({ ok: false, error: "Save rejected - GitHub simkl dispatch failed: " + dispatchResult.reason }, 502);
      }
    }

    return json({
      ok: true,
      changed: changed.map((l) => l.name),
      added: added.map((l) => l.name),
      removed: removed.map((l) => l.name),
      dispatch: dispatch.map((l) => ({ id: l.id, name: l.name })),
      officialChanged,
      simklChanged: simklChanged.map((l) => l.name),
      github: dispatchResult,
    });
  } catch (e) {
    return json({ error: "Save failed." }, 500);
  }
}

export async function handleExportConfig(env, request) {
  const guard = requireAdmin(request, env);
  if (guard) return guard;
  const cfg = await loadConfig(env.STORE);
  return json(cfg);
}

export async function handleTriggerRefresh(env, request) {
  const guard = requireAdmin(request, env);
  if (guard) return guard;
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
        page = parsed.page === "official" || parsed.page === "simkl" ? parsed.page : null;
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
  const guard = requireAdmin(request, env);
  if (guard) return guard;
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
      const run = {
        id: now + Math.floor(Math.random() * 1000),
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
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Failed to record runs." }, 500);
  }
}