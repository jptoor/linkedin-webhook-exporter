# Skeptical re-review

## Executive summary

The remediation is substantial, but this repository is not release-ready. Of the 39 prior findings, 9 are VERIFIED, 25 are PARTIAL, 3 are NOT FIXED, and 2 are REGRESSED. The most important remaining risks are an export-start race, weak export-tab URL ownership, an unsigned-production mode, receiver acceptance of arbitrary import URLs, incomplete search URL redaction, and the retained bulk-export feature without the required legal/product authorization.

The permitted checks produced mixed evidence:

- `npm run typecheck` passed.
- `node scripts/pack.mjs` passed and rebuilt the zip.
- `npm test` could not complete because the receiver test process is not permitted to bind `127.0.0.1`; 149 tests passed and 26 receiver tests were skipped after the setup failure.
- `npm run test:acceptance` could not execute its assertions for the same sandbox port-binding restriction; the fixture site/mock webhook failed at `listen EPERM: operation not permitted 127.0.0.1`.
- `npm run lint` failed on the existing untracked `scripts/e2e-samples.mjs:78` (`m` is unused). This is a release-gate failure regardless of whether that file is considered part of the remediation.

The report reflects the current working tree. No source, test, or documentation file was changed for this review; the requested report is the only deliberate addition. The packaging check did refresh the tracked zip artifact.

## Finding summary

| ID | Prior severity | Verdict | Note |
|---|---:|---|---|
| SEC-01 | P0 | VERIFIED | Loopback default, secret gate, explicit CORS, and authenticated reads exist; receiver tests could not bind. |
| BG-01 | P0 | VERIFIED | Capture/queue/dedupe daily-counter RMW operations are serialized; export start has a separate race (NF-01). |
| RCV-01 | P0 | VERIFIED | Payload parsing and bounded array handling are inside the request error boundary. |
| LEG-01 | P0 | PARTIAL | Policy warning was added, but bulk scraping remains enabled without authorization. |
| SEC-02 | P1 | PARTIAL | Content settings are redacted, but page senders can still reach export controls. |
| SEC-03 | P1 | PARTIAL | Host validation improved, but canonicalization has case, scheme, and regional-host edge cases. |
| SEC-04 | P1 | PARTIAL | Settings validation exists, but test-send failure/permission paths are not fully transactional. |
| SEC-05 | P1 | VERIFIED | Timestamp, event grammar, header/body agreement, and transactional event identity checks exist. |
| BG-02 | P1 | VERIFIED | Leases and stale recovery are implemented and unit-tested. |
| BG-03 | P1 | VERIFIED | CAS/status rereads prevent stale page commits from overriding pause/stop. |
| BG-04 | P1 | PARTIAL | Listener ordering and tab removal handling are fixed, but URL identity is too weak. |
| BG-05 | P1 | VERIFIED | Clear removes sent/failed/pending history while retaining only fresh in-flight work. |
| BG-06 | P1 | PARTIAL | Delivery reservation is confirmed/released, but clear/prune paths can leave reservations. |
| BG-07 | P1 | PARTIAL | Local-day accounting and admission charging exist, but semantics/tests are incomplete. |
| CONTENT-01 | P1 | VERIFIED | Route key includes query and navigation remounts are serialized. |
| CONTENT-02 | P1 | PARTIAL | Main disposers exist, but asynchronous work and toast timers outlive teardown. |
| CONTENT-03 | P1 | PARTIAL | Scroll settling is better, but termination and pagination still rely on heuristics. |
| PAR-01 | P1 | PARTIAL | SDUI fixtures and grouping logic exist, but structure detection remains brittle. |
| PAR-02 | P1 | PARTIAL | Chatter/location filtering improved; row identity and localized structures remain weak. |
| PAR-03 | P1 | VERIFIED | Grouped Sales Navigator containers and nested headings are handled and tested. |
| PAR-04 | P1 | PARTIAL | Current-role precedence is fixed, but excluded history is still fully traversed. |
| PAY-01 | P1 | VERIFIED | Mapping presets emit the common envelope and mapping tests cover the preset matrix. |
| PAY-02 | P1 | PARTIAL | Lead/settings validators exist, but message/storage boundaries still trust casts. |
| RCV-02 | P1 | VERIFIED | Byte limits, 413 handling, timeouts, and request-level catches exist. |
| RCV-03 | P1 | PARTIAL | Lead/search validation is strict; import `search_url` bypasses it. |
| DEE-01 | P1 | PARTIAL | Stable audit-before-paid ordering exists, but validation and idempotent side effects are incomplete. |
| TEST-01 | P1 | PARTIAL | More fixtures/tests exist, but receiver and acceptance evidence did not execute here. |
| DOC-01 | P1 | PARTIAL | Safety claims were softened, but several code/spec/example contradictions remain. |
| PKG-01 | P1 | PARTIAL | Privacy and permission cleanup exist; store/public privacy deliverables are absent. |
| PAR-05 | P2 | PARTIAL | Conservative cleaning has meaningful tests but deletes legitimate-looking names/emoji. |
| SEARCH-01 | P2 | PARTIAL | Query grammar and parameter filtering improved; sent search URLs remain under-redacted. |
| RCV-04 | P2 | PARTIAL | One contract is documented, but receiver keeps a permissive duplicate decoder. |
| RCV-05 | P2 | PARTIAL | Authenticated reads and quieter logs exist; retention/PII/log-write guarantees are incomplete. |
| DEE-02 | P2 | VERIFIED | Per-event DDL was removed and migration/per-event statements are separated. |
| TEST-02 | P2 | PARTIAL | Concurrency/lease/fuzz coverage was added, but lifecycle and receiver execution gaps remain. |
| PKG-02 | P2 | PARTIAL | Icons, attribution, and checksum assertions exist; reproducible release provenance does not. |
| DOC-02 | P2 | PARTIAL | Evidence is dated and separated from tests, but live claims are not reproducible artifacts. |
| QUALITY-01 | P3 | PARTIAL | CI has useful gates, but lint is red and security/schema gates are non-blocking or absent. |
| QUALITY-02 | P3 | PARTIAL | Accessibility and shadow styling improved, but the open root/light-DOM controls remain exposed. |

