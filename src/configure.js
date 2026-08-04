// Configure page: shared shell (header + hamburger menu + confirm modal +
// CSS) hosting per-module tabs. Phase 1 ships the scraper tab; the other
// three menu items render "coming soon". Tab markup lives in
// scraperTabHtml() below, injected into #tabHost at load; each module
// owns its state in `window.moduleState` and renders via its own render().

function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildConfigurePage(origin, config) {
  const initial = JSON.stringify(config);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#000000">
<title>my-list — Configure</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* ── RESET + TOKENS ── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  input, button, select, textarea { font: inherit; }

  :root {
    --bg: #000000;
    --surface: #0a0a0a;
    --surface2: #141414;
    --surface3: #1a1a1a;
    --border: #1f1f1f;
    --border2: #2a2a2a;
    --text: #e6edf3;
    --dim: #9da7b3;
    --muted: #6e7681;
    --accent: #06b6d4;
    --accent-dim: rgba(6,182,212,0.10);
    --accent-glow: rgba(6,182,212,0.18);
    --accent-soft: rgba(6,182,212,0.06);
    --danger: #b91c1c;
    --ok: #34d399;
    --r: 8px;
    --r2: 10px;
    --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    min-height: 100vh;
    line-height: 1.5;
  }
  body > * { position: relative; z-index: 1; }

  /* Selection stays neutral — no accent tint on highlight. */
  ::selection { background: var(--border2); color: var(--text); }
  /* One focus line only: inputs shift border color, no stacked outline ring. */
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input:focus, select:focus { outline: none; border-color: var(--accent); }

  /* ── HEADER ── */
  header {
    border-bottom: 1px solid var(--border);
    padding: 14px 24px;
    display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; z-index: 100;
    background: var(--bg);
  }
  .header-title { font-weight: 600; font-size: 16px; letter-spacing: 0.02em; color: var(--text); }
  .header-actions { display: flex; gap: 8px; align-items: center; }

  /* ── BUTTONS (solid accent, no color-mix) ── */
  button {
    padding: 10px 16px; border-radius: var(--r); border: 1px solid var(--accent);
    background: var(--accent); color: #000;
    font-size: 13px; font-weight: 500; cursor: pointer; flex-shrink: 0;
    transition: filter 0.15s;
  }
  button:hover { filter: brightness(1.1); }
  button:disabled { opacity: 0.6; cursor: default; filter: none; }
  button.secondary {
    background: var(--surface2); border-color: var(--border2); color: var(--text);
  }
  button.secondary:hover { background: var(--surface3); filter: none; }
  button.danger {
    background: var(--danger); border-color: var(--danger); color: #fff;
    padding: 6px 10px; font-size: 11px; font-weight: 400;
  }
  button.danger:hover { filter: brightness(1.15); }
  button.btn-save { padding: 8px 16px; }
  .btn-icon {
    background: transparent; border: 1px solid var(--border2); color: var(--dim);
    font-size: 16px; cursor: pointer; padding: 7px 9px; border-radius: var(--r);
    display: flex; align-items: center; justify-content: center;
    transition: color 0.15s, border-color 0.15s;
  }
  .btn-icon:hover { color: var(--text); border-color: var(--dim); }
  .btn-icon:disabled { opacity: 0.5; cursor: default; }
  .btn-icon:disabled:hover { color: var(--dim); border-color: var(--border2); }
  #refreshBtn svg { transition: transform 0.15s; }
  #refreshBtn.spinning svg { animation: refresh-spin 0.9s linear infinite; }
  @keyframes refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  /* ── MAIN ── */
  main { max-width: 1400px; margin: 0 auto; padding: 24px 32px 80px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  p.sub { color: var(--dim); margin: 0 0 14px; font-size: 12px; }
  #status { font-size: 12px; min-height: 16px; margin: 6px 0 14px; }
  #status.error { color: var(--danger); }
  #status.ok { color: var(--ok); }

  /* ── INPUTS + SELECTS — explicit dark, can never render white ── */
  input {
    background: var(--surface); color: var(--text);
    border: 1px solid var(--border2); border-radius: var(--r);
    padding: 8px 10px; font-size: 13px; outline: none;
    transition: border-color 0.12s;
  }
  input::placeholder { color: var(--muted); }
  input:hover { border-color: var(--dim); }
  input:focus { border-color: var(--accent); }

  select {
    appearance: none; -webkit-appearance: none;
    background-color: var(--surface); color: var(--text);
    border: 1px solid var(--border2); border-radius: var(--r);
    padding: 8px 28px 8px 10px; font-size: 13px; cursor: pointer; outline: none;
    background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236e7681' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 9px center;
    transition: border-color 0.12s;
  }
  select:hover { border-color: var(--dim); }
  select:focus { border-color: var(--accent); }
  select option { background: var(--surface); color: var(--text); }

  /* ── SCRAPER TAB ── */
  .scraper-toolbar { display: flex; justify-content: flex-end; margin-bottom: 14px; }

  .create-list-section { margin-bottom: 18px; }
  .btn-create-list {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 11px 16px; border-radius: var(--r);
    border: 1px dashed var(--border2); background: transparent;
    color: var(--dim); font-size: 13px; font-weight: 500; cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .btn-create-list:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
  .create-list-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .create-list-row .name-input { flex: 1 1 150px; min-width: 0; }
  .create-list-row .url-input { flex: 3 1 280px; min-width: 0; font-family: ui-monospace, monospace; font-size: 12px; }
  .create-list-row button { flex-shrink: 0; }

  .list-card {
    background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--r2); padding: 12px;
    margin-bottom: 10px; display: flex; flex-direction: column;
    transition: opacity 0.15s;
  }
  .list-card.disabled { opacity: 0.6; }

  .card-top { display: flex; gap: 12px; align-items: flex-start; }
  .toggle-col { flex-shrink: 0; padding-top: 2px; }
  .toggle { position: relative; display: inline-block; width: 38px; height: 22px; cursor: pointer; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider {
    position: absolute; inset: 0; background: var(--surface3); border: 1px solid var(--border2);
    border-radius: 999px; transition: background 0.15s, border-color 0.15s;
  }
  .toggle-slider::before {
    content: ''; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px;
    border-radius: 50%; background: var(--muted); transition: transform 0.15s, background 0.15s;
  }
  .toggle input:checked + .toggle-slider { background: var(--accent-dim); border-color: var(--accent); }
  .toggle input:checked + .toggle-slider::before { transform: translateX(16px); background: var(--accent); box-shadow: 0 0 6px var(--accent-glow); }

  .right-col { flex: 1; min-width: 0; }
  .info { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name-static {
    font-size: 13px; font-weight: 500; color: var(--text); cursor: pointer;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .name-static:hover { color: var(--accent); }
  .name-edit { font-size: 13px; padding: 3px 8px; }
  .id-chip {
    font-size: 9.5px; color: var(--muted); background: var(--surface2);
    border: 1px solid var(--border2); padding: 1.5px 6px; border-radius: 4px;
    font-family: ui-monospace, monospace; flex-shrink: 0; letter-spacing: 0.01em;
  }

  .card-controls { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  .card-controls .url-row { flex: 1 1 100%; min-width: 0; }
  .card-controls .url-input {
    width: 100%; font-family: ui-monospace, monospace; font-size: 12px;
    padding: 7px 9px; border-radius: 7px;
  }
  .card-controls select { font-size: 12px; padding-top: 7px; padding-bottom: 7px; flex-shrink: 0; }
  .card-controls .max-pages { width: 60px; flex-shrink: 0; text-align: center; font-family: ui-monospace, monospace; font-size: 12px; padding: 7px 9px; border-radius: 7px; }
  .card-controls button { flex-shrink: 0; }
  .card-error { color: var(--danger); font-size: 12px; margin-top: 8px; }
  .empty { color: var(--muted); text-align: center; padding: 24px 0; font-size: 13px; }

  /* ── ACCENT POPUP ── */
  .accent-popup-wrap { position: relative; }
  .accent-popup {
    display: none; position: absolute; top: calc(100% + 8px); right: 0;
    background: var(--surface); border: 1px solid var(--border2); border-radius: 10px;
    padding: 14px; z-index: 200; width: 220px; max-width: calc(100vw - 32px);
  }
  .accent-popup.visible { display: block; }
  .accent-popup-title { font-size: 11px; font-weight: 500; color: var(--dim); margin-bottom: 10px; }
  .swatch-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .swatch {
    width: 24px; height: 24px; border-radius: 50%; cursor: pointer;
    border: 2px solid transparent; transition: transform 0.15s, border-color 0.15s; flex-shrink: 0;
  }
  .swatch:hover { transform: scale(1.1); }
  .swatch.selected { border-color: var(--text); box-shadow: 0 0 0 1px rgba(255,255,255,0.15); }

  /* ── MENU ── */
  .menu-popup-wrap { position: relative; }
  .menu-popup {
    display: none; position: absolute; top: calc(100% + 8px); right: 0;
    background: var(--surface); border: 1px solid var(--border2); border-radius: 10px;
    padding: 6px; z-index: 200; width: 200px; max-width: calc(100vw - 32px);
  }
  .menu-popup.visible { display: block; }
  .menu-item {
    display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 7px;
    font-size: 12.5px; color: var(--dim); cursor: pointer; transition: background 0.1s, color 0.1s;
  }
  .menu-item svg { flex-shrink: 0; }
  .menu-item:hover { background: var(--surface2); color: var(--text); }
  .menu-item.active { background: var(--accent-dim); color: var(--accent); }
  .menu-item.disabled { opacity: 0.4; cursor: default; }
  .menu-item.disabled:hover { background: none; color: var(--dim); }
  .menu-soon { margin-left: auto; font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }

  /* ── CONFIRM MODAL ── */
  .confirm-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: none;
    align-items: center; justify-content: center; z-index: 300; padding: 20px;
  }
  .confirm-backdrop.visible { display: flex; }
  .confirm-modal {
    background: var(--surface);
    border: 1px solid var(--border2); border-radius: var(--r2);
    padding: 20px; width: 100%; max-width: 360px;
  }
  .confirm-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
  .confirm-body { font-size: 12.5px; color: var(--dim); line-height: 1.5; margin-bottom: 18px; }
  .confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .confirm-actions button { padding: 8px 14px; font-size: 12.5px; }

  /* ── RESPONSIVE ── */
  @media (max-width: 900px) { main { padding: 20px; } }
  @media (min-width: 560px) {
    .card-top { align-items: center; }
    .right-col { display: flex; flex-direction: row; align-items: center; gap: 10px; }
    .info { flex: 1 1 160px; }
    .card-controls { flex-wrap: wrap; }
    .card-controls .url-row { flex: 1 1 100%; }
  }
  @media (max-width: 640px) {
    header { padding: 10px 14px; }
    .header-title { font-size: 13px; }
    .header-actions { gap: 6px; }
    button.btn-save { padding: 6px 11px; font-size: 11px; }
    .btn-icon { padding: 6px 8px; }
    main { padding: 14px 12px 56px; }
    .create-list-row { gap: 6px; }
    .create-list-row input { flex: 1 1 100%; }
    .create-list-row button { flex: 1 1 auto; }
    .btn-create-list { font-size: 12px; padding: 10px 14px; }
    .list-card { padding: 9px; margin-bottom: 8px; border-radius: 12px; }
    .card-top { gap: 9px; }
    .name-static { font-size: 12px; }
    .card-controls { flex-wrap: wrap; }
    .card-controls .url-row { flex: 1 1 100%; }
    select { font-size: 12px; padding-top: 6px; padding-bottom: 6px; }
    button.danger { padding: 5px 8px; font-size: 10px; }
    .accent-popup { right: -14px; width: 190px; padding: 12px; }
    .swatch { width: 24px; height: 24px; }
    .menu-popup { right: -14px; width: 180px; padding: 5px; }
    .menu-item { padding: 8px 9px; font-size: 12px; }
  }
  @media (max-width: 380px) {
    .right-col { gap: 6px; }
    .card-controls { flex-wrap: wrap; }
    .card-controls select { flex: 1 1 100%; }
  }
</style>
</head>
<body>

<header>
  <div class="header-title">my-list</div>
  <div class="header-actions">
    <button class="btn-save" id="saveBtn">Save</button>
    <button class="btn-icon" id="refreshBtn" onclick="openRefreshConfirm()" title="Refresh — regenerate all enabled lists">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
    </button>
    <div class="accent-popup-wrap">
      <button class="btn-icon" id="accentBtn" title="Accent colour">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9c0-1.66-1.34-3-3-3h-2a3 3 0 0 1-2.12-5.12C14.6 3.1 14.5 2.6 14.5 2c0-1.66.5-3 1.5-4.5"/></svg>
      </button>
      <div class="accent-popup" id="accentPopup">
        <div class="accent-popup-title">Accent Colour</div>
        <div class="swatch-row" id="swatchRow"></div>
      </div>
    </div>
    <div class="menu-popup-wrap">
      <button class="btn-icon" id="menuBtn" title="Menu">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      <div class="menu-popup" id="menuPopup">
        <div class="menu-item active" data-module="scraper" onclick="activateModule('scraper')">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          MDBList Scraper
        </div>
        <div class="menu-item disabled" onclick="soon()">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
          MDBList Official List<span class="menu-soon">soon</span>
        </div>
        <div class="menu-item disabled" onclick="soon()">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.6-9.5-9A5.5 5.5 0 0 1 12 6.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.4-9.5 9-9.5 9z"/></svg>
          Simkl List<span class="menu-soon">soon</span>
        </div>
        <div class="menu-item disabled" onclick="soon()">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/></svg>
          TMDB List<span class="menu-soon">soon</span>
        </div>
      </div>
    </div>
  </div>
</header>

<main>
  <h1>MDBList Scraper</h1>
  <p class="sub">Paste mdblist.com listing URLs, pick the type, and they become Stremio catalogs. Data lives in <code>data/</code> on GitHub Pages.</p>
  <div id="status"></div>
  <div id="tabHost"></div>
</main>

<div class="confirm-backdrop" id="refreshConfirmBackdrop">
  <div class="confirm-modal">
    <div class="confirm-title">Refresh all scraper lists?</div>
    <div class="confirm-body">This force-regenerates every enabled list right now (headless Chromium on GitHub Actions). It can take a few minutes per list. Are you sure?</div>
    <div class="confirm-actions">
      <button class="secondary" onclick="closeRefreshConfirm()">Cancel</button>
      <button id="confirmRefreshBtn">Refresh all</button>
    </div>
  </div>
</div>

<div class="confirm-backdrop" id="deleteConfirmBackdrop">
  <div class="confirm-modal">
    <div class="confirm-title">Delete this list?</div>
    <div class="confirm-body" id="deleteConfirmBody"></div>
    <div class="confirm-actions">
      <button class="secondary" onclick="closeDeleteConfirm()">Cancel</button>
      <button class="danger" id="confirmDeleteBtn">Delete</button>
    </div>
  </div>
</div>

<script>
const ORIGIN = ${JSON.stringify(origin)};
let state = ${initial};

// ─── Scraper module state ───
let listNameEditIndex = -1;
let pendingDeleteIndex = -1;

function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Accent colour (localStorage-persisted) ───
const ACCENT_COLORS = {
  '#fb923c': { dim: 0.10, glow: 0.18 }, // Amber
  '#f59e0b': { dim: 0.10, glow: 0.18 }, // Gold
  '#f43f5e': { dim: 0.10, glow: 0.18 }, // Rose
  '#e63d64': { dim: 0.10, glow: 0.18 }, // Magenta
  '#60a5fa': { dim: 0.10, glow: 0.18 }, // Sky Blue
  '#38bdf8': { dim: 0.10, glow: 0.18 }, // Ice Blue
  '#818cf8': { dim: 0.10, glow: 0.18 }, // Indigo
  '#5550f7': { dim: 0.10, glow: 0.18 }, // Violet
  '#06b6d4': { dim: 0.10, glow: 0.18 }, // Cyan (default)
  '#19be81': { dim: 0.10, glow: 0.18 }, // Emerald
  '#e2e8f0': { dim: 0.08, glow: 0.14 }, // Pure White
  '#94a3b8': { dim: 0.08, glow: 0.14 }, // Slate
};
const ACCENT_STORAGE_KEY = 'mylist_accent';

function hexToRgb(hex) {
  return parseInt(hex.slice(1,3), 16) + ',' + parseInt(hex.slice(3,5), 16) + ',' + parseInt(hex.slice(5,7), 16);
}

function applyAccent(hex) {
  if (!hex || !ACCENT_COLORS[hex]) hex = '#06b6d4';
  const { dim, glow } = ACCENT_COLORS[hex];
  const rgb = hexToRgb(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-dim', 'rgba(' + rgb + ',' + dim + ')');
  root.style.setProperty('--accent-glow', 'rgba(' + rgb + ',' + glow + ')');
  root.style.setProperty('--accent-soft', 'rgba(' + rgb + ',0.06)');
}

function selectAccent(hex) {
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('selected', s.dataset.accent === hex));
  applyAccent(hex);
  try { localStorage.setItem(ACCENT_STORAGE_KEY, hex); } catch (e) {}
}

function initSwatches() {
  const row = document.getElementById('swatchRow');
  let saved = '#06b6d4';
  try { saved = localStorage.getItem(ACCENT_STORAGE_KEY) || '#06b6d4'; } catch (e) {}
  row.innerHTML = Object.keys(ACCENT_COLORS).map(hex =>
    '<div class="swatch' + (hex === saved ? ' selected' : '') + '" data-accent="' + hex + '" style="background:' + hex + '" onclick="selectAccent(\\\'' + hex + '\\\')"></div>'
  ).join('');
  applyAccent(saved);
}

function toggleAccentPopup() { document.getElementById('accentPopup').classList.toggle('visible'); }
function setStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = kind || '';
}

function soon() { setStatus('That module is coming soon — only the MDBList Scraper tab is live right now.', 'error'); }

// ─── Menu ───
function toggleMenu() { document.getElementById('menuPopup').classList.toggle('visible'); }
function activateModule(m) {
  document.getElementById('menuPopup').classList.remove('visible');
  if (m !== 'scraper') { soon(); return; }
  document.querySelectorAll('.menu-item').forEach(i => i.classList.toggle('active', i.dataset.module === 'scraper'));
  renderScraper();
}
document.addEventListener('click', (e) => {
  const popup = document.getElementById('menuPopup');
  if (popup.classList.contains('visible') && !document.getElementById('menuBtn').contains(e.target) && !popup.contains(e.target)) {
    popup.classList.remove('visible');
  }
  const accentPopup = document.getElementById('accentPopup');
  const accentWrap = e.target.closest('.accent-popup-wrap');
  if (accentPopup.classList.contains('visible') && !accentWrap) {
    accentPopup.classList.remove('visible');
  }
});

// ─── Scraper tab ───
function renderScraper() {
  const host = document.getElementById('tabHost');
  const lists = state.scraper.lists;
  const cards = lists.map((l, i) => {
    const editing = listNameEditIndex === i;
    return '<div class="list-card' + (l.enabled ? '' : ' disabled') + '" id="card-' + i + '">' +
      '<div class="card-top">' +
        '<div class="toggle-col"><label class="toggle"><input type="checkbox" ' + (l.enabled ? 'checked' : '') + ' onchange="toggleList(' + i + ')"><span class="toggle-slider"></span></label></div>' +
        '<div class="right-col">' +
          '<div class="info">' +
            (editing
              ? '<input class="name-edit" id="nameInput-' + i + '" value="' + escapeAttr(l.name) + '" onkeydown="if(event.key===\\\'Enter\\\')saveName(' + i + ');if(event.key===\\\'Escape\\\')cancelName(' + i + ')">'
              : '<span class="name-static" onclick="startNameEdit(' + i + ')">' + escapeAttr(l.name) + '</span>') +
            '<span class="id-chip">' + escapeAttr(l.id) + '</span>' +
          '</div>' +
          '<div class="card-controls">' +
            '<div class="url-row"><input class="url-input" value="' + escapeAttr(l.url) + '" onchange="updateList(' + i + ', \\\'url\\\', this.value)" placeholder="https://mdblist.com/movies/…" spellcheck="false" title="mdblist listing URL"></div>' +
            '<select onchange="updateList(' + i + ', \\\'type\\\', this.value)">' +
              '<option value="movie"' + (l.type === 'movie' ? ' selected' : '') + '>Movie</option>' +
              '<option value="series"' + (l.type === 'series' ? ' selected' : '') + '>Series</option>' +
            '</select>' +
            '<input class="max-pages" type="number" min="1" max="50" value="' + l.maxPages + '" onchange="updateList(' + i + ', \\\'maxPages\\\', this.value)" title="Max pages to scrape">' +
            '<button class="danger" onclick="askDelete(' + i + ')">Delete</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card-error" id="cardError-' + i + '"></div>' +
    '</div>';
  }).join('');

  const createRow =
    '<div class="create-list-section">' +
      '<button class="btn-create-list" id="createListBtn" onclick="showCreateRow()">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>' +
        'Add List' +
      '</button>' +
      '<div class="create-list-row" id="createListRow" style="display:none">' +
        '<input class="name-input" id="createNameInput" placeholder="Name — e.g. Latest Movie" spellcheck="false">' +
        '<input class="url-input" id="createUrlInput" placeholder="https://mdblist.com/movies/…" spellcheck="false">' +
        '<select id="createTypeSelect"><option value="movie">Movie</option><option value="series">Series</option></select>' +
        '<button onclick="confirmCreateList()">Add</button>' +
        '<button class="secondary" onclick="hideCreateRow()">Cancel</button>' +
      '</div>' +
    '</div>';

  const toolbar = '<div class="scraper-toolbar"><button class="secondary" onclick="openStatus()">' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px">' +
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>' +
      '<polyline points="15 3 21 3 21 9"></polyline>' +
      '<line x1="10" y1="14" x2="21" y2="3"></line>' +
    '</svg>' +
    'Status</button></div>';

  host.innerHTML = toolbar + createRow + (cards || '<div class="empty">No scraper lists yet — add one above.</div>');
  if (listNameEditIndex >= 0 && listNameEditIndex < lists.length) {
    const el = document.getElementById('nameInput-' + listNameEditIndex);
    if (el) { el.focus(); el.select(); }
  }
}

function updateList(i, key, value) {
  const l = state.scraper.lists[i];
  if (!l) return;
  if (key === 'maxPages') {
    const n = parseInt(value, 10);
    l.maxPages = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 3;
  } else {
    l[key] = value;
  }
}

function toggleList(i) {
  const l = state.scraper.lists[i];
  if (!l) return;
  l.enabled = !l.enabled;
  renderScraper();
}

// Inline rename: name/type only touch the manifest (built live from
// config), never the data file — so renaming must NOT trigger a regen.
function startNameEdit(i) { listNameEditIndex = i; renderScraper(); }
function saveName(i) {
  const el = document.getElementById('nameInput-' + i);
  if (el && el.value.trim()) state.scraper.lists[i].name = el.value.trim();
  listNameEditIndex = -1;
  renderScraper();
}
function cancelName(i) { listNameEditIndex = -1; renderScraper(); }

function showCreateRow() {
  document.getElementById('createListBtn').style.display = 'none';
  document.getElementById('createListRow').style.display = 'flex';
  document.getElementById('createNameInput').focus();
}
function hideCreateRow() {
  document.getElementById('createListBtn').style.display = 'flex';
  document.getElementById('createListRow').style.display = 'none';
}
async function confirmCreateList() {
  const name = document.getElementById('createNameInput').value.trim();
  const url = document.getElementById('createUrlInput').value.trim();
  const type = document.getElementById('createTypeSelect').value;
  if (!name) { setStatus('List needs a name.', 'error'); return; }
  if (!url) { setStatus('Paste an mdblist.com listing URL.', 'error'); return; }
  const expectedPath = type === 'series' ? '/shows/' : '/movies/';
  if (!url.includes(expectedPath)) {
    setStatus('URL must be an mdblist.com listing page (' + expectedPath + ').', 'error');
    return;
  }
  if (state.scraper.lists.some(l => l.name.toLowerCase() === name.toLowerCase())) {
    setStatus('A list with that name already exists.', 'error');
    return;
  }
  const id = await randomId(url);
  state.scraper.lists.push({ id, name, url, type, maxPages: 3, enabled: true });
  hideCreateRow();
  renderScraper();
  setStatus('List added. Press Save to keep it.', 'ok');
}

function askDelete(i) {
  const l = state.scraper.lists[i];
  if (!l) return;
  pendingDeleteIndex = i;
  document.getElementById('deleteConfirmBody').textContent =
    '"' + l.name + '" will be removed from the config and its data file deleted from GitHub. Existing files on disk for disabled lists stay until deleted here.';
  document.getElementById('deleteConfirmBackdrop').classList.add('visible');
}
function closeDeleteConfirm() { document.getElementById('deleteConfirmBackdrop').classList.remove('visible'); pendingDeleteIndex = -1; }
function confirmDelete() {
  if (pendingDeleteIndex < 0) return;
  state.scraper.lists.splice(pendingDeleteIndex, 1);
  pendingDeleteIndex = -1;
  closeDeleteConfirm();
  renderScraper();
}

// IDs are derived from the URL — must match the server's
// randomScraperId() (sha256 → first 8 hex nibbles mapped to alphabet).
// Hashing in the browser via SubtleCrypto so client + server agree.
async function randomId(seedUrl) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  if (!seedUrl) return 'mdb_scrape_' + Math.random().toString(36).slice(2, 10);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seedUrl));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += chars[parseInt(hex[i], 16) % chars.length];
  }
  return 'mdb_scrape_' + out;
}

