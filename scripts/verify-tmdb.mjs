// Self-check for the TMDB module additions: config migration, content
// hash stability, generator source-plan logic, and the configure page UI.
// Run: node scripts/verify-tmdb.mjs
import { migrateConfig, tmdbContentHash, normalizeTmdbList, runsKeyFor } from "../src/config.js";
import { buildDiscoverSources, computeSourceHash } from "./tmdb.mjs";
import { JSDOM } from "jsdom";

let fail = 0;
const check = (name, ok) => { console.log((ok ? "PASS" : "FAIL") + " " + name); if (!ok) fail++; };

// ── config.js ──
const raw = {
  scraper: { lists: [] }, official: { lists: [] }, simkl: { lists: [] },
  tmdb: { lists: [{
    discoverListId: "abc12345", name: "Test", mediaType: "movie", sort: "popularity_desc", enabled: true,
    includeModes: { genre: "or", keyword: "and", company: "and", collection: "and" },
    includeGenres: [28, 27], excludeGenres: [99], includeKeywords: [1], excludeKeywords: [],
    includeCompanies: [], excludeCompanies: [], includeReleaseTypes: [4],
    includeCollections: [10], excludeCollections: [],
  }] },
};
const cfg = migrateConfig(raw);
check("migrate keeps valid tmdb list", cfg.tmdb.lists.length === 1);
check("migrated entry fields survive", cfg.tmdb.lists[0].discoverListId === "abc12345" && cfg.tmdb.lists[0].includeModes.genre === "or");
check("bad id dropped", normalizeTmdbList({ discoverListId: "BAD ID!" }) === null);
check("unknown mediaType coerced to movie", normalizeTmdbList({ discoverListId: "abc12345", mediaType: "all" }).mediaType === "movie");
check("runsKeyFor tmdb branch", runsKeyFor("tmdb_discover_movie_abc12345") === "runs:tmdb");

const l = cfg.tmdb.lists[0];
const h1 = tmdbContentHash(l);
check("hash stable across identical copies", tmdbContentHash(JSON.parse(JSON.stringify(l))) === h1);
const renamed = { ...JSON.parse(JSON.stringify(l)), name: "Renamed" };
check("rename does not change hash", tmdbContentHash(renamed) === h1);
const toggled = { ...JSON.parse(JSON.stringify(l)), enabled: false };
check("disable does not change hash (dispatch handled separately)", tmdbContentHash(toggled) === h1);
const genreChanged = JSON.parse(JSON.stringify(l));
genreChanged.includeGenres.push(53);
check("filter change changes hash", tmdbContentHash(genreChanged) !== h1);

// ── tmdb.mjs source plan ──
const allAnd = buildDiscoverSources({ includeGenres: [28], includeKeywords: [1], includeModes: {} }, "movie");
check("all-AND is single query mode", allAnd.singleQueryMode && allAnd.sources.length === 0);
check("AND fragment carries all dims", allAnd.singleQueryQs.includes("with_genres=28") && allAnd.singleQueryQs.includes("with_keywords=1"));

const genreOr = buildDiscoverSources({ includeGenres: [28], includeKeywords: [1], includeModes: { genre: "or" } }, "movie");
check("OR genre fans out to one discover source", genreOr.sources.length === 1 && genreOr.sources[0].qs.includes("with_genres=28") && genreOr.sources[0].qs.includes("with_keywords=1"));
check("OR genre not single-query", !genreOr.singleQueryMode);

const collOnlyOr = buildDiscoverSources({ includeCollections: [10], includeKeywords: [1], includeModes: { collection: "or" } }, "movie");
check("collection-only OR emits AND fragment as own source (bug fix)", collOnlyOr.sources.some((s) => s.kind === "discover" && s.qs.includes("with_keywords=1")));

const seriesColl = buildDiscoverSources({ includeCollections: [10], includeModes: { collection: "or" } }, "series");
check("collection ignored for series", seriesColl.sources.length === 0 && seriesColl.singleQueryMode);

const rtSeries = buildDiscoverSources({ includeReleaseTypes: [4], includeModes: {} }, "series");
check("release type ignored for series", !rtSeries.singleQueryQs.includes("with_release_type"));

const hashA = computeSourceHash({ ...l });
const reordered = JSON.parse(JSON.stringify(l));
reordered.includeGenres = [...l.includeGenres].reverse();
check("sourceHash order-independent", computeSourceHash(reordered) === hashA);

// ── configure.js UI ──
const { buildConfigurePage } = await import("../src/configure.js");
const html = buildConfigurePage("https://example.workers.dev", {
  scraper: { lists: [] }, official: { lists: [] }, simkl: { lists: [] }, tmdb: { lists: [l] },
});
const errors = [];
const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });
dom.window.addEventListener("error", (e) => errors.push(e.message));
await new Promise((r) => setTimeout(r, 1200));
const doc = dom.window.document;
check("UI: no JS errors", errors.length === 0);
if (errors.length) console.log(errors.join("\n"));
check("UI: TMDB menu item active-capable", !!doc.querySelector('.menu-item[data-module="tmdb"]'));
dom.window.activateModule("tmdb");
await new Promise((r) => setTimeout(r, 100));
check("UI: renderTmdb renders card", !!doc.getElementById("tcard-0"));
check("UI: card shows id chip", doc.getElementById("tcard-0").textContent.includes("tmdb_discover_movie_abc12345"));
check("UI: dimension sections rendered", doc.querySelectorAll("#tcard-0 .tmdb-dim").length === 5);
check("UI: AND tag present", !!doc.querySelector("#tcard-0 .dim-mode-tag"));
check("UI: preview button present", !!doc.querySelector('#tcard-0 .card-actions .secondary'));
check("UI: header title set", doc.getElementById("headerTitle").textContent === "TMDB List");
dom.window.activateModule("scraper");
await new Promise((r) => setTimeout(r, 50));
check("UI: switching back to scraper works", !!doc.querySelector(".list-card, .create-list-section"));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
