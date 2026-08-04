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
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  input, button, select, textarea { font-family: inherit; }

  :root {
    --bg: #050508;
    --bg-soft: #0a0a10;
    --surface: #0c0c13;
    --surface2: #13131d;
    --surface3: #1a1a26;
    --border: #1b1b26;
    --border-bright: #262635;
    --text: #e8edf4;
    --text-dim: #a5aebc;
    --text-muted: #6b7385;
    --accent: #06b6d4;
    --accent-dim: rgba(6,182,212,0.10);
    --accent-glow: rgba(6,182,212,0.18);
    --accent-soft: rgba(6,182,212,0.06);
    --danger: #ff5f66;
    --danger-bg: rgba(255,95,102,0.10);
    --danger-border: rgba(255,95,102,0.30);
    --ok: #34d399;
    --radius: 9px;
    --radius-lg: 14px;
    --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --shadow-card: 0 1px 0 rgba(255,255,255,0.02) inset, 0 8px 28px -18px rgba(0,0,0,0.85);
    --shadow-pop: 0 20px 48px -12px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.03);
  }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    min-height: 100vh;
    line-height: 1.5;
  }

  body::before {
    content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background:
      radial-gradient(90rem 34rem at 50% -12rem, rgba(6,182,212,0.055), transparent 62%),
      radial-gradient(70rem 30rem at 85% 115%, rgba(96,92,255,0.04), transparent 60%);
  }
  body > * { position: relative; z-index: 1; }

  ::selection { background: var(--accent-dim); color: var(--accent); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-bright); border: 2px solid var(--bg); border-radius: 6px; }
  ::-webkit-scrollbar-thumb:hover { background: #32324a; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

  /* ── HEADER ── */
  header {
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    z-index: 100;
  }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .header-title { font-weight: 600; font-size: 15px; letter-spacing: 0.01em; color: var(--text); }

  button.btn-save {
    padding: 8px 18px; border-radius: var(--radius); border: 1px solid var(--accent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 86%, #ffffff), var(--accent));
    color: #040507; font-size: 13px; font-weight: 600;
    cursor: pointer; flex-shrink: 0;
    box-shadow: 0 0 14px -4px var(--accent-glow), 0 1px 0 rgba(255,255,255,0.22) inset;
    letter-spacing: 0.01em;
    transition: filter 0.15s, box-shadow 0.15s, transform 0.1s;
  }
  button.btn-save:hover { filter: brightness(1.1); box-shadow: 0 0 22px -4px var(--accent-glow), 0 1px 0 rgba(255,255,255,0.22) inset; }
  button.btn-save:active { transform: translateY(1px); }
  button.btn-save:disabled { opacity: 0.55; cursor: default; filter: none; box-shadow: none; }

  .btn-icon {
    background: var(--surface); border: 1px solid var(--border-bright); color: var(--text-dim);
    font-size: 16px; cursor: pointer; padding: 7px 9px; border-radius: var(--radius);
    display: flex; align-items: center; justify-content: center;
    transition: color 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s;
    box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset;
  }
  .btn-icon:hover { color: var(--text); border-color: var(--accent); box-shadow: 0 0 12px -6px var(--accent-glow); }
  .btn-icon:disabled { opacity: 0.5; cursor: default; }
  .btn-icon:disabled:hover { color: var(--text-dim); border-color: var(--border-bright); box-shadow: none; }

  #refreshBtn svg { transition: transform 0.15s; }
  #refreshBtn.spinning svg { animation: refresh-spin 0.9s linear infinite; }
  @keyframes refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  /* ── ACCENT POPUP ── */
  .accent-popup-wrap { position: relative; }
  .accent-popup {
    display: none; position: absolute; top: calc(100% + 8px); right: 0;
    background: var(--surface); border: 1px solid var(--border-bright); border-radius: 10px;
    padding: 14px; z-index: 200; width: 220px; max-width: calc(100vw - 32px);
    box-shadow: var(--shadow-pop);
  }
  .accent-popup.visible { display: block; }
  .accent-popup-title { font-size: 11px; font-weight: 500; color: var(--text-dim); margin-bottom: 10px; }
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
    display: none; position: absolute; right: 0; top: calc(100% + 8px);
    background: var(--surface2); border: 1px solid var(--border-bright);
    border-radius: var(--radius); min-width: 180px; overflow: hidden;
    box-shadow: var(--shadow-pop); z-index: 200;
  }
  .menu-popup.visible { display: block; }
  .menu-item {
    padding: 10px 14px; cursor: pointer; color: var(--text-dim); font-size: 13px;
    display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border);
    transition: background 0.1s, color 0.1s;
  }
  .menu-item:last-child { border-bottom: none; }
  .menu-item:hover { background: var(--surface3); color: var(--text); }
  .menu-item.active { color: var(--accent); font-weight: 600; }
  .menu-item.disabled { opacity: 0.4; cursor: default; }
  .menu-item.disabled:hover { background: none; color: var(--text-dim); }
  .menu-soon { margin-left: auto; font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }

  /* ── MAIN ── */
  main { max-width: 1200px; margin: 0 auto; padding: 24px 32px 80px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  p.sub { color: var(--text-dim); margin: 0 0 20px; font-size: 12px; }

  button {
    padding: 10px 16px; border-radius: var(--radius); border: 1px solid var(--accent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 86%, #ffffff), var(--accent));
    color: #040507; font-size: 13px; font-weight: 600; cursor: pointer; flex-shrink: 0;
    box-shadow: 0 0 14px -4px var(--accent-glow), 0 1px 0 rgba(255,255,255,0.22) inset;
    transition: filter 0.15s, box-shadow 0.15s, transform 0.1s;
  }
  button:hover { filter: brightness(1.1); box-shadow: 0 0 22px -4px var(--accent-glow), 0 1px 0 rgba(255,255,255,0.22) inset; }
  button:active { transform: translateY(1px); }
  button.secondary {
    background: var(--surface2); border-color: var(--border-bright); color: var(--text);
    font-weight: 500; box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset;
  }
  button.secondary:hover { background: var(--surface3); filter: none; box-shadow: 0 1px 0 rgba(255,255,255,0.03) inset; }
  button.danger {
    background: var(--danger-bg); border-color: var(--danger-border); color: var(--danger);
    padding: 6px 10px; font-size: 11px; font-weight: 500; box-shadow: none;
  }
  button.danger:hover { background: rgba(255,95,102,0.18); filter: none; border-color: var(--danger); box-shadow: none; }

  /* ── SCRAPER TAB ── */
  .scraper-section { margin-bottom: 16px; }
  .add-list-btn {
    display: flex; align-items: center; gap: 8px; width: 100%; justify-content: center;
    padding: 11px 16px; border-radius: var(--radius); border: 1px dashed var(--border-bright);
    background: transparent; color: var(--text-dim); font-size: 13px; font-weight: 500; cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .add-list-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .add-list-row { display: flex; gap: 8px; }
  .add-list-row .text-input { flex: 1; min-width: 0; }

  .list-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
    padding: 16px 18px; margin-bottom: 12px; box-shadow: var(--shadow-card);
    transition: border-color 0.15s, opacity 0.15s;
  }
  .list-card.disabled { opacity: 0.6; }

  .card-top { display: flex; gap: 12px; align-items: flex-start; }
  .toggle-col { flex-shrink: 0; padding-top: 2px; }

  .toggle {
    position: relative; display: inline-block; width: 38px; height: 22px; cursor: pointer; flex-shrink: 0;
  }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider {
    position: absolute; inset: 0; background: var(--surface3); border: 1px solid var(--border-bright);
    border-radius: 999px; transition: background 0.15s, border-color 0.15s;
  }
  .toggle-slider::before {
    content: ''; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px;
    border-radius: 50%; background: var(--text-muted); transition: transform 0.15s, background 0.15s;
  }
  .toggle input:checked + .toggle-slider { background: var(--accent-dim); border-color: var(--accent); }
  .toggle input:checked + .toggle-slider::before { transform: translateX(16px); background: var(--accent); }

  .right-col { flex: 1; min-width: 0; }
  .info { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .name-edit {
    background: transparent; border: 1px solid transparent; color: var(--text);
    font-size: 15px; font-weight: 600; padding: 2px 6px; border-radius: 6px; min-width: 0; flex: 0 1 auto;
  }
  .name-edit:hover { border-color: var(--border-bright); }
  .name-edit:focus { outline: none; border-color: var(--accent); background: var(--surface2); }
  .name-static { font-size: 15px; font-weight: 600; color: var(--text); }

  .id-chip {
    font-size: 11px; color: var(--text-muted); background: var(--surface2);
    border: 1px solid var(--border); padding: 2px 8px; border-radius: 999px; font-family: ui-monospace, monospace;
  }

  .fields { display: grid; grid-template-columns: 1fr 180px; gap: 10px; margin-top: 12px; align-items: end; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .field .text-input {
    background: var(--surface2); border: 1px solid var(--border-bright); color: var(--text);
    font-size: 12px; padding: 8px 10px; border-radius: var(--radius); width: 100%;
    outline: none; transition: border-color 0.15s, box-shadow 0.15s;
    font-family: ui-monospace, monospace;
  }
  .field .text-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim); }
  .field .text-input::placeholder { color: var(--text-muted); }

  .field select, .add-list-row select {
    background: var(--surface2); border: 1px solid var(--border-bright); color: var(--text);
    font-size: 12px; padding: 8px 10px; border-radius: var(--radius); width: 100%; outline: none; cursor: pointer;
  }
  .field select:focus, .add-list-row select:focus { border-color: var(--accent); }

  .controls { display: flex; gap: 8px; margin-top: 12px; }
  .controls .status-btn { margin-left: auto; }

  .card-error { color: var(--danger); font-size: 12px; margin-top: 8px; }

  .empty { color: var(--text-muted); text-align: center; padding: 32px 0; font-size: 13px; }

  /* ── STATUS / CONFIRM MODAL ── */
  #status {
    padding: 10px 16px; border-radius: var(--radius); margin-bottom: 16px; font-size: 13px; display: none;
  }
  #status.ok { display: block; background: rgba(52,211,153,0.08); border: 1px solid rgba(52,211,153,0.25); color: var(--ok); }
  #status.error { display: block; background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger); }

  .confirm-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 300;
  }
  .confirm-backdrop.visible { display: flex; }
  .confirm-modal {
    background: var(--surface2); border: 1px solid var(--border-bright); border-radius: var(--radius-lg);
    padding: 20px; width: 400px; max-width: 92vw; box-shadow: var(--shadow-pop);
  }
  .confirm-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
  .confirm-body { color: var(--text-dim); font-size: 13px; margin-bottom: 16px; line-height: 1.6; }
  .confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }

  @media (max-width: 720px) {
    main { padding: 16px 14px 60px; }
    header { padding: 10px 14px; }
    .fields { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<header>
  <div class="header-title" id="headerTitle">my-list</div>
  <div class="header-actions">
    <button class="btn-save" id="saveBtn">Save</button>
    <button class="btn-icon" id="refreshBtn" onclick="openRefreshConfirm()" title="Refresh — regenerate all enabled lists in the current module">
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
        <div class="menu-item active" data-module="scraper" onclick="activateModule('scraper')">MDBList Scraper</div>
        <div class="menu-item disabled" onclick="soon()">MDBList Official List<span class="menu-soon">soon</span></div>
        <div class="menu-item disabled" onclick="soon()">Simkl List<span class="menu-soon">soon</span></div>
        <div class="menu-item disabled" onclick="soon()">TMDB List<span class="menu-soon">soon</span></div>
      </div>
    </div>
  </div>
</header>

<main>
  <h1 id="pageTitle">MDBList Scraper</h1>
  <p class="sub" id="pageSub">Paste mdblist.com listing URLs, pick the type, and they become Stremio catalogs. Data lives in <code>data/</code> on GitHub Pages.</p>
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

// ─── Accent colour (localStorage-persisted, like the tmdb page) ───
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
    '<div class="swatch' + (hex === saved ? ' selected' : '') + '" data-accent="' + hex + '" style="background:' + hex + '" onclick="selectAccent(\'' + hex + '\')"></div>'
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
  render();
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
              ? '<input class="name-edit" id="nameInput-' + i + '" value="' + escapeAttr(l.name) + '" onkeydown="if(event.key===\'Enter\')saveName(' + i + ');if(event.key===\'Escape\')cancelName(' + i + ')">'
              : '<span class="name-static" onclick="startNameEdit(' + i + ')">' + escapeAttr(l.name) + '</span>') +
            '<span class="id-chip">' + escapeAttr(l.id) + '</span>' +
          '</div>' +
          '<div class="fields">' +
            '<div class="field"><label>URL (mdblist listing)</label><input class="text-input" value="' + escapeAttr(l.url) + '" onchange="updateList(' + i + ', \'url\', this.value)" placeholder="https://mdblist.com/movies/…" spellcheck="false"></div>' +
            '<div class="field"><label>Type</label><select onchange="updateList(' + i + ', \'type\', this.value)">' +
              '<option value="movie"' + (l.type === 'movie' ? ' selected' : '') + '>Movie</option>' +
              '<option value="series"' + (l.type === 'series' ? ' selected' : '') + '>Series</option>' +
            '</select></div>' +
            '<div class="field"><label>Max Pages</label><input class="text-input" type="number" min="1" max="50" value="' + l.maxPages + '" onchange="updateList(' + i + ', \'maxPages\', this.value)"></div>' +
            '<div class="field"><label>Status</label><button class="secondary status-btn" onclick="openStatus()">Status</button></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="controls">' +
        '<button class="danger" onclick="askDelete(' + i + ')">Delete</button>' +
      '</div>' +
      '<div class="card-error" id="cardError-' + i + '"></div>' +
    '</div>';
  }).join('');

  const addRow = '<div class="scraper-section"><button class="add-list-btn" id="addListBtn" onclick="showAddRow()">+ Add List</button>' +
    '<div class="add-list-row" id="addListRow" style="display:none">' +
      '<input class="text-input" id="addNameInput" placeholder="Name — e.g. Latest Movie" spellcheck="false">' +
      '<input class="text-input" id="addUrlInput" placeholder="https://mdblist.com/movies/…" spellcheck="false">' +
      '<select id="addTypeSelect"><option value="movie">Movie</option><option value="series">Series</option></select>' +
      '<button onclick="confirmAddList()">Add</button>' +
      '<button class="secondary" onclick="hideAddRow()">Cancel</button>' +
    '</div></div>';

  host.innerHTML = (cards || '<div class="empty">No scraper lists yet. Add one below.</div>') + addRow;
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

function showAddRow() {
  document.getElementById('addListBtn').style.display = 'none';
  document.getElementById('addListRow').style.display = 'flex';
  document.getElementById('addNameInput').focus();
}
function hideAddRow() {
  document.getElementById('addListBtn').style.display = 'flex';
  document.getElementById('addListRow').style.display = 'none';
}
function confirmAddList() {
  const name = document.getElementById('addNameInput').value.trim();
  const url = document.getElementById('addUrlInput').value.trim();
  const type = document.getElementById('addTypeSelect').value;
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
  hideAddRow();
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

function openStatus() { window.location.href = ORIGIN + '/status'; }

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
