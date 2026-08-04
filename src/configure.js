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
<meta name="theme-color" content="#050508">
<title>my-list — Configure</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* ── RESET + TOKENS ── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  input, button, select, textarea { font: inherit; }

  :root {
    --bg: #050508;
    --surface: #0c0c13;
    --surface2: #13131d;
    --surface3: #1a1a26;
    --border: #1b1b26;
    --border2: #262635;
    --text: #e8edf4;
    --dim: #a5aebc;
    --muted: #6b7385;
    --accent: #06b6d4;
    --accent-dim: rgba(6,182,212,0.10);
    --accent-glow: rgba(6,182,212,0.18);
    --accent-soft: rgba(6,182,212,0.06);
    --danger: #ff5f66;
    --danger-bg: rgba(255,95,102,0.10);
    --danger-border: rgba(255,95,102,0.30);
    --ok: #34d399;
    --r: 9px;
    --r2: 14px;
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
  ::selection { background: #262635; color: #e8edf4; }
  /* One focus line only: inputs shift border color, no stacked outline ring. */
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input:focus, select:focus { outline: none; border-color: var(--accent); }

  /* ── HEADER ── */
  header {
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; z-index: 100;
    background: rgba(5,5,8,0.85);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
  }
  .header-title { font-weight: 600; font-size: 15px; letter-spacing: 0.01em; }
  .header-actions { display: flex; gap: 8px; align-items: center; }

  /* ── BUTTONS (solid accent, no color-mix) ── */
  button {
    padding: 9px 16px; border-radius: var(--r); border: 1px solid var(--accent);
    background: var(--accent); color: #040507;
    font-size: 13px; font-weight: 600; cursor: pointer; flex-shrink: 0;
    transition: filter 0.15s, transform 0.1s;
  }
  button:hover { filter: brightness(1.1); }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: 0.55; cursor: default; filter: none; box-shadow: none; }
  button.secondary {
    background: var(--surface2); border-color: var(--border2); color: var(--text); font-weight: 500;
  }
  button.secondary:hover { background: var(--surface3); filter: none; }
  button.danger {
    background: var(--danger-bg); border-color: var(--danger-border); color: var(--danger);
    padding: 6px 10px; font-size: 11px; font-weight: 500; box-shadow: none;
  }
  button.danger:hover { background: rgba(255,95,102,0.18); border-color: var(--danger); filter: none; }
  button.btn-save { padding: 8px 18px; }
  .btn-icon {
    background: var(--surface); border: 1px solid var(--border2); color: var(--dim);
    font-size: 16px; cursor: pointer; padding: 7px 9px; border-radius: var(--r);
    display: flex; align-items: center; justify-content: center;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .btn-icon:hover { color: var(--text); border-color: var(--accent); }
  #refreshBtn.spinning svg { animation: refresh-spin 0.9s linear infinite; }
  @keyframes refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  /* ── MAIN ── */
  main { max-width: 1400px; margin: 0 auto; padding: 24px 32px 80px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  p.sub { color: var(--dim); margin: 0 0 14px; font-size: 12px; }
  #status { font-size: 12px; margin: 0 0 14px; }
  #status:empty { display: none; }
  #status.error { color: var(--danger); }
  #status.ok { color: var(--ok); }

  /* ── INPUTS + SELECTS — explicit dark, can never render white ── */
  input {
    background: #0c0c13; color: #e8edf4;
    border: 1px solid var(--border2); border-radius: 8px;
    padding: 8px 10px; font-size: 13px; outline: none;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  input::placeholder { color: var(--muted); }
  input:hover { border-color: #2f2f42; }
  input:focus { border-color: var(--accent); }
  /* No native spin arrows on number inputs */
  input[type="number"]::-webkit-outer-spin-button,
  input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  input[type="number"] { -moz-appearance: textfield; appearance: textfield; }

  select {
    appearance: none; -webkit-appearance: none;
    background-color: #0c0c13; color: #e8edf4;
    border: 1px solid var(--border2); border-radius: 8px;
    padding: 8px 28px 8px 10px; font-size: 13px; cursor: pointer; outline: none;
    background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7385' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 9px center;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  select:hover { border-color: #2f2f42; }
  select:focus { border-color: var(--accent); }
  select option { background: #0c0c13; color: #e8edf4; }

  /* ── SCRAPER TAB ── */
  .scraper-toolbar { display: flex; justify-content: flex-end; margin-bottom: 14px; }
  .scraper-toolbar button.secondary { padding: 6px 12px; font-size: 11px; font-weight: 500; }

  .create-list-section { margin-bottom: 18px; }
  .btn-create-list {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 11px 16px; border-radius: var(--r);
    border: 1px dashed var(--border2); background: transparent;
    color: var(--dim); font-size: 13px; font-weight: 500; cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .btn-create-list:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .create-list-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .create-list-row .name-input { flex: 1 1 150px; min-width: 0; font-size: 12px; padding: 7px 9px; }
  .create-list-row .url-input { flex: 3 1 280px; min-width: 0; font-family: ui-monospace, monospace; font-size: 12px; padding: 7px 9px; }
  .create-list-row select { font-size: 12px; padding-top: 7px; padding-bottom: 7px; }
  .create-list-row button { flex-shrink: 0; padding: 7px 14px; font-size: 12px; }

  .list-card {
    background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--r2); padding: 12px;
    margin-bottom: 10px; display: flex; flex-direction: column;
    transition: border-color 0.15s, opacity 0.15s;
  }
  .list-card:hover { border-color: #242436; }
  .list-card.disabled { opacity: 0.6; }

  .card-top { display: flex; gap: 12px; align-items: flex-start; }
  .toggle-col { flex-shrink: 0; padding-top: 3px; }
  .toggle { position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider {
    position: absolute; inset: 0; background: var(--surface3); border: 1px solid var(--border2);
    border-radius: 999px; transition: background 0.15s, border-color 0.15s;
  }
  .toggle-slider::before {
    content: ''; position: absolute; width: 10px; height: 10px; left: 2px; top: 2px;
    border-radius: 50%; background: var(--muted); transition: transform 0.15s, background 0.15s;
  }
  .toggle input:checked + .toggle-slider { background: var(--accent-dim); border-color: var(--accent); }
  .toggle input:checked + .toggle-slider::before { transform: translateX(12px); background: var(--accent); }

  .right-col { flex: 1; min-width: 0; }
  .info { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name-static {
    font-size: 13px; font-weight: 600; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 300px;
  }
  .name-edit { font-size: 13px; padding: 3px 8px; }
  .icon-btn {
    display: flex; align-items: center; justify-content: center; width: 22px; height: 22px;
    border: 1px solid var(--border2); border-radius: 6px; color: var(--muted); cursor: pointer; flex-shrink: 0;
    background: transparent; transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .icon-btn:hover { color: var(--text); border-color: #3a3a52; background: var(--surface2); }
  .id-chip {
    font-size: 10px; color: var(--muted); background: var(--surface2);
    border: 1px solid var(--border); padding: 1px 7px; border-radius: 999px;
    font-family: ui-monospace, monospace; flex-shrink: 0;
  }

  .card-controls { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  .card-controls .url-input { margin-right: 60px; }
  .card-controls .url-input {
    flex: 0 1 40%; min-width: 0; font-family: ui-monospace, monospace; font-size: 12px;
    padding: 7px 9px; border-radius: 7px;
  }
  .card-controls select { font-size: 12px; padding-top: 7px; padding-bottom: 7px; flex-shrink: 0; }
  .pages-label { font-size: 11px; color: var(--muted); flex-shrink: 0; }
  .card-controls .max-pages { width: 56px; flex-shrink: 0; text-align: center; font-family: ui-monospace, monospace; font-size: 12px; padding: 7px 9px; border-radius: 7px; }
  .card-controls button { flex-shrink: 0; }
  .card-error { color: var(--danger); font-size: 12px; margin-top: 8px; }
  .empty { color: var(--muted); text-align: center; padding: 24px 0; font-size: 13px; }

  /* ── ACCENT POPUP ── */
  .accent-popup-wrap { position: relative; }
  .accent-popup {
    display: none; position: absolute; top: calc(100% + 8px); right: 0;
    background: var(--surface); border: 1px solid var(--border2); border-radius: 10px;
    padding: 14px; z-index: 200; width: 220px; max-width: calc(100vw - 32px);
    box-shadow: 0 20px 48px -12px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.03);
  }
  .accent-popup.visible { display: block; }
  .accent-popup-title { font-size: 11px; font-weight: 500; color: var(--dim); margin-bottom: 10px; }
  .swatch-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .swatch {
    width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
    border: 2px solid transparent; transition: transform 0.15s, border-color 0.15s; flex-shrink: 0;
  }
  .swatch:hover { transform: scale(1.15); }
  .swatch.selected { border-color: #fff; box-shadow: 0 0 0 1px rgba(255,255,255,0.3); transform: scale(1.1); }

  /* ── MENU ── */
  .menu-popup-wrap { position: relative; }
  .menu-popup {
    display: none; position: absolute; top: calc(100% + 8px); right: 0;
    background: var(--surface); border: 1px solid var(--border2); border-radius: 10px;
    padding: 6px; z-index: 200; width: 200px; max-width: calc(100vw - 32px);
    box-shadow: 0 20px 48px -12px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.03);
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
    position: fixed; inset: 0; background: rgba(3,3,6,0.72); display: none;
    backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
    align-items: center; justify-content: center; z-index: 300; padding: 20px;
  }
  .confirm-backdrop.visible { display: flex; }
  .confirm-modal {
    background: var(--surface);
    border: 1px solid var(--border2); border-radius: var(--r2);
    padding: 20px; width: 100%; max-width: 360px;
    box-shadow: 0 28px 60px -16px rgba(0,0,0,0.9);
  }
  .confirm-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
  .confirm-body { font-size: 12.5px; color: var(--dim); line-height: 1.5; margin-bottom: 18px; }
  .confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .confirm-actions button { padding: 8px 14px; font-size: 12.5px; }

  /* ── RESPONSIVE ── */
  @media (max-width: 900px) { main { padding: 20px; } }
  @media (min-width: 560px) {
    .card-top { align-items: center; }
  }
  @media (max-width: 640px) {
    header { padding: 10px 14px; }
    .header-title { font-size: 13px; }
    .header-actions { gap: 6px; }
    button.btn-save { padding: 6px 11px; font-size: 11px; }
    .btn-icon { padding: 6px 8px; }
    main { padding: 14px 12px 56px; }
    .create-list-row { gap: 6px; }
    .create-list-row .name-input,
    .create-list-row .url-input,
    .create-list-row select,
    .create-list-row .max-pages { flex: 1 1 100%; }
    .create-list-row button { flex: 1 1 auto; padding: 6px 10px; font-size: 11px; }
    .btn-create-list { font-size: 12px; padding: 10px 14px; }
    .list-card { padding: 9px; margin-bottom: 8px; border-radius: 12px; }
    .card-top { gap: 9px; }
    .toggle { width: 26px; height: 15px; }
    .toggle-slider::before { width: 9px; height: 9px; }
    .toggle input:checked + .toggle-slider::before { transform: translateX(11px); }
    .name-static { font-size: 12px; }
    .icon-btn { width: 20px; height: 20px; }
    .icon-btn svg { width: 12px; height: 12px; }
    .card-controls { flex-wrap: wrap; }
    .card-controls .url-input { flex: 1 1 100%; }
    select { font-size: 10px; padding: 5px 24px 5px 6px; background-position: right 6px center; }
    .pages-label { font-size: 10px; }
    .card-controls .max-pages { font-size: 11px; padding: 5px 6px; }
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
  <div class="header-title" id="headerTitle">MDBList Scraper</div>
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
        '<div class="info">' +
          (editing
            ? '<input class="name-edit" id="nameInput-' + i + '" value="' + escapeAttr(l.name) + '" onkeydown="if(event.key===\\\'Enter\\\')saveName(' + i + ');if(event.key===\\\'Escape\\\')cancelName(' + i + ')" onblur="saveName(' + i + ')">'
            : '<span class="name-static">' + escapeAttr(l.name) + '</span>') +
          '<span class="icon-btn" onclick="startNameEdit(' + i + ')" title="Rename">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>' +
          '</span>' +
          '<span class="id-chip">' + escapeAttr(l.id) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-controls">' +
        '<input class="url-input" value="' + escapeAttr(l.url) + '" onchange="updateList(' + i + ', \\\'url\\\', this.value)" placeholder="https://mdblist.com/movies/…" spellcheck="false" title="mdblist listing URL">' +
        '<select onchange="updateList(' + i + ', \\\'type\\\', this.value)">' +
          '<option value="movie"' + (l.type === 'movie' ? ' selected' : '') + '>Movie</option>' +
          '<option value="series"' + (l.type === 'series' ? ' selected' : '') + '>Series</option>' +
        '</select>' +
        '<span class="pages-label">pages:</span>' +
        '<input class="max-pages" type="number" min="1" max="50" value="' + l.maxPages + '" onchange="updateList(' + i + ', \\\'maxPages\\\', this.value)" title="Max pages to scrape">' +
        '<button class="danger" onclick="askDelete(' + i + ')">Delete</button>' +
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
        '<span class="pages-label">pages:</span>' +
        '<input class="max-pages" id="createPagesInput" type="number" min="1" max="50" value="3">' +
        '<button onclick="confirmCreateList()">Add</button>' +
        '<button class="secondary" onclick="hideCreateRow()">Cancel</button>' +
      '</div>' +
    '</div>';

  document.getElementById('headerTitle').textContent = 'MDBList Scraper';
  const toolbar = '<div class="scraper-toolbar"><button class="secondary" onclick="openStatus()">Status</button></div>';

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
  const pagesInput = document.getElementById('createPagesInput');
  const n = pagesInput ? parseInt(pagesInput.value, 10) : NaN;
  const maxPages = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 3;
  state.scraper.lists.push({ id, name, url, type, maxPages, enabled: true });
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
