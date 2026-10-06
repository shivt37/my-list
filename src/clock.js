// Clock: singleton Durable Object alarm clock. Holds no timetable itself -
// it reads config.schedules from KV on every (re)arm, finds the next due
// slot, and sets its ONE alarm for exactly that minute. The alarm fires the
// due modules through the same workflow_dispatch path manual triggers use,
// then chains to the next alarm. A sparse hourly Cron Trigger calls /ensure
// as a watchdog (a stuck alarm chain = a stopped clock).
//
// Classic constructor style (no `extends DurableObject`) on purpose: zero
// worker-only imports, so this file loads under plain node for tests.
//
// Hard discipline: NOTHING here throws outward. The platform retries a
// throwing alarm() up to 6x with backoff - a throw would turn one failure
// into a storm. Every fault is caught, logged, and (for dispatches)
// recorded as a failed /status row.

import { loadConfig, addRuns, runsKeyFor, OFFICIAL_RUNS_KEY, SIMKL_RUNS_KEY, TMDB_RUNS_KEY } from "./config.js";
import { dispatchScraperWorkflow } from "./dispatch.js";
import { OFFICIAL_WORKFLOW, SIMKL_WORKFLOW, TMDB_WORKFLOW } from "./routes.js";
import { normalizeSchedules, nextSlotAfter, dueModulesAt } from "./schedule.js";

const MODULE_DEFS = {
  tmdb: { workflowEnv: "GH_TMDB_WORKFLOW", workflow: TMDB_WORKFLOW, runsKey: TMDB_RUNS_KEY, hasEnabled: (cfg) => cfg.tmdb.lists.some((l) => l.enabled) },
  scrape: { workflowEnv: "GH_WORKFLOW", workflow: "scrape.yml", runsKey: runsKeyFor("mdb_scrape_cron"), hasEnabled: (cfg) => cfg.scraper.lists.some((l) => l.enabled) },
  official: { workflowEnv: "GH_OFFICIAL_WORKFLOW", workflow: OFFICIAL_WORKFLOW, runsKey: OFFICIAL_RUNS_KEY, hasEnabled: (cfg) => cfg.official.lists.some((l) => l.enabled) },
  simkl: { workflowEnv: "GH_SIMKL_WORKFLOW", workflow: SIMKL_WORKFLOW, runsKey: SIMKL_RUNS_KEY, hasEnabled: (cfg) => cfg.simkl.lists.some((l) => l.enabled) },
};

// An alarm more than this far in the past means the chain is stuck, not
// merely late - re-arm instead of trusting it.
const STUCK_AFTER_MS = 15 * 60000;