## Verification details

### P0 findings

#### SEC-01 — VERIFIED

The receiver defaults to loopback at `receiver/server.mjs:24`, refuses startup without `LWE_SECRET` unless the unsigned flag is set at `receiver/server.mjs:35`, applies explicit CORS at `receiver/server.mjs:353`, and protects non-health reads with the admin token at `receiver/server.mjs:314`. The named receiver authentication/read tests exist at `tests/unit/receiver.test.ts:58` and `tests/unit/receiver.test.ts:128`; they would fail without the secret/read gates, but this run could not execute them because the child receiver could not bind loopback. The unsigned flag is not actually development-only; see NF-03.

#### BG-01 — VERIFIED

The capture RMW path is inside `withLock` at `src/background/service-worker.ts:94`, and flush claims/commits under the same mutex at `src/background/service-worker.ts:215` and `src/background/service-worker.ts:236`; queue, dedupe, and daily state are persisted together at `src/background/service-worker.ts:162`. The concurrent-capture test at `tests/unit/worker.test.ts:70` would expose duplicate admission/cap races without this serialization. This does not cover concurrent `EXPORT_START`, which is a separate new race (NF-01).

#### RCV-01 — VERIFIED

The request handler parses, validates, extracts, and commits inside the single catchable path at `receiver/server.mjs:372` through `receiver/server.mjs:424`; bounded JSON-array parsing is at `receiver/server.mjs:143` through `receiver/server.mjs:160`. The malformed JSON/hostile payload tests at `tests/unit/receiver.test.ts:88` would exercise the old out-of-boundary throw, but all receiver tests were skipped after the bind failure. Static control flow supports the claimed fix.

#### LEG-01 — PARTIAL

The README now explicitly says the extension must not bypass controls or automate collection contrary to platform rules at `README.md:15` through `README.md:21`, and repeats the warning at `README.md:146` through `README.md:159`. However, the bulk export remains implemented and advertised at `README.md:84` through `README.md:91`; no authorization mechanism, product restriction, or named test closes the original legal/product conflict. The remaining fix is to remove/disable bulk export until written authorization exists, or obtain and document that authorization and enforce its scope in the product.

### P1 findings

#### SEC-02 — PARTIAL

Only non-secret settings are sent to content scripts by `src/shared/settings.ts:86` through `src/shared/settings.ts:88`, and normal content messages are checked against sender ID/page origin at `src/background/service-worker.ts:508` through `src/background/service-worker.ts:525`. But `EXPORT_PAUSE`, `EXPORT_RESUME`, `EXPORT_STOP`, and `EXPORT_STATUS` are handled at `src/background/service-worker.ts:565` through `src/background/service-worker.ts:575` without the required `fromExt` check; `EXPORT_START` also accepts a caller-supplied numeric tab ID at `src/background/service-worker.ts:559` through `src/background/service-worker.ts:563`. The trust-boundary test at `tests/unit/worker.test.ts:37` would fail for the fixed CAPTURE/settings boundary but does not test these controls. Add an extension-page authorization guard to every export-control case and verify that a supplied tab belongs to the requested LinkedIn page/job.

#### SEC-03 — PARTIAL

