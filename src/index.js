// my-list worker - phase 1: MDBList scraper module only.
// Thin router: config lives in KV, catalog data in repo data/ (GitHub
// Pages), scraping happens in GitHub Actions. No scheduled handler -
// schedules are the workflows' own cron lines, edited on github.com.

import { loadConfig } from "./config.js";
import { buildManifest, handleCatalog, handleStatus, handleSaveConfig, handleExportConfig, handleTriggerRefresh, handleRunsPost, handleTmdbSearch, handleTmdbPreviewDiscover, handleMdblistOfficialCatalog, configureResponse, CATALOG_RE } from "./routes.js";
import { statusPageResponse } from "./status.js";
import { checkSession, isPublic, isAdminPath, isAuthEnabled, handleLogin, handleLogout, loginPageHtml } from "./auth.js";

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

    // ── AUTH ROUTES (always reachable, no session required) ──
    if (pathname === "/configure/login" && request.method === "POST") {
      return handleLogin(env, request);
    }
    if (pathname === "/configure/logout" && (request.method === "POST" || request.method === "GET")) {
      return handleLogout();
    }

    // ── GATE EVERYTHING ELSE (admin page + admin control APIs) ──
    // AUTH_ENABLED="false" skips the session check entirely (login page,
    // rate limiter, cookies all stay intact but bypassed - re-enable is
    // instant and requires no session migration).
    if (isAuthEnabled(env) && isAdminPath(pathname) && !isPublic(pathname)) {
      const sess = await checkSession(env, request);
      if (!sess.ok) {
        const accept = request.headers.get("Accept") || "";
        if (accept.includes("text/html") && pathname === "/configure") {
          return new Response(loginPageHtml({ error: null, blocked: false }), {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          });
        }
        return json({ error: "Unauthorized - log in at /configure first." }, 401);
      }
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
      // HTML UI by default; ?format=json keeps the raw feed (tests + tooling).
      if (new URL(request.url).searchParams.get("format") === "json") {
        return handleStatus(env, request);
      }
      return statusPageResponse(env, request);
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

    // TMDB live helpers (Discover form search boxes + preview).
    const tmdbSearchMatch = pathname.match(/^\/tmdb\/search-(keyword|company|collection)$/);
    if (tmdbSearchMatch) {
      const query = url.searchParams.get("query") || "";
      return handleTmdbSearch(env, tmdbSearchMatch[1], query);
    }

    if (pathname === "/tmdb/preview-discover" && request.method === "POST") {
      return handleTmdbPreviewDiscover(env, request);
    }

    // Official picker: live MDBList catalog minus already-configured slugs.
    if (pathname === "/mdblist/official-catalog") {
      return handleMdblistOfficialCatalog(env);
    }

    return json({ error: "Not found" }, 404);
  },
};
