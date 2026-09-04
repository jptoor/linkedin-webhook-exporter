# Audit remediation status

Tracks each finding in `docs/AUDIT.md`. "Fixed" means code changed and a test
covers it; "Addressed" means documentation or policy changed; "Open" means
not done.

| ID | Status | What changed | Where |
|---|---|---|---|
| SEC-01 | Fixed | Receiver binds 127.0.0.1, requires `LWE_SECRET` unless `LWE_ALLOW_UNSIGNED=1`, read routes need `LWE_ADMIN_TOKEN` (404 otherwise), CORS only for an explicit origin | `receiver/server.mjs`; `tests/unit/receiver.test.ts` |
| BG-01 | Fixed | Every storage read-modify-write runs under an async mutex; concurrent captures are serialized | `src/background/lock.ts`, `service-worker.ts`; `worker.test.ts` "concurrent captures" |
| RCV-01 | Fixed | Schema validation with bounded fields, safe JSON-array parsing, one error boundary per request (400/413/500, never a crash) | `receiver/server.mjs`; `receiver.test.ts` "robustness" |
| LEG-01 | Addressed | README and PRIVACY.md state LinkedIn's prohibition and that no cap/pacing is a safe harbor; competitor-parity framing removed from README; bulk export retained as an explicit, visible, user-started action | `README.md`, `PRIVACY.md` |
| SEC-02 | Fixed | Content scripts receive `ContentSettings` (no secrets); worker validates `sender.id`, sender kind, page origin vs message URL, and every message field; privileged commands are extension-page only | `service-worker.ts`, `shared/validate.ts`; `worker.test.ts` "trust boundary" |
| SEC-03 | Fixed | Canonicalizers accept only LinkedIn hosts (apex, www, 2-letter regional), reject credentials/ports/nested paths, enforce slug/URN grammars | `shared/normalize.ts`; `normalize.test.ts` |
| SEC-04 | Fixed | Save and Test share one validate-and-authorize path; Test requests the host permission, validates headers, and rolls settings back on failure | `src/options/options.ts` |
| SEC-05 | Fixed | Integer unix-second timestamps in both schemes; event-id grammar; receiver requires header/body id equality and inserts the id inside the transaction | `shared/signing.ts`, `receiver/server.mjs`; `signing.test.ts`, `receiver.test.ts` |
| BG-02 | Fixed | `sending` items carry a lease; stale leases are recovered on every flush/startup | `background/queue.ts`; `queue.test.ts`, `worker.test.ts` "stale sending" |
| BG-03 | Fixed | Export jobs carry a revision; page results commit with compare-and-swap and are discarded if pause/stop landed meanwhile; status re-read after every await | `service-worker.ts` `commitJob` |
| BG-04 | Fixed | Listener attached before navigation, already-complete tabs accepted, `tabs.onRemoved` fails the job, unexpected URL fails the page | `service-worker.ts` `navigateAndWait` |
| BG-05 | Fixed | `clearQueue("all")` removes everything except in-flight fresh leases | `queue.ts`; `queue.test.ts` |
| BG-06 | Fixed | Dedupe entries are reserved on queue, confirmed on 2xx, released on permanent failure | `service-worker.ts`; `worker.test.ts` "releases the identity" |
| BG-07 | Fixed | Local calendar day; separate `queued` / `delivered` / `failed` counters; the cap limits admissions (documented) | `service-worker.ts`, `SPEC.md` |
| CONTENT-01 | Fixed | Route key = path + query minus session/tracking params; `pushState`, `replaceState`, `popstate`, and a poll all trigger remount | `src/content/index.ts` |
| CONTENT-02 | Fixed | Every mount returns a disposer (observer, interval, timers, checkboxes); one global message listener; observer scoped to the results container | `src/content/index.ts` |
| CONTENT-03 | Fixed | Scroll waits for position settle and a DOM quiet period; next-page decision reports its source (control vs row count) | `src/content/index.ts`, `messages.ts` |
| PAR-01 | Fixed | SDUI fixtures checked in (`samples/`); unanchored entries grouped by date line; localized section labels; warnings on uncertainty | `parsers/profile.ts`; `parsers.test.ts` |
| PAR-02 | Fixed | People-search cards filter chatter lines and recognize location by shape, not position | `parsers/search.ts`; `parsers.test.ts` |
| PAR-03 | Fixed | Lead-page experience parsed by container; nested heading spans and grouped roles handled | `parsers/salesnav.ts`; `parsers.test.ts` |
| PAR-04 | Fixed | Excluded history reads only the first entry; documented precedence matches code | `parsers/profile.ts`, `SPEC.md` |
| PAY-01 | Fixed | Every body in every preset starts with `schema_version`, `event`, `event_id`, `sent_at`; `isPayload` checks the event enum | `shared/mapping.ts`; `mapping.test.ts` |
| PAY-02 | Fixed | `sanitizeSettings` on every read; `validateLead(s)` at the worker boundary | `shared/settings.ts`, `shared/validate.ts`; tests |
| RCV-02 | Fixed | Byte-counted body limit with 413, Content-Length pre-check, request timeouts, error handlers | `receiver/server.mjs` |
| RCV-03 | Fixed | Types/lengths/hosts enforced; identity fallback is a namespaced hash and flagged | `receiver/server.mjs` |
| DEE-01 | Fixed | Runtime validation at entry; stable key from the original identity; audit row written before paid steps and updated after | `examples/deepline/linkedin-capture.play.ts` |
| TEST-01 | Fixed | SDUI/messy fixtures in `samples/` drive unit and acceptance tests; live evidence separated in docs | `samples/`, `tests/` |
| DOC-01 | Addressed | README/SPEC rewritten from observed behavior; settings documented; guarantees marked best effort | `README.md`, `docs/SPEC.md` |
| PKG-01 | Addressed | `PRIVACY.md`, `activeTab` dropped, `npm run pack` asserts manifest permissions/hosts | `PRIVACY.md`, `scripts/pack.mjs` |
| PAR-05 | Fixed | Conservative name cleaning (trailing badges only, exact credential tokens), particles/suffixes/mononyms/"Last, First", dash and pipe headline splits with role-word check | `shared/normalize.ts`, `parsers/common.ts` |
| SEARCH-01 | Fixed | Real grammar for Sales Navigator expressions; session/tracking params redacted; repeated keys kept; case-insensitive page key | `shared/search.ts` |
| RCV-04 | Fixed | One documented secret contract (base64/base64url, `whsec_`, raw fallback only without prefix); bounded integer timestamps; multi-signature headers | `shared/signing.ts`, `receiver/server.mjs` |
| RCV-05 | Fixed | Redacted logs (event id + counts), authenticated reads, WAL + busy timeout, `LWE_QUIET` | `receiver/server.mjs` |
| DEE-02 | Fixed | DDL moved to `migrations/001_sales_nav_imports.sql`; per-event SQL is a single INSERT … ON CONFLICT and one UPDATE | `examples/deepline/` |
| TEST-02 | Fixed | Fake-chrome worker tests (concurrency, leases, dedupe release), receiver fuzz cases, hostile URL and header tests, CI retry | `tests/unit/worker.test.ts` and others |
| PKG-02 | Addressed | Icons committed; `pack` script with checksum; brand attribution note | `scripts/pack.mjs`, `src/brand/ATTRIBUTION.md` |
| DOC-02 | Addressed | Live findings dated and labeled as manual evidence; sample fixtures replace narrative claims | `docs/SPEC.md`, `docs/ACCEPTANCE_TESTS.md` |
| QUALITY-01 | Fixed | ESLint gate, `npm audit` (warning), pack/manifest assertion in CI | `.github/workflows/ci.yml`, `eslint.config.mjs` |
| QUALITY-02 | Fixed | Panel in an open shadow root with region/heading/live-region semantics, labeled inputs, focus styles | `src/content/ui.ts` |