The URL validator rejects credentials, ports, nested hosts, and non-LinkedIn hosts at `src/shared/normalize.ts:85` through `src/shared/normalize.ts:103`, and slug canonicalization decodes/re-encodes one slug at `src/shared/normalize.ts:112` through `src/shared/normalize.ts:126`. The named normalization tests at `tests/unit/normalize.test.ts:74` through `tests/unit/normalize.test.ts:115` cover hostile hosts and basic URL forms, but the route regex is case-sensitive (`src/shared/normalize.ts:115`), canonicalizers accept HTTP while production lead validation requires HTTPS (`src/shared/validate.ts:50`), and any two-letter subdomain is accepted (`src/shared/normalize.ts:85` through `src/shared/normalize.ts:90`). Add case-insensitive route matching, use one explicit approved regional-host policy, and enforce the same scheme policy at parse/canonicalize/validate boundaries; add uppercase route, trailing slash, regional host, and percent-encoded slug tests.

#### SEC-04 — PARTIAL

Settings are sanitized on read/write at `src/shared/settings.ts:72` through `src/shared/settings.ts:80`, webhook URLs and headers are validated at `src/shared/settings.ts:6` through `src/shared/settings.ts:23` and `src/shared/settings.ts:90` through `src/shared/settings.ts:102`, and options requests permission before saving at the claimed options path. There is no named test in the status map, and the test-send path calls `sendBody` without an options-level rollback/finally guard; malformed signing configuration can throw before the failure is converted to a user-visible result. Add tests for invalid headers/secrets, permission denial, changed host permission, and failed test send, and wrap test-send permission/settings mutations in a transactional `try/finally` rollback.

#### SEC-05 — VERIFIED

The signing verifier requires integer bounded timestamps at `src/shared/signing.ts:27` through `src/shared/signing.ts:35`, verifies the event grammar/signature at `src/shared/signing.ts:60` through `src/shared/signing.ts:65` and `src/shared/signing.ts:128` through `src/shared/signing.ts:138`, while the receiver requires header/body event identity agreement before its transaction at `receiver/server.mjs:397` through `receiver/server.mjs:407`. The signing and receiver tests exist at `tests/unit/signing.test.ts:17` through `tests/unit/signing.test.ts:28` and `tests/unit/receiver.test.ts:58` through `tests/unit/receiver.test.ts:85`; they would fail without the timestamp/event-ID/header checks, although the receiver suite was blocked by loopback binding. Replay prevention remains transaction/event-ID based rather than a separate replay cache, as documented.

#### BG-02 — VERIFIED

Queue claims create a lease at `src/background/queue.ts:22` through `src/background/queue.ts:25`, stale sending items are recovered at `src/background/queue.ts:29` through `src/background/queue.ts:35`, and the next alarm considers lease expiry at `src/background/queue.ts:48` through `src/background/queue.ts:53`. The stale-lease test at `tests/unit/worker.test.ts:115` would leave items stranded without this recovery. The implementation matches the claimed failure fix.

#### BG-03 — VERIFIED

`commitJob` uses revision/status compare-and-swap at `src/background/service-worker.ts:303` through `src/background/service-worker.ts:323`; the export loop rereads status after collection and before page transition at `src/background/service-worker.ts:421` through `src/background/service-worker.ts:451`. The acceptance pause/stop cases at `tests/acceptance/extension.spec.ts:281` through `tests/acceptance/extension.spec.ts:394` target the stale-snapshot scenario, but could not run in this sandbox. Static control flow prevents a stale page result from committing over a newer pause/stop revision.

#### BG-04 — PARTIAL

The navigation listener is installed before `tabs.update` at `src/background/service-worker.ts:349` through `src/background/service-worker.ts:375`, already-complete tabs are accepted at `src/background/service-worker.ts:376` through `src/background/service-worker.ts:379`, and tab removal rejects immediately at `src/background/service-worker.ts:368` through `src/background/service-worker.ts:380`. However, `sameUrl` compares only the `page` query parameter at `src/background/service-worker.ts:339` through `src/background/service-worker.ts:345`; a filter/query change can therefore be treated as the requested page, while a wrong redirect waits for timeout. Add a canonical full-query comparison (excluding only explicitly non-semantic parameters), reject unexpected navigation immediately, and bind the loop to a tab/job ownership token. The named export acceptance coverage exists but was blocked by port binding.

#### BG-05 — VERIFIED

`clearQueue` removes all statuses except a fresh sending lease at `src/background/queue.ts:60` through `src/background/queue.ts:65`; the popup invokes that operation at `src/popup/popup.html:125`, and queue/worker tests cover clear behavior at `tests/unit/queue.test.ts:61` through `tests/unit/queue.test.ts:65` and `tests/unit/worker.test.ts:123` through `tests/unit/worker.test.ts:131`. These tests would fail if sent/failed history were still retained by clear.

