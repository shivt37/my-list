// GitHub Actions workflow dispatch — /save-config, /trigger-refresh and
// /runs all reach the repo through this one function.

const GH_API = "https://api.github.com";

export async function dispatchScraperWorkflow(env, { lists = [], action = "scrape", deleteIds = [] } = {}) {
  if (!env.GH_TOKEN || !env.GH_REPO || !env.GH_WORKFLOW) {
    return { dispatched: false, reason: "GH_TOKEN/GH_REPO/GH_WORKFLOW not configured" };
  }
  const res = await fetch(`${GH_API}/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "my-list-worker",
    },
    body: JSON.stringify({
      ref: env.GH_REF || "main",
      inputs: {
        lists: lists.join(","),
        action,
        ...(deleteIds.length > 0 && { delete_ids: deleteIds.join(",") }),
      },
    }),
  });
  if (res.status !== 204) {
    const text = await res.text();
    return { dispatched: false, reason: `GitHub API ${res.status}: ${text}` };
  }
  return { dispatched: true, lists, action };
}
