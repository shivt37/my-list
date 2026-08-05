// my-list worker - phase 1: MDBList scraper module only.
// Thin router: config lives in KV, catalog data in repo data/ (GitHub
// Pages), scraping happens in GitHub Actions. No scheduled handler -
// schedules are the workflows' own cron lines, edited on github.com.

import { loadConfig } from "./config.js";
import { buildManifest, handleCatalog, handleStatus, handleSaveConfig, handleExportConfig, handleTriggerRefresh, handleRunsPost, configureResponse, CATALOG_RE } from "./routes.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "x-content-type-options": "nosniff", ...corsHeaders, ...extraHeaders },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...corsHeaders, "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }

    if (pathname === "/" || pathname === "") {
      return new Response(
        "my-list - Stremio addon\nConfigure: /configure\nManifest: /manifest.json\nStatus: /status",
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    if (pathname === "/configure") {
      const cfg = await loadConfig(env.STORE);
      return configureResponse(env, url.origin, cfg);
    }

    if (pathname === "/manifest.json") {
      return json(await buildManifest(env));
    }

    const catalogMatch = pathname.match(CATALOG_RE);
    if (catalogMatch) {
      const [, type, catalogId, extra] = catalogMatch;
      const skipMatch = (extra || "").match(/skip=(\d+)/);
      const skip = skipMatch ? parseInt(skipMatch[1], 10) : 0;
      return handleCatalog(env, type, catalogId, skip);
    }

    if (pathname === "/status") {
      return handleStatus(env, request);
    }

    if (pathname === "/save-config" && request.method === "POST") {
      return handleSaveConfig(env, request);
    }

    if (pathname === "/export-config") {
      return handleExportConfig(env, request);
    }

    if (pathname === "/trigger-refresh" && request.method === "POST") {
      return handleTriggerRefresh(env, request);
    }

    if (pathname === "/runs" && request.method === "POST") {
      return handleRunsPost(env, request);
    }

    return json({ error: "Not found" }, 404);
  },
};