#### BG-06 — PARTIAL

The worker reserves identity before sending at `src/background/service-worker.ts:162` through `src/background/service-worker.ts:170`, confirms delivery only after the response at `src/background/service-worker.ts:246` through `src/background/service-worker.ts:250`, and releases a permanent failure at `src/background/service-worker.ts:250` through `src/background/service-worker.ts:258`. The dedupe test at `tests/unit/worker.test.ts:91` through `tests/unit/worker.test.ts:112` would fail if failed deliveries were permanently deduped, but no test covers clear/prune/restart. A queued item removed by clear/pruning can leave its dedupe identity reserved until TTL. Release reservations when queue items are discarded, or persist reservation ownership and reconcile it during startup/pruning.

#### BG-07 — PARTIAL

The day key is local-calendar based at `src/background/service-worker.ts:42` through `src/background/service-worker.ts:45`; admissions increment the queued counter and reject at the cap at `src/background/service-worker.ts:138` through `src/background/service-worker.ts:170`, and failed/delivered accounting is updated during flush at `src/background/service-worker.ts:244` through `src/background/service-worker.ts:258`. The status response still labels the queued/admission counter as `sentToday` at `src/background/service-worker.ts:268` through `src/background/service-worker.ts:278`, and the status map names no dedicated boundary/failure test. Add fake-clock tests around local midnight, explicit queued/delivered/failed semantics in the API/UI, and verify whether retries should consume admissions once or per attempt.

#### CONTENT-01 — VERIFIED

The route key includes pathname and sorted query parameters while dropping only session/tracking keys at `src/content/index.ts:360` through `src/content/index.ts:369`; pushState, replaceState, popstate, and polling feed a serialized remount chain at `src/content/index.ts:371` through `src/content/index.ts:402`. The navigation acceptance case exists at `tests/acceptance/extension.spec.ts:413` through `tests/acceptance/extension.spec.ts:432` and would fail if query-only navigation were ignored, but it could not execute here. Excluding known volatile parameters is an intentional identity choice and should be covered with a same-query/different-filter test.

#### CONTENT-02 — PARTIAL

List teardown removes the observer, interval, checkboxes, and classes at `src/content/index.ts:187` through `src/content/index.ts:203`, and the global message listener has a disposer at `src/content/index.ts:347` through `src/content/index.ts:356`; panel teardown removes its host at `src/content/ui.ts:108` through `src/content/ui.ts:111`. Async `decorate`/settings work can still resolve after disposal (`src/content/index.ts:96` through `src/content/index.ts:152`), and toast timers are not registered with the disposer (`src/content/ui.ts:115` through `src/content/ui.ts:121`). Add an AbortController or mount generation check after every await, cancel toast/poll work, and add repeated navigation/unload listener-count tests.

#### CONTENT-03 — PARTIAL

The auto-scroll loop waits for scroll settling and DOM quiet at `src/content/index.ts:223` through `src/content/index.ts:251`, with a bounded loop; next-page detection still falls back to row-count thresholds at `src/content/index.ts:257` through `src/content/index.ts:262`. The named delayed-row acceptance case exists at `tests/acceptance/extension.spec.ts:434` through `tests/acceptance/extension.spec.ts:444`, but its fixture swaps content in pre-existing rows rather than appending virtualized rows (`tests/fixtures/generators.mjs:39` through `tests/fixtures/generators.mjs:50`). Replace smooth scrolling with deterministic scroll steps where possible, require a stable end condition tied to the actual scroller, and add nested-scroller, no-op-scroll, late-append, and disabled-next fixtures.

#### PAR-01 — PARTIAL

SDUI fixtures and warnings were added, and grouping by date/heading is implemented in the profile parser at `src/content/parsers/profile.ts:105` through `src/content/parsers/profile.ts:209`; parser tests cover the samples at the claimed unit-test locations. The parser still relies on exact top-card/heading anchors, a ten-parent search limit, and leaf/anchor assumptions, while no-anchor grouping only warns (`src/content/parsers/profile.ts:181` through `src/content/parsers/profile.ts:188`). Add semantic container detection, localized heading fixtures, malformed/duplicate group tests, and an explicit confidence/error result instead of silently accepting guessed groups.

#### PAR-02 — PARTIAL

Search parsing now filters chatter and applies a location shape check at `src/content/parsers/search.ts:40` through `src/content/parsers/search.ts:57`, and the parser tests cover the added sample. It still treats `raw[0]` as the name and the first non-location body as the headline, so accessible-name/landmark order changes and localized chatter can produce incorrect canonical fields. Identify the profile link/name structurally, then test realistic localized rows with multiple badges, credentials, and reordered spans.

