# /configure UI Audit & Redesign Recommendations

**Target:** `src/configure.js` → `http://127.0.0.1:8787/configure` (MDBList Scraper — Stremio/Nuvio catalog backend control panel)
**Method:** Impeccable dual-track (deterministic detector + browser evidence) · Playwright instrumentation at 6 widths · Exa/Firecrawl pattern research · 4 parallel element-group brainstorms → conflict-resolved mobile synthesis
**User constraints (binding):** single expert owner-user · WCAG 2.1 AA · dark base `#050508` pinned · **Inter pinned** (detector's overused-font flag recorded as user-accepted exception)

**Full reasoning archives:** `.audit/sections/a-structural.md`, `b-visual.md`, `c-interaction.md`, `d-states-a11y.md`, `e-mobile-synthesis.md` (~144 KB, every element's ~15 options preserved with elimination scores). Raw data: `.audit/*.json`. Screenshots: `.audit/shots/`.

---

## Phase 1 — Ground Truth (measured, not guessed)

### Detector findings (`detect.mjs --json src/configure.js`)
| Rule | Line | Verdict |
|---|---|---|
| `side-tab` — accent left-border on notes | 387 (`.sort-fallback-note`) | **Actionable anti-pattern** → redesigned as icon-prefixed inline note (§B Color) |
| `overused-font` — Inter | 24 | **User-pinned exception**, no change |

### Token system as computed
`--bg #050508` · surfaces `#0c0c13/#13131d/#1a1a26` · borders `#1b1b26/#262635` · text tiers `#e8edf4 / #a5aebc / #6b7385` · accent `#06b6d4` (+3 alpha variants) · danger `#ff5f66` set · ok `#34d399` · radii tokens 9/14px.

**Token violations (hard numbers):**
- Card background is hardcoded neutral **`#161616`** — off the blue-tinted surface ladder; breaks elevation logic.
- **Radius chaos:** live values 4/5/6/7/8/9/10/12/14/16/20/999px against two tokens.
- **Font-size chaos:** 13 sizes in use (8.5–16px incl. half-pixels); zero `<h1>` in DOM; header title is a div; 8.5px and 9px text on mobile.
- Spacing ad-hoc (6/8/9/10/12/14/18px), no base grid.

### WCAG contrast (AA = 4.5:1 normal)
| Pair | Ratio | Status |
|---|---|---|
| text on bg | ≈17.4:1 | ✓ |
| dim on bg / card | 9.6 / 8.7 | ✓ |
| **muted on surface2** | **4.1:1** | ✗ fail (id-chip, hints, tier-heads, placeholders) |
| **muted on card #161616** | **4.35:1** | ✗ marginal fail |
| danger on bg | 5.9:1 | ✓ |
| Save label on accent | 8.2:1 | ✓ |

### Interaction facts (Playwright-tested)
- `:focus-visible` 2px accent ring exists ✓ (on real buttons/inputs only).
- **Escape does not close modals** (tested false). **Backdrop click does not close** (false). Focus stays on `<body>` at open; Tab walks out of the open modal back into page content (no trap). No `role=dialog`, no `aria-modal`.
- Navigation = hamburger popup of `div[onclick]` items — **not keyboard focusable at all**; no nav landmark, no tablist semantics.
- 12 accent swatches = unlabeled, unreachable divs. Pencil/eye/chevron/mode-tags/chip-× = clickable spans without button semantics or names.
- Touch targets @375: rename/eye spans **20×20**, mode-pill segments **30×15**, chip-remove **16×16**, card-refresh 31×27 — far below WCAG 2.5.8's 24px floor and iOS/Android norms.
- No horizontal overflow at any width down to 320 ✓.
- Transitions: consistent 100–150ms micro-eases everywhere; modals/popups appear **instantly** (display toggle); one keyframe (preview entrance 180ms); refresh spin while dispatching.
- Save has no dirty tracking (always enabled); failure copy leaks infra jargon verbatim: *"Save rejected - GitHub tmdb dispatch failed: GH_TOKEN/GH_REPO/GH_WORKFLOW not configured"* (reproduced in dev — see `save-attempt-1440.png`).

### Annotated before-shots (numbered callouts)
| File | Callout legend |
|---|---|
| `.audit/shots/anno-scraper-1440.png` / `-768` / `-375` | ① header ② Save ③ global refresh ④ accent picker ⑤ module menu ⑥ Status toolbar row ⑦ Add List ⑧ enable toggle ⑨ list name ⑩ id-chip ⑪ URL input ⑫ type select ⑬ pages input ⑭ per-card actions |
| `.audit/shots/anno-tmdb-1440.png` / `-768` / `-375` | ① header ② Save ③ AND/Mix/OR pill ④ pill hint paragraph ⑤ dimension section ⑥ per-dim AND/OR tag ⑦ media/sort selects |

---

## Phase 2 — Research Base (what the picks cite)

| Source | Used for |
|---|---|
| W3C ARIA APG Dialog Pattern (+ native `<dialog>`) | modal contract: role/aria-modal, focus-in, trap, Escape, focus-return — current page violates all five |
| NN/g *Confirmation Dialogs* | specificity, verb buttons, never default the destructive choice, don't cry wolf |
| Carbon deletion tiers | trivial→undo · moderate→confirm · high-impact→type-the-name |
| PatternFly danger-button guidance | danger styling reserved for serious consequence; warning icon beside headline |
| Siemens Element dialog rules | Cancel-left/primary-right; verbs mirror title |
| UX Bit destructive-placement study (2025) | placement as behavioral brake (−17% accidental deletes case) |
| Eleken picker survey + uxpatterns.dev | curated swatch-only is correct for product UI; radiogroup semantics, ≥32px swatches, reset affordance |
| designpixil settings IA / Primer / Win32 tabs guidance | tabs fit 4–8 peer sections; segmented fits short peer views; sidebar needs 8+; tabs must look like tabs |
| Atlassian Elevation + Muzli/ColorUI/Tekton dark-mode systems | higher elevation = lighter surface in dark mode; 4-level ladder; semantic `--{role}-{state}` tokens; halation/chroma rules |
| AIOStreams configurator (Firecrawl scrape + DeepWiki) | direct comparable: per-item rows = switch+pencil+trash; explicit Save step; hamburger/arrows nav; v2 "beautiful config" redesign precedent |

---

## Phase 3 — Element verdicts (full 15-option tables in section files)

### Structural (`a-structural.md`)
| Element | Winner | Why this one |
|---|---|---|
| Header bar | **A11 glass-panel header**: brand left, true `<h1>` center, Save + `•••` overflow right | Fixes zero-h1 semantics, gives the product a name anchor, caps sticky-bar width budget; overflow menu absorbs refresh/accent so mobile keeps one row |
| Layout/grid | **A23 fluid max-width clamp(1120–1400px) + 2-col card grid ≥1024; Status inline at content top** | Real density is ~700px wide; 1400 wastes it. Two-col earns space back without cramming controls; kills the orphaned toolbar row |
| Nav between modules | **A32 WAI-ARIA tablist directly below header** (arrow-key roving tabindex), ≤380 compact segmented control | 4 peer sections is textbook tabs territory; fixes the unreachable-div hamburger completely; localStorage persistence kept |
| Per-list card | **A45 labeled-form two-zone card** (flex-gap, margin hacks deleted) + embedded create slot; eye-preview button rendered only on TMDB tab | Kills both alignment hacks, labels every field (a11y + scanability), removes the state-corrupting eye bug by construction |

### Visual system (`b-visual.md`)
| Element | Winner | Why this one |
|---|---|---|
| Typography | **T15 integer ladder 10/11/13/15/20** + mono 11, tabular numerals, rem-based, semantic role classes; header becomes real h1 | 13 sizes → 5 stops; ends half-pixel drift while keeping expert density; Inter weights stay 400/500/600 |
| Color system | **C9+C10+C11+C12+C15 composite**: role-named 4-level blue-tinted ladder, card gets `--surface-card #0f1119`, tertiary text corrected to AA-passing `#8b94a6`, full danger/ok families, **accent banned from borders**, side-tab note replaced by icon-prefixed inline callout | One ruling fixes elevation logic + every contrast fail + the detector's `side-tab` flag simultaneously |
| Spacing | **S15 4px grid, 6 tokens (4/8/12/16/24/32), gap-over-margin**, card becomes CSS grid | Deletes the 60px/40px hacks at the root instead of patching them |
| Iconography | **I15 inline Lucide at 14/16/18 optical sizes, stroke 1.75, 44px hit-area decoupling; icon+label mandatory for destructive actions; grid/list pictographs demoted to text segments** | Keeps the existing visual language, fixes touch math, removes icon-only ambiguity exactly where mistakes are expensive |

### Interaction (`c-interaction.md`)
| Element | Winner | Why this one |
|---|---|---|
| Accent picker | **P15 palette popover ≥768 / bottom sheet <768**; 4×3 named radiogroup, 32/44px swatches, hover/focus live-preview + commit-on-click, Reset row, aria-live announce | Matches Linear/Notion-proven curated-palette model; makes 12 dead divs fully accessible; live preview already works — now it's discoverable |
| Save + feedback | **S15 dirty-gated header Save** (disabled until dirty, amber dot) + toast success / sticky error chip w/ retry + tab-switch & `beforeunload` guards + Ctrl+S | Ends always-on Save ambiguity and silent-loss navigation; error chip fixes scroll-invisible failures |
| Modals ×3 | **M15 native-`<dialog>` tiering**: refresh-all keeps accent primary + duration-expectation copy; **refresh-single modal deleted** (immediate dispatch + card spinner); delete = danger modal naming the object + client-side Undo toast; bottom sheets <768 | NN/g: don't confirm what's cheap to redo — single-list refresh is reversible-ish and frequent; Delete is the one true destructive act and gets the full danger treatment; `<dialog>` gives Escape/inert/trap for free |
| Motion | **X15 token ladder 100/170/240ms `cubic-bezier(.2,.8,.2,1)`**, enter-only overlay transitions, View Transitions tab crossfade, FLIP add/remove cards, save checkmark draw, full `prefers-reduced-motion` kill-switch | Extends the existing micro-ease consistency to the currently-instant popups without adding jank on low-power clients |

### States + accessibility (`d-states-a11y.md`)
| Element | Winner | Why this one |
|---|---|---|
| Empty/loading/error | **S13 Layered State Contract**: field-level validation, region-owned skeletons/spinners, single global toast (polite success / alert errors) with humanized ERROR_MAP + Details disclosures; empty states become icon+headline+body+action | One contract covers every async surface incl. TMDB preview; kills jargon leaks at the mapping layer |
| Accessibility layer | **B2 Native-first conversion**: real buttons/nav/dialog/radio-swatches instead of ARIA-painted divs + token contrast fix (`--muted→#8a93a8`); full 28-row remediation matrix included | Native HTML delivers keyboard/SR/touch correctness with less code than aria-spelunking; matrix sequences the work |
| TMDB dimension editor | **Self-describing disclosure rows**: sibling-button headers with collapsed chip summaries, dual-coded include/exclude chips (tint + − glyph + subheads), separated AND/OR mode button | Fixes color-alone coding, tiny type, and mystery-meat collapsed state in one structural move |
| Preview system | **D4 Ranked filmstrip**: snap-scroll posters with rank badges, labeled Posters/List segmented control, skeleton loading, actionable empty state | Grid/list toggle survives because order verification is a real task; rank badges answer "is my sort working?" at a glance |

---

## Phase 4 — Mobile Shrink Strategy (`e-mobile-synthesis.md`)

One coherent 375px system: glass header (brand + h1 + Save) → compact segmented nav → content column with labeled two-zone cards → bottom sheets for modals/picker → top toasts under header.

**Top conflicts resolved (of 18):**
1. **Nav**: states-agent favored keeping the hamburger; structural agent chose the tablist → **tablist wins at all widths**; its semantics migrate into the header `•••`.
2. **Toast position**: interaction agent wanted bottom-above-safe-area; states agent top-under-header → **top wins <1024** (bottom zone belongs to sheets + keyboard + safe area).
3. **Touch law vs density**: blanket 44px collides with chips and C-section's 40px Save → **44px standalone everywhere** (Save grows to 56×44); one documented WCAG 2.5.8 inline exception at 24px for chip-remove `×`.

Full output includes an 11-region × 6-breakpoint behavior matrix, complete touch-target compliance pass, and motion survival rules per `prefers-reduced-motion`.

---

## Punch List

### Quick wins (low effort — do first)
1. Replace `.list-card` background `#161616` → `--surface-card` token (`#0f1119`). *(1 line)*
2. Kill `side-tab`: restyle `.sort-fallback-note` as plain tinted text, drop `border-left: 3px solid var(--accent)`. *(1 line + detector re-run goes clean)*
3. Bump `--muted` usages that fail AA → `--muted` value `#8a93a8`. *(token change, ~4.9:1 everywhere)*
4. Add Escape-to-close + backdrop-click-close + `role="dialog"`/`aria-modal="true"` to the three backdrops (pre-`<dialog>` stopgap). *(~15 lines JS + 2 attrs each)*
5. Move focus into modal on open; return it on close. *(~6 lines)*
6. Convert menu-items, swatches, pencil/eye/mode-tag/chip-remove spans → real `<button>`s (or `role=radiogroup` for swatches) with aria-labels. *(mechanical)*
7. Add `<h1>` (visually styled as current title). *(1 line + CSS)*
8. Raise touch targets: mode-pill height 23→32px min, chip-remove ×→24px hit area via padding, icon-btn 22→28px visual/44 hit via pseudo-element. *(CSS only)*
9. Humanize save-error copy via ERROR_MAP (never print `GH_TOKEN/GH_REPO/GH_WORKFLOW` raw). *(map + one branch)*
10. Radius consolidation: map 6/7px→`--r-sm 8px`… collapse 12 values to 3 tokens. *(CSS find-replace)*
11. Font-size consolidation first pass: 8.5/9/9.5/10/10.5 → 10 or 11 floor. *(CSS)*
12. Eye-preview button: render only when `activeModule==='tmdb'` (removes state-corruption bug). *(one conditional)*
13. Add `aria-live="polite"` region wired to existing `setStatus()`. *(2 lines)*

### Larger reworks (plan separately)
R1. **Native `<dialog>` conversion** of all three confirms + M15 tiering (delete Undo toast, refresh-single immediate dispatch). *Effort: M*
R2. **A32 tablist nav** replacing hamburger popup (arrow-key roving tabindex, ≤380 segmented variant). *M*
R3. **A45 card rebuild** as labeled-form two-zone grid (deletes both alignment hacks) + embedded create slot. *M*
R4. **Token spine adoption** (semantic `--{role}-{state}` names, T15 type ladder, S15 spacing grid) across the whole stylesheet. *M-L*
R5. **P15 accent picker** rebuild (named radiogroup, bottom sheet <768, Reset, aria-live). *M*
R6. **S15 save pipeline**: dirty tracking, amber dot, beforeunload/tab guards, toast success/error chip, drafts. *M-L*
R7. **S13 state contract**: skeleton/spinner regions, empty-state anatomy, ERROR_MAP layer. *L*
R8. **X15 motion pass**: overlay enter transitions, FLIP add/remove, View Transitions crossfade, reduced-motion kill-switch. *M*
R9. **Header A11** (brand/h1-center/actions regroup) + layout A23 clamp + 2-col grid ≥1024. *M*
R10. **Dimension editor + preview D4** overhaul (disclosure rows, dual-coded chips, ranked filmstrip). *L*

*Suggested sequencing: all Quick wins → R1/R2/R3 (biggest UX-per-effort) → R4/R6 → R5/R8/R9 → R7/R10.*

---

## Supplementary artifact
Element tracker spreadsheet: `ui-audit-tracker.xlsx` (element → winner → effort → priority → phase source file).
