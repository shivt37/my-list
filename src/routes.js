// Stremio-facing routes: manifest + catalog serving. Catalog data files
// live in the repo's data/ dir (GitHub Pages); the worker is a thin
// fetcher, never touching mdblist itself.

import { loadConfig, migrateConfig, configVersion, listContentHash, tmdbContentHash, normalizeTmdbList, addRuns, getRuns, saveConfig, runsKeyFor, tmdbCatalogId, officialCatalogsFor, OFFICIAL_RUNS_KEY, SIMKL_CATALOGS, SIMKL_RUNS_KEY, TMDB_RUNS_KEY } from "./config.js";
import { dispatchScraperWorkflow } from "./dispatch.js";
import { isAuthEnabled } from "./auth.js";
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

export function html(body, extraHeaders = {}) {
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
  return html(buildConfigurePage(origin, config, { authEnabled: isAuthEnabled(env) }));
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
  // /configure), falling back to the derived default. The config is the
  // source of id/type/slug and the data-file name on the next regen.
  const officialBySlug = new Map(cfg.official.lists.map((l) => [l.slug, l.name]));
  const enabledOfficial = new Set(cfg.official.lists.filter((l) => l.enabled).map((l) => l.slug));
  const officialCatalogs = officialCatalogsFor(cfg.official.lists)
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
      id: tmdbCatalogId(l),
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

// Scraper data files carry raw mdblist rows (imdb_id/title/year/score/
// poster/description + a type-specific date field that extraction has
// never successfully filled - see scraper report S1). The catalog type
// comes from the operator's declared list, never inferred from rows.
// Owner request 2026-08-26: releaseInfo shows the full release date
// (digital/first-air, populated since the S1 selector repair) with the bare
// year as fallback for pre-repair data files; mdblist's internal score is
// NOT an IMDb rating - the misleading imdbRating field is dropped entirely.
function rowToMeta(row, catalogType = row.type) {
  const releaseDate = row.digital_release_date || row.first_air_date || null;
  return {
    id: row.imdb_id,
    type: catalogType === "series" ? "series" : "movie",
    name: row.title,
    poster: row.poster_path
      ? row.poster_path.startsWith("http")
        ? row.poster_path
        : `https://image.tmdb.org/t/p/w500/${row.poster_path}`
      : undefined,
    releaseInfo: releaseDate || (row.year ? String(row.year) : undefined),
  };
}

function rowToMetaOfficial(row) {
  const releaseDate = row.release_date || null;
  return {
    id: row.imdb_id,
    type: row.type,
    name: row.title,
    poster: row.poster ? row.poster.replace("/w200/", "/w500/") : undefined,
    releaseInfo: releaseDate || (row.year ? String(row.year) : undefined),
  };
}

// Simkl data files (simkl_arriving_today_*.json) carry { id, name } per
// item, not the scraper's imdb_id/title shape - id/name pass through.
function rowToMetaSimkl(row) {
  return {
    id: row.id || row.imdb_id,
    type: row.type === "movie" ? "movie" : "series",
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
  const official = officialCatalogsFor(cfg.official.lists).find((c) => c.id === catalogId);
  const simkl = SIMKL_CATALOGS.find((c) => c.id === catalogId);
  const list = cfg.scraper.lists.find((l) => l.id === catalogId);
  const tmdbList = cfg.tmdb.lists.find((l) => tmdbCatalogId(l) === catalogId);
  const metaOf = official ? rowToMetaOfficial : simkl ? rowToMetaSimkl : tmdbList ? rowToMetaTmdb : rowToMeta;

  // B11 (actual contract): unknown ids return empty; ids of DISABLED
  // modules keep serving their data on purpose - the manifest gates what
  // clients can discover, while direct catalog URLs stay valid across a
  // disable/enable cycle.
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
  // Forward catalogType positionally too: rowToMetaTmdb(row, type) reads its
  // second argument - row.type alone never reached it (B1 fix).
  return json({ metas: slice.map((r) => metaOf({ ...r, type: catalogType }, catalogType)) }, 200);
}

export async function handleStatus(env, request) {
  const page = request && new URL(request.url).searchParams.get("page");
  const official = page === "official";
  const simkl = page === "simkl";
  const tmdb = page === "tmdb";
  const cfg = await loadConfig(env.STORE);
  const runs = official
    ? await getRuns(env.STORE, OFFICIAL_RUNS_KEY)
    : simkl
      ? await getRuns(env.STORE, SIMKL_RUNS_KEY)
      : tmdb
        ? await getRuns(env.STORE, TMDB_RUNS_KEY)
        : await getRuns(env.STORE, "runs:scraper");
  const listById = new Map(cfg.scraper.lists.map((l) => [l.id, l.name]));
  // Official/simkl runs are keyed by catalog id (mdboff_<slug>_<movie|show>),
  // but the operator-renamed name lives on the config list - resolve the
  // run's catalog id back through the slug so a rename in /configure shows
  // here too, instead of the derived default.
  const cfgoffNames = new Map(cfg.official.lists.map((l) => [l.slug, l.name]));
  const cfgSimNames = new Map(cfg.simkl.lists.map((l) => [l.slug, l.name]));
  const officialByName = new Map(officialCatalogsFor(cfg.official.lists).map((c) => [c.id, cfgoffNames.get(c.slug) || c.name]));
  const simklByName = new Map(SIMKL_CATALOGS.map((c) => [c.id, cfgSimNames.get(c.slug) || c.name]));
  const tmdbByName = new Map(cfg.tmdb.lists.map((l) => [tmdbCatalogId(l), l.name]));
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
    // Owner request 2026-08-24: enabling an official list regenerates its
    // data immediately instead of waiting for cron/manual refresh. Strict
    // OFF->ON compare - disables and net-unchanged stays dispatch-free.
    const officialEnabledSlugs = incoming.official.lists
      .filter((l) => { const prev = prevOffById.get(l.slug); return prev && !prev.enabled && l.enabled; })
      .map((l) => l.slug);
    // Dynamic officials: brand-new slugs (picker adds) regenerate right away
    // when enabled; removals dispatch a data-file cleanup run.
    const officialAddedSlugs = incoming.official.lists
      .filter((l) => !prevOffById.has(l.slug) && l.enabled)
      .map((l) => l.slug);
    const officialRegenSlugs = [...new Set([...officialEnabledSlugs, ...officialAddedSlugs])];
    const nextOffSlugs = new Set(incoming.official.lists.map((l) => l.slug));
    const officialRemovedIds = current.official.lists
      .filter((l) => !nextOffSlugs.has(l.slug))
      .flatMap((l) => [`mdboff_${l.slug}_movie`, `mdboff_${l.slug}_show`]);
    const prevSimById = new Map(current.simkl.lists.map((l) => [l.slug, l]));
    let simklChanged = incoming.simkl.lists.filter((l) => {
      const prev = prevSimById.get(l.slug);
      if (!prev) return true;
      return prev.enabled !== l.enabled || JSON.stringify(prev.filter) !== JSON.stringify(l.filter);
    });
    // Timezone is global to the simkl module - a change redefines which
    // calendar day "today" is for BOTH lists, so every enabled kind
    // regenerates even when its own filters are untouched. Reuses the
    // filter-change dispatch path (before-persist, rollback on failure).
    const simklTzChanged = (current.simkl.timezone || "UTC") !== (incoming.simkl.timezone || "UTC");
    if (simklTzChanged) {
      for (const l of incoming.simkl.lists) {
        if (l.enabled && !simklChanged.some((c) => c.slug === l.slug)) simklChanged.push(l);
      }
    }
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
      .map((l) => tmdbCatalogId(l));
    // Owner request 2026-08-24: toggling a TMDB list ON must regenerate even
    // when content is unchanged (tmdbContentHash deliberately excludes
    // `enabled`, and must keep excluding it - scripts/tmdb.mjs mirrors this
    // hash onto data files). Toggle-on also rescues lists that were added
    // while disabled and never generated. Set-dedupe against hash-path ids.
    const tmdbToggledOnIds = incoming.tmdb.lists
      .filter((l) => { const prev = prevTmdbById.get(l.discoverListId); return prev && !prev.enabled && l.enabled; })
      .map((l) => tmdbCatalogId(l));
    const tmdbGenerateSet = new Set([...tmdbGenerateIds, ...tmdbToggledOnIds]);
    const tmdbDeleteIds = tmdbRemoved.map((l) => tmdbCatalogId(l));
    // B4: a media-type switch mints a new catalog id (type is baked into the
    // id), which would orphan the old type's data file forever. Queue the
    // old id for deletion alongside removals.
    const tmdbTypeSwitchOldIds = incoming.tmdb.lists
      .filter((l) => { const p = prevTmdbById.get(l.discoverListId); return p && p.mediaType !== l.mediaType; })
      .map((l) => tmdbCatalogId(prevTmdbById.get(l.discoverListId)));
    for (const oldId of tmdbTypeSwitchOldIds) if (!tmdbDeleteIds.includes(oldId)) tmdbDeleteIds.push(oldId);
    const dispatch = [];
    for (const l of [...changed, ...added]) if (l.enabled) dispatch.push(l);
    const deleteIds = removed.map((l) => l.id);

    // Both dispatches fire before the persist: save is the last step, so
    // no config write happens on any dispatch failure and no workflow
    // has read a config it shouldn't trust yet.
    // F2 dispatch order: ALL regenerations first (simkl, official, tmdb,
    // scraper), then ALL destructive cleanups at the tail, immediately
    // before the persist. Any failure during a regeneration = clean
    // rollback with nothing destructive fired - a rejected save can never
    // delete data files for lists the rolled-back config still
    // advertises. (tmdb deletes MUST be their own action=delete dispatch:
    // tmdb.yml only forwards --delete_ids when action=delete, so a
    // combined generate+delete dispatch silently dropped the deletes -
    // F3A-1, the root cause of orphaned tmdb_discover_* files.)
    // F3: every dispatch carries the configVersion it was saved for - the
    // workflows poll /export-config until this version is visible (or
    // abort), so a dispatched run never applies stale settings.
    const expectedVersion = configVersion(incoming);
    let dispatchResult = { dispatched: false, reason: "no dispatch needed" };
    // ── Phase 1: regenerations (non-destructive) ──
    if (simklDispatchKinds.length > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        workflow: env.GH_SIMKL_WORKFLOW || SIMKL_WORKFLOW,
        inputs: { kinds: simklDispatchKinds.join(","), config_version: expectedVersion },
      });
      if (!dispatchResult.dispatched) {
        return json({ ok: false, error: "Save rejected - GitHub simkl dispatch failed: " + dispatchResult.reason }, 502);
      }
    }
    const officialRegenNeeded = officialRegenSlugs.length > 0;
    if (officialRegenNeeded) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        workflow: env.GH_OFFICIAL_WORKFLOW || OFFICIAL_WORKFLOW,
        inputs: { slugs: officialRegenSlugs.join(","), config_version: expectedVersion },
      });
      if (!dispatchResult.dispatched) {
        return json({ ok: false, error: "Save rejected - GitHub official dispatch failed: " + dispatchResult.reason }, 502);
      }
    }
    if (tmdbGenerateSet.size > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        workflow: env.GH_TMDB_WORKFLOW || TMDB_WORKFLOW,
        inputs: { ids: [...tmdbGenerateSet].join(","), config_version: expectedVersion },
      });
      if (!dispatchResult.dispatched) {
        return json({ ok: false, error: "Save rejected - GitHub tmdb dispatch failed: " + dispatchResult.reason }, 502);
      }
    }
    if (dispatch.length > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        lists: dispatch.map((l) => l.id),
        action: "scrape",
        inputs: { lists: dispatch.map((l) => l.id).join(","), action: "scrape", config_version: expectedVersion },
      });
      if (!dispatchResult.dispatched) {
        return json({ ok: false, error: "Save rejected - GitHub dispatch failed: " + dispatchResult.reason }, 502);
      }
    }

    // ── Phase 2: destructive cleanups, tail-adjacent to the persist ──
    // Official cleanup: data-file cleanup for deleted officials. F10:
    // best-effort — its own comment declares failure harmless (orphan JSON
    // files that nothing serve), so a dispatch failure must not veto the
    // save. The response carries officialCleanupPending so the UI can say
    // so; orphans get removed by any later successful save or cron.
    let officialCleanupPending = false;
    if (officialRemovedIds.length > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        workflow: env.GH_OFFICIAL_WORKFLOW || OFFICIAL_WORKFLOW,
        inputs: { action: "delete", delete_ids: officialRemovedIds.join(","), config_version: expectedVersion },
      });
      if (!dispatchResult.dispatched) {
        officialCleanupPending = true;
        console.warn("Official cleanup dispatch failed (non-critical):", dispatchResult.reason);
      }
    }
    // TMDB deletes carry action=delete explicitly - tmdb.yml only forwards
    // --delete_ids in that mode (F3A-1: combined dispatches dropped them).
    if (tmdbDeleteIds.length > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        workflow: env.GH_TMDB_WORKFLOW || TMDB_WORKFLOW,
        inputs: { action: "delete", delete_ids: tmdbDeleteIds.join(","), config_version: expectedVersion },
      });
      if (!dispatchResult.dispatched) {
        return json({ ok: false, error: "Save rejected - GitHub tmdb cleanup dispatch failed: " + dispatchResult.reason }, 502);
      }
    }
    // Scraper delete: pure delete run (no --lists) - the regen phase above
    // already refreshed every surviving list, so this only removes the
    // deleted ids' data files.
    if (deleteIds.length > 0) {
      dispatchResult = await dispatchScraperWorkflow(env, {
        action: "scrape_delete",
        deleteIds,
        inputs: { lists: deleteIds.join(","), action: "scrape_delete", delete_ids: deleteIds.join(","), config_version: expectedVersion },
      });
      if (!dispatchResult.dispatched) {
        return json({ ok: false, error: "Save rejected - GitHub dispatch failed: " + dispatchResult.reason }, 502);
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
      // Names whose workflows actually fired this save - the UI reports
      // from these, never from the changed arrays (a disable is a change
      // but must not claim a regeneration).
      officialDispatched: incoming.official.lists
        .filter((l) => officialRegenSlugs.includes(l.slug))
        .map((l) => l.name),
      officialAdded: incoming.official.lists
        .filter((l) => !prevOffById.has(l.slug))
        .map((l) => l.name),
      officialRemoved: current.official.lists
        .filter((l) => !nextOffSlugs.has(l.slug))
        .map((l) => l.name),
      // F10: true when the best-effort official cleanup dispatch failed —
      // the save persisted anyway; the orphaned files clear on a later
      // save or cron refresh.
      officialCleanupPending,
      simklChanged: simklChanged.map((l) => l.name),
      simklDispatched: simklChanged.filter((l) => l.enabled).map((l) => l.name),
      // Display names for everything this save will regenerate - hash-path
      // changes AND enable-toggles, deduped via the same set.
      tmdbChanged: incoming.tmdb.lists
        .filter((l) => l.enabled && tmdbGenerateSet.has(tmdbCatalogId(l)))
        .map((l) => l.name),
      tmdbRemoved: tmdbRemoved.map((l) => l.name),
      github: dispatchResult,
    });
  } catch (e) {
    // F20: body-parse failures (malformed JSON from a proxy hiccup or a
    // truncated request) are the CLIENT's fault - classify as 400 with an
    // actionable message, mirroring the preview endpoint's existing
    // pattern. Real internal faults keep the 500.
    if (e instanceof SyntaxError) return json({ error: "Invalid request body: " + e.message }, 400);
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
    // Consistent contract across all four modules: unknown id → 404,
    // known-but-disabled id → 400 with an actionable message.
    if (page === "official") {
      const enabledQ = cfg.official.lists.filter((l) => l.enabled);
      // S5 (mirrored from the scraper branch): don't dispatch a GitHub run
      // just to print "nothing to do" when nothing is enabled.
      if (!singleId && enabledQ.length === 0) return json({ ok: true, lists: [] });
      if (singleId) {
        const list = cfg.official.lists.find((l) => l.slug === singleId);
        if (!list) return json({ error: "Unknown official list." }, 404);
        if (!list.enabled) return json({ error: `"${list.name}" is disabled - enable it first.` }, 400);
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
    // S5 (mirrored from the scraper branch): don't dispatch a GitHub run
    // just to print "nothing to do" when nothing is enabled.
    if (!singleId && enabledQ.length === 0) return json({ ok: true, lists: [] });
    if (singleId) {
      const list = cfg.simkl.lists.find((l) => l.slug === singleId);
      if (!list) return json({ error: "Unknown simkl list." }, 404);
      if (!list.enabled) return json({ error: `"${list.name}" is disabled - enable it first.` }, 400);
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
    // S5 (mirrored from the scraper branch): don't dispatch a GitHub run
    // just to print "nothing to do" when nothing is enabled.
    if (!singleId && enabledQ.length === 0) return json({ ok: true, lists: [] });
    let ids;
    if (singleId) {
      const list = cfg.tmdb.lists.find((l) => tmdbCatalogId(l) === singleId);
      if (!list) return json({ error: "Unknown TMDB list." }, 404);
      if (!list.enabled) return json({ error: `"${list.name}" is disabled - enable it first.` }, 400);
      ids = [singleId];
    } else {
      ids = enabledQ.map((l) => tmdbCatalogId(l));
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
    if (!list) return json({ error: "Unknown scraper list." }, 404);
    if (!list.enabled) return json({ error: `"${list.name}" is disabled - enable it first.` }, 400);
    targets = [list];
  } else {
    targets = cfg.scraper.lists.filter((l) => l.enabled);
  }
  // S5: don't dispatch a GitHub Actions run just to print "nothing to do".
  if (targets.length === 0) return json({ ok: true, lists: [] });

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
    // F19: sanitize ALL records first (per-record isolation: a malformed
    // record is skipped, never poisons its siblings), then group by history
    // key and write each key ONCE - a 50-record batch for one key goes
    // from ~100 store operations to exactly 2.
    const byKey = new Map();
    for (const r of body.runs) {
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
        const key = runsKeyFor(run.catalog_id);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(run);
      } catch {
        // Skip the bad record; keep ingesting the rest of the batch.
      }
    }
    for (const [key, records] of byKey) {
      try {
        // Orphan-aware eviction: which catalog ids still exist in config
        // for this module's history key? (orphans drop first at the cap)
        const liveIds = await liveCatalogIdsFor(env.STORE, key);
        await addRuns(env.STORE, records, key, liveIds);
      } catch {
        // One key's write failing must not drop the other keys' records.
      }
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Failed to record runs." }, 500);
  }
}

// The set of catalog ids that could legitimately appear in a given runs key:
// the ids whose runs would be keyed there by runsKeyFor(). Used to spot
// orphaned history (list deleted from config) at ingest time.
async function liveCatalogIdsFor(store, runsKey) {
  const cfg = await loadConfig(store);
  const ids = new Set();
  const addIf = (id) => { if (runsKeyFor(id) === runsKey) ids.add(id); };
  for (const l of cfg.scraper.lists) addIf(l.id);
  for (const l of officialCatalogsFor(cfg.official.lists)) addIf(l.id);
  for (const l of cfg.simkl.lists) addIf(`simkl_arriving_today_${l.slug}`);
  for (const l of cfg.tmdb.lists) addIf(tmdbCatalogId(l));
  return ids;
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
  // ponytail: single retry on connection-level failures - the operator's
  // local network drops ~40% of outbound connections (fast-fail, not
  // timeouts), and preview fires dozens of sequential calls where one loss
  // would 502 the whole request. Remove when local networking is stable.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.themoviedb.org/3${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${env.TMDB_READ_ACCESS_TOKEN}`, Accept: "application/json" },
        // Bound a hung TMDB connection - the preview endpoint can issue dozens
        // of sequential rounds, and an unbounded stall would hold the request
        // open until the platform kills it.
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // Return the error as plain data (not a Response wrapper) so every
        // caller's data.error check works: search, discover rounds, and the
        // collection branches all surface TMDB failures to the operator.
        return { error: `TMDB ${res.status}: ${body.slice(0, 200)}` };
      }
      return res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
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
// a discover list entry (normalizeTmdbList shape).
const PREVIEW_PAGES = 25;
const PREVIEW_PAGE_SIZE = 20;

// Client-side sort of the unioned multi-source result set - mirrors the old
// worker's sortParts so preview order matches what the generated catalog
// serves. title_asc on series falls back to popularity (TMDB /discover/tv
// has no name sort). Owner request 2026-08-25: movies without a release
// date are dropped (matching scripts/tmdb.mjs); series keep sinking last.
function sortPreviewItems(items, sortKey, mediaType) {
  const dateField = mediaType === "series" ? "first_air_date" : "release_date";
  const hasDate = (i) => Boolean(i[dateField]);
  if (mediaType !== "series") items = items.filter(hasDate);
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
    const mediaType = entry.mediaType;
    const endpoint = mediaType === "series" ? "/discover/tv" : "/discover/movie";
    const sortMap = mediaType === "series"
      ? { release_desc: "first_air_date.desc", release_asc: "first_air_date.asc", popularity_desc: "popularity.desc", vote_desc: "vote_average.desc", title_asc: "popularity.desc" }
      : { release_desc: "primary_release_date.desc", release_asc: "primary_release_date.asc", popularity_desc: "popularity.desc", vote_desc: "vote_average.desc", title_asc: "original_title.asc" };
    const sortBy = sortMap[entry.sort] || sortMap.release_asc;

    let excludeQs = "";
    if (entry.excludeGenres.length > 0) excludeQs += `&without_genres=${encodeURIComponent(entry.excludeGenres.join("|"))}`;
    if (entry.excludeKeywords.length > 0) excludeQs += `&without_keywords=${encodeURIComponent(entry.excludeKeywords.join("|"))}`;
    if (entry.excludeCompanies.length > 0) excludeQs += `&without_companies=${encodeURIComponent(entry.excludeCompanies.join("|"))}`;
    // B7: optional vote-count floor, mirroring scripts/tmdb.mjs.
    const voteFloorQs = entry.minVoteCount > 0 ? `&vote_count.gte=${entry.minVoteCount}` : "";

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
    // Collection membership is fetched in BOTH modes: OR mode inserts the
    // members directly (full part objects, B3), AND mode uses the set to
    // post-filter discover results below (B2 - previously dead code because
    // the set was only ever built on the OR path).
    const hasCollections = mediaType !== "series" && entry.includeCollections.length > 0;
    const collectionOnly = hasCollections && sources.length === 0 && !andQs;
    if (hasCollections) {
      const parts = [];
      const failedLookups = [];
      const results = await Promise.allSettled(
        [...new Set(entry.includeCollections)].map((id) => tmdbApi(env, `/collection/${id}`))
      );
      for (const r of results) {
        // B6: a failed lookup must be loud, not a silent filter bypass.
        // tmdbApi returns parsed JSON on success or { error } on TMDB
        // failure - the .error check below catches both shapes.
        if (r.status !== "fulfilled") {
          failedLookups.push(String(r.reason?.message || r.reason).slice(0, 120));
          continue;
        }
        if (r.value && typeof r.value.json === "function") {
          const body = await r.value.json().catch(() => ({}));
          failedLookups.push(String(body.error || "unknown TMDB error").slice(0, 120));
          continue;
        }
        if (r.value && r.value.error) {
          failedLookups.push(String(r.value.error).slice(0, 120));
          continue;
        }
        for (const p of r.value.parts || []) {
          collectionIdSet.add(p.id);
          parts.push(p);
        }
      }
      if (failedLookups.length > 0) return json({ error: `Collection lookup failed: ${failedLookups.join("; ")}` }, 502);
      // OR mode: members enter directly. AND + collection-only: discover is
      // skipped entirely (below), so the members ARE the result and must be
      // seeded too - the post-filter then keeps them by identity.
      if (!isAnd("collection") || collectionOnly)
        for (const p of parts) if (!dedup.has(p.id)) dedup.set(p.id, p);
    }
    // Collection-only list (no genre/keyword/company/release-type dim at all):
    // skip the discover round-trips. Otherwise a release-sorted 25-page
    // window almost never intersects an older collection and the preview
    // reads as empty.
    let page = 1;
    let totalPages = 1;
    if (!collectionOnly) {
      do {
        const queries = sources.length > 0 ? sources : [andQs];
        const round = await Promise.all(
          queries.map((qs) =>
            tmdbApi(env, `${endpoint}?${qs.replace(/^&/, "")}&sort_by=${encodeURIComponent(sortBy)}&page=${page}${excludeQs}${voteFloorQs}`)
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
    }

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

    // sortPreviewItems filters undated movies (returns a new array) -
    // capture the result, don't rely on in-place sorting.
    items = sortPreviewItems(items, entry.sort, mediaType);
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
    // Body-parse failures (malformed JSON) stay a 400; anything downstream
    // (TMDB fetch/timeout/parse) is a gateway problem, not the client's (B15).
    if (e instanceof SyntaxError) return json({ error: "Invalid request body: " + e.message }, 400);
    return json({ error: "Preview failed: " + e.message }, 502);
  }
}

// ── MDBList official catalog proxy (configure picker) ───────────────────
// GET /mdblist/official-catalog → the live /lists/official catalog minus
// slugs already configured. Cached ~10 min in KV: the catalog changes at
// MDBList's pace (weeks), not the operator's, and the endpoint is
// undocumented with unknown rate limits - never hammer it.
const OFFICIAL_CATALOG_CACHE_KEY = "cache:mdblist-official";
const OFFICIAL_CATALOG_TTL_MS = 10 * 60 * 1000;

export async function handleMdblistOfficialCatalog(env) {
  if (!env.MDBLIST_API_KEY) {
    return json({ error: "MDBLIST_API_KEY not configured - set it as a Cloudflare worker secret." }, 500);
  }
  const cfg = await loadConfig(env.STORE);
  const existing = new Set(cfg.official.lists.map((l) => l.slug));

  let all = null;
  try {
    const cached = await env.STORE.get(OFFICIAL_CATALOG_CACHE_KEY, "json");
    if (cached && Array.isArray(cached.lists) && Date.now() - cached.fetched_at < OFFICIAL_CATALOG_TTL_MS) {
      all = cached.lists;
    }
  } catch { /* cache miss/hit failure falls through to live fetch */ }

  if (!all) {
    try {
      const res = await fetch(`https://api.mdblist.com/lists/official?apikey=${encodeURIComponent(env.MDBLIST_API_KEY)}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        return json({ error: `MDBList ${res.status}: ${(await res.text()).slice(0, 200)}` }, 502);
      }
      all = await res.json();
      if (!Array.isArray(all)) return json({ error: "Unexpected MDBList catalog shape." }, 502);
      // Best-effort cache write - a KV hiccup must not fail the request.
      try { await env.STORE.put(OFFICIAL_CATALOG_CACHE_KEY, JSON.stringify({ fetched_at: Date.now(), lists: all })); } catch { }
    } catch (e) {
      return json({ error: "Failed to reach MDBList: " + e.message }, 502);
    }
  }

  const lists = all
    .filter((l) => l && typeof l.slug === "string" && !existing.has(l.slug))
    .map((l) => ({
      slug: l.slug,
      name: l.name || l.slug,
      description: l.description || "",
      items: Number.isInteger(l.items) ? l.items : null,
      movies: Number.isInteger(l.movies) ? l.movies : null,
      shows: Number.isInteger(l.shows) ? l.shows : null,
      updated: l.updated || null,
    }));
  return json({ lists });
}