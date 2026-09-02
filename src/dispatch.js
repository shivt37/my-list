// GitHub Actions workflow dispatch - /save-config, /trigger-refresh and
// /runs all reach the repo through this one function. The workflow file
// is overridable (official lists dispatch to official.yml, not scrape.yml)
// so each page keeps its own cron. Each workflow declares different
// workflow_dispatch inputs, so the caller passes the exact input object
// for its target workflow.

const GH_API = "https://api.github.com";

export async function dispatchScraperWorkflow(env, { lists = [], action = "scrape", deleteIds = [], workflow, inputs } = {}) {
  // Local-dev stub: set GH_DISPATCH_STUB in .dev.vars to make saves fully
  // functional without real GitHub secrets - dispatches "succeed" and are
  // logged instead of fired. Never set on production.
  if (env.GH_DISPATCH_STUB) {
    console.log(`[dispatch-stub] ${workflow || env.GH_WORKFLOW || "scrape.yml"} <-`, inputs || { lists, action, deleteIds });
    return { dispatched: true, stubbed: true };
  }
  const wf = workflow || env.GH_WORKFLOW;
  if (!env.GH_TOKEN || !env.GH_REPO || !wf) {
    return { dispatched: false, reason: "GH_TOKEN/GH_REPO/GH_WORKFLOW not configured" };
  }
  const payloadInputs = inputs || {
    lists: lists.join(","),
    action,
    ...(deleteIds.length > 0 && { delete_ids: deleteIds.join(",") }),
  };
  let res;
  try {
    res = await fetch(`${GH_API}/repos/${env.GH_REPO}/actions/workflows/${wf}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "my-list-worker",
      },
      // Bound a hung GitHub API connection so a save/refresh fails fast
      // with a clear reason instead of stalling the request.
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        ref: env.GH_REF || "main",
        inputs: payloadInputs,
      }),
    });
  } catch (e) {
    // Network-level failure (DNS, timeout, connection reset) - same
    // structured result as a non-204 so callers veto/warn consistently
    // instead of the thrown error bubbling into a 500.
    return { dispatched: false, reason: `GitHub API unreachable: ${e.message}` };
  }
  if (res.status !== 204) {
    const detail = (await res.text()).slice(0, 200);
    return { dispatched: false, reason: `GitHub API returned ${res.status}${detail ? ": " + detail : ""}` };
  }
  return { dispatched: true, lists, action, workflow: wf };
}