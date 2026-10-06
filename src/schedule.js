// Pure timetable logic for the Clock DO (src/clock.js). No I/O, no
// Cloudflare imports - fully unit-testable under node. All times are UTC
// "HH:MM" strings; IST display lives in the UI layer (IST has no DST, so
// the mapping never shifts).

export const SCHEDULE_MODULES = ["scrape", "official", "simkl", "tmdb"];

// Defaults mirror the pre-DO behavior: everything twice daily except tmdb
// (owner decision, F14).
const DEFAULT_TIMES = {
  scrape: ["00:00", "12:00"],
  official: ["00:00", "12:00"],
  simkl: ["00:00", "12:00"],
  tmdb: ["00:00"],
};

const TIME_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const MAX_SLOTS = 4;
const MAX_RULES = 4;

function cleanTimes(arr) {
  const seen = new Set();
  const out = [];
  if (Array.isArray(arr)) {
    for (const t of arr) {
      if (typeof t !== "string") continue;
      const v = t.trim();
      if (TIME_RE.test(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    out.sort();
  }
  return out.slice(0, MAX_SLOTS);
}

// Rule kinds: daily {times}, interval {everyHours, anchor}, everyNDays
// {everyDays, at, ref}. Legacy {enabled, times} (no rules key) normalizes
// to a single daily rule - old configs keep working untouched.
function normalizeRule(r, todayRef) {
  if (!r || typeof r !== "object") return null;
  if (r.kind === "interval") {
    const everyHours = Math.floor(Number(r.everyHours));
    const anchor = typeof r.anchor === "string" && TIME_RE.test(r.anchor.trim()) ? r.anchor.trim() : "00:00";
    if (!Number.isFinite(everyHours) || everyHours < 1 || everyHours > 24) return null;
    return { kind: "interval", everyHours, anchor };
  }
  if (r.kind === "everyNDays") {
    const everyDays = Math.floor(Number(r.everyDays));
    const at = typeof r.at === "string" && TIME_RE.test(r.at.trim()) ? r.at.trim() : "00:00";
    let ref = typeof r.ref === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.ref.trim()) ? r.ref.trim() : todayRef;
    const [Y, M, D] = ref.split("-").map(Number);
    const chk = new Date(Date.UTC(Y, M - 1, D));
    if (chk.getUTCFullYear() !== Y || chk.getUTCMonth() !== M - 1 || chk.getUTCDate() !== D) ref = todayRef;
    if (!Number.isFinite(everyDays) || everyDays < 1 || everyDays > 30) return null;
    return { kind: "everyNDays", everyDays, at, ref };
  }
  // Default kind: daily.
  const times = cleanTimes(r.times);
  if (times.length === 0) return null;
  return { kind: "daily", times };
}

export function normalizeSchedules(raw, nowMs = Date.now()) {
  const src = raw && typeof raw === "object" ? raw : {};
  const d = new Date(nowMs);
  const todayRef = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const out = {};
  for (const m of SCHEDULE_MODULES) {
    const e = src[m];
    if (!e || typeof e !== "object") {
      out[m] = { enabled: true, times: [...DEFAULT_TIMES[m]], rules: [{ kind: "daily", times: [...DEFAULT_TIMES[m]] }] };
      continue;
    }
    const times = Array.isArray(e.times) ? cleanTimes(e.times) : [...DEFAULT_TIMES[m]];
    let rules = [];
    if (Array.isArray(e.rules)) {
      for (const r of e.rules) {
        const n = normalizeRule(r, todayRef);
        if (n) rules.push(n);
      }
      rules = rules.slice(0, MAX_RULES);
    } else {
      if (times.length > 0) rules = [{ kind: "daily", times }];
    }
    out[m] = { enabled: e.enabled !== false, times, rules };
  }
  return out;
}

const DAY_MS = 86400000;

function utcDayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function slotMs(hhmm, dayStartMs) {
  const [h, mi] = hhmm.split(":").map(Number);
  return dayStartMs + (h * 60 + mi) * 60000;
}

// Earliest slot strictly after nowMs (today, else tomorrow). Null when
// nothing is enabled/scheduled - the clock then clears its alarm and idles.
export function nextSlotAfter(schedules, nowMs) {
  let best = null;
  for (const m of SCHEDULE_MODULES) {
    const s = schedules[m];
    if (!s || !s.enabled) continue;
    for (const r of s.rules || []) {
      const at = nextRuleOccurrence(r, nowMs);
      if (at == null) continue;
      if (!best || at < best.atMs) best = { module: m, time: hhmm(at), rule: r.kind, atMs: at };
    }
  }
  return best;
}

// Slots due at nowMs: scheduled time passed, not yet fired (lastFire maps
// module -> fired slot time), within the catch-up bound. One entry per
// module (earliest due slot wins) - a long outage refires each module once,
// never a stampede of backlog slots.
export const CATCH_UP_MAX_MS = DAY_MS;

export function dueModulesAt(schedules, nowMs, lastFire = {}) {
  const fromMs = nowMs - CATCH_UP_MAX_MS;
  const byModule = new Map();
  for (const m of SCHEDULE_MODULES) {
    const s = schedules[m];
    if (!s || !s.enabled) continue;
    for (const r of s.rules || []) {
      for (const at of ruleOccurrences(r, fromMs, nowMs)) {
        if ((lastFire[m] || 0) >= at) continue;
        const prev = byModule.get(m);
        if (!prev || at < prev.atMs) byModule.set(m, { module: m, time: hhmm(at), rule: r.kind, atMs: at });
      }
    }
  }
  return [...byModule.values()];
}

// Next `count` fires across the timetable - powers the "then …" part of
// the next-fire line so the operator sees WHY a slot fires next (e.g. a
// leftover afternoon slot still beats a newly added morning one).
export function upcomingFires(schedules, nowMs, count = 3) {
  const all = [];
  const horizon = nowMs + 8 * DAY_MS;
  for (const m of SCHEDULE_MODULES) {
    const s = schedules[m];
    if (!s || !s.enabled) continue;
    for (const r of s.rules || []) {
      for (const at of ruleOccurrences(r, nowMs + 1, horizon)) {
        all.push({ module: m, time: hhmm(at), rule: r.kind, atMs: at });
      }
    }
  }
  all.sort((a, b) => a.atMs - b.atMs);
  return all.slice(0, count);
}
// Interval grids anchor to a FIXED epoch (1970-01-01 + anchor time), never
// to "today": re-anchoring per call shifts the grid at midnight, so a
// due-check and a next-check on opposite sides of midnight disagree and
// the same interval fires twice. Fixed-epoch grids are stable forever.
function intervalBase(rule) {
  const [h, mi] = rule.anchor.split(":").map(Number);
  return (h * 60 + mi) * 60000;
}
// ── per-rule occurrence math ─────────────────────────────────────────
// Next occurrence of one rule strictly after nowMs.
function nextRuleOccurrence(rule, nowMs) {
  if (!rule) return null;
  if (rule.kind === "interval") {
    const step = rule.everyHours * 3600000;
    const base = intervalBase(rule);
    const k = nowMs < base ? 0 : Math.floor((nowMs - base) / step) + 1;
    return base + k * step;
  }
  if (rule.kind === "everyNDays") {
    const base = ndayBase(rule);
    if (base == null) return null;
    const step = rule.everyDays * DAY_MS;
    const k = nowMs < base ? 0 : Math.floor((nowMs - base) / step) + 1;
    return base + k * step;
  }
  // daily
  const day = utcDayStart(nowMs);
  for (let dOff = 0; dOff < 2; dOff++) {
    const base = day + dOff * DAY_MS;
    for (const t of rule.times) {
      const at = slotMs(t, base);
      if (at > nowMs) return at;
    }
  }
  return null; // unreachable - rules always carry non-empty times
}

// All occurrences of one rule within [fromMs, toMs].
function ruleOccurrences(rule, fromMs, toMs) {
  const out = [];
  if (!rule) return out;
  if (rule.kind === "interval") {
    const step = rule.everyHours * 3600000;
    const base = intervalBase(rule);
    for (let at = base + Math.ceil((fromMs - base) / step) * step; at <= toMs; at += step) out.push(at);
    return out;
  }
  if (rule.kind === "everyNDays") {
    const base = ndayBase(rule);
    if (base == null) return out;
    const step = rule.everyDays * DAY_MS;
    for (let at = base + Math.ceil((fromMs - base) / step) * step; at <= toMs; at += step) out.push(at);
    return out;
  }
  for (let base = utcDayStart(fromMs); base <= toMs; base += DAY_MS) {
    for (const t of rule.times) {
      const at = slotMs(t, base);
      if (at >= fromMs && at <= toMs) out.push(at);
    }
  }
  return out;
}

function ndayBase(rule) {
  const [Y, M, D] = rule.ref.split("-").map(Number);
  const [h, mi] = rule.at.split(":").map(Number);
  const base = Date.UTC(Y, M - 1, D, h, mi);
  return Number.isFinite(base) ? base : null;
}

function hhmm(ms) {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}