#### PAR-03 — VERIFIED

Sales Navigator experience parsing now isolates the experience container and recognizes nested `h2`/`h3` headings and grouped roles at `src/content/parsers/salesnav.ts:94` through `src/content/parsers/salesnav.ts:147`. The grouped/nested fixture and parser test cover the prior heading-loss/misassignment scenario; without the container/heading boundary logic, the grouped sample would collapse roles. Broader layout drift remains a maintenance risk, but the named prior failure is addressed.

#### PAR-04 — PARTIAL

Classic parsing now gives the current company precedence at `src/content/parsers/profile.ts:82` through `src/content/parsers/profile.ts:95`, matching the documented precedence. But excluded history still calls `querySelectorAll` over the entire history before slicing at `src/content/parsers/profile.ts:33`, and the SDUI path builds all leaves/groups before applying its limit at `src/content/parsers/profile.ts:226` through `src/content/parsers/profile.ts:284`. The existing tests at `tests/unit/profile.test.ts:61` through `tests/unit/profile.test.ts:68` validate output, not that excluded history is not read. Parse only the first current-role entry/container when the flag is false and add a fixture with conflicting later history plus a traversal spy.

#### PAY-01 — VERIFIED

The common envelope is built at `src/shared/mapping.ts:4` through `src/shared/mapping.ts:8` and applied to single/batch presets at `src/shared/mapping.ts:77` through `src/shared/mapping.ts:101`; search bodies also receive stable envelope fields at `src/shared/mapping.ts:107` through `src/shared/mapping.ts:120`. The mapping matrix tests at `tests/unit/mapping.test.ts:16` through `tests/unit/mapping.test.ts:31` would fail if a preset omitted the event/version/id contract. `isPayload` remains intentionally lightweight at `src/shared/mapping.ts:123` through `src/shared/mapping.ts:128`; full runtime validation is PAY-02/receiver responsibility.

#### PAY-02 — PARTIAL

Runtime lead validation is implemented at `src/shared/validate.ts:50` through `src/shared/validate.ts:85`, and settings are sanitized at `src/shared/settings.ts:39` through `src/shared/settings.ts:69`; the hostile-lead/settings tests would fail without the bounds and URL checks. However, several message paths still rely on TypeScript casts and do not enforce page-type/page-URL consistency, while persisted daily state is loaded as an unchecked cast at `src/background/service-worker.ts:55` through `src/background/service-worker.ts:75`. Add discriminated runtime schemas for every message and storage record, reject inconsistent source fields, and migrate/quarantine malformed stored values.

#### RCV-02 — VERIFIED

The receiver checks content length and byte counts, returns 413 for oversize bodies, and installs request error/timeout handling at `receiver/server.mjs:326` through `receiver/server.mjs:347`; the outer handler catches failures at `receiver/server.mjs:427` through `receiver/server.mjs:437`. The oversized/timeout robustness cases exist at `tests/unit/receiver.test.ts:88` through `tests/unit/receiver.test.ts:126` and would exercise the old connection-destroy/crash behavior, but the suite could not bind. Strengthen the oversized assertion from “connection reset or 413” to require the intended 413 response once the test can run.

#### RCV-03 — PARTIAL

Lead and search URLs are validated against the LinkedIn/loopback policy at `receiver/server.mjs:174` through `receiver/server.mjs:209` and `receiver/server.mjs:239` through `receiver/server.mjs:267`; namespaced event IDs are bounded/checked at `receiver/server.mjs:162` through `receiver/server.mjs:168`. `extractImport` accepts `search_url` using only `str()` at `receiver/server.mjs:269` through `receiver/server.mjs:275`, so a valid signed import can persist an arbitrary external URL; invalid page types are also nulled rather than rejected. Add one shared URL validator for lead/search/import provenance and reject or null unsafe import URLs with a regression test.

#### DEE-01 — PARTIAL

The play validates a bounded subset of fields and writes its audit identity before paid steps at `examples/deepline/linkedin-capture.play.ts:79` through `examples/deepline/linkedin-capture.play.ts:147`; stable-key construction is at `examples/deepline/linkedin-capture.play.ts:129` through `examples/deepline/linkedin-capture.play.ts:132`. But the validator spreads the original input back into the accepted object, leaving fields such as `schema_version`, `source`, `sent_at`, and `page_type` unvalidated, and the existing audit row is not used to short-circuit downstream enrichment (`examples/deepline/linkedin-capture.play.ts:134` through `examples/deepline/linkedin-capture.play.ts:224`). No executable test imports this example; it is outside the TypeScript project include. Replace spread-based validation with an allowlisted output, check existing status before paid work, and use an outbox/idempotent downstream key for retries.

#### TEST-01 — PARTIAL