Deliberately open:

- Bulk export is still shipped. The audit's P0 recommendation is a product
  and legal decision; the code now states the risk plainly and never claims
  compliance. Removing the feature is a one-line change in `detectPageType`
  / `exportablePageType` if that decision is made.

## Re-review (docs/AUDIT-2.md) new findings

Codex's second pass rated 9 findings VERIFIED and 25 PARTIAL (it could not bind
ports in its sandbox, so the receiver and acceptance suites did not execute
there; they run locally and in CI). Its summary line also mentions "3 NOT
FIXED, 2 REGRESSED" but no row in its own table carries either verdict. The
ten new findings it raised:

| ID | Status | What changed | Where |
|---|---|---|---|
| NF-01 | Fixed | Export start reserves the job row under the lock before creating a tab; a concurrent start is refused with `job_running`; tab creation failure fails the job | `service-worker.ts` `startExport`; `worker.test.ts` "five simultaneous EXPORT_START" ; `extension.spec.ts` AT-28 |
| NF-02 | Fixed | Page identity = origin + path + every non-session query param + page (`isSameSearchPage`); collect responses must echo the job id and expected page and report the parsed URL | `shared/export-job.ts`, `service-worker.ts`, `content/index.ts`; `audit2.test.ts` |
| NF-03 | Fixed | Unsigned mode requires the flag AND a loopback bind AND `NODE_ENV != production` | `receiver/server.mjs`; `receiver.test.ts` "NF-03" |
| NF-04 | Fixed | Import `search_url` and lead `page_url` go through the LinkedIn/loopback validator and are redacted; hostile values become null | `receiver/server.mjs` `provenanceUrl`; `receiver.test.ts` "NF-04/NF-05" |
| NF-05 | Fixed | The receiver uses the same sensitive-parameter list as the extension, decodes keys, drops fragments, and stores the redacted URL | `receiver/server.mjs` `redactSearchUrl` |
| NF-06 | Fixed | `full_name_raw` keeps the rendered name whenever cleaning changed it | `parsers/common.ts` `setName`, `shared/types.ts`; `audit2.test.ts` |
| NF-07 | Fixed | Log values and messages have URLs redacted, messages truncated, a 512 KB byte bound, and a dedicated write lock | `shared/log.ts`; `audit2.test.ts` |
| NF-08 | Fixed | List mounts carry a liveness flag checked after every await; toasts return disposers registered with the mount; export polling stops when the panel is gone | `content/index.ts`, `content/ui.ts` |
| NF-09 | Fixed | New fixture appends the second half of rows only after scrolling and enables Next only then; exported to the sample site | `tests/fixtures/generators.mjs` `appendedSalesNav`; AT-27 |
| NF-10 | Addressed | Deepline README and SPEC now state that the flat Deepline body starts with the envelope fields | `examples/deepline/README.md`, `docs/SPEC.md` |

Still deliberately open: LEG-01 (bulk export kept; product/legal decision).
