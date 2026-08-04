#!/usr/bin/env node
// Dry-run integration tests: every worker route against an in-memory fake
// KV + stub GitHub API. No network except githubPagesCatalogUrl — that's
// stubbed too. Run: node scripts/dry-test.mjs

import { strict as assert } from "node:assert";
import {
  loadConfig, saveConfig, migrateConfig, emptyConfig,
  randomScraperId, listContentHash, addRun, getRuns,
} from "../src/config.js";
import {
  buildManifest, handleStatus, handleSaveConfig, handleExportConfig,
  handleTriggerRefresh, handleRunsPost, handleCatalog, CATALOG_RE,
} from "../src/routes.js";

// exact copy of SEED_LISTS[0].url from src/config.js — healing matches URLs verbatim
const SEED_URL = "https://mdblist.com/movies/?q_title=&q_sort=releasedigital&q_sortorder=asc&q_current_page=0&actor=&director=&yearf=&yeart=&yearr=365&yearu=0&q_score_input=1&q_score_input_max=100&q_rogerebert_input=0.0&q_rogerebert_input_max=4.0&q_imdbrating_input=4.0&q_imdbrating_input_max=10.0&q_imdbvotes_input=400&q_traktrating_input=0&q_traktrating_input_max=100&q_traktvotes_input=0&q_tmdbrating_input=0&q_tmdbrating_input_max=100&q_tmdbvotes_input=1&q_letterrating_input=0.0&q_letterrating_input_max=5.0&q_lettervotes_input=0&q_metacriticsrating_input=0&q_metacriticsrating_input_max=100&q_metacriticsvotes_input=0&q_tomatoesrating_input=0&q_tomatoesrating_input_max=100&q_tomatoesvotes_input=0&q_audiencerating_input=0&q_audiencerating_input_max=100&q_audiencevotes_input=0&q_anidbrating_input=0.0&q_anidbrating_input_max=10.0&q_anidbvotes_input=0&parental_nudity_min_i=0&parental_nudity_i=5&parental_violence_min_i=0&parental_violence_i=5&parental_language_min_i=0&parental_language_i=5&parental_drinking_min_i=0&parental_drinking_i=5&q_score_average=on&tmdbid_hide=on&q_genre_exclude=documentary&q_genre_exclude=game-show&q_genre_exclude=home-and-garden&q_genre_exclude=news&q_genre_exclude=reality&q_genre_exclude=reality-tv&q_genre_exclude=special-interest&q_genre_exclude=sporting-event&q_genre_exclude=talk-show&q_genre_exclude=tv-movie&q_status=released&q_release=4&release_regions=&release_days_past=&release_days_future=&q_language_x=ml&q_language_x=ta&q_language_x=te&q_country=&q_country_x=mx%2Cpk%2Ckr%2Cru%2Ctr%2Ccn%2Ceg%2Cbd%2Ctw%2Cid&budget=&revenue=&production_country=&production_country_exclude=&q_runtime_min=&q_runtime_max=&q_list=&q_listx=&q_tagx=10979&q_tagx=124256&q_tagx=295269&q_tagx=295272&q_theater=&q_region=US%2CCA%2CIN&q_provider_x=11&q_provider_x=73&q_provider_x=212&q_provider_x=232&q_provider_x=257&q_provider_x=528&q_limit=200&q_watched=&q_trakt_list_name=&q_trakt_list_desc=";

function makeKV() {
  const m = new Map();
  return {
    get: async (k, t) => { const v = m.get(k); return t === "json" && v ? JSON.parse(v) : v ?? null; },
    put: async (k, v) => m.set(k, typeof v === "string" ? v : JSON.stringify(v)),
    _m: m,
  };
}

function makeEnv(kv) {
  const ghCalls = [];
  const env = {
    STORE: kv,
    GITHUB_PAGES_BASE: "https://stub.pages/base",
    GH_TOKEN: "tok", GH_REPO: "u/r", GH_WORKFLOW: "scrape.yml", GH_REF: "main",
    _ghCalls: ghCalls,
  };
  env.GH_FETCH = async (url, opts) => {
    ghCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    return { status: 204, text: async () => "" };
  };
  return env;
}