// ─── Save (hash-compare → dispatch changed lists only) ───
async function saveAll() {
  if (state.scraper.lists.length === 0) {
    setStatus('Add at least one scraper list first.', 'error');
    return;
  }
  if (state.scraper.lists.some(l => !l.url.trim())) {
    setStatus('Every list needs an mdblist URL.', 'error');
    return;
  }
  const btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch(ORIGIN + '/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setStatus(data.dispatch && data.dispatch.length
      ? 'Saved. Regenerating: ' + data.dispatch.map(d => d.name).join(', ')
      : 'Saved (no content change — nothing regenerated).', 'ok');
  } catch (e) {
    setStatus('Save failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

function openRefreshConfirm() { document.getElementById('refreshConfirmBackdrop').classList.add('visible'); }
function closeRefreshConfirm() { document.getElementById('refreshConfirmBackdrop').classList.remove('visible'); }
async function confirmRefresh() {
  closeRefreshConfirm();
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning'); btn.disabled = true;
  try {
    const res = await fetch(ORIGIN + '/trigger-refresh', { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setStatus('Refresh dispatched — GitHub Actions is regenerating all enabled lists.', 'ok');
  } catch (e) {
    setStatus('Refresh failed: ' + e.message, 'error');
  } finally {
    btn.classList.remove('spinning'); btn.disabled = false;
  }
}

function openStatus() { window.open(ORIGIN + '/status', '_blank'); }

document.getElementById('saveBtn').onclick = saveAll;
document.getElementById('menuBtn').onclick = toggleMenu;
document.getElementById('accentBtn').onclick = toggleAccentPopup;
document.getElementById('confirmRefreshBtn').onclick = confirmRefresh;
document.getElementById('confirmDeleteBtn').onclick = confirmDelete;

initSwatches();
renderScraper();
</script>
</body>
</html>`;
}