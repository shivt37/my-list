// Cloudflare clock: Cron Triggers (wrangler.toml [triggers]) replace the
// workflows' own `schedule:` blocks - GitHub's scheduler is best-effort
// with hours-long delays (audit/report/cron-reliability.md). Each firing
// dispatches the due workflows through the SAME workflow_dispatch endpoint
// the manual paths (/save-config, /trigger-refresh, Actions-tab button)
// use, with blank inputs - every script treats a missing id filter as
// "all enabled", so a blank dispatch IS the old cron run. Manual triggers
// are untouched: same endpoint, same payload shape, only the caller differs.

import { loadConfig, addRuns, runsKeyFor, OFFICIAL_RUNS_KEY, SIMKL_RUNS_KEY, TMDB_RUNS_KEY } from "./config.js";
import { dispatchScraperWorkflow } from "./dispatch.js";
import { OFFICIAL_WORKFLOW, SIMKL_WORKFLOW, TMDB_WORKFLOW } from "./routes.js";

// tmdb stays once-daily (owner decision, F14); the other three run twice.
// Keys must match wrangler.toml crons exactly - controller.cron echoes the
// firing expression, and anything unmapped is ignored (never dispatched).
const SCHEDULE = {
  "0 0 * * *": ["tmdb", "scrape", "official", "simkl"],
  "0 12 * * *": ["scrape", "official", "simkl"],
};

const MODULES = {
  tmdb: { workflowEnv: "GH_TMDB_WORKFLOW", workflow: TMDB_WORKFLOW, runsKey: TMDB_RUNS_KEY, hasEnabled: (cfg) => cfg.tmdb.lists.some((l) => l.enabled) },
  scrape: { workflowEnv: "GH_WORKFLOW", workflow: "scrape.yml", runsKey: runsKeyFor("mdb_scrape_cron"), hasEnabled: (cfg) => cfg.scraper.lists.some((l) => l.enabled) },
  official: { workflowEnv: "GH_OFFICIAL_WORKFLOW", workflow: OFFICIAL_WORKFLOW, runsKey: OFFICIAL_RUNS_KEY, hasEnabled: (cfg) => cfg.official.lists.some((l) => l.enabled) },
  simkl: { workflowEnv: "GH_SIMKL_WORKFLOW", workflow: SIMKL_WORKFLOW, runsKey: SIMKL_RUNS_KEY, hasEnabled: (cfg) => cfg.simkl.lists.some((l) => l.enabled) },
};

export async function handleCronDispatch(env, cron) {
  const due = SCHEDULE[cron];
  if (!due) {
    console.log(`[cron] ignoring unexpected schedule "${cron}" - no workflows mapped.`);
    return { fired: false, reason: "unmapped cron" };
  }
  const cfg = await loadConfig(env.STORE);
  const results = [];
  for (const name of due) {
    const def = MODULES[name];
    const workflow = env[def.workflowEnv] || def.workflow;
    // S5 mirror (from handleTriggerRefresh): never spin a GitHub run for a
    // module with nothing enabled - the scripts would just print "no
    // enabled lists" and exit.
    if (!def.hasEnabled(cfg)) {
      console.log(`[cron] ${workflow}: nothing enabled - skipping dispatch.`);
      results.push({ module: name, workflow, dispatched: false, skipped: true });
      continue;
    }
    // One inline retry: a single transient GitHub API failure must not eat
    // a whole daypart. Anything beyond that is RECORDED, never thrown - a
    // throw after partial success would make the runtime redeliver the
    // event and double-dispatch the workflows that already went out.
    let result = await dispatchScraperWorkflow(env, { workflow, inputs: { origin: "cron" } });
    if (!result.dispatched) {
      console.error(`[cron] ${workflow}: first dispatch failed (${result.reason}) - retrying once.`);
      result = await dispatchScraperWorkflow(env, { workflow, inputs: { origin: "cron" } });
    }
    if (!result.dispatched) {
      console.error(`[cron] ${workflow}: dispatch failed twice: ${result.reason}`);
      // Owner choice: dispatch failures surface as failed rows in /status
      // (clock icon, same as any failed run) - visible without new services.
      const now = Date.now();
      try {
        await addRuns(env.STORE, [{
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
        console.error(`[cron] ${workflow}: failed to record dispatch failure: ${e.message}`);
      }
    } else {
      console.log(`[cron] ${workflow}: dispatched.`);
    }
    results.push({ module: name, workflow, dispatched: result.dispatched, ...(result.dispatched ? {} : { reason: result.reason }) });
  }
  return { fired: true, cron, results };
}