The repository now has SDUI/messy fixtures and unit/acceptance coverage, including navigation, delayed rows, log, shadow, and concurrent-tab cases at `tests/acceptance/extension.spec.ts:413` through `tests/acceptance/extension.spec.ts:541`. However, the receiver setup failed before its 26 tests ran, acceptance failed before its first assertion because ports cannot bind, and the synthetic delayed fixture keeps rows in place instead of modeling appended/virtualized rows. Make receiver tests in-process or injectable, make acceptance use a permitted server adapter, and add assertions that fail when no real test body executes.

#### DOC-01 — PARTIAL

README language now describes best-effort behavior and gives an explicit safety warning at `README.md:139` through `README.md:159`, while the SPEC documents delivery and permission boundaries. The documentation still contradicts implementation: the SPEC describes `.lwe-root` at `docs/SPEC.md:70` through `docs/SPEC.md:80`, says Deepline receives no envelope at `docs/SPEC.md:323` through `docs/SPEC.md:329`, and retains an `activeTab` claim at `docs/SPEC.md:358` even though the mapping code emits an envelope and the permission was dropped. Reconcile docs with generated payloads/UI selectors and add a contract check that fails on drift.

#### PKG-01 — PARTIAL

`PRIVACY.md:8` through `PRIVACY.md:36` documents local storage, queue, dedupe, and outbound data, and the activeTab permission was removed; the pack script asserts the intended permissions/hosts. There is still no public privacy-policy URL/store listing artifact, and the local-only wording does not fully describe deployments using the receiver/Deepline integration. Publish a stable privacy/data-use document, link it from the extension metadata, and include the release artifact/check in CI.

### P2 findings

#### PAR-05 — PARTIAL

Name cleaning now removes zero-width/bidi text, known badges, credential suffixes, particles, and handles mononyms at `src/shared/normalize.ts:34` through `src/shared/normalize.ts:80`; the Unicode/credential tests at `tests/unit/normalize.test.ts:15` through `tests/unit/normalize.test.ts:72` would catch several original failures. The implementation is over-broad: any trailing emoji/flag is stripped at `src/shared/normalize.ts:11` through `src/shared/normalize.ts:23`, `MS`/`MA`/`BA` can be legitimate names at `src/shared/normalize.ts:28`, and leading particles such as `van Gogh` are split incorrectly at `src/shared/normalize.ts:68` through `src/shared/normalize.ts:80`. Preserve the raw full name, require structural evidence before removing badges, and add a locale/name corpus covering particles, credentials-as-names, Unicode, and emoji.

#### SEARCH-01 — PARTIAL

Sales Navigator expressions are bounded and recursively parsed at `src/shared/search.ts:44` through `src/shared/search.ts:124`; parameter decoding removes case-insensitive sensitive keys/duplicates at `src/shared/search.ts:19` through `src/shared/search.ts:41`, and the search tests cover encoded commas/nested filters. But the sent `search_url` is produced by `searchKey` at `src/shared/search.ts:161` through `src/shared/search.ts:176`, while the receiver’s duplicate redactor only removes `page`, `sessionid`, `_ntb`, and `trk` at `receiver/server.mjs:229` through `receiver/server.mjs:237`. The parser also stops scalar values at raw commas and is not a complete grammar for realistic future/lowercase expressions. Centralize canonical redaction, preserve only explicitly safe query keys, and add raw/encoded comma, nested, duplicate, lowercase, and all-sensitive-key tests.

#### RCV-04 — PARTIAL

The shared signing module documents and tests standard/LWE forms and bounded timestamps at `src/shared/signing.ts:27` through `src/shared/signing.ts:35` and `src/shared/signing.ts:74` through `src/shared/signing.ts:138`. The receiver nevertheless has a second decoder at `receiver/server.mjs:283` through `receiver/server.mjs:288` using permissive `Buffer.from` behavior, with no canonical padding/length validation and no shared conformance vectors. Move decoding into the shared contract (or duplicate strict vectors exactly), reject non-canonical encodings, and run receiver vectors in-process.

#### RCV-05 — PARTIAL

The receiver enables WAL/busy handling at `receiver/server.mjs:41` through `receiver/server.mjs:42`, suppresses ordinary logs with `LWE_QUIET` at `receiver/server.mjs:33`, and authenticated read endpoints are guarded at `receiver/server.mjs:314` through `receiver/server.mjs:318`. This reduces exposure but does not define retention/deletion/backup policy, and authenticated reads still return stored PII; on the extension side, log entries are bounded by count only at `src/shared/log.ts:40` through `src/shared/log.ts:65`, not by total bytes or message length. Document retention and deletion, cap total log bytes, and make log storage writes serialized or best-effort with explicit loss semantics.