// env whose GH fetch always fails (401) — save must reject with 502
function makeEnvGHFail(kv) {
  const ghCalls = [];
  const env = {
    STORE: kv,
    GITHUB_PAGES_BASE: "https://stub.pages/base",
    GH_TOKEN: "tok", GH_REPO: "u/r", GH_WORKFLOW: "scrape.yml", GH_REF: "main",
    _ghCalls: ghCalls,
  };
  env.GH_FETCH = async () => {
    ghCalls.push({ url: "x", body: null });
    return { status: 401, text: async () => "unauthorized" };
  };
  return env;
}

const jsonOf = async (r) => JSON.parse(await r.text());

// dispatch.js calls global fetch — swap it for the fake during a call
async function withFetch(fake, fn) {
  const og = global.fetch;
  global.fetch = fake;
  try { return await fn(); } finally { global.fetch = og; }
}

let n = 0;
function check(name, fn) {
  try { fn(); n++; console.log("PASS " + name); }
  catch (e) { console.log("FAIL " + name + " — " + e.message); process.exitCode = 1; }
}

// ── config.js ──
{
  const kv = makeKV();
  const cfg = await loadConfig(kv);                       // empty KV → seeds
  assert.equal(cfg.scraper.lists.length, 3);
  assert.equal(cfg.scraper.lists[0].id, "mdb_scrape_1djyii3b");
  assert.ok(kv._m.has("config"), "seed persisted");
  const cfg2 = await loadConfig(kv);
  assert.deepEqual(cfg2, cfg, "second load stable");
  check("loadConfig seeds 3 pinned lists on empty KV, persists", () => {});

  const l0 = cfg.scraper.lists[0];
  assert.equal(listContentHash(l0), listContentHash({ ...l0 }));
  assert.notEqual(listContentHash(l0), listContentHash({ ...l0, maxPages: 5 }), "maxPages in hash");
  assert.notEqual(listContentHash(l0), listContentHash({ ...l0, enabled: false }), "enabled in hash");
  assert.equal(listContentHash(l0), listContentHash({ ...l0, name: "Different" }), "name NOT in hash");
  check("listContentHash: url/maxPages/enabled only", () => {});

  const m1 = migrateConfig({ scraper: { lists: [{ name: "x", url: "https://mdblist.com/movies/?q_limit=10" }] } });
  assert.ok(m1.scraper.lists[0].id.startsWith("mdb_scrape_"));
  assert.equal(m1.scraper.lists[0].maxPages, 3);
  const m2 = migrateConfig({ scraper: { lists: [{ id: "mdb_scrape_abc", maxPages: 999 }] } });
  assert.equal(m2.scraper.lists[0].maxPages, 50, "clamp high");
  const m3 = migrateConfig({ scraper: { lists: [{ maxPages: -5 }] } });
  assert.equal(m3.scraper.lists[0].maxPages, 1, "negative maxPages clamped to 1");
  const m4 = migrateConfig({ scraper: { lists: [{ name: "   ", type: "series", maxPages: 2.7 }] } });
  assert.equal(m4.scraper.lists[0].name, "Untitled");
  assert.equal(m4.scraper.lists[0].type, "series");
  assert.equal(m4.scraper.lists[0].maxPages, 2, "floor");
  check("migrateConfig: id gen, clamping, defaults", () => {});

  // heal: persisted list with seed URL but wrong id → rewritten to pinned id (once only)
  {
    const kv2 = makeKV();
    await kv2.put("config", JSON.stringify({ scraper: { lists: [{ id: "mdb_scrape_old1", name: "Old", url: SEED_URL, type: "movie", maxPages: 3, enabled: true }] } }));
    const c = await loadConfig(kv2);
    assert.equal(c.scraper.lists[0].id, "mdb_scrape_1djyii3b", "healed to pinned id");
    // second load: healing is one-shot — a NEW list added later with the seed URL
    // must keep its own id (the pinned one is already taken)
    const kv3 = makeKV();
    await kv3.put("config", JSON.stringify({ scraper: { lists: [{ id: "mdb_scrape_other", name: "Other", url: "https://mdblist.com/movies/?q_sort=popularity", type: "movie", maxPages: 3, enabled: true }] } }));
    await kv3.put("healed", "1");
    const c2 = await loadConfig(kv3);
    assert.equal(c2.scraper.lists[0].id, "mdb_scrape_other", "no rewrite after healed marker");
    check("loadConfig heals once, then leaves ids alone", () => {});
  }

  // runs cap at 30, newest first
  {
    const kv3 = makeKV();
    for (let i = 0; i < 35; i++) await addRun(kv3, { id: i, catalog_id: "x" });
    const runs = await getRuns(kv3);
    assert.equal(runs.length, 30);
    assert.equal(runs[0].id, 34);
    assert.equal(runs[29].id, 5);
    check("addRun caps history at 30, unshift order", () => {});
  }
}

