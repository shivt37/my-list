// Standalone verification: regen-on-enable for Official + TMDB in
// handleSaveConfig (owner request 2026-08-24), plus scraper regressions.
//
// Run: node scripts/save-config.test.mjs
// No deps - stubs globalThis.fetch (captures workflow dispatches, returns
// GitHub's 204) and a fake KV. Fixtures are passed through migrateConfig()
// so the stored config and the incoming body share identical normalized
// shapes (otherwise migration's own field-filling reads as a Simkl change).
import assert from "node:assert/strict";
import { handleSaveConfig } from "../src/routes.js";
import { migrateConfig, SIMKL_LISTS } from "../src/config.js";

// ── capture harness ──────────────────────────────────────────────────
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = u.match(/actions\/workflows\/([^/]+)\/dispatches/);
  if (m && init?.method === "POST") {
    calls.push({ workflow: m[1], inputs: JSON.parse(init.body).inputs });
    return new Response(null, { status: 204 });
  }
  if (m) throw new Error("unexpected non-POST hit on dispatches");
  return realFetch(url, init);
};

function fakeKV(initial) {
  let data = initial === undefined ? null : JSON.parse(JSON.stringify(initial));
  return {
    get: async () => (data === null ? null : JSON.parse(JSON.stringify(data))),
    put: async (_k, v) => { data = JSON.parse(v); },
    dump: () => data,
  };
}

const req = (body) => new Request("http://worker.test/save-config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// GH creds present so scraper dispatches reach the capture point too.
const ENV = (kv) => ({ STORE: kv, GH_TOKEN: "t", GH_REPO: "owner/repo", GH_WORKFLOW: "scrape.yml" });

const RAW_BASE = () => ({
  scraper: { lists: [{
    id: "mdb_scrape_aaaa", name: "list-a",
    url: "https://mdblist.com/movies/a", type: "movie", maxPages: 1, enabled: true,
  }] },
  // INVARIANT (loadConfig): official must carry exactly the 3 known slugs
  // and simkl exactly the 2 known slugs - any other count is wholesale-
  // replaced with defaults before diffs run. Fixtures honor that.
  official: { lists: [
    { slug: "popular", name: "Popular", enabled: true },
    { slug: "justwatch-streaming-charts", name: "JustWatch Streaming Charts", enabled: true },
    { slug: "moviemeter", name: "MovieMeter", enabled: false },
  ] },
  simkl: { lists: SIMKL_LISTS.map((s) => ({ ...structuredClone(s) })) },
  tmdb: { lists: [] },
});
// Migrated once per use so stored/incoming shapes always match.
const baseConfig = () => migrateConfig(RAW_BASE());

const tmdbList = (over = {}) => ({
  discoverListId: "abcd1234", name: "TMDB One", mediaType: "movie",
  sort: "popularity_desc", enabled: true,
  includeModes: {}, includeGenres: [], excludeGenres: [],
  includeKeywords: [], includeKeywordNames: [], excludeKeywords: [], excludeKeywordNames: [],
  includeCompanies: [], includeCompanyNames: [], excludeCompanies: [], excludeCompanyNames: [],
  includeCollections: [], includeCollectionNames: [], excludeCollections: [], excludeCollectionNames: [],
  includeReleaseTypes: [],
  ...over,
});
const tmdbBase = (lists) => {
  const cfg = baseConfig();
  cfg.tmdb = { lists };
  return cfg;
};

async function save(kv, body) {
  const res = await handleSaveConfig(ENV(kv), req(body));
  return { status: res.status, json: await res.json() };
}

const byWf = (wf) => calls.filter((c) => c.workflow === wf);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── OFFICIAL ─────────────────────────────────────────────────────────
test("official OFF->ON dispatches official.yml with the slug", async () => {
  const kv = fakeKV(baseConfig());
  calls.length = 0;
  const b = baseConfig();
  b.official.lists[2].enabled = true; // moviemeter
  const { status, json } = await save(kv, b);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  const off = byWf("official.yml");
  assert.equal(off.length, 1);
  assert.equal(off[0].inputs.slugs, "moviemeter");
  assert.deepEqual(json.officialDispatchedSlugs, ["moviemeter"]);
});

test("official ON->OFF dispatches nothing", async () => {
  const kv = fakeKV(baseConfig());
  calls.length = 0;
  const b = baseConfig();
  b.official.lists[0].enabled = false; // popular
  await save(kv, b);
  assert.deepEqual(calls, []);
});

test("net-unchanged official config dispatches nothing", async () => {
  const kv = fakeKV(baseConfig());
  calls.length = 0;
  await save(kv, baseConfig());
  assert.deepEqual(calls, []);
});

test("two officials OFF->ON in one save = ONE joined dispatch", async () => {
  const seed = baseConfig();
  seed.official.lists[0].enabled = false; // popular
  seed.official.lists[2].enabled = false; // moviemeter
  const kv = fakeKV(seed);
  calls.length = 0;
  const b = baseConfig();
  b.official.lists[0].enabled = true;
  b.official.lists[2].enabled = true;
  await save(kv, b);
  const off = byWf("official.yml");
  assert.equal(off.length, 1, "exactly one official dispatch");
  assert.equal(off[0].inputs.slugs, "popular,moviemeter");
});

test("official rename-only stays silent", async () => {
  const kv = fakeKV(baseConfig());
  calls.length = 0;
  const b = baseConfig();
  b.official.lists[1].name = "Renamed Charts";
  await save(kv, b);
  assert.deepEqual(calls, []);
});

test("official dispatch failure rejects save AND skips persist", async () => {
  const kv = fakeKV(baseConfig());
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/dispatches")) return new Response("boom", { status: 500 });
    return real(url, init);
  };
  try {
    calls.length = 0;
    const b = baseConfig();
    b.official.lists[2].enabled = true;
    const { status, json } = await save(kv, b);
    assert.equal(status, 502);
    assert.match(json.error, /official dispatch failed/);
    assert.equal(kv.dump().official.lists[2].enabled, false, "persist skipped on failure");
  } finally { globalThis.fetch = real; }
});