export class Clock {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
  }

  json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  // Internal endpoints (called by the worker itself, never publicly routed).
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/rearm") return this.json(await this.rearm(Date.now()));
      if (url.pathname === "/ensure") return this.json(await this.ensure(Date.now()));
      return this.json({ error: "unknown clock endpoint" }, 404);
    } catch (e) {
      return this.json({ error: String((e && e.message) || e).slice(0, 200) }, 500);
    }
  }

  // Platform alarm entry. Retried up to 6x on throw - so never throw:
  // fire, re-arm, and let faults land in logs + run records instead.
  async alarm(alarmInfo) {
    try {
      if (alarmInfo && alarmInfo.retryCount) {
        console.log(`[clock] alarm redelivery (attempt ${alarmInfo.retryCount}) - lastFire guards re-fires.`);
      }
      await this.fireDue(Date.now());
      await this.rearm(Date.now());
    } catch (e) {
      console.error(`[clock] alarm failed: ${(e && e.message) || e}`);
      try {
        await this.rearm(Date.now());
      } catch (e2) {
        console.error(`[clock] rearm failed: ${(e2 && e2.message) || e2}`);
      }
    }
  }

  async loadTimetable() {
    const cfg = await loadConfig(this.env.STORE);
    return { cfg, schedules: normalizeSchedules(cfg && cfg.schedules) };
  }

  async loadSchedules() {
    return (await this.loadTimetable()).schedules;
  }

  // Recompute "what's next" from the current timetable and move the alarm
  // there. Unconditional by design - safe to call anytime (boot, watchdog,
  // future UI saves). Clears the alarm when nothing is scheduled.
  async rearm(nowMs) {
    const next = nextSlotAfter(await this.loadSchedules(), nowMs);
    if (!next) {
      await this.storage.deleteAlarm();
      console.log("[clock] nothing scheduled - alarm cleared.");
      return { rearmed: true, next: null };
    }
    await this.storage.setAlarm(next.atMs);
    console.log(`[clock] alarm set: ${next.module} at ${new Date(next.atMs).toISOString()}`);
    return { rearmed: true, next };
  }

  // Watchdog: repair a missing or stuck alarm, fire anything that became
  // due while the chain was broken, then re-arm. No-op when healthy.
  async ensure(nowMs) {
    let current = null;
    try {
      current = await this.storage.getAlarm();
    } catch (e) {
      console.error(`[clock] ensure: getAlarm failed: ${(e && e.message) || e}`);
    }
    if (current == null || current < nowMs - STUCK_AFTER_MS) {
      console.log(`[clock] ensure: alarm ${current == null ? "missing" : "stuck in past"} - firing due + re-arming.`);
      await this.fireDue(nowMs);
      return this.rearm(nowMs);
    }
    return { ok: true, alarmAt: new Date(current).toISOString() };
  }

  // Dispatch every due module (S5: skip modules with nothing enabled),
  // record double-failures as failed /status rows, stamp lastFire ONLY on
  // success so a failed slot retries on the next tick/alarm instead of
  // being marked done.
  async fireDue(nowMs) {
    const { cfg, schedules } = await this.loadTimetable();
    let lastFire = {};
    try {
      lastFire = (await this.storage.get("lastFire")) || {};
    } catch (e) {
      console.error(`[clock] fireDue: lastFire read failed: ${(e && e.message) || e}`);
    }
    const results = [];
    for (const slot of dueModulesAt(schedules, nowMs, lastFire)) {
      const def = MODULE_DEFS[slot.module];
      const workflow = this.env[def.workflowEnv] || def.workflow;
      // S5 mirror (from handleTriggerRefresh): never spin a GitHub run for
      // a module with nothing enabled - the scripts would just print "no
      // enabled lists" and exit. Unstamped, so enabling a list later fires
      // the next slot normally.
      if (!def.hasEnabled(cfg)) {
        console.log(`[clock] ${workflow}: nothing enabled - skipping dispatch.`);
        results.push({ module: slot.module, workflow, dispatched: false, skipped: true });
        continue;
      }
      let result = await dispatchScraperWorkflow(this.env, { workflow, inputs: { origin: "cron" } });
      if (!result.dispatched) {
        console.error(`[clock] ${workflow}: first dispatch failed (${result.reason}) - retrying once.`);
        result = await dispatchScraperWorkflow(this.env, { workflow, inputs: { origin: "cron" } });
      }
      if (!result.dispatched) {
        console.error(`[clock] ${workflow}: dispatch failed twice: ${result.reason}`);
        const now = Date.now();
        try {
          await addRuns(this.env.STORE, [{
            catalog_id: `dispatch:${workflow}`,
            started_at: now,
            finished_at: now,
            pages_scraped: 0,
            movies_found: 0,
            status: "failed",
            error_message: String(result.reason || "dispatch failed").slice(0, 500),
            triggered_by: "scheduled",
          }], def.runsKey, null);
        } catch (e) {
          console.error(`[clock] ${workflow}: failed to record dispatch failure: ${(e && e.message) || e}`);
        }
      } else {
        console.log(`[clock] ${workflow}: dispatched for slot ${slot.time}.`);
        lastFire[slot.module] = slot.atMs;
      }
      results.push({ module: slot.module, workflow, dispatched: result.dispatched, ...(result.dispatched ? {} : { reason: result.reason }) });
    }
    try {
      await this.storage.put("lastFire", lastFire);
    } catch (e) {
      console.error(`[clock] fireDue: lastFire write failed: ${(e && e.message) || e}`);
    }
    return results;
  }
}
