# Codebase Concerns

**Analysis Date:** 2026-08-05

## Tech Debt

**No formal test framework:**
- Issue: Tests use raw `node:assert` with manual `check()` helper instead of a proper test runner
- Files: `scripts/dry-test.mjs`, `scripts/verify-ui.mjs`
- Impact: No test discovery, no parallel execution, no coverage reporting, no CI integration
- Fix approach: Adopt vitest or node:test runner for structured test execution

**Inline HTML/CSS/JS in configure.js:**
- Issue: 850-line file with server-rendered HTML containing inline CSS (~330 lines) and inline JS (~400 lines)
- Files: `src/configure.js`
- Impact: No syntax highlighting, no linting, no hot reload, XSS surface area
- Fix approach: Extract to static assets or use a build tool; consider a lightweight framework

**No TypeScript:**
- Issue: Entire codebase uses plain JavaScript without type annotations
- Files: `src/*.js`, `scripts/*.mjs`
- Impact: No static analysis, no autocomplete, type-related bugs at runtime
- Fix approach: Add JSDoc types or migrate to TypeScript

## Known Bugs

**Concurrent save race condition:**
- Symptoms: Two rapid saves can clobber each other's config
- Files: `src/routes.js:168-241`
- Trigger: Two browser tabs open simultaneously, both clicking Save
- Workaround: None documented; acceptable for single-operator admin page

**Git push race in CI:**
- Symptoms: Concurrent workflow runs can lose data when pushing
- Files: `.github/workflows/scrape.yml:76-80`, `.github/workflows/official.yml:50-56`
- Trigger: Scheduled cron + manual dispatch overlap
- Workaround: `git pull --rebase` before push, but still possible under heavy concurrency

## Security Considerations

**Wildcard CORS:**
- Risk: Any origin can make requests to the worker API
- Files: `src/index.js:10`, `src/routes.js:18`
- Current mitigation: None
- Recommendations: Restrict to specific origins or use authenticated endpoints for write operations

**Unsafe-inline CSP:**
- Risk: Inline scripts/styles can be injected if CSP is bypassed
- Files: `src/routes.js:34`
- Current mitigation: CSP header present, but `'unsafe-inline'` weakens it
- Recommendations: Use nonces or hashes for inline scripts; extract styles to external files

**No authentication on admin endpoints:**
- Risk: `/save-config`, `/trigger-refresh`, `/runs` are publicly accessible
- Files: `src/index.js:58-72`
- Current mitigation: None
- Recommendations: Add API key or session-based auth for write operations

**Secrets in workflow files:**
- Risk: GitHub secrets referenced but not validated at startup
- Files: `scripts/scrape.mjs:56-59`, `scripts/official.mjs:44-47`
- Current mitigation: Scripts exit(1) if missing
- Recommendations: Validate all required secrets at application startup

## Performance Bottlenecks

**No catalog caching on worker:**
- Problem: Each `/catalog/` request fetches from GitHub Pages
- Files: `src/routes.js:132-138`
- Cause: Worker acts as thin proxy without local cache
- Improvement path: Add KV caching for catalog responses (5-minute TTL)

**Puppeteer warm-up per run:**
- Problem: Each scrape run opens browser and warms up sessions
- Files: `scripts/scrape.mjs:158-196`
- Cause: Stealth requires fresh browser context per type
- Improvement path: Already optimized with `warmedUpTypes` set; limited further improvement possible

**Large JSON files in data/:**
- Problem: Catalog files can grow large with many items
- Files: `data/*.json`
- Cause: No pagination or streaming; full file loaded per request
- Improvement path: Consider pagination at data level or virtual scrolling

## Fragile Areas

**MDBList DOM scraping:**
- Files: `scripts/scrape.mjs:236-290`
- Why fragile: Depends on specific CSS selectors (`.card`, `.header.movie-title`, `.idscore.search-score-main`) that can change without notice
- Safe modification: Add fallback selectors; monitor scrape success rates
- Test coverage: No automated tests for DOM structure changes

**GitHub Actions workflow dispatch:**
- Files: `src/dispatch.js:10-36`
- Why fragile: Depends on GitHub API response codes; 204 expected for success
- Safe modification: Handle additional success codes; add retry logic
- Test coverage: Mocked in dry-test.mjs

**ID generation and healing:**
- Files: `src/config.js:25-33`, `src/config.js:172-183`
- Why fragile: One-shot healing mechanism; if interrupted, IDs may not match data files
- Safe modification: Never modify healing logic after first deployment
- Test coverage: Covered in dry-test.mjs

## Scaling Limits

**Worker KV storage:**
- Current capacity: Config + 30 run records per module
- Limit: KV has 25 GB limit; current usage well below
- Scaling path: Not an issue at current scale

**GitHub Pages bandwidth:**
- Current capacity: Catalog files served statically
- Limit: 100 GB/month bandwidth limit
- Scaling path: Monitor usage; consider CDN if approaching limit

**GitHub Actions minutes:**
- Current capacity: 2000 minutes/month (free tier)
- Limit: Each scrape run ~5-15 minutes depending on list count
- Scaling path: Optimize scrape duration; consider caching

## Dependencies at Risk

**puppeteer-extra + stealth plugin:**
- Risk: Plugin may fall behind Puppeteer updates; detection by mdblist.com
- Impact: Scraping will fail; catalog data goes stale
- Migration plan: Monitor upstream; consider official MDBList API if available

**Cloudflare Workers:**
- Risk: Free tier has request limits; pricing changes
- Impact: Worker becomes unavailable
- Migration plan: Monitor usage; consider paid tier if needed

## Missing Critical Features

**No health check endpoint:**
- Problem: No way to verify worker is running and KV is accessible
- Blocks: Monitoring, alerting, uptime tracking

**No rate limiting:**
- Problem: API endpoints can be called without limits
- Blocks: Abuse prevention, cost control

**No request validation on /runs:**
- Problem: No authentication; any caller can inject run records
- Blocks: Accurate status reporting

## Test Coverage Gaps

**No integration tests for scraper:**
- What's not tested: End-to-end scraping against real mdblist.com
- Files: `scripts/scrape.mjs`
- Risk: DOM changes break scraping silently
- Priority: High

**No tests for error recovery:**
- What's not tested: Browser crash, network timeout, partial writes
- Files: `scripts/scrape.mjs:301-321`
- Risk: Data corruption or incomplete catalogs
- Priority: Medium

**No tests for concurrent operations:**
- What's not tested: Multiple saves, multiple workflow dispatches
- Files: `src/routes.js:168-241`
- Risk: Config corruption under load
- Priority: Low (single-operator use case)

**No tests for CSP compliance:**
- What's not tested: Inline scripts in configure page
- Files: `src/configure.js`
- Risk: XSS vulnerabilities undetected
- Priority: Medium

---

*Concerns audit: 2026-08-05*