// ── routes.js — one fresh KV per save scenario (each save persists) ──

async function freshEnv() {
  const k = makeKV();
  const e = makeEnv(k);
  await loadConfig(k);          // seed the 3 pinned lists
  return { kv: k, env: e };
}

{
  const { env } = await freshEnv();
  const man = await buildManifest(env);
  assert.equal(man.catalogs.length, 3);
  assert.deepEqual(man.types, ["movie", "series"]);
  check("buildManifest lists 3 enabled catalogs", () => {});

  // every catalog declares the skip extra so Stremio paginates past item 100
  for (const c of man.catalogs) {
    assert.deepEqual(c.extra, [{ name: "skip", isRequired: false }]);
    assert.ok("name" in c && "id" in c && "type" in c, "catalog has name/id/type");
  }
  check("manifest catalogs declare skip extra (name/id/type order)", () => {});
}

{
  // no-op: same list, same fields → no dispatch, no GH call
  const { kv, env } = await freshEnv();
  const cur = await loadConfig(kv);
  const body = { scraper: { lists: cur.scraper.lists } };
  const res = await handleSaveConfig(env, new Request("http://x/save-config", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const d = await jsonOf(res);
  assert.equal(d.ok, true);
  assert.equal(d.changed.length, 0); assert.equal(d.added.length, 0);
  assert.equal(d.dispatch.length, 0);
  assert.equal(env._ghCalls.length, 0, "no GH dispatch for no-op");
  check("save no-op: no dispatch", () => {});
}

{
  // add one list → dispatch scrape for it only
  const { kv, env } = await freshEnv();
  const cur = await loadConfig(kv);
  const list = { id: "mdb_scrape_new1", name: "New", url: "https://mdblist.com/shows/?q_limit=10", type: "series", maxPages: 2, enabled: true };
  const res = await withFetch(env.GH_FETCH, () => handleSaveConfig(env, new Request("http://x/save-config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scraper: { lists: [...cur.scraper.lists, list] } }),
  })));
  const d = await jsonOf(res);
  assert.equal(d.added.length, 1); assert.equal(d.dispatch.length, 1);
  assert.equal(d.github.dispatched, true);
  assert.equal(env._ghCalls.length, 1);
  assert.equal(env._ghCalls[0].body.inputs.action, "scrape");
  assert.deepEqual(env._ghCalls[0].body.inputs.lists, "mdb_scrape_new1");
  check("save add: dispatches scrape for the added list only", () => {});
}

{
  // delete one list → scrape_delete + delete_ids for the workflow to rm the data file
  const { kv, env } = await freshEnv();
  const cur = await loadConfig(kv);
  const res = await withFetch(env.GH_FETCH, () => handleSaveConfig(env, new Request("http://x/save-config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scraper: { lists: cur.scraper.lists.slice(0, 2) } }),
  })));
  const d = await jsonOf(res);
  assert.equal(d.removed.length, 1);
  assert.equal(env._ghCalls.length, 1);
  assert.equal(env._ghCalls[0].body.inputs.action, "scrape_delete");
  assert.deepEqual(env._ghCalls[0].body.inputs.delete_ids, cur.scraper.lists[2].id);
  check("save delete: scrape_delete + delete_ids for data file", () => {});
}

