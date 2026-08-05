// GitHub Actions workflow dispatch - /save-config, /trigger-refresh and
// /runs all reach the repo through this one function. The workflow file
// is overridable (official lists dispatch to official.yml, not scrape.yml)
// so each page keeps its own cron. Each workflow declares different
// workflow_dispatch inputs, so the caller passes the exact input object
// for its target workflow.

const GH_API = "https://api.github.com";

export async function dispatchScraperWorkflow(env, { lists = [], action = "scrape", deleteIds = [], workflow, inputs } = {}) {
  const wf = workflow || env.GH_WORKFLOW;
  if (!env.GH_TOKEN || !env.GH_REPO || !wf) {
    return { dispatched: false, reason: "GH_TOKEN/GH_REPO/GH_WORKFLOW not configured" };
  }
  const payloadInputs = inputs || {
    lists: lists.join(","),
    action,
    ...(deleteIds.length > 0 && { delete_ids: deleteIds.join(",") }),
  };
  const res = await fetch(`${GH_API}/repos/${env.GH_REPO}/actions/workflows/${wf}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "my-list-worker",
    },
    body: JSON.stringify({
      ref: env.GH_REF || "main",
      inputs: payloadInputs,
    }),
  });
  if (res.status !== 204) {
    return { dispatched: false, reason: `GitHub API returned ${res.status}` };
  }
  return { dispatched: true, lists, action, workflow: wf };
}