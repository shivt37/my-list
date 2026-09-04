// Status page - HTML UI for the scrape-run history.
// /status            -> this page (server-rendered, all 4 modules embedded, tabs switch client-side)
// /status?format=json -> the raw JSON feed (previous behaviour; tests + tooling)
//
// Data source: handleStatus() in routes.js, called once per module. No other
// file was touched for the data path - the JSON contract is unchanged.
// Accent: the page reads localStorage 'mylist_accent' (the key /configure
// writes) and applies the same dim/glow/soft values, so the accent colour
// matches the configure page automatically.

import { handleStatus, html } from "./routes.js";
import { loadConfig } from "./config.js";

const MODULES = ["scraper", "official", "simkl", "tmdb"];

// Mirrors ACCENT_COLORS in configure.js (that file is one template literal -
// not importable). Keep in sync if the configure palette ever changes.
const ACCENT_COLORS = {
  "#fb923c": { name: "Amber", dim: 0.10, glow: 0.18 },
  "#f59e0b": { name: "Gold", dim: 0.10, glow: 0.18 },
  "#f43f5e": { name: "Rose", dim: 0.10, glow: 0.18 },
  "#e63d64": { name: "Magenta", dim: 0.10, glow: 0.18 },
  "#60a5fa": { name: "Sky Blue", dim: 0.10, glow: 0.18 },
  "#38bdf8": { name: "Ice Blue", dim: 0.10, glow: 0.18 },
  "#818cf8": { name: "Indigo", dim: 0.10, glow: 0.18 },
  "#5550f7": { name: "Violet", dim: 0.10, glow: 0.18 },
  "#06b6d4": { name: "Cyan (default)", dim: 0.10, glow: 0.18 },
  "#19be81": { name: "Emerald", dim: 0.10, glow: 0.18 },
  "#e2e8f0": { name: "Pure White", dim: 0.08, glow: 0.14 },
  "#94a3b8": { name: "Slate", dim: 0.08, glow: 0.14 },
};

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// "02-09-2026 05:51:32 PM" (IST, as handleStatus emits) -> epoch ms
function istToEpoch(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(s || "");
  if (!m) return null;
  let h = parseInt(m[4], 10) % 12;
  if (m[7] === "PM") h += 12;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], h, +m[5], +m[6]) - 5.5 * 3600 * 1000;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// epoch -> { time: "10:03:11 PM", day: "01 Sep", full: "01 Sep 2026, 10:03:11 PM IST" }