#### DEE-02 — VERIFIED

The play no longer performs per-event DDL: its audit insert is at `examples/deepline/linkedin-capture.play.ts:134` through `examples/deepline/linkedin-capture.play.ts:147`, followed by enrichment/update statements at `examples/deepline/linkedin-capture.play.ts:213` through `examples/deepline/linkedin-capture.play.ts:224`; migration is separated as claimed. There is no named executable test because the example is not included in the project test/typecheck path. Add a smoke test if the example remains a supported release surface, but the original per-event DDL finding is fixed.

#### TEST-02 — PARTIAL

The worker tests now cover concurrent capture, leases, clear, and dedupe at `tests/unit/worker.test.ts:70` through `tests/unit/worker.test.ts:131`, and receiver tests include hostile URLs/headers. They do not cover service-worker suspension between awaits, export start races, redirect/query takeover, disposer cancellation, actual row insertion/virtualization, or all receiver payload presets; receiver and acceptance suites also did not execute in this environment. Add deterministic fake Chrome tabs/storage, fake clocks/alarms, abortable navigation/collection tests, and an in-process receiver preset matrix.

#### PKG-02 — PARTIAL

Committed icons/attribution and packaging assertions exist, and `node scripts/pack.mjs` passed. The build does not invoke the icon-generation path, the zip is not shown to be reproducible or signed, and the pack assertions do not establish a production host allowlist/provenance chain. Make icon generation/build inputs explicit, sort/archive deterministically, emit a manifest/checksum from CI, and assert production permissions/hosts.

#### DOC-02 — PARTIAL

The SPEC now labels live observations as dated/manual evidence at `docs/SPEC.md:145` through `docs/SPEC.md:164`, and acceptance criteria distinguish live evidence from fixtures. The claimed live metrics/layout evidence is still narrative without checked-in captures, query data, or a reproducible script; remove unsupported quantitative claims or publish immutable evidence and the exact collection procedure.

### P3 findings

#### QUALITY-01 — PARTIAL

CI runs typecheck, lint, tests, packaging, and a non-blocking npm audit warning at `.github/workflows/ci.yml:15` through `.github/workflows/ci.yml:23`; the pack script passed and typecheck passed. The current lint gate fails at `scripts/e2e-samples.mjs:78`, npm audit is advisory, and there is no strict runtime-schema/security smoke gate. Fix the unused variable, make required security/schema checks blocking, and ensure tests fail when receiver/acceptance setup cannot run.

#### QUALITY-02 — PARTIAL

The panel uses an explicit open shadow root at `src/content/ui.ts:50`, provides a region/heading/live status at `src/content/ui.ts:55` through `src/content/ui.ts:87`, and labels controls at `src/content/ui.ts:144` through `src/content/ui.ts:154`; acceptance checks the shadow UI at `tests/acceptance/extension.spec.ts:509` through `tests/acceptance/extension.spec.ts:520`. An open root is discoverable and mutable by page JavaScript, while row checkboxes and toasts remain in light DOM; no focus transfer/restore test covers route changes. Use ownership markers and defensive remounting (or a closed root where compatible), keep page-facing controls isolated, add focus management, and test page CSS/script tampering.

## New findings

### P1 — NF-01: concurrent `EXPORT_START` can overwrite the active job

`src/background/service-worker.ts:463` through `src/background/service-worker.ts:479` reads `existing` outside the lock, creates a job/tab, and only then writes the job under the lock. Two callers can both observe no active job, create separate tabs/loops, and let the last write win; `exportLoopRunning` at `src/background/service-worker.ts:398` then causes one loop to return while the orphaned tab continues. Atomically check-and-reserve the job under `withLock`, create/validate the tab as a state transition, and cancel/reconcile the loser; add a `Promise.all` start test.

### P1 — NF-02: export tab URL ownership is still insufficient

`sameUrl` at `src/background/service-worker.ts:339` through `src/background/service-worker.ts:345` ignores every query parameter except `page`, and the loop collects after navigation at `src/background/service-worker.ts:411` through `src/background/service-worker.ts:423`. A user or another extension can change the active search filters while preserving path/page, causing collection for a different search to be attributed to the job. Compare the complete canonical semantic query, reject redirects immediately, and use a content-side job nonce/expected URL handshake before accepting rows.

### P1 — NF-03: unsigned receiver mode is not development-gated

`receiver/server.mjs:27` enables unsigned requests solely from `LWE_ALLOW_UNSIGNED=1`, while startup only checks `!SECRET && !ALLOW_UNSIGNED` at `receiver/server.mjs:35` through `receiver/server.mjs:38`. The message says the flag is for local development, but production with that environment variable accepts unsigned POSTs. Require `NODE_ENV=development` plus loopback for unsigned mode, or use an explicit one-time local-only mode that cannot be enabled by a production deployment; add a production-env regression test.