{
  // change maxPages on list 0 + delete list 2 → scrape_delete with delete_ids
  const { kv, env } = await freshEnv();
  const cur = await loadConfig(kv);
  const list0 = { ...cur.scraper.lists[0], maxPages: 5 };
  const kept = [list0, cur.scraper.lists[1]];
  const res = await withFetch(env.GH_FETCH, () => handleSaveConfig(env, new Request("http://x/save-config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scraper: { lists: kept } }),
  })));
  const d = await jsonOf(res);
  assert.equal(d.changed.length, 1); assert.equal(d.removed.length, 1);
  assert.equal(env._ghCalls.length, 1);
  assert.equal(env._ghCalls[0].body.inputs.action, "scrape_delete");
  assert.deepEqual(env._ghCalls[0].body.inputs.delete_ids, cur.scraper.lists[2].id);
  assert.deepEqual(env._ghCalls[0].body.inputs.lists, "mdb_scrape_1djyii3b");
  check("save change+delete: scrape_delete with delete_ids", () => {});
}

{
  // disabled list change → NOT dispatched (hash changes but dispatch skips disabled)
  const { kv, env } = await freshEnv();
  const cur = await loadConfig(kv);
  const list0 = { ...cur.scraper.lists[0], enabled: false };
  const res = await withFetch(env.GH_FETCH, () => handleSaveConfig(env, new Request("http://x/save-config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scraper: { lists: [list0, ...cur.scraper.lists.slice(1)] } }),
  })));
  const d = await jsonOf(res);
  assert.equal(d.changed.length, 1, "still reported changed");
  assert.equal(d.dispatch.length, 0, "not dispatched (disabled)");
  assert.equal(env._ghCalls.length, 0);
  check("save: disabled list changes not dispatched", () => {});
}

{
  // GH dispatch fails → save rejected with 502, config NOT persisted
  const { kv } = await freshEnv();
  const cur = await loadConfig(kv);
  const envFail = makeEnvGHFail(kv);
  const list0 = { ...cur.scraper.lists[0], maxPages: 9 };
  const res = await withFetch(envFail.GH_FETCH, () => handleSaveConfig(envFail, new Request("http://x/save-config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scraper: { lists: [list0, ...cur.scraper.lists.slice(1)] } }),
  })));
  const d = await jsonOf(res);
  assert.equal(res.status, 502, "dispatch failure rejected");
  assert.equal(d.ok, false);
  const after = await loadConfig(kv);
  assert.equal(after.scraper.lists[0].maxPages, 3, "config NOT persisted on dispatch failure");
  check("save: GH dispatch fail → 502, config not persisted", () => {});
}

{
  // malformed body: scraper missing → migrateConfig falls back to empty lists → would
  // silently wipe config; handleSaveConfig guard should 400 it
  const { env: envBad } = await freshEnv();
  const res = await handleSaveConfig(envBad, new Request("http://x/save-config", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nope: 1 }),
  }));
  assert.equal(res.status, 400, "malformed save body rejected");
  check("save malformed body → 400", () => {});
}

{
  // runs POST + status
  const { kv: kvR, env: envR } = await freshEnv();
  const before = (await getRuns(kvR)).length;
  const res = await handleRunsPost(envR, new Request("http://x/runs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runs: [{ catalog_id: "mdb_scrape_1djyii3b", pages_scraped: 2, movies_found: 40, status: "success" }] }),
  }));
  assert.equal(res.status, 200);
  assert.equal((await getRuns(kvR)).length, before + 1);
  const bad = await handleRunsPost(envR, new Request("http://x/runs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: 1 }),
  }));
  assert.equal(bad.status, 400);
  const tooMany = await handleRunsPost(envR, new Request("http://x/runs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runs: Array.from({ length: 51 }, () => ({ catalog_id: "x" })) }),
  }));
  assert.equal(tooMany.status, 400, "runs cap 50");
  check("runs POST records + validates + caps at 50", () => {});

  const st = await handleStatus(envR);
  const out = await jsonOf(st);
  assert.ok(Array.isArray(out));
  assert.equal(out[0].catalog_name, "Latest Movie(digital releases)");
  assert.equal(out[0].catalog_id, "mdb_scrape_1djyii3b");
  assert.ok(!("id" in out[0]), "no internal run id");
  assert.match(out[0].started_at_ist, /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2} (AM|PM)$/);
  check("status: name+id fields, IST format, no raw id", () => {});
}