// ── TMDB ─────────────────────────────────────────────────────────────
test("tmdb OFF->ON with unchanged content generates (old gap closed)", async () => {
  const kv = fakeKV(tmdbBase([{ ...tmdbList(), enabled: false }]));
  calls.length = 0;
  await save(kv, tmdbBase([{ ...tmdbList(), enabled: true }]));
  const t = byWf("tmdb.yml");
  assert.equal(t.length, 1);
  assert.equal(t[0].inputs.ids, "tmdb_discover_movie_abcd1234");
});

test("tmdb response names toggled-on list as regenerating", async () => {
  const kv = fakeKV(tmdbBase([{ ...tmdbList(), enabled: false }]));
  calls.length = 0;
  const { json } = await save(kv, tmdbBase([{ ...tmdbList(), enabled: true }]));
  assert.deepEqual(json.tmdbChanged, ["TMDB One"]);
});

test("tmdb content-edit + toggle-on same save = deduped single id", async () => {
  const kv = fakeKV(tmdbBase([{ ...tmdbList(), enabled: false }]));
  calls.length = 0;
  await save(kv, tmdbBase([{ ...tmdbList(), enabled: true, sort: "release_desc" }]));
  const t = byWf("tmdb.yml");
  assert.equal(t.length, 1);
  assert.equal(t[0].inputs.ids.split(",").length, 1);
});

test("tmdb ON->OFF dispatches neither generate nor delete", async () => {
  const kv = fakeKV(tmdbBase([{ ...tmdbList() }]));
  calls.length = 0;
  await save(kv, tmdbBase([{ ...tmdbList(), enabled: false }]));
  assert.equal(byWf("tmdb.yml").length, 0);
});

