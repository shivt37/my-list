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

export function normalizeSchedules(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const m of SCHEDULE_MODULES) {
    const e = src[m];
    if (!e || typeof e !== "object") {
      out[m] = { enabled: true, times: [...DEFAULT_TIMES[m]] };
      continue;
    }
    const times = [];
    if (Array.isArray(e.times)) {
      const seen = new Set();
      for (const t of e.times) {
        if (typeof t !== "string") continue;
        const v = t.trim();
        if (TIME_RE.test(v) && !seen.has(v)) {
          seen.add(v);
          times.push(v);
        }
      }
      times.sort();
    } else {
      times.push(...DEFAULT_TIMES[m]);
    }
    out[m] = { enabled: e.enabled !== false, times: times.slice(0, MAX_SLOTS) };
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
  const day = utcDayStart(nowMs);
  for (let dOff = 0; dOff < 2 && !best; dOff++) {
    const base = day + dOff * DAY_MS;
    for (const m of SCHEDULE_MODULES) {
      const s = schedules[m];
      if (!s || !s.enabled) continue;
      for (const t of s.times) {
        const at = slotMs(t, base);
        if (at <= nowMs) continue;
        if (!best || at < best.atMs) best = { module: m, time: t, atMs: at };
      }
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
  const byModule = new Map();
  const day = utcDayStart(nowMs);
  for (let dOff = 1; dOff >= 0; dOff--) {
    const base = day - dOff * DAY_MS;
    for (const m of SCHEDULE_MODULES) {
      const s = schedules[m];
      if (!s || !s.enabled || byModule.has(m)) continue;
      for (const t of s.times) {
        const at = slotMs(t, base);
        if (at > nowMs) continue;
        if (nowMs - at > CATCH_UP_MAX_MS) continue;
        if ((lastFire[m] || 0) >= at) continue;
        const prev = byModule.get(m);
        if (!prev || at < prev.atMs) byModule.set(m, { module: m, time: t, atMs: at });
      }
    }
  }
  return [...byModule.values()];
}