### P1 — NF-04: import provenance accepts arbitrary URLs

`receiver/server.mjs:269` through `receiver/server.mjs:275` stores `i.search_url` after only length/type conversion, unlike the stricter search path at `receiver/server.mjs:239` through `receiver/server.mjs:249`. A signed caller can inject an external URL into imported-record provenance and later authenticated reads. Reuse the canonical LinkedIn/loopback validator for imports and test cross-origin, credential-bearing, and malformed import URLs.

### P1 — NF-05: search redaction is inconsistent and incomplete

The shared sensitive-key set is broader at `src/shared/search.ts:3` through `src/shared/search.ts:9`, but the receiver’s independently implemented `searchKey` at `receiver/server.mjs:229` through `receiver/server.mjs:237` removes only four exact key names. Tracking/session values such as `trkInfo`, `utm_*`, `midToken`, or differently encoded keys can remain in persisted `search_key` and extension log URLs. Use one URL parser/redactor in both paths, drop fragments and all sensitive keys case-insensitively (including duplicate/encoded names), and test the full list.

### P2 — NF-06: normalization deletes legitimate identity data

The blanket terminal emoji rule at `src/shared/normalize.ts:11` through `src/shared/normalize.ts:23`, credential-like tokens at `src/shared/normalize.ts:28`, and particle handling at `src/shared/normalize.ts:68` through `src/shared/normalize.ts:80` can turn legitimate names into different people or empty/incorrect first/last names. Preserve an unmodified source name, apply badge stripping only with structural evidence, and use locale-aware particle/credential heuristics with a confidence flag and a preservation corpus.

### P2 — NF-07: activity log can retain sensitive URLs and grow without a byte bound

The extension logs page/search URLs at `src/background/service-worker.ts:103`, `src/background/service-worker.ts:172`, `src/background/service-worker.ts:197`, and `src/background/service-worker.ts:234`; `redact` only redacts values whose key names look secret at `src/shared/log.ts:43` through `src/shared/log.ts:57`. `logEvent` stores `msg` without truncation and performs an unlocked read-modify-write at `src/shared/log.ts:68` through `src/shared/log.ts:79`; the 1,000-entry ring is not a total-byte limit. Redact URL query values through the shared search redactor, cap messages/serialized entries and total bytes, and serialize or explicitly tolerate concurrent log writes; add URL-value, long-error, and concurrent-writer tests.

### P2 — NF-08: content teardown does not cancel all asynchronous work

Disposers remove synchronous observers/listeners at `src/content/index.ts:187` through `src/content/index.ts:203`, but `decorate` and navigation setup can resume after disposal, and toast timers are created outside the disposer at `src/content/ui.ts:115` through `src/content/ui.ts:121`. The open shadow root at `src/content/ui.ts:50` and light-DOM row controls also allow page scripts/CSS to tamper with UI state. Add an AbortController/generation token checked after every await, register every timer, and test rapid route changes, unload, delayed responses, and page tampering.

### P2 — NF-09: fixture coverage does not model the claimed scrolling structures

The delayed fixture replaces innerHTML in existing rows at `tests/fixtures/generators.mjs:39` through `tests/fixtures/generators.mjs:50`; it has one results scroller and no true late row insertion, nested scroller, virtualization, or disabled-next control. The acceptance test can therefore pass while the production termination heuristic at `src/content/index.ts:223` through `src/content/index.ts:262` still misses real rows or over-fetches. Add fixtures for appended/removed rows, nested scrollers, no-op scrolling, delayed mutations after quiet, and explicit pagination state.

### P2 — NF-10: Deepline example documentation disagrees with emitted payloads

The example README says the play input is verbatim and has “No envelope” at `examples/deepline/README.md:37`, and the SPEC repeats that at `docs/SPEC.md:323` through `docs/SPEC.md:325`; `toDeeplineRow` actually emits `schema_version`, `event`, `event_id`, and `sent_at` at `src/shared/mapping.ts:49` through `src/shared/mapping.ts:63`. Update the docs/play schema to match the shipped payload, or deliberately strip the envelope for Deepline and add a cross-product contract test against the receiver/play input.

## Overall release recommendation

Do not release. The P0 legal finding remains only partially addressed, the receiver and acceptance suites did not execute in this environment, lint is failing, and the new P1 races/authorization/provenance issues affect correctness and security. A release candidate should first close NF-01 through NF-05, resolve LEG-01 with an explicit product/legal decision, make receiver/acceptance tests runnable or fail deterministically with a supported adapter, fix lint, and add regression tests for URL ownership, unsigned mode, import URLs, redaction, and all mapping presets.