{
  const { kv: kvR, env: envR } = await freshEnv();
  const cur = await loadConfig(kvR);
  const res = await withFetch(envR.GH_FETCH, () => handleTriggerRefresh(envR));
  const d = await jsonOf(res);
  assert.equal(d.ok, true);
  const last = envR._ghCalls[envR._ghCalls.length - 1];
  assert.equal(last.body.inputs.action, "scrape");
  assert.equal(last.body.inputs.lists, cur.scraper.lists.map((l) => l.id).join(","));
  check("trigger-refresh dispatches all enabled", () => {});
}

{
  // unconfigured GH → 501
  const { kv: kvU, env: envU } = await freshEnv();
  const env2 = makeEnv(kvU); env2.GH_TOKEN = undefined; env2.GH_REPO = undefined; env2.GH_WORKFLOW = undefined;
  const res = await handleTriggerRefresh(env2);
  assert.equal(res.status, 501);
  check("trigger-refresh without GH env → 501", () => {});
}

{
  // catalog fetch: stub GH Pages → empty metas
  const og = global.fetch;
  global.fetch = async (u) => ({ ok: true, json: async () => ({ items: [{ imdb_id: "tt1", title: "A", year: 2020, score: 80, poster_path: "/p.jpg", description: "d" }] }) });
  try {
    const { kv: kvC, env: envC } = await freshEnv();
    const res = await handleCatalog(envC, "movie", "mdb_scrape_1djyii3b", 0);
    const out = await jsonOf(res);
    assert.equal(out.metas.length, 1);
    assert.equal(out.metas[0].id, "tt1");
    assert.equal(out.metas[0].imdbRating, "8.0");
    assert.match(out.metas[0].poster, /^https:\/\/image\.tmdb\.org/);
    const res2 = await handleCatalog(envC, "movie", "unknown-id", 0);
    assert.equal((await jsonOf(res2)).metas.length, 0);
  } finally { global.fetch = og; }
  check("catalog: rowToMeta mapping, unknown id → empty", () => {});
}

{
  assert.ok(CATALOG_RE.test("/catalog/movie/mdb_scrape_x/skip=100.json"));
  assert.ok(CATALOG_RE.test("/catalog/series/mdb_scrape_x.json"));
  check("CATALOG_RE matches both url shapes", () => {});
}

{
  // XSS probe: hostile name/url through full page render must stay escaped
  const bad = {
    scraper: { lists: [{ id: "mdb_scrape_x", name: '</script><img src=x onerror=alert(1)>', url: 'javascript:alert(1)"', type: "movie", maxPages: 3, enabled: true }] },
  };
  const { buildConfigurePage } = await import("../src/configure.js");
  const page = buildConfigurePage("https://x", bad);
  // state blob must escape < so </script> can't break out of the inline script
  assert.ok(page.includes('\\u003c/script>'), "state blob escapes < (</script> neutralized)");
  // name is rendered client-side via escapeAttr()
  assert.ok(page.includes("'<span class=\"name-static\">' + escapeAttr(l.name)"),
    "render path escapes via escapeAttr");
  const blob = page.slice(page.indexOf("<script>"));
  assert.ok(blob.includes("escapeAttr"), "escapeAttr defined in page JS");
  check("configure page escapes hostile name/url", () => {});
}

console.log("\nDone. " + (process.exitCode ? "FAILURES" : "ALL PASS"));
