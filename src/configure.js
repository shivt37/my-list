// Configure page: shared shell (header + hamburger menu + confirm modal +
// CSS) hosting per-module tabs. Tab markup lives in scraperTabHtml-style
// render functions below, injected into #tabHost at load; all modules share
// the single `state` object and re-render via rerenderActive().

export function buildConfigurePage(origin, config) {
  // </script> can escape the inline state blob (V8 JSON.stringify does not
  // escape <), so hard-escape it before embedding.
  const initial = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#050508">
<title>my-list - Configure</title>
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
    --surface-card: #0f1119;
    --border: #1b1b26;
    --border2: #262635;
    --text: #e8edf4;
    --dim: #a5aebc;
    --muted: #8a93a8;
    --accent: #06b6d4;
    --accent-dim: rgba(6,182,212,0.10);
    --accent-glow: rgba(6,182,212,0.18);
    --accent-soft: rgba(6,182,212,0.06);
    --danger: #ff5f66;
    --danger-bg: rgba(255,95,102,0.10);
    --danger-border: rgba(255,95,102,0.30);
    --ok: #34d399;
    --r: 9px;
    --r-sm: 8px;
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

  /* Selection stays neutral - no accent tint on highlight. */
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
  .header-title { font-weight: 600; font-size: 15px; letter-spacing: 0.01em; margin: 0; }
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
  #refreshBtn.spinning svg, .card-refresh.spinning svg { animation: refresh-spin 0.9s linear infinite; }
  @keyframes refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .card-refresh { padding: 5px 6px; }
  .card-refresh svg { display: block; }
  .tmdb-eye-active { color: var(--accent); border-color: var(--accent); }

  /* ── MAIN ── */
  main { max-width: 1400px; margin: 0 auto; padding: 24px 32px 80px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  p.sub { color: var(--dim); margin: 0 0 14px; font-size: 12px; }
  #status { font-size: 12px; margin: 0 0 14px; }
  #status:empty { display: none; }
  #status.error { color: var(--danger); }
  #status.ok { color: var(--ok); }

  /* ── INPUTS + SELECTS - explicit dark, can never render white ── */
  input {
    background: #0c0c13; color: #e8edf4;
    border: 1px solid var(--border2); border-radius: var(--r-sm);
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
    border: 1px solid var(--border2); border-radius: var(--r-sm);
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

  /* A45: quiet "+ Add List" ghost trigger BELOW the cards, expanding into a
     mini-form. Owner call: Name/URL carry labels; Type + Pages mirror the
     list card's compact controls and share a line on mobile too. */
  .create-slot { margin-top: 16px; }
  .btn-create-list {
    display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px;
    border-radius: var(--r); border: 1px dashed var(--border2); background: transparent;
    color: var(--dim); font-size: 13px; font-weight: 500; cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .btn-create-list:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .create-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 12px; }
  .create-form .field { flex: 1 1 200px; }
  .create-form .field :is(input, select) { width: 100%; font-size: 12px; padding: 7px 9px; }
  .create-form .url-input { font-family: ui-monospace, monospace; }
  .create-form > select { font-size: 12px; padding: 7px 26px 7px 9px; flex-shrink: 0; }
  .create-form .pages-field { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; font-size: 11px; color: var(--muted); cursor: pointer; }
  .create-form .max-pages { width: 56px; text-align: center; font-family: ui-monospace, monospace; font-size: 12px; padding: 7px 9px; }
  .create-form .body-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .create-form button { padding: 7px 14px; font-size: 12px; flex-shrink: 0; }
  /* TMDB variant: everything one line, media-type select sized like the
     scraper card's type select, Add/Cancel pinned right. */
  .create-form.inline { gap: 8px; }
  .create-form.inline .field-name { flex: 1 1 200px; }
  .create-form.inline .field-name .name-input { width: 100%; }
  .create-form.inline .field-mtype { flex: 0 0 auto; }
  .create-form.inline .field-mtype select { width: auto; min-width: 76px; font-size: 12px; padding: 7px 26px 7px 9px; }

  .list-card {
    background: var(--surface-card);
    border: 1px solid var(--border); border-radius: var(--r2); padding: 12px;
    margin-bottom: 10px; display: flex; flex-direction: column;
    transition: border-color 0.15s, opacity 0.15s;
  }
  .list-card:hover { border-color: #242436; }
  /* A45: disabled cards stop fading wholesale (opacity .6 dragged text below
     contrast). Quiet border + muted name/chip instead; controls are actually
     disabled via JS (everything except the enable toggle). */
  .list-card.disabled { border-color: var(--border); }
  .list-card.disabled .name-static, .list-card.disabled .id-chip { color: var(--muted); }
  .list-card.disabled :is(input, select, button)[disabled] { opacity: 0.45; }

  /* A45 two-zone card: head = identity row, body = one compact control row
     (per owner review: previous density kept - only "Pages" carries a small
     inline label; full stacked labels live solely in the create form). */
  .card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .card-head > .id-chip { margin-left: auto; }
  .card-head > .count-line { flex-basis: 100%; }
  .card-body { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; margin-top: 12px; }
  .card-body .url-input { flex: 1 1 220px; min-width: 0; font-family: ui-monospace, monospace; font-size: 12px; padding: 7px 9px; }
  .card-body select { font-size: 12px; padding-top: 7px; padding-bottom: 7px; flex-shrink: 0; }
  .pages-field { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; font-size: 11px; color: var(--muted); cursor: pointer; }
  .card-body .max-pages { width: 56px; text-align: center; font-family: ui-monospace, monospace; font-size: 12px; padding: 7px 9px; }
  .body-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .official-hint { font-size: 11px; color: var(--muted); flex: 1 1 0; min-width: 0; }
  /* Field/label vocabulary reserved for the create forms */
  .field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .field-label { font-size: 11px; font-weight: 500; color: var(--muted); letter-spacing: 0.02em; }
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
  /* Pencil hugs the name text; the wrap fills remaining space so long
     names still ellipsize instead of shoving the pencil to the card edge. */
  .name-wrap { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; }
  .name-static {
    font-size: 13px; font-weight: 600; color: var(--text);
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .name-edit { flex: 1 1 auto; min-width: 0; font-size: 13px; padding: 3px 8px; }
  .icon-btn {
    display: flex; align-items: center; justify-content: center; width: 22px; height: 22px;
    border: 1px solid var(--border2); border-radius: var(--r-sm); color: var(--muted); cursor: pointer; flex-shrink: 0;
    background: transparent; padding: 0; transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .icon-btn:hover { color: var(--text); border-color: #3a3a52; background: var(--surface2); filter: none; }
  .id-chip {
    font-size: 10px; color: var(--muted); background: var(--surface2);
    border: 1px solid var(--border); padding: 1px 7px; border-radius: 999px;
    font-family: ui-monospace, monospace; flex-shrink: 0;
  }

  .official-note { font-size: 12px; color: var(--dim); margin-bottom: 14px; }
  .card-error { color: var(--danger); font-size: 12px; margin-top: 8px; }
  .empty { color: var(--muted); text-align: center; padding: 24px 0; font-size: 13px; }

  /* ── SIMKL FILTER EDITOR ── */
  .simkl-filter {
    margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px;
    display: grid; grid-template-columns: 132px 1fr; gap: 10px;
  }
  /* The rating-source chip (imdb/mal) reuses .id-chip, which phones hide -
     this row must stay visible at every width. */
  .simkl-filter .id-chip { display: inline-block; }
  /* Filter fields sit in a 2-col grid (text column + value column) - the
     CSV inputs never stretch full width, so a long genre list stays a
     contained field instead of a full-bleed strip. Mobile stacks 1-col. */
  .filter-line { display: contents; }
  .filter-label { font-size: 11px; font-weight: 500; color: var(--dim); }
  .filter-value { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .filter-value .url-input { flex: 1 1 100%; min-width: 0; font-size: 12px; padding: 6px 9px; border-radius: var(--r-sm); }
  .filter-check { accent-color: var(--accent); }
  .filter-top { display: contents; }
  .filter-top .secondary { justify-self: start; flex-shrink: 0; padding: 5px 10px; font-size: 11px; }
  /* Rating filter is a labelled switch, not a bare checkbox. */
  .filter-toggle { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .toggle-text { font-size: 12px; color: var(--dim); }

  /* Tiers read as a real table: side-by-side columns, spanning BOTH grid
     columns. Before, .tier-table had no grid-column so it fell into the
     132px label column and every input stacked vertically. */
  .tier-table { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
  .tier-head, .tier-row {
    display: grid; grid-template-columns: repeat(4, minmax(64px, 1fr)) 26px;
    gap: 6px; align-items: center;
  }
  .tier-head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 0 2px; }
  .tier-head span { text-align: center; }
  .tier-head .th-src { display: block; font-size: 9px; font-weight: 400; opacity: 0.75; margin-top: 1px; }
  .tier-num { width: 100%; min-width: 0; font-family: ui-monospace, monospace; font-size: 12px; padding: 6px 9px; border-radius: var(--r-sm); text-align: center; }
  .tier-row .danger { justify-self: start; padding: 6px 10px; font-size: 12px; }
  @media (max-width: 600px) {
    /* Owner call: label and its value share one line on phones - except the
       three CSV rows, whose input drops to its own full-width line below. */
    .simkl-filter { grid-template-columns: auto 1fr; }
    .filter-csv .filter-label, .filter-csv .filter-value { grid-column: 1 / -1; }
    .filter-value { flex-wrap: wrap; }
    .tier-head, .tier-row { grid-template-columns: repeat(4, minmax(48px, 1fr)) 26px; gap: 4px; }
    .tier-num { font-size: 11px; padding: 6px 5px; }
    .tier-row .danger { padding: 6px 8px; }
  }

  /* ── TMDB DISCOVER TAB ── */
  .tmdb-dim { border-top: 1px solid var(--border); padding: 8px 0 2px; margin-top: 6px; }
  .tmdb-dim:first-child { border-top: none; margin-top: 0; padding-top: 0; }
  .tmdb-dim-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .dim-mode-tag {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 1px 6px; border-radius: var(--r-sm); font-size: 9px; font-weight: 600; letter-spacing: 0.06em;
    line-height: 1.5; cursor: pointer; flex-shrink: 0; user-select: none;
    color: var(--dim); background: var(--surface2); border: 1px solid var(--border2);
    transition: color 0.12s, border-color 0.12s;
  }
  .dim-mode-tag:hover { color: var(--text); border-color: var(--accent); filter: none; }
  .exclude-label-toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; background: none; border: 0; padding: 0; font: inherit; color: inherit; }
  .exclude-label-toggle:hover { filter: none; }
  .exclude-label { display: flex; align-items: center; gap: 7px; }
  .exclude-chevron { transition: transform 0.15s; color: var(--muted); }
  .exclude-chevron.open { transform: rotate(180deg); }
  /* 3-position sliding pill: AND / Mix (read-only) / OR. Thumb position via
     "left" (not translateX) - translateX % resolves against the thumb's own
     width, not the track's. */
  .mode-toggle {
    position: relative; display: flex; align-items: center; width: 108px; height: 23px; flex-shrink: 0;
    box-sizing: border-box; background: var(--surface2); border: 1px solid var(--border2); border-radius: 999px; padding: 2px;
  }
  .mode-toggle-thumb {
    position: absolute; top: 2px; left: 2px;
    width: calc((100% - 4px) / 3); height: 17px;
    background: var(--accent); border-radius: 999px;
    box-shadow: 0 0 0 1px var(--accent), 0 0 6px var(--accent-glow);
    transition: left 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
  }
  .mode-toggle[data-mode="mixed"] .mode-toggle-thumb {
    left: calc((100% - 4px) / 3 + 2px);
    background: var(--muted); box-shadow: none;
  }
  .mode-toggle[data-mode="or"] .mode-toggle-thumb { left: calc((100% - 4px) / 3 * 2 + 2px); }
  .mode-toggle-btn {
    position: relative; z-index: 1; flex: 1 1 0; align-self: stretch; margin: 0;
    display: flex; align-items: center; justify-content: center; text-align: center;
    background: transparent; border: 0; padding: 0; box-sizing: border-box;
    appearance: none; color: var(--dim); font-family: inherit; font-size: 10px; line-height: 1;
    transition: color 0.12s;
  }
  .mode-toggle-btn:not(:disabled) { cursor: pointer; }
  .mode-toggle-btn:disabled { cursor: default; }
  .mode-toggle-btn:hover:not(.active):not(:disabled) { color: var(--text); }
  .mode-toggle-btn.active { color: #000; }
  .mode-toggle[data-mode="mixed"] .mode-toggle-mixed { color: #000; }
  .include-mode-hint { font-size: 10.5px; color: var(--muted); line-height: 1.45; }
  .include-mode-row { display: flex; align-items: baseline; gap: 10px; margin: 10px 0 2px; flex-wrap: wrap; }
  .members-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); }
  .members-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; align-items: center; }
  .members-empty { font-size: 11px; color: var(--muted); font-style: italic; }
  .member-chip {
    display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dim);
    background: var(--surface2); border: 1px solid var(--border2); border-radius: 999px;
    padding: 4px 6px 4px 10px; max-width: 220px;
    transition: border-color 0.12s;
  }
  .member-chip:hover { border-color: #32324a; }
  .chip-remove {
    display: flex; align-items: center; justify-content: center; width: 16px; height: 16px;
    border-radius: 50%; color: var(--muted); cursor: pointer; font-size: 13px; line-height: 1; flex-shrink: 0;
    background: transparent; border: 0; padding: 0;
    transition: background 0.12s, color 0.12s;
  }
  .chip-remove:hover { background: rgba(255,95,102,0.14); color: var(--danger); filter: none; }
  .member-chip-add {
    cursor: pointer; color: var(--accent); border-color: rgba(6,182,212,0.5);
    background: var(--accent-soft); padding: 4px 12px;
    transition: border-color 0.12s, background 0.12s;
  }
  .member-chip-add:hover { opacity: 1; border-color: var(--accent); }
  .exclude-chip {
    display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--danger);
    background: var(--danger-bg); border: 1px solid var(--danger-border); border-radius: 999px;
    padding: 4px 6px 4px 10px; max-width: 220px;
  }
  .exclude-chip .chip-remove:hover { background: rgba(255,95,102,0.24); }
  .exclude-chip-add {
    cursor: pointer; color: var(--dim); border-color: var(--border2); background: var(--surface2);
    padding: 4px 12px; display: inline-flex; align-items: center; font-size: 11.5px;
    border-radius: 999px; border-width: 1px; border-style: solid;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }
  .exclude-chip-add:hover { color: var(--text); border-color: var(--dim); }
  .exclude-genre-select-inline {
    flex: 0 0 auto; width: fit-content; min-width: 0;
    color: var(--dim); border-color: var(--border2); background: var(--surface2);
    padding: 4px 8px; font-size: 11.5px; border-radius: 999px; cursor: pointer;
  }
  .inline-add-search { margin-top: 8px; }
  .inline-add-search .search-row { display: flex; gap: 6px; }
  .inline-add-search .search-input-wrap { position: relative; flex: 1; }
  .inline-add-search .search-input { width: 100%; font-size: 12.5px; padding: 7px 30px 7px 10px; }
  .inline-add-search .search-icon { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
  .inline-add-search .search-results {
    max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; margin-top: 8px;
  }
  .result-item {
    display: flex; align-items: center; gap: 9px; font-size: 12.5px; padding: 6px 9px;
    border-radius: var(--r-sm); cursor: pointer; background: var(--surface); border: 1px solid var(--border);
  }
  .result-item:hover { border-color: var(--accent); }
  .result-item.disabled { opacity: 0.45; cursor: default; }
  .result-thumb, .result-thumb-placeholder {
    width: 28px; height: 42px; border-radius: var(--r-sm); object-fit: cover; flex-shrink: 0; background: var(--surface2);
  }
  .result-thumb-placeholder { display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 13px; }
  .result-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-meta { font-size: 10.5px; color: var(--muted); }
  .empty-msg { font-size: 11.5px; color: var(--muted); padding: 6px 2px; }
  .sort-fallback-note {
    font-size: 11px; color: var(--muted); background: var(--surface2);
    border-radius: var(--r-sm); padding: 6px 10px; margin-top: 8px;
  }
  /* ── PREVIEW ROW (horizontal scroll strip, ported from old worker) ── */
  .preview-row {
    margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);
    width: 100%; max-width: 100%; min-width: 0; overflow: hidden;
    animation: tmdb-preview-in 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes tmdb-preview-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  .preview-toolbar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
  .preview-msg { font-size: 12px; color: var(--dim); padding: 6px 2px; }
  .preview-msg.error { color: var(--danger); }
  .preview-scroll {
    display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden; padding: 2px 2px 6px;
    scrollbar-width: thin;
  }
  .preview-scroll::-webkit-scrollbar { height: 6px; }
  .preview-item { flex: 0 0 74px; width: 74px; position: relative; transition: transform 0.12s ease; }
  .preview-item:hover { transform: translateY(-2px); }
  .preview-item img, .preview-poster-placeholder {
    width: 74px; height: 111px; object-fit: cover; border-radius: var(--r-sm);
    background: var(--surface2); display: block;
  }
  .preview-item-title {
    font-size: 10.5px; color: var(--fg); margin-top: 5px; line-height: 1.3;
    overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .preview-item-year { font-size: 10px; color: var(--muted); margin-top: 1px; }
  .preview-item-link {
    position: absolute; top: 5px; right: 5px; width: 20px; height: 20px;
    border-radius: var(--r-sm); opacity: 0; transition: opacity 0.12s, color 0.12s, border-color 0.12s;
    background: rgba(10,10,13,0.72);
  }
  .preview-item-link:hover { color: var(--accent); border-color: var(--accent); }
  .preview-item:hover .preview-item-link,
  .preview-item-link:focus-visible { opacity: 1; }
  .preview-list-link { width: 18px; height: 18px; flex-shrink: 0; align-self: center; margin-left: 4px; opacity: 0.55; transition: opacity 0.12s, color 0.12s, border-color 0.12s; }
  .preview-list-link:hover { opacity: 1; color: var(--accent); border-color: var(--accent); }
  .preview-list { display: flex; flex-direction: column; max-height: 260px; overflow-y: auto; }
  .preview-list-item {
    display: flex; align-items: baseline; gap: 8px;
    padding: 7px 4px; border-bottom: 1px solid var(--border);
  }
  .preview-list-item:last-child { border-bottom: none; }
  .preview-list-num { font-size: 11px; color: var(--muted); flex-shrink: 0; min-width: 1.6em; text-align: right; }
  .preview-list-name { font-size: 12.5px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; min-width: 0; }
  .count-line { font-size: 11px; color: var(--muted); margin-top: 3px; }
  /* ── ACCENT POPUP ── */
  .accent-popup-wrap { position: relative; }
  .accent-popup {
    display: none; position: absolute; top: calc(100% + 8px); right: 0;
    background: var(--surface); border: 1px solid var(--border2); border-radius: var(--r);
    padding: 14px; z-index: 200; width: 220px; max-width: calc(100vw - 32px);
    box-shadow: 0 20px 48px -12px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.03);
  }
  .accent-popup.visible { display: block; }
  .accent-popup-title { font-size: 11px; font-weight: 500; color: var(--dim); margin-bottom: 10px; }
  .swatch-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .swatch {
    width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
    border: 2px solid transparent; transition: transform 0.15s, border-color 0.15s; flex-shrink: 0;
    padding: 0; appearance: none; -webkit-appearance: none;
  }
  .swatch:hover { transform: scale(1.15); filter: none; }
  .swatch.selected { border-color: #fff; box-shadow: 0 0 0 1px rgba(255,255,255,0.3); transform: scale(1.1); }

  /* ── MENU ── */
  .menu-popup-wrap { position: relative; }
  .menu-popup {
    display: none; position: absolute; top: calc(100% + 8px); right: 0;
    background: var(--surface); border: 1px solid var(--border2); border-radius: var(--r);
    padding: 6px; z-index: 200; width: 200px; max-width: calc(100vw - 32px);
    box-shadow: 0 20px 48px -12px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.03);
  }
  .menu-popup.visible { display: block; }
  .menu-item {
    display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: var(--r-sm);
    background: transparent; border-color: transparent; font-weight: 400; text-align: left; width: 100%;
    font-size: 12.5px; color: var(--dim); cursor: pointer; transition: background 0.1s, color 0.1s;
  }
  .menu-item svg { flex-shrink: 0; }
  .menu-item:hover { background: var(--surface2); color: var(--text); filter: none; }
  .menu-item.active { background: var(--accent-dim); color: var(--accent); }
  .menu-item.disabled { opacity: 0.4; cursor: default; }
  .menu-item.disabled:hover { background: none; color: var(--dim); }
  .menu-soon { margin-left: auto; font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }

  /* ── CONFIRM DIALOGS (R1: native <dialog>; QW4/QW5 stopgaps removed) ── */
  dialog.confirm-modal {
    background: var(--surface);
    border: 1px solid var(--border2); border-radius: var(--r2);
    padding: 20px; width: min(400px, calc(100vw - 40px));
    margin: auto;
    box-shadow: 0 28px 60px -16px rgba(0,0,0,0.9);
  }
  dialog.confirm-modal::backdrop {
    background: rgba(3,3,6,0.72);
    backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  }
  @media (max-width: 767px) {
    /* Bottom sheet: docked, full-width, grab handle, safe-area aware */
    dialog.confirm-modal {
      position: fixed; inset: auto 0 0 0; margin: 0;
      width: 100%; max-width: none;
      border-radius: var(--r2) var(--r2) 0 0; border-bottom: none;
      padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    }
    dialog.confirm-modal::before {
      content: ''; display: block; width: 36px; height: 4px;
      border-radius: 999px; background: var(--border2); margin: 0 auto 14px;
    }
  }
  .confirm-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
  .confirm-body { font-size: 12.5px; color: var(--dim); line-height: 1.5; margin-bottom: 18px; }
  .confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .confirm-actions button { padding: 8px 14px; font-size: 12.5px; }

  /* ── UNDO TOAST (R1 minimal inline widget; R7's S13 toast system absorbs it) ── */
  .toast-wrap {
    position: fixed; left: 50%; transform: translateX(-50%); bottom: 24px;
    display: none; align-items: center; gap: 14px;
    background: var(--surface3); border: 1px solid var(--border2); border-radius: var(--r);
    padding: 10px 16px; z-index: 500;
    font-size: 12.5px; color: var(--text);
    box-shadow: 0 12px 32px -8px rgba(0,0,0,0.7);
  }
  .toast-wrap.visible { display: flex; }
  .toast-undo {
    background: transparent; border: 0; padding: 2px 4px;
    color: var(--accent); font-weight: 600; cursor: pointer;
  }
  .toast-undo:hover { filter: brightness(1.15); }

  /* ── RESPONSIVE ── */
  @media (max-width: 900px) { main { padding: 20px; } }
  @media (min-width: 561px) {
    .card-head { align-items: center; }
  }
  @media (max-width: 640px) {
    header { padding: 10px 14px; }
    .header-title { font-size: 13px; }
    .header-actions { gap: 6px; }
    button.btn-save { padding: 6px 11px; font-size: 11px; }
    .btn-icon { padding: 6px 8px; }
    main { padding: 14px 12px 56px; }
    .create-form .field { flex-basis: 100%; }
    .create-form.inline .field-name { flex-basis: 100%; }
    .card-body .url-input { flex: 1 1 100%; }
    .body-actions { margin-left: auto; }
    .list-card { padding: 9px; margin-bottom: 8px; }
    .card-head { gap: 9px; }
    .toggle { width: 26px; height: 15px; }
    .toggle-slider::before { width: 9px; height: 9px; }
    .toggle input:checked + .toggle-slider::before { transform: translateX(11px); }
    .name-static { font-size: 12px; }
    .id-chip { display: none; }
    .icon-btn { width: 20px; height: 20px; }
    .icon-btn svg { width: 12px; height: 12px; }
    select { font-size: 10px; padding: 5px 24px 5px 6px; background-position: right 6px center; }
    .card-body .max-pages { font-size: 11px; padding: 5px 6px; }
    button.danger { padding: 5px 8px; font-size: 10px; }
    .accent-popup { right: -14px; width: 190px; padding: 12px; }
    .swatch { width: 24px; height: 24px; }
    .menu-popup { right: -14px; width: 180px; padding: 5px; }
    .menu-item { padding: 8px 9px; font-size: 12px; }

    /* ── TMDB tab (ported from old worker) ── */
    .preview-item:hover { transform: none; }
    .members-label { font-size: 10px; }
    .member-chip, .exclude-chip { font-size: 10.5px; padding: 3px 5px 3px 9px; max-width: 150px; }
    .member-chip-add, .exclude-chip-add { padding: 3px 10px; }
    .exclude-genre-select-inline { font-size: 10.5px; padding: 3px 6px; }
    .include-mode-row { gap: 7px; }
    .mode-toggle { width: 96px; height: 21px; }
    .mode-toggle-thumb { height: 15px; }
    .mode-toggle-btn { font-size: 9px; }
    .dim-mode-tag { font-size: 8.5px; padding: 1px 5px; }
    .preview-row { margin-top: 9px; padding-top: 9px; }
    .preview-item { flex: 0 0 60px; width: 60px; }
    .preview-item img, .preview-poster-placeholder { width: 60px; height: 90px; }
    .preview-item-title { font-size: 9.5px; }
    /* No hover on touch - keep TMDB links always visible */
    .preview-item-link { opacity: 1; width: 17px; height: 17px; top: 4px; right: 4px; }
    .preview-list-link { opacity: 1; width: 17px; height: 17px; }
    .inline-add-search button { flex: 1 1 auto; padding: 6px 10px; font-size: 11px; }
  }
  @media (max-width: 380px) {
    .right-col { gap: 6px; }
    .card-body .url-input { flex-basis: 100%; }
  }
</style>
</head>
<body>

<header>
  <h1 class="header-title" id="headerTitle">MDBList Scraper</h1>
  <div class="header-actions">
    <button class="btn-save" id="saveBtn">Save</button>
    <button class="btn-icon" id="refreshBtn" onclick="openRefreshConfirm()" title="Refresh - regenerate all enabled lists">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
    </button>
    <div class="accent-popup-wrap">
      <button class="btn-icon" id="accentBtn" title="Accent colour">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
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
        <button type="button" class="menu-item active" data-module="scraper" onclick="activateModule('scraper')">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          MDBList Scraper
        </button>
        <button type="button" class="menu-item" data-module="official" onclick="activateModule('official')">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
          MDBList Official List
        </button>
        <button type="button" class="menu-item" data-module="simkl" onclick="activateModule('simkl')">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.6-9.5-9A5.5 5.5 0 0 1 12 6.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.4-9.5 9-9.5 9z"/></svg>
          Simkl List
        </button>
        <button type="button" class="menu-item" data-module="tmdb" onclick="activateModule('tmdb')">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/></svg>
          TMDB List
        </button>
      </div>
    </div>
  </div>
</header>

<main>
  <div id="status" aria-live="polite"></div>
  <div id="tabHost"></div>
</main>

<dialog class="confirm-modal" id="refreshConfirmDlg" aria-labelledby="refreshAllTitle" aria-describedby="refreshAllBody">
  <div class="confirm-title" id="refreshAllTitle">Refresh all lists?</div>
  <div class="confirm-body" id="refreshAllBody"></div>
  <div class="confirm-actions">
    <button class="secondary" autofocus onclick="closeRefreshConfirm()">Cancel</button>
    <button id="confirmRefreshBtn">Refresh all</button>
  </div>
</dialog>

<dialog class="confirm-modal" id="deleteConfirmDlg" aria-labelledby="deleteConfirmTitle" aria-describedby="deleteConfirmBody">
  <div class="confirm-title" id="deleteConfirmTitle">Delete this list?</div>
  <div class="confirm-body" id="deleteConfirmBody"></div>
  <div class="confirm-actions">
    <button class="secondary" autofocus onclick="closeDeleteConfirm()">Cancel</button>
    <button class="danger" id="confirmDeleteBtn">Delete list</button>
  </div>
</dialog>

<dialog class="confirm-modal" id="refreshOneDlg" aria-labelledby="refreshOneTitle" aria-describedby="refreshOneBody">
  <div class="confirm-title" id="refreshOneTitle">Refresh this list?</div>
  <div class="confirm-body" id="refreshOneBody"></div>
  <div class="confirm-actions">
    <button class="secondary" autofocus onclick="closeRefreshOneConfirm()">Cancel</button>
    <button id="confirmRefreshOneBtn">Refresh</button>
  </div>
</dialog>

<div class="toast-wrap" id="toastWrap" role="status">
  <span id="toastMsg"></span>
  <button type="button" class="toast-undo" id="toastUndo">Undo</button>
</div>

<script>
const ORIGIN = ${JSON.stringify(origin).replace(/</g, "\\u003c")};
let state = ${initial};

// ─── Scraper module state ───
let listNameEditIndex = -1;
let pendingDeleteIndex = -1;
let pendingRefreshIndex = -1;

function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Accent colour (localStorage-persisted) ───
const ACCENT_COLORS = {
  '#fb923c': { name: 'Amber', dim: 0.10, glow: 0.18 },
  '#f59e0b': { name: 'Gold', dim: 0.10, glow: 0.18 },
  '#f43f5e': { name: 'Rose', dim: 0.10, glow: 0.18 },
  '#e63d64': { name: 'Magenta', dim: 0.10, glow: 0.18 },
  '#60a5fa': { name: 'Sky Blue', dim: 0.10, glow: 0.18 },
  '#38bdf8': { name: 'Ice Blue', dim: 0.10, glow: 0.18 },
  '#818cf8': { name: 'Indigo', dim: 0.10, glow: 0.18 },
  '#5550f7': { name: 'Violet', dim: 0.10, glow: 0.18 },
  '#06b6d4': { name: 'Cyan (default)', dim: 0.10, glow: 0.18 },
  '#19be81': { name: 'Emerald', dim: 0.10, glow: 0.18 },
  '#e2e8f0': { name: 'Pure White', dim: 0.08, glow: 0.14 },
  '#94a3b8': { name: 'Slate', dim: 0.08, glow: 0.14 },
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
  document.querySelectorAll('.swatch').forEach(s => {
    const on = s.dataset.accent === hex;
    s.classList.toggle('selected', on);
    s.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  applyAccent(hex);
  try { localStorage.setItem(ACCENT_STORAGE_KEY, hex); } catch (e) {}
}

function initSwatches() {
  const row = document.getElementById('swatchRow');
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', 'Accent colour');
  let saved = '#06b6d4';
  try { saved = localStorage.getItem(ACCENT_STORAGE_KEY) || '#06b6d4'; } catch (e) {}
  row.innerHTML = Object.keys(ACCENT_COLORS).map(hex =>
    '<button type="button" role="radio" aria-checked="' + (hex === saved ? 'true' : 'false') + '" class="swatch' + (hex === saved ? ' selected' : '') + '" data-accent="' + hex + '" style="background:' + hex + '" aria-label="Accent colour: ' + ACCENT_COLORS[hex].name + '" onclick="selectAccent(\\\'' + hex + '\\\')"></button>'
  ).join('');
  applyAccent(saved);
}

function toggleAccentPopup() { document.getElementById('accentPopup').classList.toggle('visible'); }
function setStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = kind || '';
}

function soon() { setStatus('That module is coming soon - only the MDBList Scraper tab is live right now.', 'error'); }

// QW9: translate known raw infra errors into plain sentences. Unknown
// errors pass through untouched - never hide an unexpected failure.
// new RegExp (not a /.../ literal): this code lives inside a template
// literal, and backslash-escaped slashes would be eaten before reaching
// the browser.
const ERROR_MAP = [
  [new RegExp('GH_TOKEN/GH_REPO/GH_WORKFLOW not configured', 'i'),
    'GitHub is not connected - set the GH_TOKEN secret on the worker first.'],
];
function humanizeError(msg) {
  for (const [re, friendly] of ERROR_MAP) if (re.test(msg)) return msg.replace(re, friendly);
  return msg;
}

// ─── Menu ───
function toggleMenu() { document.getElementById('menuPopup').classList.toggle('visible'); }
let activeModule = 'scraper';
const MODULE_KEY = 'mylist_active_module';
function activateModule(m) {
  document.getElementById('menuPopup').classList.remove('visible');
  if (m !== 'scraper' && m !== 'official' && m !== 'simkl' && m !== 'tmdb') { soon(); return; }
  activeModule = m;
  try { localStorage.setItem(MODULE_KEY, m); } catch (e) {}
  document.querySelectorAll('.menu-item').forEach(i => i.classList.toggle('active', i.dataset.module === m));
  if (m === 'scraper') renderScraper();
  else if (m === 'official') renderOfficial();
  else if (m === 'tmdb') renderTmdb();
  else renderSimkl();
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
    return '<div class="list-card' + (l.enabled ? '' : ' disabled') + '" id="card-' + i + '">' +
      '<div class="card-head">' +
        '<label class="toggle"><input type="checkbox" ' + (l.enabled ? 'checked' : '') + ' onchange="toggleList(' + i + ')"><span class="toggle-slider"></span></label>' +
        nameEditBlock(i, l) +
        '<span class="id-chip">' + escapeAttr(l.id) + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<input class="url-input" value="' + escapeAttr(l.url) + '" onchange="updateList(' + i + ', \\\'url\\\', this.value)" placeholder="https://mdblist.com/movies/…" spellcheck="false">' +
        '<select onchange="updateList(' + i + ', \\\'type\\\', this.value)">' +
          '<option value="movie"' + (l.type === 'movie' ? ' selected' : '') + '>Movie</option>' +
          '<option value="series"' + (l.type === 'series' ? ' selected' : '') + '>Series</option>' +
        '</select>' +
        '<label class="pages-field">Pages' +
          '<input class="max-pages" type="number" min="1" max="50" value="' + l.maxPages + '" onchange="updateList(' + i + ', \\\'maxPages\\\', this.value)">' +
        '</label>' +
        '<span class="body-actions">' +
          '<button class="btn-icon card-refresh" onclick="askSingleRefresh(' + i + ')" title="Refresh this list" aria-label="Refresh this list">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' +
          '</button>' +
          '<button class="danger" onclick="askDelete(' + i + ')">Delete</button>' +
        '</span>' +
      '</div>' +
      '<div class="card-error" id="cardError-' + i + '"></div>' +
    '</div>';
  }).join('');

  const emptyHint = lists.length ? '' : '<div class="empty">No scraper lists yet - add your first below.</div>';
  const trigger = lists.length
    ? '<button class="btn-create-list" id="createListBtn" onclick="showCreateRow()">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>' +
      'Add List</button>'
    : '';
  const createOpen = lists.length ? ' style="display:none"' : ' style="display:flex"';
  const createSlot =
    '<div class="create-slot">' + trigger +
      '<div class="create-form" id="createListRow"' + createOpen + '>' +
        '<label class="field"><span class="field-label">Name</span><input class="name-input" id="createNameInput" placeholder="Name - e.g. Latest Movie" spellcheck="false"></label>' +
        '<label class="field"><span class="field-label">URL</span><input class="url-input" id="createUrlInput" placeholder="https://mdblist.com/movies/…" spellcheck="false"></label>' +
        '<select id="createTypeSelect"><option value="movie">Movie</option><option value="series">Series</option></select>' +
        '<label class="pages-field">Pages<input class="max-pages" id="createPagesInput" type="number" min="1" max="50" value="3"></label>' +
        '<span class="body-actions"><button onclick="confirmCreateList()">Add</button><button type="button" class="secondary" onclick="hideCreateRow()">Cancel</button></span>' +
      '</div>' +
    '</div>';

  document.getElementById('headerTitle').textContent = 'MDBList Scraper';
  const toolbar = '<div class="scraper-toolbar"><button class="secondary" onclick="openStatus()">Status</button></div>';

  host.innerHTML = toolbar + cards + emptyHint + createSlot;
  applyDisabledState();
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

// Inline rename: name only touches the manifest (built live from
// config), never the data file - so renaming must NOT trigger a regen.
// Shared by scraper, official + simkl cards. The pencil sits in a name-wrap
// so it hugs the name text instead of stretching to the card's right edge.
function moduleLists() {
  return activeModule === 'simkl' ? state.simkl.lists
    : activeModule === 'official' ? state.official.lists
    : activeModule === 'tmdb' ? state.tmdb.lists
    : state.scraper.lists;
}
// A45: a disabled list no longer fades via opacity (that failed contrast).
// Instead every control except its enable toggle is genuinely disabled -
// inputs can't be edited, buttons can't be clicked, text stays readable.
function applyDisabledState() {
  document.querySelectorAll('.list-card.disabled').forEach(card => {
    card.querySelectorAll('input:not(.toggle input), select, button').forEach(el => { el.disabled = true; });
  });
}
function nameEditBlock(i, l, extraHtml) {
  const editing = listNameEditIndex === i;
  return '<div class="name-wrap">' +
    (editing
      ? '<input class="name-edit" id="nameInput-' + i + '" value="' + escapeAttr(l.name) + '" onkeydown="if(event.key===\\\'Enter\\\')saveName(' + i + ');if(event.key===\\\'Escape\\\')cancelName(' + i + ')" onblur="saveName(' + i + ')">'
      : '<span class="name-static">' + escapeAttr(l.name) + '</span>') +
    '<button type="button" class="icon-btn" onclick="startNameEdit(' + i + ')" title="Rename" aria-label="Rename list">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>' +
    '</button>' +
    // The preview-eye only makes sense on TMDB cards: toggleTmdbPreview
    // indexes state.tmdb.lists, so rendering it on scraper/official/simkl
    // cards made the button either a silent no-op or (worse) hijack the
    // page to the TMDB tab by toggling an unrelated same-index list.
    (activeModule === 'tmdb'
      ? '<button type="button" class="icon-btn' + (l.previewOpen ? ' tmdb-eye-active' : '') + '" onclick="toggleTmdbPreview(' + i + ')" title="Preview results" aria-label="Preview results"' + (l.previewOpen ? ' aria-pressed="true"' : '') + '>' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>' +
      '</button>'
      : '') +
  '</div>';
}

function startNameEdit(i) {
  if (listNameEditIndex === i) { cancelName(i); return; }
  listNameEditIndex = i; rerenderActive();
}
function saveName(i) {
  if (listNameEditIndex !== i) return;
  const lists = moduleLists();
  const el = document.getElementById('nameInput-' + i);
  // lists[i] guard: switching modules with a rename still open fires blur
  // after the swap - the index may not exist (or exist) in the NEW module.
  if (el && el.value.trim() && lists[i]) {
    const newName = el.value.trim().toLowerCase();
    // Duplicate guard mirrors create. TMDB allows the same name across
    // media types (catalog id embeds type); other modules are name-only.
    const clash = lists.some((l, j) =>
      j !== i && l.name.toLowerCase() === newName &&
      (activeModule !== 'tmdb' || l.mediaType === lists[i].mediaType));
    if (clash) { setStatus('A list with that name already exists.', 'error'); return; }
    lists[i].name = el.value.trim();
  }
  listNameEditIndex = -1;
  rerenderActive();
}
function cancelName(i) { listNameEditIndex = -1; rerenderActive(); }
function rerenderActive() { if (activeModule === 'simkl') renderSimkl(); else if (activeModule === 'official') renderOfficial(); else if (activeModule === 'tmdb') renderTmdb(); else renderScraper(); }

// Clicking anywhere outside the open rename input commits it. Native blur
// only fires when focus moves to another focusable element, so a click on
// empty card padding leaves the input focused - this listener covers that.
//
// IMPORTANT: bail out if the click landed on the same card's rename UI
// (input or its pencil button). Without this guard, capture-phase
// pointerdown commits the rename AND tears down the DOM (rerender swaps
// innerHTML) before the click handler runs - the target element is gone,
// the click never reaches it. Every sibling control (toggle, URL, refresh,
// delete) on the open-rename card required two clicks to use.
document.addEventListener('pointerdown', (e) => {
  if (listNameEditIndex < 0) return;
  const wrap = document.querySelector('#card-' + listNameEditIndex + ' .name-wrap, #ocard-' + listNameEditIndex + ' .name-wrap, #socard-' + listNameEditIndex + ' .name-wrap');
  if (wrap && wrap.contains(e.target)) return;
  const el = document.getElementById('nameInput-' + listNameEditIndex);
  if (el && !el.contains(e.target)) saveName(listNameEditIndex);
}, true);

function showCreateRow() {
  const btn = document.getElementById('createListBtn');
  const row = document.getElementById('createListRow');
  if (!btn || !row) return;
  btn.style.display = 'none';
  row.style.display = 'flex';
  document.getElementById('createNameInput').focus();
}
function hideCreateRow() {
  const btn = document.getElementById('createListBtn');
  const row = document.getElementById('createListRow');
  if (!btn || !row) return;
  btn.style.display = '';
  row.style.display = 'none';
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
  const l = activeModule === 'tmdb' ? state.tmdb.lists[i] : state.scraper.lists[i];
  if (!l) return;
  pendingDeleteIndex = i;
  document.getElementById('deleteConfirmTitle').textContent = "Delete '" + l.name + "'?";
  document.getElementById('deleteConfirmBody').textContent = 'Removes this list and its saved filters, tiers, and pages settings. You can re-add the URL later but tuning is lost.';
  document.getElementById('deleteConfirmDlg').showModal();
}
function closeDeleteConfirm() { document.getElementById('deleteConfirmDlg').close(); pendingDeleteIndex = -1; }

// R1 undo window: deletion is in-memory until Save, so Undo simply splices
// the snapshot back. ponytail: minimal inline toast; R7's S13 toast system
// replaces this widget.
let undoTimer = null;
function showUndoToast(name, restore) {
  const wrap = document.getElementById('toastWrap');
  document.getElementById('toastMsg').textContent = "Deleted '" + name + "'";
  document.getElementById('toastUndo').onclick = () => {
    clearTimeout(undoTimer);
    wrap.classList.remove('visible');
    restore();
    setStatus("Restored '" + name + "'. Press Save to keep it.", 'ok');
  };
  wrap.classList.add('visible');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => wrap.classList.remove('visible'), 8000);
}

function confirmDelete() {
  if (pendingDeleteIndex < 0) return;
  const i = pendingDeleteIndex;
  const lists = activeModule === 'tmdb' ? state.tmdb.lists : state.scraper.lists;
  const snapshot = lists[i];
  const name = snapshot.name;
  lists.splice(i, 1);
  pendingDeleteIndex = -1;
  closeDeleteConfirm();
  rerenderActive();
  showUndoToast(name, () => {
    lists.splice(Math.min(i, lists.length), 0, snapshot);
    rerenderActive();
  });
}

// IDs are derived from the URL - must match the server's
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

// ─── Official module tab ───
function renderOfficial() {
  const host = document.getElementById('tabHost');
  const lists = state.official.lists;
  const cards = lists.map((l, i) => {
    return '<div class="list-card' + (l.enabled ? '' : ' disabled') + '" id="ocard-' + i + '">' +
      '<div class="card-head">' +
        '<label class="toggle"><input type="checkbox" ' + (l.enabled ? 'checked' : '') + ' onchange="toggleOfficial(' + i + ')"><span class="toggle-slider"></span></label>' +
        nameEditBlock(i, l) +
        '<span class="id-chip">' + escapeAttr(l.slug) + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<span class="official-hint">Movies + shows, refreshed every 12 hours via the MDBList API</span>' +
        '<span class="body-actions">' +
          '<button class="btn-icon card-refresh" onclick="askSingleRefresh(' + i + ')" title="Refresh this official list" aria-label="Refresh this official list">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' +
          '</button>' +
        '</span>' +
      '</div>' +
      '<div class="card-error" id="ocardError-' + i + '"></div>' +
    '</div>';
  }).join('');

  document.getElementById('headerTitle').textContent = 'MDBList Official List';
  const toolbar = '<div class="scraper-toolbar"><button class="secondary" onclick="openStatus()">Status</button></div>';

  host.innerHTML = toolbar + '<div class="official-note">These are the 3 fixed MDBList official lists. They cannot be added or deleted - only renamed, enabled or disabled.</div>' + (cards || '<div class="empty">No official lists.</div>');
  applyDisabledState();
}

function toggleOfficial(i) {
  const l = state.official.lists[i];
  if (!l) return;
  l.enabled = !l.enabled;
  renderOfficial();
}

// R1 (amended per owner): single-list refresh keeps its confirmation, as a
// native dialog that names the list and states the timing.
function askSingleRefresh(i) {
  const m = activeModule;
  const list = m === 'official' ? state.official.lists[i] : m === 'simkl' ? state.simkl.lists[i] : m === 'tmdb' ? state.tmdb.lists[i] : state.scraper.lists[i];
  if (!list) return;
  pendingRefreshIndex = i;
  document.getElementById('refreshOneTitle').textContent = "Refresh '" + list.name + "'?";
  const timing = m === 'simkl' || m === 'tmdb' ? 'a few seconds' : m === 'official' ? 'about a minute' : '1-3 minutes';
  document.getElementById('refreshOneBody').textContent = 'Queues a GitHub Actions rebuild of just this list now. Typically takes ' + timing + '; progress shows on the Status page.';
  document.getElementById('refreshOneDlg').showModal();
}
function closeRefreshOneConfirm() { document.getElementById('refreshOneDlg').close(); pendingRefreshIndex = -1; }

async function performSingleRefresh(i) {
  const m = activeModule;
  const list = m === 'official' ? state.official.lists[i] : m === 'simkl' ? state.simkl.lists[i] : m === 'tmdb' ? state.tmdb.lists[i] : state.scraper.lists[i];
  if (!list) return;
  const cardSel = (m === 'official' ? '#ocard-' + i : m === 'simkl' ? '#socard-' + i : m === 'tmdb' ? '#tcard-' + i : '#card-' + i) + ' .card-refresh';
  const btn = document.querySelector(cardSel);
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  try {
    // Page-scoped: official tab sends page=official + the slug, simkl tab
    // sends page=simkl + the kind, tmdb tab sends page=tmdb + catalog id,
    // scraper tab sends the list id (defaults to the scraper page).
    const body = m === 'official' ? { page: 'official', id: list.slug }
      : m === 'simkl' ? { page: 'simkl', id: list.slug }
      : m === 'tmdb' ? { page: 'tmdb', id: 'tmdb_discover_' + list.mediaType + '_' + list.discoverListId }
      : { id: list.id };
    const res = await fetch(ORIGIN + '/trigger-refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const tail = m === 'official' ? 'official list (movies + shows).' : m === 'simkl' ? 'simkl list.' : m === 'tmdb' ? 'TMDB list.' : 'list.';
    setStatus("'" + list.name + "' is rebuilding - regenerating just that " + tail, 'ok');
  } catch (e) {
    setStatus('Refresh failed: ' + humanizeError(e.message), 'error');
  } finally {
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

// ─── Simkl module tab ───
function renderSimkl() {
  const host = document.getElementById('tabHost');
  const lists = state.simkl.lists;
  const cards = lists.map((l, i) => {
    const f = l.filter || {};
    const tiers = (f.rating_tiers || []).map((t, ti) =>
      '<div class="tier-row">' +
        '<input class="tier-num" type="number" step="0.1" placeholder="min" value="' + (t.min_rating ?? '') + '" onchange="setTier(' + i + ',' + ti + ',\\\'min_rating\\\',this.value)">' +
        '<input class="tier-num" type="number" step="0.1" placeholder="max" value="' + (t.max_rating ?? '') + '" onchange="setTier(' + i + ',' + ti + ',\\\'max_rating\\\',this.value)">' +
        '<input class="tier-num" type="number" step="1" placeholder="votes" value="' + (t.min_votes ?? '') + '" onchange="setTier(' + i + ',' + ti + ',\\\'min_votes\\\',this.value)">' +
        '<input class="tier-num" type="number" step="0.1" placeholder="sec." value="' + (t.min_secondary_rating ?? '') + '" onchange="setTier(' + i + ',' + ti + ',\\\'min_secondary_rating\\\',this.value)">' +
        '<button class="danger" onclick="removeTier(' + i + ',' + ti + ')">−</button>' +
      '</div>'
    ).join('') || '<div class="empty">No rating tiers.</div>';

    return '<div class="list-card' + (l.enabled ? '' : ' disabled') + '" id="socard-' + i + '">' +
      '<div class="card-head">' +
        '<label class="toggle"><input type="checkbox" ' + (l.enabled ? 'checked' : '') + ' onchange="toggleSimkl(' + i + ')"><span class="toggle-slider"></span></label>' +
        nameEditBlock(i, l) +
        '<span class="id-chip">' + escapeAttr(l.slug) + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<span class="official-hint">' + (l.slug === 'anime' ? 'Anime' : 'Series') + ', refreshed every 12 hours</span>' +
        '<span class="body-actions">' +
          '<button class="btn-icon card-refresh" onclick="askSingleRefresh(' + i + ')" title="Refresh this simkl list" aria-label="Refresh this simkl list">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' +
          '</button>' +
        '</span>' +
      '</div>' +
      '<div class="simkl-filter" id="simfilter-' + i + '">' +
        '<div class="filter-line"><span class="filter-label">Rating source</span><div class="filter-value"><span class="id-chip">' + escapeAttr(f.rating_source || 'imdb') + '</span></div></div>' +
        '<div class="filter-line"><label class="filter-label" for="sfRating-' + i + '">Rating filter</label><div class="filter-value"><input type="checkbox" class="filter-check" id="sfRating-' + i + '" ' + (f.rating_filter_enabled ? 'checked' : '') + ' onchange="toggleRatingEnabled(' + i + ',this.checked)"><span class="toggle-text">' + (f.rating_filter_enabled ? 'Filtering enabled' : 'Filtering disabled') + '</span></div></div>' +
        '<div class="filter-line filter-csv"><label class="filter-label" for="sfGenres-' + i + '">Exclude genres</label><div class="filter-value"><input class="url-input" id="sfGenres-' + i + '" value="' + escapeAttr((f.exclude_genres || []).join(', ')) + '" onchange="setCsv(' + i + ',\\\'exclude_genres\\\',this.value)" placeholder="Talk Show, Reality, News"></div></div>' +
        '<div class="filter-line filter-csv"><label class="filter-label" for="sfIncC-' + i + '">Include countries</label><div class="filter-value"><input class="url-input" id="sfIncC-' + i + '" value="' + escapeAttr((f.include_countries || []).join(', ')) + '" onchange="setCsv(' + i + ',\\\'include_countries\\\',this.value)" placeholder="us, gb"></div></div>' +
        '<div class="filter-line filter-csv"><label class="filter-label" for="sfExcC-' + i + '">Exclude countries</label><div class="filter-value"><input class="url-input" id="sfExcC-' + i + '" value="' + escapeAttr((f.exclude_countries || []).join(', ')) + '" onchange="setCsv(' + i + ',\\\'exclude_countries\\\',this.value)" placeholder="cn, kr, jp"></div></div>' +
        '<div class="filter-line filter-top"><span class="filter-label">Rating tiers</span><div class="filter-value"><button class="secondary" onclick="addTier(' + i + ')">+ Add tier</button></div></div>' +
        '<div class="tier-table"><div class="tier-head"><span>Min rating<span class="th-src">(' + escapeAttr(f.rating_source || 'imdb') + ')</span></span><span>Max rating<span class="th-src">(' + escapeAttr(f.rating_source || 'imdb') + ')</span></span><span>Min votes</span><span>Min sec.<span class="th-src">(simkl)</span></span><span></span></div>' + tiers + '</div>' +
      '</div>' +
      '<div class="card-error" id="socardError-' + i + '"></div>' +
    '</div>';
  }).join('');

  document.getElementById('headerTitle').textContent = 'Simkl List';
  const toolbar = '<div class="scraper-toolbar"><button class="secondary" onclick="openStatus()">Status</button></div>';

  host.innerHTML = toolbar + '<div class="official-note">The 2 fixed SIMKL Arriving Today lists. Filters are typed below and applied on the next refresh.</div>' + (cards || '<div class="empty">No simkl lists.</div>');
  applyDisabledState();
}

function toggleSimkl(i) {
  const l = state.simkl.lists[i];
  if (!l) return;
  l.enabled = !l.enabled;
  renderSimkl();
}

function setCsv(i, key, value) {
  const l = state.simkl.lists[i];
  if (!l) return;
  l.filter[key] = value.split(',').map(s => s.trim()).filter(Boolean);
}

function setTier(i, ti, field, value) {
  const l = state.simkl.lists[i];
  if (!l) return;
  const n = parseFloat(value);
  l.filter.rating_tiers[ti][field] = Number.isFinite(n) ? n : undefined;
}

function addTier(i) {
  state.simkl.lists[i].filter.rating_tiers.push({ min_rating: null, max_rating: null, min_votes: null, min_secondary_rating: null });
  renderSimkl();
}

function removeTier(i, ti) {
  state.simkl.lists[i].filter.rating_tiers.splice(ti, 1);
  renderSimkl();
}

function toggleRatingEnabled(i, checked) {
  state.simkl.lists[i].filter.rating_filter_enabled = checked;
}

// ─── TMDB Discover module tab ───
// Ported from the old tmdb worker's Discover page: 5 filter dimensions
// (genre static, keyword/company/collection via live TMDB search, release
// type static movie-only), per-dimension AND/OR for genre/keyword/company/
// collection, per-list sort, live preview. One list = one catalog
// (tmdb_discover_<movie|series>_<8 chars>).
const TMDB_GENRES = [
  { id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }, { id: 16, name: 'Animation' }, { id: 35, name: 'Comedy' },
  { id: 80, name: 'Crime' }, { id: 99, name: 'Documentary' }, { id: 18, name: 'Drama' }, { id: 10751, name: 'Family' },
  { id: 14, name: 'Fantasy' }, { id: 36, name: 'History' }, { id: 27, name: 'Horror' }, { id: 10402, name: 'Music' },
  { id: 9648, name: 'Mystery' }, { id: 10749, name: 'Romance' }, { id: 878, name: 'Science Fiction' }, { id: 10770, name: 'TV Movie' },
  { id: 53, name: 'Thriller' }, { id: 10752, name: 'War' }, { id: 37, name: 'Western' },
];
// TMDB's TV genre ids differ from movie ids in several entries - a shared
// list would send wrong ids to /discover/tv.
const TMDB_TV_GENRES = [
  { id: 10759, name: 'Action & Adventure' }, { id: 16, name: 'Animation' }, { id: 35, name: 'Comedy' },
  { id: 80, name: 'Crime' }, { id: 99, name: 'Documentary' }, { id: 18, name: 'Drama' }, { id: 10751, name: 'Family' },
  { id: 10762, name: 'Kids' }, { id: 9648, name: 'Mystery' }, { id: 10763, name: 'News' }, { id: 10764, name: 'Reality' },
  { id: 10765, name: 'Sci-Fi & Fantasy' }, { id: 10766, name: 'Soap' }, { id: 10767, name: 'Talk' },
  { id: 10768, name: 'War & Politics' }, { id: 37, name: 'Western' },
];
const tmdbGenresFor = (mediaType) => (mediaType === 'series' ? TMDB_TV_GENRES : TMDB_GENRES);
const TMDB_RELEASE_TYPES = [
  { id: 1, name: 'Premiere' }, { id: 2, name: 'Theatrical (limited)' }, { id: 3, name: 'Theatrical' },
  { id: 4, name: 'Digital' }, { id: 5, name: 'Physical' }, { id: 6, name: 'TV' },
];
const TMDB_SORTS = [
  { value: 'release_asc', label: 'Release date ↑' }, { value: 'release_desc', label: 'Release date ↓' },
  { value: 'popularity_desc', label: 'Popularity ↓' }, { value: 'vote_desc', label: 'Rating ↓' },
  { value: 'title_asc', label: 'Title A-Z' },
];
// kind -> config field names. Explicit table (no pluralization guessing) -
// same lesson as the old worker's DISCOVER_FIELD_KEYS.
const TMDB_FIELD_KEYS = {
  genre:       { include: 'includeGenres', exclude: 'excludeGenres' },
  keyword:     { include: 'includeKeywords', exclude: 'excludeKeywords' },
  company:     { include: 'includeCompanies', exclude: 'excludeCompanies' },
  releaseType: { include: 'includeReleaseTypes', exclude: null },
  collection:  { include: 'includeCollections', exclude: 'excludeCollections' },
};
const TMDB_DIMS = [
  { kind: 'genre', label: 'Genres', hasExclude: true, isStatic: true, searchKind: null, movieOnly: false },
  { kind: 'keyword', label: 'Keywords', hasExclude: true, isStatic: false, searchKind: 'keyword', movieOnly: false },
  { kind: 'company', label: 'Companies', hasExclude: true, isStatic: false, searchKind: 'company', movieOnly: false },
  { kind: 'releaseType', label: 'Release Type', hasExclude: false, isStatic: true, searchKind: null, movieOnly: true },
  { kind: 'collection', label: 'Part of Collection', hasExclude: true, isStatic: false, searchKind: 'collection', movieOnly: true },
];
// Names for the dims that carry them (keyword/company/collection). Genre and
// releaseType names resolve from their static option lists instead.
const TMDB_NAME_KEYS = {
  keyword:   { include: 'includeKeywordNames', exclude: 'excludeKeywordNames' },
  company:   { include: 'includeCompanyNames', exclude: 'excludeCompanyNames' },
  collection:{ include: 'includeCollectionNames', exclude: 'excludeCollectionNames' },
};
function tmdbStaticName(kind, id, mediaType) {
  const opts = kind === 'releaseType' ? TMDB_RELEASE_TYPES : tmdbGenresFor(mediaType);
  const opt = opts.find((o) => o.id === id);
  return opt ? opt.name : String(id);
}

let tmdbSearchTimer = null;

function tmdbEmptyList(mediaType) {
  return {
    discoverListId: '', name: '', mediaType: mediaType || 'movie', sort: 'release_asc', enabled: true,
    includeModes: { genre: 'and', keyword: 'and', company: 'and', collection: 'and' },
    includeGenres: [], excludeGenres: [],
    includeKeywords: [], includeKeywordNames: [], excludeKeywords: [], excludeKeywordNames: [],
    includeCompanies: [], includeCompanyNames: [], excludeCompanies: [], excludeCompanyNames: [],
    includeReleaseTypes: [],
    includeCollections: [], includeCollectionNames: [], excludeCollections: [], excludeCollectionNames: [],
  };
}

// ─── TMDB Discover tab ──────────────────────────────────────────────────────
// UI ported from the old worker's renderDiscoverLists/filterSectionHtml:
// named chips, collapsible filter sections with counts, global AND/Mix/OR
// pill, inline search rows, dropdown-add for static dims, eye-icon preview
// with grid/list toggle + TMDB links + caching.

const TMDB_MODE_KINDS = ['genre', 'keyword', 'company', 'collection'];
const tmdbOpenSections = new Set();
let tmdbAdding = null; // { i, kind, side }
let tmdbSearchResultsHtml = null;

function tmdbModeSummary(l) {
  const values = TMDB_MODE_KINDS.map((k) => (l.includeModes[k] === 'or' ? 'or' : 'and'));
  if (values.every((v) => v === 'and')) return 'and';
  if (values.every((v) => v === 'or')) return 'or';
  return 'mixed';
}

function tmdbUrlFor(p) {
  const kind = p.type === 'series' ? 'tv' : 'movie';
  return 'https://www.themoviedb.org/' + kind + '/' + String(p.id).replace(/^tmdb:/, '');
}

function renderTmdb() {
  const host = document.getElementById('tabHost');
  const lists = state.tmdb.lists;
  const cards = lists.map((l, i) => {
    const dims = TMDB_DIMS.filter((d) => !(d.movieOnly && l.mediaType === 'series'))
      .map((dim) => tmdbDimSection(i, l, dim)).join('');
    const summary = tmdbModeSummary(l);
    const countLine = typeof l.count === 'number' ? l.count + (l.previewTruncated ? '+' : '') + ' results' : '';
    const pillHint = summary === 'mixed'
      ? "Genres, Keywords, Companies, and Part of Collection are not all set the same way - use each dimension's own AND/OR tag to adjust individually, or click AND/OR here to set all four at once."
      : summary === 'or'
        ? 'Each genre, keyword, company, release type, and collection is an independent source; results are unioned.'
        : "All include dimensions are AND'd into one TMDB query (often returns few or no results).";
    return '<div class="list-card' + (l.enabled ? '' : ' disabled') + '" id="tcard-' + i + '">' +
      '<div class="card-head">' +
        '<label class="toggle"><input type="checkbox" ' + (l.enabled ? 'checked' : '') + ' onchange="toggleTmdb(' + i + ')"><span class="toggle-slider"></span></label>' +
        nameEditBlock(i, l) +
        '<span class="id-chip">tmdb_discover_' + escapeAttr(l.mediaType) + '_' + escapeAttr(l.discoverListId) + '</span>' +
        '<div class="count-line">' + countLine + '</div>' +
      '</div>' +
      '<div class="card-body">' +
        '<select onchange="updateTmdb(' + i + ', \\\'mediaType\\\', this.value)" title="Media type">' +
          '<option value="movie"' + (l.mediaType === 'movie' ? ' selected' : '') + '>Movie</option>' +
          '<option value="series"' + (l.mediaType === 'series' ? ' selected' : '') + '>Series</option>' +
        '</select>' +
        '<select onchange="updateTmdb(' + i + ', \\\'sort\\\', this.value)" title="Sort order">' +
          TMDB_SORTS.map((s) => '<option value="' + s.value + '"' + (l.sort === s.value ? ' selected' : '') + '>' + s.label + '</option>').join('') +
        '</select>' +
        '<span class="body-actions">' +
          '<button class="btn-icon card-refresh" onclick="askSingleRefresh(' + i + ')" title="Refresh this list" aria-label="Refresh this list">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' +
          '</button>' +
          '<button class="danger" onclick="askDelete(' + i + ')">Delete</button>' +
        '</span>' +
      '</div>' +
      (l.sort === 'title_asc' && l.mediaType === 'series'
        ? '<div class="sort-fallback-note">Title (A-Z) is not supported by TMDB for series - showing Popularity instead.</div>'
        : '') +
      '<div class="include-mode-row">' +
        '<span class="members-label">Combine includes</span>' +
        '<div class="mode-toggle" data-mode="' + summary + '" role="group" aria-label="Combine include filters">' +
          '<div class="mode-toggle-thumb" aria-hidden="true"></div>' +
          '<button type="button" class="mode-toggle-btn' + (summary === 'and' ? ' active' : '') + '" onclick="setTmdbAllModes(' + i + ', \\\'and\\\')" title="Set every dimension to AND - a movie must match ALL of them at once">AND</button>' +
          '<button type="button" class="mode-toggle-btn mode-toggle-mixed" disabled title="Mix - dimensions are not all set the same way; see each dimension tag">Mix</button>' +
          '<button type="button" class="mode-toggle-btn' + (summary === 'or' ? ' active' : '') + '" onclick="setTmdbAllModes(' + i + ', \\\'or\\\')" title="Set every dimension to OR - a movie matching ANY of them appears in the catalog">OR</button>' +
        '</div>' +
        '<span class="include-mode-hint">' + pillHint + '</span>' +
      '</div>' +
      dims +
      (l.previewOpen ? tmdbPreviewHtml(i, l) : '') +
      '<div class="card-error" id="tcardError-' + i + '"></div>' +
    '</div>';
  }).join('');

  document.getElementById('headerTitle').textContent = 'TMDB List';
  const toolbar = '<div class="scraper-toolbar"><button class="secondary" onclick="openStatus()">Status</button></div>';
  const emptyHint = lists.length ? '' : '<div class="official-note">No TMDB discover lists yet - add your first below.</div>';
  const trigger = lists.length
    ? '<button class="btn-create-list" id="tmdbCreateBtn" onclick="showTmdbCreate()">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>' +
      'Add Discover List</button>'
    : '';
  const createOpen = lists.length ? ' style="display:none"' : ' style="display:flex"';
  const createRow =
    '<div class="create-slot">' + trigger +
      '<div class="create-form inline" id="tmdbCreateRow"' + createOpen + '>' +
        '<label class="field field-name"><span class="field-label">Name</span><input class="name-input" id="tmdbCreateNameInput" placeholder="Name - e.g. 80s Horror" spellcheck="false"></label>' +
        '<label class="field field-mtype"><span class="field-label">Media type</span><select id="tmdbCreateTypeSelect"><option value="movie">Movie</option><option value="series">Series</option></select></label>' +
        '<span class="body-actions"><button onclick="confirmCreateTmdb()">Add</button><button type="button" class="secondary" onclick="hideTmdbCreate()">Cancel</button></span>' +
      '</div>' +
    '</div>';

  host.innerHTML = toolbar + cards + emptyHint + createRow;
  applyDisabledState();

  if (tmdbAdding) {
    const inp = document.getElementById('tmdbInlineInput');
    if (inp) { inp.focus(); }
  }
}

function showTmdbCreate() {
  const btn = document.getElementById('tmdbCreateBtn');
  const row = document.getElementById('tmdbCreateRow');
  if (!btn || !row) return;
  btn.style.display = 'none';
  row.style.display = 'flex';
  document.getElementById('tmdbCreateNameInput').focus();
}
function hideTmdbCreate() {
  const btn = document.getElementById('tmdbCreateBtn');
  const row = document.getElementById('tmdbCreateRow');
  if (!btn || !row) return;
  btn.style.display = '';
  row.style.display = 'none';
}
async function confirmCreateTmdb() {
  const name = document.getElementById('tmdbCreateNameInput').value.trim();
  if (!name) { setStatus('List needs a name.', 'error'); return; }
  const mediaType = document.getElementById('tmdbCreateTypeSelect').value;
  // Same name is fine across media types - the catalog id embeds the type
  // (tmdb_discover_<mediaType>_<id>), so Stremio sees them as distinct.
  if (state.tmdb.lists.some((l) => l.name.toLowerCase() === name.toLowerCase() && l.mediaType === mediaType)) {
    setStatus('A ' + mediaType + ' list with that name already exists.', 'error');
    return;
  }
  // Server generates the same shape on save if blank; generate here so the
  // card shows a stable id immediately and re-saves keep it.
  let id;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name + ':' + Date.now()));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    id = '';
    for (let i = 0; i < 8; i++) id += chars[parseInt(hex[i], 16) % chars.length];
  } catch (e) {
    id = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  }
  const fresh = tmdbEmptyList(mediaType);
  fresh.discoverListId = id;
  fresh.name = name;
  state.tmdb.lists.push(fresh);
  hideTmdbCreate();
  renderTmdb();
  setStatus('List added. Expand a filter section below to start narrowing it down, then press Save to generate it.', 'ok');
}

function toggleTmdb(i) {
  const l = state.tmdb.lists[i];
  if (!l) return;
  l.enabled = !l.enabled;
  renderTmdb();
}

function updateTmdb(i, key, value) {
  const l = state.tmdb.lists[i];
  if (!l) return;
  l[key] = value;
  if (key === 'mediaType' || key === 'sort') {
    delete l.count;
    if (l.previewOpen) { loadTmdbPreview(i); return; }
  }
  renderTmdb();
}

function setTmdbAllModes(i, mode) {
  const l = state.tmdb.lists[i];
  if (!l) return;
  l.includeModes = { genre: mode, keyword: mode, company: mode, collection: mode };
  invalidateTmdbPreview(l);
  renderTmdb();
}

function setTmdbMode(i, kind, mode) {
  const l = state.tmdb.lists[i];
  if (!l) return;
  l.includeModes[kind] = mode;
  invalidateTmdbPreview(l);
  renderTmdb();
}

function toggleTmdbSection(i, kind) {
  const key = i + ':' + kind;
  if (tmdbOpenSections.has(key)) tmdbOpenSections.delete(key);
  else tmdbOpenSections.add(key);
  if (tmdbAdding && tmdbAdding.i === i && tmdbAdding.kind === kind) closeTmdbInlineSearch();
  else renderTmdb();
}

function addTmdbStatic(i, kind, field, valueStr) {
  if (!valueStr) return;
  const id = parseInt(valueStr, 10);
  const l = state.tmdb.lists[i];
  if (!l || l[TMDB_FIELD_KEYS[kind][field]].includes(id)) return;
  l[TMDB_FIELD_KEYS[kind][field]].push(id);
  invalidateTmdbPreview(l);
  renderTmdb();
}

function removeTmdbId(i, kind, field, id) {
  const l = state.tmdb.lists[i];
  if (!l) return;
  const key = TMDB_FIELD_KEYS[kind][field];
  const idx = l[key].indexOf(id);
  if (idx !== -1) l[key].splice(idx, 1);
  const namesKey = TMDB_NAME_KEYS[kind] && TMDB_NAME_KEYS[kind][field];
  if (namesKey && l[namesKey]) l[namesKey].splice(idx, 1);
  invalidateTmdbPreview(l);
  renderTmdb();
}

function openTmdbInlineSearch(i, kind, side) {
  tmdbAdding = { i, kind, side };
  tmdbSearchResultsHtml = null;
  renderTmdb();
  const input = document.getElementById('tmdbInlineInput');
  if (input) input.focus();
}
function closeTmdbInlineSearch() {
  tmdbAdding = null;
  tmdbSearchResultsHtml = null;
  renderTmdb();
}

async function runTmdbInlineSearch() {
  if (!tmdbAdding) return;
  const input = document.getElementById('tmdbInlineInput');
  if (!input) return;
  const q = input.value.trim();
  if (tmdbSearchTimer) clearTimeout(tmdbSearchTimer);
  if (q.length < 2) {
    tmdbSearchResultsHtml = null;
    rerenderKeepInput(q);
    return;
  }
  tmdbSearchTimer = setTimeout(async () => {
    try {
      const res = await fetch(ORIGIN + '/tmdb/search-' + tmdbAdding.kind + '?query=' + encodeURIComponent(q));
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const l = state.tmdb.lists[tmdbAdding.i];
      const idsKey = TMDB_FIELD_KEYS[tmdbAdding.kind][tmdbAdding.side];
      tmdbSearchResultsHtml = data.results.length === 0
        ? '<div class="empty-msg">No results found.</div>'
        : data.results.map((r) => {
            const already = l && l[idsKey].includes(r.id);
            return '<div class="result-item' + (already ? ' disabled' : '') + '"' +
              (already ? '' : ' onclick="pickTmdbResult(' + tmdbAdding.i + ',\\\'' + tmdbAdding.kind + '\\\',\\\'' + tmdbAdding.side + '\\\',' + r.id + ',\\\'' + escapeForOnclick(r.name) + '\\\')"') + '>' +
              (r.poster ? '<img class="result-thumb" src="' + escapeAttr(r.poster) + '">' : '<div class="result-thumb-placeholder">⬚</div>') +
              '<div><div class="result-title">' + escapeAttr(r.name) + '</div>' +
              '<div class="result-meta">' + (already ? 'Already added' : 'Click to add') + '</div></div></div>';
          }).join('');
    } catch (e) {
      tmdbSearchResultsHtml = '<div class="empty-msg">Search failed: ' + escapeAttr(e.message) + '</div>';
    }
    rerenderKeepInput(q);
  }, 400);
}

// Re-render then restore the inline input's text + caret - innerHTML swap
// would otherwise wipe what the user typed mid-search.
function rerenderKeepInput(text) {
  renderTmdb();
  const fresh = document.getElementById('tmdbInlineInput');
  if (fresh) { fresh.value = text; fresh.focus(); fresh.setSelectionRange(text.length, text.length); }
}

function pickTmdbResult(i, kind, side, id, name) {
  const l = state.tmdb.lists[i];
  if (!l) return;
  const idsKey = TMDB_FIELD_KEYS[kind][side];
  const namesKey = TMDB_NAME_KEYS[kind][side];
  if (l[idsKey].includes(id)) { setStatus('That is already added.', 'error'); return; }
  l[idsKey].push(id);
  l[namesKey].push(name);
  invalidateTmdbPreview(l);
  closeTmdbInlineSearch();
}

// Old worker's escapeForOnclick - escapeAttr alone mangles apostrophes when
// the string lands inside a JS string literal in an attribute.
function escapeForOnclick(str) {
  return escapeAttr(str).replace(/'/g, "\\'");
}

function tmdbDimSection(i, l, dim) {
  if (dim.movieOnly && l.mediaType === 'series') return '';
  const keys = TMDB_FIELD_KEYS[dim.kind];
  const nameKeys = TMDB_NAME_KEYS[dim.kind];
  const hasMode = dim.kind !== 'releaseType';
  const mode = l.includeModes[dim.kind] || 'and';
  const isOpen = tmdbOpenSections.has(i + ':' + dim.kind);
  const totalCount = [keys.include, keys.exclude].filter(Boolean)
    .reduce((n, f) => n + (l[f] || []).length, 0);

  const chipRow = (field, label, cls) => {
    const ids = l[keys[field]] || [];
    const names = nameKeys ? (l[nameKeys[field]] || []) : null;
    const chips = ids.map((id, idx) => {
      const shown = dim.isStatic ? tmdbStaticName(dim.kind, id, l.mediaType) : (names[idx] != null ? names[idx] : String(id));
      return '<span class="' + cls + '">' + escapeAttr(shown) +
        '<button type="button" class="chip-remove" onclick="removeTmdbId(' + i + ',\\\'' + dim.kind + '\\\',\\\'' + field + '\\\',' + id + ')" title="Remove" aria-label="Remove ' + escapeAttr(shown) + '">×</button></span>';
    }).join('');
    const addingHere = tmdbAdding && tmdbAdding.i === i && tmdbAdding.kind === dim.kind && tmdbAdding.side === field;
    let adder;
    if (dim.isStatic) {
      const opts = (dim.kind === 'releaseType' ? TMDB_RELEASE_TYPES : tmdbGenresFor(l.mediaType))
        .filter((o) => !ids.includes(o.id));
      adder = '<select class="exclude-genre-select-inline" onchange="addTmdbStatic(' + i + ',\\\'' + dim.kind + '\\\',\\\'' + field + '\\\',this.value);this.value=\\'\\'">' +
        '<option value="">+ ' + (field === 'include' ? 'Add' : 'Exclude') + '</option>' +
        opts.map((o) => '<option value="' + o.id + '">' + escapeAttr(o.name) + '</option>').join('') +
        '</select>';
    } else if (!addingHere) {
      adder = cls === 'member-chip'
        ? '<span class="member-chip member-chip-add" onclick="openTmdbInlineSearch(' + i + ',\\\'' + dim.kind + '\\\',\\\'' + field + '\\\')">+ Add</span>'
        : '<span class="exclude-chip-add" onclick="openTmdbInlineSearch(' + i + ',\\\'' + dim.kind + '\\\',\\\'' + field + '\\\')">+ Exclude</span>';
    } else {
      adder = '';
    }
    return '<div class="members-label" style="margin-top:8px;">' + label + (dim.hasExclude ? ' (any of these)' : '') + '</div>' +
      '<div class="members-chips">' + chips +
        (ids.length === 0 ? '<span class="members-empty">' + (cls === 'member-chip' ? 'None yet' : 'Nothing excluded') + '</span>' : '') +
        adder + '</div>' +
      (!dim.isStatic && addingHere ? tmdbInlineSearchHtml(i, dim, field) : '');
  };

  return '<div class="tmdb-dim">' +
    '<div class="exclude-label"><button type="button" class="exclude-label-toggle" onclick="toggleTmdbSection(' + i + ',\\\'' + dim.kind + '\\\')" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
      '<span class="filter-label">' + dim.label + (totalCount > 0 ? ' (' + totalCount + ')' : '') + '</span>' +
      '<svg class="exclude-chevron' + (isOpen ? ' open' : '') + '" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
    '</button>' +
      (hasMode ? '<span class="dim-mode-tag" role="button" tabindex="0" onclick="setTmdbMode(' + i + ',\\\'' + dim.kind + '\\\',\\\'' + (mode === 'or' ? 'and' : 'or') + '\\\')" onkeydown="if(event.key===\\\'Enter\\\'||event.key===\\\' \\\'){event.preventDefault();setTmdbMode(' + i + ',\\\'' + dim.kind + '\\\',\\\'' + (mode === 'or' ? 'and' : 'or') + '\\\')}" aria-label="Set ' + dim.label + ' combination to ' + (mode === 'or' ? 'AND' : 'OR') + '" title="' + (mode === 'or'
        ? 'OR - this selection becomes its own source, unioned with everything else (click to switch to AND)'
        : 'AND - this selection narrows every other source instead of being one of its own (click to switch to OR)') + '">' + (mode === 'or' ? 'OR' : 'AND') + '</span>' : '') +
    '</div>' +
    (isOpen
      ? chipRow('include', 'Include', 'member-chip') + (dim.hasExclude ? chipRow('exclude', 'Exclude', 'exclude-chip') : '')
      : '') +
  '</div>';
}

function tmdbInlineSearchHtml(i, dim, side) {
  const placeholder = { keyword: 'Search for a keyword…', company: 'Search for a company…', collection: 'Search for a collection…' }[dim.searchKind] || 'Search…';
  return '<div class="inline-add-search">' +
    '<div class="search-row">' +
      '<div class="search-input-wrap">' +
        '<input class="search-input" id="tmdbInlineInput" type="text" placeholder="' + placeholder + '" autocomplete="off" spellcheck="false"' +
          ' oninput="runTmdbInlineSearch()"' +
          ' onkeydown="if(event.key===&quot;Escape&quot;)closeTmdbInlineSearch();">' +
        '<span class="search-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg></span>' +
      '</div>' +
      '<button onclick="runTmdbInlineSearchNow()">Add</button>' +
      '<button class="secondary" onclick="closeTmdbInlineSearch()">Cancel</button>' +
    '</div>' +
    '<div class="search-results">' + (tmdbSearchResultsHtml || '') + '</div>' +
  '</div>';
}

function runTmdbInlineSearchNow() {
  if (tmdbSearchTimer) clearTimeout(tmdbSearchTimer);
  runTmdbInlineSearch();
}

function invalidateTmdbPreview(l) {
  delete l.previewItems;
  delete l.count;
  if (l.previewOpen) loadTmdbPreview(state.tmdb.lists.indexOf(l));
}

function toggleTmdbPreview(i) {
  const l = state.tmdb.lists[i];
  if (!l) return;
  l.previewOpen = !l.previewOpen;
  if (l.previewOpen && !l.previewItems) loadTmdbPreview(i);
  else renderTmdb();
}

function toggleTmdbPreviewView(i) {
  const l = state.tmdb.lists[i];
  if (!l) return;
  l.previewViewMode = (l.previewViewMode || 'grid') === 'grid' ? 'list' : 'grid';
  renderTmdb();
}

async function loadTmdbPreview(i) {
  const l = state.tmdb.lists[i];
  if (!l) return;
  l.previewLoading = true;
  l.previewError = null;
  renderTmdb();
  try {
    const res = await fetch(ORIGIN + '/tmdb/preview-discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...l }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    l.previewItems = data.items;
    l.previewTruncated = !!data.truncated;
    l.count = data.items.length;
  } catch (e) {
    l.previewError = 'Could not load results: ' + e.message;
  } finally {
    l.previewLoading = false;
    renderTmdb();
  }
}

function tmdbPreviewHtml(i, l) {
  const isGrid = (l.previewViewMode || 'grid') === 'grid';
  let body;
  if (l.previewLoading) body = '<div class="preview-msg">Loading…</div>';
  else if (l.previewError) body = '<div class="preview-msg error">' + escapeAttr(l.previewError) + '</div>';
  else if (!(l.previewItems || []).length) body = '<div class="preview-msg">No results found.</div>';
  else if (!isGrid) {
    body = '<div class="preview-list">' + l.previewItems.map((p, idx) =>
      '<div class="preview-list-item">' +
        '<span class="preview-list-num">' + (idx + 1) + '.</span>' +
        '<span class="preview-list-name">' + escapeAttr(p.name) + (p.year ? ' (' + p.year + ')' : '') + '</span>' +
        '<a class="icon-btn preview-list-link" href="' + tmdbUrlFor(p) + '" target="_blank" rel="noopener noreferrer" title="Open on TMDB">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>' +
      '</div>').join('') + '</div>';
  } else {
    body = '<div class="preview-scroll">' + l.previewItems.map((p) =>
      '<div class="preview-item">' +
        (p.poster ? '<img src="' + escapeAttr(p.poster) + '" alt="" loading="lazy">' : '<div class="preview-poster-placeholder"></div>') +
        '<a class="icon-btn preview-item-link" href="' + tmdbUrlFor(p) + '" target="_blank" rel="noopener noreferrer" title="Open on TMDB">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>' +
        '<div class="preview-item-title">' + escapeAttr(p.name) + '</div>' +
        '<div class="preview-item-year">' + escapeAttr(p.year || '') + '</div>' +
      '</div>').join('') + '</div>';
  }
  return '<div class="preview-row">' +
    '<div class="preview-toolbar">' +
      '<span class="icon-btn" onclick="toggleTmdbPreviewView(' + i + ')" title="' + (isGrid ? 'Switch to list view' : 'Switch to grid view') + '">' +
        (isGrid
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>') +
      '</span>' +
    '</div>' +
    (l.previewTruncated
      ? '<div class="sort-fallback-note">This filter combination matches a very large number of titles - showing the first ' + (l.previewItems || []).length + ' for preview. Your actual Stremio catalog will still show everything as you scroll.</div>'
      : '') +
    body +
  '</div>';
}

// ─── Save (hash-compare → dispatch changed lists only) ───
async function saveAll() {
  // Global save: one config blob, all three modules. Zero scraper lists
  // is legal (official/simkl-only addon) - the server persists an empty
  // scraper section as-is and skips scraper dispatch.
  if (state.scraper.lists.some(l => !l.url.trim())) {
    setStatus('Every list needs an mdblist URL.', 'error');
    return;
  }
  if (state.tmdb.lists.some(l => !l.discoverListId)) {
    setStatus('TMDB list is missing an id - delete and re-add it.', 'error');
    return;
  }
  const btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    // Drop blank tier fields so empty inputs persist as absent keys, not nulls.
    const simklClone = JSON.parse(JSON.stringify(state.simkl));
    for (const l of simklClone.lists) {
      l.filter.rating_tiers = l.filter.rating_tiers.map((t) => {
        const out = {};
        for (const k of ['min_rating', 'max_rating', 'min_votes', 'min_secondary_rating']) {
          if (t[k] != null && Number.isFinite(Number(t[k]))) out[k] = Number(t[k]);
        }
        return out;
      });
    }
    // Strip UI-only preview state (cached results, flags, counters) from
    // TMDB lists before posting - the server drops unknown fields anyway,
    // so this only saves uploading hundreds of dead objects per Save.
    const slimTmdb = {
      ...state.tmdb,
      lists: state.tmdb.lists.map(({ previewOpen, previewItems, previewTruncated, previewError, previewLoading, previewViewMode, count, ...rest }) => rest),
    };
    const res = await fetch(ORIGIN + '/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...state, tmdb: slimTmdb, simkl: simklClone }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const moduleChanges = activeModule === 'official' && data.officialChanged && data.officialChanged.length
      ? 'Official toggles saved: ' + data.officialChanged.join(', ') + '. '
      : activeModule === 'simkl' && data.simklChanged && data.simklChanged.length
        ? 'Simkl filters saved: ' + data.simklChanged.join(', ') + '. '
        : '';
    const tmdbNames = []
      .concat(data.tmdbChanged || [], (data.tmdbRemoved || []).map(n => n + ' (deleted)'));
    setStatus(moduleChanges +
      (data.dispatch && data.dispatch.length
        ? 'Saved. Regenerating: ' + data.dispatch.map(d => d.name).join(', ')
        : tmdbNames.length
          ? 'Saved. Regenerating TMDB: ' + tmdbNames.join(', ')
          : (data.simklChanged && data.simklChanged.length)
            ? 'Saved. Regenerating simkl: ' + data.simklChanged.join(', ')
            : (data.officialChanged && data.officialChanged.length)
              ? 'Saved. Regenerating official: ' + data.officialChanged.join(', ')
              : 'Saved (no content change - nothing regenerated).'), 'ok');
  } catch (e) {
    setStatus('Save failed: ' + humanizeError(e.message), 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

// R1: native <dialog>. showModal() supplies Escape-close, focus trap and
// focus-return to the invoker natively - the QW4/QW5 stopgaps are deleted.
function openRefreshConfirm() {
  const m = activeModule;
  const enabledCount = (m === 'official' ? state.official.lists : m === 'simkl' ? state.simkl.lists : m === 'tmdb' ? state.tmdb.lists : state.scraper.lists)
    .filter((l) => l.enabled).length;
  document.getElementById('refreshAllTitle').textContent = 'Refresh all lists?';
  const timing = m === 'simkl' ? 'a few seconds each'
    : m === 'official' ? 'about a minute each'
    : '1-3 minutes each';
  document.getElementById('refreshAllBody').textContent = 'Queues GitHub Actions rebuilds for ' + enabledCount + ' enabled ' + (m === 'scraper' ? '' : m + ' ') + 'lists. Typically takes ' + timing + '; progress shows on the Status page.';
  document.getElementById('refreshConfirmDlg').showModal();
}
function closeRefreshConfirm() { document.getElementById('refreshConfirmDlg').close(); }
async function confirmRefresh() {
  closeRefreshConfirm();
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning'); btn.disabled = true;
  try {
    // Page-scoped: scraper tab refreshes scraper lists only, official tab
    // refreshes official lists only.
    const res = await fetch(ORIGIN + '/trigger-refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: activeModule }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const msg = activeModule === 'official'
      ? 'Refresh dispatched - GitHub Actions is regenerating all enabled official lists (movies + shows).'
      : activeModule === 'simkl'
        ? 'Refresh dispatched - GitHub Actions is regenerating all enabled SIMKL lists.'
        : 'Refresh dispatched - GitHub Actions is regenerating all enabled lists.';
    setStatus(msg, 'ok');
  } catch (e) {
    setStatus('Refresh failed: ' + humanizeError(e.message), 'error');
  } finally {
    btn.classList.remove('spinning'); btn.disabled = false;
  }
}

function openStatus() {
  const p = activeModule === 'official' ? 'official' : activeModule === 'simkl' ? 'simkl' : activeModule === 'tmdb' ? 'tmdb' : 'scraper';
  window.open(ORIGIN + '/status?page=' + p, '_blank');
}

document.getElementById('saveBtn').onclick = saveAll;
document.getElementById('menuBtn').onclick = toggleMenu;
document.getElementById('accentBtn').onclick = toggleAccentPopup;
document.getElementById('confirmRefreshBtn').onclick = confirmRefresh;
document.getElementById('confirmDeleteBtn').onclick = confirmDelete;
document.getElementById('confirmRefreshOneBtn').onclick = () => {
  const i = pendingRefreshIndex;
  closeRefreshOneConfirm();
  performSingleRefresh(i);
};

// R1: clicking the dim backdrop outside any confirm dialog closes it
// (per your call - including Delete; Escape and Cancel do the same).
function backdropCancels(dlg, closeFn) {
  dlg.addEventListener('click', (e) => {
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeFn();
  });
}
backdropCancels(document.getElementById('refreshConfirmDlg'), closeRefreshConfirm);
backdropCancels(document.getElementById('refreshOneDlg'), closeRefreshOneConfirm);
backdropCancels(document.getElementById('deleteConfirmDlg'), closeDeleteConfirm);

initSwatches();
let savedModule = 'scraper';
try { savedModule = localStorage.getItem(MODULE_KEY) || 'scraper'; } catch (e) {}
if (savedModule !== 'scraper') activateModule(savedModule); else renderScraper();
</script>
</body>
</html>`;
}
