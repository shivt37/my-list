// Stremio-facing routes: manifest + catalog serving. Catalog data files
// live in the repo's data/ dir (GitHub Pages); the worker is a thin
// fetcher, never touching mdblist itself.

import { loadConfig, migrateConfig, listContentHash, addRun, getRuns, saveConfig } from "./config.js";
import { dispatchScraperWorkflow } from "./dispatch.js";
import { buildConfigurePage } from "./configure.js";

export const ADDON_ID = "com.mylist";
export const ADDON_NAME = "my-list";
export const ADDON_VERSION = "0.1.0";
export const ADDON_DESCRIPTION = "Community-built catalogs: MDBList scraper lists (phase 1).";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders, ...extraHeaders },
  });
}

function html(body, extraHeaders = {}) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

// Stremio pagination arrives as /catalog/<type>/<id>/skip=N.json — the
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
  const catalogs = enabled.map((l) => ({
    name: l.name,
    id: l.id,
    type: l.type,
    extra: [{ name: "skip", isRequired: false }],
  }));
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

export async function handleCatalog(env, type, catalogId, skip) {
  const cfg = await loadConfig(env.STORE);
  const list = cfg.scraper.lists.find((l) => l.id === catalogId);
  if (!list) return json({ metas: [] });

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
  return json({ metas: slice.map(rowToMeta) }, 200, { "cache-control": "public, max-age=300" });
}

export async function handleStatus(env) {
  const cfg = await loadConfig(env.STORE);
  const runs = await getRuns(env.STORE);
  const byId = new Map(cfg.scraper.lists.map((l) => [l.id, l]));
  const out = runs.slice(0, 30).map((r) => ({
    catalog_name: byId.has(r.catalog_id) ? byId.get(r.catalog_id).name : r.catalog_id,
    catalog_id: r.catalog_id,
    pages_scraped: r.pages_scraped,
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
    if (!body || !body.scraper || !Array.isArray(body.scraper.lists)) {
      return json({ error: "Invalid config body — expected { scraper: { lists: [] } }" }, 400);
    }
    // Note: read-modify-write has no lock — concurrent saves can clobber
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

    const dispatch = [];
    for (const l of [...changed, ...added]) {
      if (l.enabled) dispatch.push(l);
    }
    const deleteIds = removed.map((l) => l.id);

    let dispatchResult = { dispatched: false, reason: "no dispatch needed" };
    if (dispatch.length > 0 || deleteIds.length > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        lists: dispatch.map((l) => l.id),
        action: deleteIds.length > 0 ? "scrape_delete" : "scrape",
        ...(deleteIds.length > 0 && { deleteIds }),
      });
    }
    if ((dispatch.length > 0 || deleteIds.length > 0) && !dispatchResult.dispatched) {
      // Don't persist a config whose workflow dispatch failed — the on-disk
      // data files would go stale with no way to regenerate them.
      return json({ ok: false, error: "Save rejected — GitHub dispatch failed: " + dispatchResult.reason }, 502);
    }

    await saveConfig(env.STORE, incoming);

    return json({
      ok: true,
      changed: changed.map((l) => l.name),
      added: added.map((l) => l.name),
      removed: removed.map((l) => l.name),
      dispatch: dispatch.map((l) => ({ id: l.id, name: l.name })),
      github: dispatchResult,
    });
  } catch (e) {
    return json({ error: "Save failed." }, 500);
  }
}

export async function handleExportConfig(env) {
  const cfg = await loadConfig(env.STORE);
  return json(cfg);
}

export async function handleTriggerRefresh(env) {
  const cfg = await loadConfig(env.STORE);
  const enabled = cfg.scraper.lists.filter((l) => l.enabled);
  const result = await dispatchScraperWorkflow(env, {
    lists: enabled.map((l) => l.id),
    action: "scrape",
  });
  if (!result.dispatched) {
    return json({ error: "GitHub Actions isn't configured on this worker yet (missing GH_TOKEN/GH_REPO/GH_WORKFLOW)." }, 501);
  }
  return json({ ok: true, lists: enabled.map((l) => l.id) });
}

// POST /runs — called by scripts/scrape.mjs after each list scrape to
// record the run in worker KV (status page reads from here).
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
      const run = {
        id: now + Math.floor(Math.random() * 1000),
        catalog_id: r.catalog_id,
        started_at: r.started_at ?? now,
        finished_at: r.finished_at ?? now,
        pages_scraped: r.pages_scraped ?? 0,
        movies_found: r.movies_found ?? 0,
        status: r.status ?? "failed",
        error_message: r.error_message ?? null,
      };
      await addRun(env.STORE, run);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Failed to record runs." }, 500);
  }
}