test("tmdb removal still carries delete_ids without ids (regression)", async () => {
  const kv = fakeKV(tmdbBase([{ ...tmdbList() }]));
  calls.length = 0;
  await save(kv, tmdbBase([]));
  const t = byWf("tmdb.yml");
  assert.equal(t.length, 1);
  assert.equal(t[0].inputs.delete_ids, "tmdb_discover_movie_abcd1234");
  assert.ok(!("ids" in t[0].inputs));
});

test("tmdb content edit while already enabled still generates (regression)", async () => {
  const kv = fakeKV(tmdbBase([{ ...tmdbList() }]));
  calls.length = 0;
  await save(kv, tmdbBase([{ ...tmdbList(), includeGenres: [27] }]));
  const t = byWf("tmdb.yml");
  assert.equal(t.length, 1);
  assert.equal(t[0].inputs.ids, "tmdb_discover_movie_abcd1234");
});

test("tmdb added-while-disabled does not generate (unchanged semantics)", async () => {
  const kv = fakeKV(tmdbBase([]));
  calls.length = 0;
  await save(kv, tmdbBase([tmdbList({ enabled: false })]));
  assert.equal(byWf("tmdb.yml").length, 0);
});

// ── ORDERING ─────────────────────────────────────────────────────────
test("official fires BEFORE destructive scraper when both change", async () => {
  const kv = fakeKV(baseConfig());
  calls.length = 0;
  const b = baseConfig();
  b.official.lists[2].enabled = true;                      // official dispatch
  b.scraper.lists[0].url = "https://mdblist.com/movies/b"; // scraper dispatch
  await save(kv, b);
  assert.equal(calls[0].workflow, "official.yml");
  assert.equal(calls[1].workflow, "scrape.yml");
});

// ── SCRAPER/SIMKL regressions ────────────────────────────────────────
test("scraper url edit dispatches scrape for that id (regression)", async () => {
  const kv = fakeKV(baseConfig());
  calls.length = 0;
  const b = baseConfig();
  b.scraper.lists[0].url = "https://mdblist.com/movies/b";
  await save(kv, b);
  const s = byWf("scrape.yml");
  assert.equal(s.length, 1);
  assert.equal(s[0].inputs.lists, "mdb_scrape_aaaa");
  assert.equal(s[0].inputs.action, "scrape");
});

test("scraper removal dispatches scrape_delete with delete_ids (regression)", async () => {
  const kv = fakeKV(baseConfig());
  calls.length = 0;
  const b = baseConfig();
  b.scraper.lists = [];
  await save(kv, b);
  const s = byWf("scrape.yml");
  assert.equal(s.length, 1);
  assert.equal(s[0].inputs.action, "scrape_delete");
  assert.equal(s[0].inputs.delete_ids, "mdb_scrape_aaaa");
});

test("scraper rename-only stays silent (regression)", async () => {
  const kv = fakeKV(baseConfig());
  calls.length = 0;
  const b = baseConfig();
  b.scraper.lists[0].name = "renamed-a";
  await save(kv, b);
  assert.equal(byWf("scrape.yml").length, 0);
});

test("simkl filter edit still dispatches kinds (regression)", async () => {
  const kv = fakeKV(baseConfig());
  calls.length = 0;
  const b = baseConfig();
  b.simkl.lists[0].filter.rating_tiers = [
    ...(b.simkl.lists[0].filter.rating_tiers || []),
    { min_rating: 5 },
  ];
  await save(kv, b);
  const s = byWf("simkl.yml");
  assert.equal(s.length, 1);
  assert.equal(s[0].inputs.kinds, "series");
});

// ── runner ───────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log("  ok:", name);
  } catch (e) {
    failed++;
    console.error("FAIL:", name, "\n      ", e.message);
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nALL CHECKS PASSED");
globalThis.fetch = realFetch;
process.exit(failed ? 1 : 0);
