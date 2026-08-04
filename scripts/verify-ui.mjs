// Headless check of the built /configure page: no JS errors, one Status
// button up top (new tab), create-list form rendered before cards,
// compact card-row layout. Run: node scripts/verify-ui.mjs
import { JSDOM } from "jsdom";
import { buildConfigurePage } from "../src/configure.js";

const html = buildConfigurePage("https://my-list.st87.workers.dev", {
  scraper: { lists: [
    { id: "mdb_scrape_1djyii3b", name: "Latest Movie(digital releases)", url: "https://mdblist.com/movies/?q_sort=releasedigital", type: "movie", maxPages: 3, enabled: true },
    { id: "mdb_scrape_ogu4jkeo", name: "Latest Shows", url: "https://mdblist.com/shows/?q_sort=released", type: "series", maxPages: 3, enabled: false },
  ] },
});

const errors = [];
const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });
dom.window.addEventListener("error", (e) => errors.push(e.message));
const w = dom.window;
const doc = w.document;
await new Promise((r) => setTimeout(r, 1200));

let fail = 0;
const check = (name, ok) => { console.log((ok ? "PASS" : "FAIL") + " " + name); if (!ok) fail++; };

check("no JS errors", errors.length === 0);
if (errors.length) console.log(errors.join("\n"));

check("toolbar Status button exists", !!doc.querySelector(".scraper-toolbar .secondary"));
check("openStatus opens new tab", w.openStatus.toString().includes("window.open"));
check("no per-card Status button", !doc.querySelector(".status-btn"));
check("create section before first card", (() => {
  const host = doc.getElementById("tabHost");
  const kids = Array.from(host.children).map((c) => c.className);
  return kids.indexOf("create-list-section") !== -1 &&
         kids.indexOf("create-list-section") < kids.indexOf("list-card");
})());
check("cards use controls layout", doc.querySelectorAll(".list-card .card-controls").length === doc.querySelectorAll(".list-card").length);
check("card has url input + type select + max-pages + delete", (() => {
  const row = doc.querySelector(".list-card .card-controls");
  return row && row.querySelector("input.url-input") &&
         row.querySelector("select") &&
         row.querySelector("input.max-pages") &&
         row.querySelector("button.danger");
})());
check("empty state absent with lists", !doc.querySelector(".empty"));
check("save/menu/accent bound", !!w.saveAll && !!w.toggleMenu && !!w.toggleAccentPopup);
check("create handlers defined", !!w.showCreateRow && !!w.hideCreateRow && !!w.confirmCreateList);

process.exit(fail ? 1 : 0);