function istDisplay(epoch) {
  const d = new Date(epoch + 5.5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  let h = d.getUTCHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const time = pad(h) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + " " + ampm;
  return {
    time,
    day: pad(d.getUTCDate()) + " " + MONTHS[d.getUTCMonth()],
    full: pad(d.getUTCDate()) + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear() + ", " + time + " IST",
  };
}

function relTime(epoch, now) {
  const diff = Math.max(0, now - epoch);
  if (diff < 60 * 1000) return "just now";
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + "h ago";
  return Math.floor(diff / 86400000) + "d ago";
}

function fmtDur(sec) {
  if (sec == null) return "-";
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? m + "m " + s + "s" : m + "m";
}

const CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
const MANUAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3l7.5 17 2.1-6.9L21.5 11z"/></svg>';
const REFRESH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
const CHEV_SVG = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';

async function moduleRuns(env, page, cfg) {
  const res = await handleStatus(env, new Request("https://status.local/status?page=" + page), cfg);
  return res.json();
}

function renderSummary(runs, now) {
  const total = runs.length;
  const ok = runs.filter((r) => r.status === "success").length;
  const failed = total - ok;
  const newest = runs.length ? istToEpoch(runs[0].started_at_ist) : null;
  const pct = total ? Math.round((ok / total) * 100) + "%" : "-";
  const lastSync = newest != null ? '<b title="' + esc(istDisplay(newest).full) + '">' + relTime(newest, now) + "</b>" : "<b>-</b>";
  return (
    '<div class="summary">' +
    '<span class="chip acc">Last sync ' + lastSync + "</span>" +
    '<span class="chip ok"><b>' + ok + " / " + total + "</b> success <span class=\"pct\">" + pct + "</span></span>" +
    '<span class="chip bad"><b>' + failed + "</b> failed</span>" +
    "</div>"
  );
}

function renderFilters(runs) {
  if (!runs.length) return "";
  return (
    '<div class="filters">' +
    '<button class="f-chip active" data-f="all" onclick="applyFilter(this.closest(\'section\'), \'all\')">All</button>' +
    '<button class="f-chip" data-f="success" onclick="applyFilter(this.closest(\'section\'), \'success\')">Success</button>' +
    '<button class="f-chip" data-f="failed" onclick="applyFilter(this.closest(\'section\'), \'failed\')">Failed</button>' +
    '<button class="f-chip" data-f="scheduled" onclick="applyFilter(this.closest(\'section\'), \'scheduled\')">Scheduled</button>' +
    '<button class="f-chip" data-f="manual" onclick="applyFilter(this.closest(\'section\'), \'manual\')">Manual</button>' +
    '<span class="f-count">showing ' + runs.length + " of " + runs.length + " runs</span>" +
    "</div>"
  );
}

function renderRow(r, now) {
  const epoch = istToEpoch(r.started_at_ist);
  const d = epoch != null ? istDisplay(epoch) : null;
  const pages = r.pages_scraped != null ? r.pages_scraped : r.api_pages;
  const movies = r.movies_found ?? 0;
  // Coerce status to its enum like handleStatus does for triggered_by -
  // render layer trusts nothing from KV (SR-1 hardening).
  const status = r.status === "success" ? "success" : "failed";
  const failed = status === "failed";
  const tags = "all " + status + " " + r.triggered_by;
  // Deleted lists have no operator name - handleStatus falls back to the id.
  // Render it once (not name + id twice) with a hint instead.
  const unresolved = r.catalog_name === r.catalog_id;

  const timeCell =
    '<div class="r-time"' + (d ? ' title="' + esc(d.full) + '"' : "") + ">" +
    (d ? '<span class="rel">' + relTime(epoch, now) + "</span><small>" + d.time + " &middot; " + d.day + "</small>" : "<span class=\"rel\">-</span>") +
    "</div>";

  const triggerCell =
    '<span class="trigger ' + (r.triggered_by === "manual" ? "manual" : "scheduled") + '">' +
    (r.triggered_by === "manual" ? MANUAL_SVG : CLOCK_SVG) + r.triggered_by +
    "</span>";

  // Owner format (UI-F25 decision): "Started 03-09-2026, 09:37:56 PM ·
  // Finished 03-09-2026, 09:38:48 PM" - capitalized labels, comma after the
  // date, numeric DD-MM-YYYY kept. Falls back to the raw feed string if the
  // epoch round-trip ever fails (istToEpoch can't parse it).
  const fmtStamp = (s) => {
    const e = istToEpoch(s);
    if (e == null) return esc(s);
    const d = new Date(e + 5.5 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    let h = d.getUTCHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return esc(p(d.getUTCDate()) + "-" + p(d.getUTCMonth() + 1) + "-" + d.getUTCFullYear() + ", " + p(h) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + " " + ampm);
  };

  const metaLine =
    "List ID: " + esc(r.catalog_id) + (unresolved ? " (list removed from config)" : "") +
    " &middot; Started " + fmtStamp(r.started_at_ist) + " &middot; Finished " + fmtStamp(r.finished_at_ist);

  let detail;
  if (failed) {
    // UI-F22: failed runs must carry the "how far did it get" numbers on all
    // widths - the phone layout hides the numeric columns, so the detail line
    // is the only place phones can see pages/items.
    detail =
      '<div class="detail"><div class="detail-inner"><div class="detail-label">Error</div>' +
      '<div class="err-box">' + esc(r.error_message || "(no error message recorded)") + "</div>" +
      '<div class="detail-meta">' + metaLine + " &middot; " + fmtDur(r.duration_seconds) + " &middot; " + (pages ?? 0) + " pages &middot; " + movies + " items</div>" +
      "</div></div>";
  } else {
    detail =
      '<div class="detail"><div class="detail-inner"><div class="detail-label">Run detail</div>' +
      '<div class="ok-box">Pages: ' + (pages ?? 0) + " &middot; items found: " + movies + " &middot; duration: " + fmtDur(r.duration_seconds) + "</div>" +
      '<div class="detail-meta">' + metaLine + "</div>" +
      "</div></div>";
  }

  return (
    '<div class="row' + (failed ? " is-failed" : "") + (unresolved ? " orphan" : "") + '" data-f="' + tags + '" onclick="toggleRow(this)">' +
    timeCell +
    '<span class="pill ' + status + '">' + status + "</span>" +
    '<div class="r-name" title="' + esc(r.catalog_name) + '">' + esc(r.catalog_name) + (unresolved ? '<small>list removed</small>' : "<small>" + esc(r.catalog_id) + "</small>") + "</div>" +
    triggerCell +
    '<div class="r-num">' + (pages ?? 0) + "</div>" +
    '<div class="r-num">' + movies + "</div>" +
    '<div class="r-dur">' + fmtDur(r.duration_seconds) + "</div>" +
    CHEV_SVG +
    "</div>" +
    detail
  );
}

function renderModule(m, runs, now, active, err = null) {
  const pagesLabel = m === "scraper" ? "Pages" : "API pages";
  let body;
  if (err) {
    // F28 per-module isolation: a module that fails to load shows an error
    // note in its own tab; the other three tabs keep working.
    body = '<div class="empty">Could not load run history for this module: ' + esc(String((err && err.message) || err).slice(0, 200)) + "</div>";
  } else if (!runs.length) {
    body = '<div class="empty">No runs recorded yet &mdash; GitHub Actions has not fired for this module (or history was cleared).</div>';
  } else {
    body =
      renderFilters(runs) +
      '<div class="feed">' +
      '<div class="row-head"><span>Started (IST)</span><span>Status</span><span>List</span><span>Trigger</span><span class="num">' + pagesLabel + '</span><span class="num">Items</span><span class="num">Dur.</span><span></span></div>' +
      runs.map((r) => renderRow(r, now)).join("") +
      "</div>" +
      '<div class="empty no-match" hidden>No runs match this filter in the 30-run window.</div>';
  }
  return (
    '<section id="mod-' + m + '"' + (m === active ? "" : " hidden") + ">" +
    (err
      ? '<div class="summary"><span class="chip bad"><b>!</b> failed to load</span></div>'
      : renderSummary(runs, now)) +
    body +
    "</section>"
  );
}

export async function statusPageResponse(env, request) {
  const wanted = new URL(request.url).searchParams.get("page");
  const active = MODULES.includes(wanted) ? wanted : "scraper";
  const now = Date.now();
  // F28: one shared config load (was four); parallel module fetches (was
  // sequential); per-module try/catch so one broken module can't 500 the
  // whole diagnostics page.
  const cfg = await loadConfig(env.STORE);
  const settled = await Promise.all(
    MODULES.map(async (m) => {
      try {
        return [m, await moduleRuns(env, m, cfg), null];
      } catch (e) {
        return [m, null, e];
      }
    })
  );
  const runsByModule = {};
  const errByModule = {};
  for (const [m, runs, err] of settled) {
    runsByModule[m] = runs;
    errByModule[m] = err;
  }

  const tabs = MODULES.map(
    (m) => '<button class="tab' + (m === active ? " active" : "") + '" role="tab" aria-selected="' + (m === active) + '" data-mod="' + m + '" onclick="switchTab(this)">' + (m === "scraper" ? "Scraper" : m === "official" ? "Official" : m === "simkl" ? "Simkl" : "TMDB") + "</button>"
  ).join("");

  const sections = MODULES.map((m) => renderModule(m, runsByModule[m], now, active, errByModule[m])).join("");

  const pageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#050508">
<meta name="color-scheme" content="dark">
<title>my-list &middot; Status</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    color-scheme: dark;
    --bg: #050508;
    --surface: #0c0c13;
    --surface2: #13131d;
    --surface3: #1a1a26;
    --surface-card: #0f1119;
    --text: #e8edf4;
    --dim: #a5aebc;
    --muted: #8a93a8;
    --accent: #06b6d4;
    --accent-dim: rgba(6,182,212,0.10);
    --border: rgba(255,255,255,0.06);
    --border2: rgba(255,255,255,0.12);
    --ok: #34d399;
    --ok-dim: rgba(52,211,153,0.12);
    --ok-border: rgba(52,211,153,0.30);
    --fail: #f87171;
    --fail-dim: rgba(248,113,113,0.12);
    --fail-border: rgba(248,113,113,0.30);
    --r: 8px;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  html, body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; line-height: 1.5; min-height: 100vh; }
  ::selection { background: var(--border2); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  header {
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    position: sticky; top: 0; z-index: 100;
    background: rgba(5,5,8,0.85);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  }
  .h-title { font-weight: 600; font-size: 15px; letter-spacing: 0.01em; white-space: nowrap; }
  .h-title .sep { color: var(--muted); font-weight: 400; margin: 0 6px; }
  .h-title span.sub { color: var(--dim); font-weight: 400; font-size: 13px; }
  .h-actions { display: flex; gap: 8px; align-items: center; }
  .btn-ghost {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--surface); border: 1px solid var(--border2); color: var(--dim);
    font-size: 12px; font-weight: 500; padding: 6px 11px; border-radius: var(--r); cursor: pointer;
    text-decoration: none;
    transition: color .15s, border-color .15s, background .15s;
  }
  .btn-ghost:hover { color: var(--text); border-color: var(--accent); text-decoration: none; }

  main { max-width: 1080px; margin: 0 auto; padding: 24px 24px calc(80px + env(safe-area-inset-bottom, 0px)); }

  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
  .tab {
    background: var(--surface); border: 1px solid var(--border2); color: var(--dim);
    font: inherit; font-size: 12.5px; font-weight: 500; padding: 7px 14px; border-radius: var(--r); cursor: pointer;
    transition: color .15s, border-color .15s, background .15s;
  }
  .tab:hover { color: var(--text); background: var(--surface2); }
  .tab.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); font-weight: 600; }

  .summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 14px; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    background: var(--surface-card); border: 1px solid var(--border); border-radius: var(--r);
    padding: 6px 12px; font-size: 12px; color: var(--dim);
  }
  .chip b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .chip.ok b { color: var(--ok); } .chip.bad b { color: var(--fail); } .chip.acc b { color: var(--accent); }
  .chip .pct { font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .filters { display: flex; gap: 6px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
  .f-chip {
    background: transparent; border: 1px solid var(--border2); color: var(--muted);
    font: inherit; font-size: 11.5px; font-weight: 500; padding: 4px 11px; border-radius: 999px; cursor: pointer;
    transition: color .15s, border-color .15s, background .15s;
  }
  .f-chip:hover { color: var(--text); }
  .f-chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .f-count { margin-left: auto; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .feed { border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; background: var(--surface-card); }
  .row-head, .row {
    display: grid;
    grid-template-columns: 118px 88px minmax(0, 1fr) 92px 64px 88px 62px 22px;
    gap: 10px; align-items: center;
    padding: 10px 14px;
  }
  .row-head {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted);
    background: var(--surface2); border-bottom: 1px solid var(--border);
  }
  .row-head .num { text-align: right; }
  .row { border-bottom: 1px solid var(--border); transition: background .12s; }
  .row:last-of-type { border-bottom: none; }
  .row:hover { background: var(--surface2); }
  .row.is-failed { border-left: 2px solid var(--fail); padding-left: 12px; }
  /* Orphaned run (list deleted from config): secondary presence - the
     history stays visible but clearly reads as inactive. */
  .row.orphan { opacity: 0.55; }
  .row.orphan .r-name { font-style: italic; }
  .row.expanded { background: var(--surface2); }
  .r-time { font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .r-time .rel { display: block; font-weight: 600; color: var(--text); font-size: 12px; }
  .r-time small { display: block; font-size: 10px; color: var(--muted); margin-top: 1px; }
  .pill {
    display: inline-flex; align-items: center; gap: 5px; justify-self: start;
    font-size: 10.5px; font-weight: 600; padding: 2px 9px; border-radius: 999px;
    text-transform: capitalize;
  }
  .pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; }
  .pill.success { color: var(--ok); background: var(--ok-dim); border: 1px solid var(--ok-border); }
  .pill.success::before { background: var(--ok); }
  .pill.failed { color: var(--fail); background: var(--fail-dim); border: 1px solid var(--fail-border); }
  .pill.failed::before { background: var(--fail); }
  .r-name { font-size: 12.5px; font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .r-name small { display: block; font-size: 9.5px; color: var(--muted); font-family: ui-monospace, monospace; font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
  /* Trigger badges: light pill treatment like success/failed, but in a
     neutral lavender-gray so they stay visually secondary to status. */
  .trigger {
    display: inline-flex; align-items: center; gap: 5px; justify-self: start;
    font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: capitalize;
    border-radius: 999px; padding: 2px 8px;
  }
  .trigger svg { width: 11px; height: 11px; flex-shrink: 0; }
  .trigger.scheduled {
    color: #b9c0d4; background: rgba(185,192,212,0.10); border: 1px solid rgba(185,192,212,0.28);
  }
  .trigger.scheduled svg { color: #b9c0d4; }
  .trigger.manual {
    color: #c9b8e8; background: rgba(201,184,232,0.10); border: 1px solid rgba(201,184,232,0.28);
  }
  .trigger.manual svg { color: inherit; }
  .r-num { font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; text-align: right; }
  .r-dur { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
  .chev { width: 12px; height: 12px; color: var(--muted); transition: transform .15s; justify-self: end; }
  .row.expanded .chev { transform: rotate(90deg); color: var(--text); }

  .detail { display: none; background: var(--surface); border-bottom: 1px solid var(--border); }
  .detail.open { display: block; }
  .detail-inner { padding: 4px 14px 13px calc(118px + 88px + 10px + 10px + 14px + 2px); }
  .detail-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 5px; }
  .err-box {
    font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.55;
    color: var(--fail); background: var(--fail-dim); border: 1px solid var(--fail-border);
    border-radius: 6px; padding: 9px 11px; word-break: break-word; white-space: pre-wrap;
  }
  .ok-box {
    font-family: ui-monospace, monospace; font-size: 11.5px;
    color: var(--dim); background: var(--surface2); border: 1px solid var(--border);
    border-radius: 6px; padding: 9px 11px;
  }
  .detail-meta { font-size: 10.5px; color: var(--muted); margin-top: 6px; }
  .empty { color: var(--muted); text-align: center; padding: 40px 16px; font-size: 13px; }
  .foot { margin-top: 22px; font-size: 11.5px; color: var(--muted); text-align: center; }

  @media (max-width: 900px) { main { padding: 20px 16px calc(64px + env(safe-area-inset-bottom, 0px)); } }
  @media (max-width: 767px) {
    header { padding: 10px 14px; }
    .row-head { display: none; }
    /* card layout: separate cards with gaps (like /configure), name/time
       left, pill/trigger right, chevron spanning the right edge. */
    .feed { border: none; background: transparent; border-radius: 0; overflow: visible; }
    .row {
      grid-template-columns: 1fr auto 14px;
      grid-template-areas: "name pill chev" "meta trigger chev";
      row-gap: 8px; column-gap: 10px; padding: 11px 14px;
      background: var(--surface-card);
      border: 1px solid var(--border2);
      border-radius: 8px;
      margin-bottom: 8px;
    }
    .feed .row:last-of-type { border-bottom: 1px solid var(--border2); }
    .r-time { grid-area: meta; font-size: 11px; display: flex; gap: 8px; align-items: baseline; }
    .r-time .rel { display: inline; font-size: 11.5px; }
    .r-time small { display: inline; margin: 0; }
    .r-name { grid-area: name; }
    .r-name small { display: none; }
    .pill { grid-area: pill; justify-self: end; }
    .trigger { grid-area: trigger; justify-self: end; }
    .chev { grid-area: chev; display: block; align-self: center; width: 14px; height: 14px; }
    .row.expanded { margin-bottom: 0; border-bottom: none; border-radius: 8px 8px 0 0; }
    .row.expanded + .detail { border: 1px solid var(--border2); border-top: none; border-radius: 0 0 8px 8px; margin-bottom: 8px; }
    .r-num, .r-dur { display: none; }
    .detail-inner { padding: 4px 14px 13px 14px; }
  }
  @media (max-width: 640px) {
    .h-title { font-size: 13px; }
    .h-title span.sub { font-size: 12px; }
    .h-actions { gap: 6px; }
    .btn-ghost { padding: 8px 10px; min-height: 36px; }
    main { padding: 14px 12px calc(56px + env(safe-area-inset-bottom, 0px)); }
    .tab { padding: 8px 14px; min-height: 40px; }
    .f-chip { padding: 4px 12px; min-height: 0; }
    .filters { gap: 5px; }
    .summary { gap: 6px; }
    .chip { padding: 7px 11px; }
  }
  @media (max-width: 380px) {
    .h-title span.sub { display: none; }
  }
</style>
</head>
<body>

<header>
  <div class="h-title">my-list<span class="sep">&middot;</span><span class="sub">Status</span></div>
  <div class="h-actions">
    <button class="btn-ghost" onclick="location.reload()" title="Reload run data (does not re-run workflows)">${REFRESH_SVG}Reload</button>
    <a class="btn-ghost" href="/status?format=json&amp;page=${active}" title="Raw JSON feed (previous behaviour)">Raw JSON</a>
  </div>
</header>

<main>
  <div class="tabs" role="tablist">${tabs}</div>
  ${sections}
  <div class="foot">Shows the last 30 runs per module, newest first &middot; all times IST &middot; scheduled runs fire on GitHub Actions cron</div>
</main>

<script>
(function () {
  var ACCENTS = ${JSON.stringify(ACCENT_COLORS)};
  var saved = null;
  try { saved = localStorage.getItem('mylist_accent'); } catch (e) {}
  if (saved && ACCENTS[saved]) {
    var c = ACCENTS[saved];
    var rgb = parseInt(saved.slice(1, 3), 16) + ',' + parseInt(saved.slice(3, 5), 16) + ',' + parseInt(saved.slice(5, 7), 16);
    var root = document.documentElement;
    root.style.setProperty('--accent', saved);
    root.style.setProperty('--accent-dim', 'rgba(' + rgb + ',' + c.dim + ')');
  }
})();

function switchTab(btn) {
  document.querySelectorAll('.tab').forEach(function (x) {
    x.classList.remove('active');
    x.setAttribute('aria-selected', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  ['scraper', 'official', 'simkl', 'tmdb'].forEach(function (m) {
    var sec = document.getElementById('mod-' + m);
    if (sec) sec.hidden = m !== btn.dataset.mod;
  });
  // Keep the URL and the raw-JSON link on the tab the user is actually
  // viewing (replaceState = no back-button spam; refresh keeps the tab).
  history.replaceState(null, '', '/status?page=' + btn.dataset.mod);
  var raw = document.querySelector('a[href*="format=json"]');
  if (raw) raw.href = '/status?format=json&page=' + btn.dataset.mod;
}

function toggleRow(row) {
  var detail = row.nextElementSibling;
  if (!detail || !detail.classList.contains('detail')) return;
  var open = detail.classList.toggle('open');
  row.classList.toggle('expanded', open);
}

function applyFilter(section, mode) {
  if (!section) return;
  section.querySelectorAll('.f-chip').forEach(function (x) { x.classList.remove('active'); });
  var btn = section.querySelector('.f-chip[data-f="' + mode + '"]');
  if (btn) btn.classList.add('active');
  var rows = section.querySelectorAll('.feed .row');
  var shown = 0;
  rows.forEach(function (r) {
    var tags = (r.dataset.f || '').split(' ');
    var show = mode === 'all' || tags.indexOf(mode) !== -1;
    r.style.display = show ? '' : 'none';
    if (show) shown++;
    else {
      var d = r.nextElementSibling;
      if (d && d.classList.contains('detail')) d.classList.remove('open');
      r.classList.remove('expanded');
    }
  });
  var count = section.querySelector('.f-count');
  if (count) count.textContent = 'showing ' + shown + ' of ' + rows.length + ' runs';
  var empty = section.querySelector('.no-match');
  if (empty) empty.hidden = shown > 0;
}
</script>
</body>
</html>`;

  // Reuse the configure page's response helper: identical security header +
  // nosniff. cache-control: no-store must be preserved (live diagnostics page).
  return html(pageHtml, { "cache-control": "no-store" });
}
