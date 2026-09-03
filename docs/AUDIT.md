# LinkedIn Webhook Exporter — adversarial audit

Audit date: 2026-09-03  
Scope: the complete repository at commit `d2b686d`, including `src/`,
`receiver/`, `examples/deepline/`, `scripts/`, fixtures and tests, generated
manifest output, `README.md`, `docs/SPEC.md`, and
`docs/ACCEPTANCE_TESTS.md`.

## Executive summary

- The extension has a useful, small architecture and sound baseline choices
  such as WebCrypto HMAC, `credentials: "omit"`, `redirect: "error"`,
  parameterized SQLite statements, text-only DOM rendering, and persisted
  queue bodies. Those choices are not enough to make the current release safe.
- P0 blockers: the reference receiver listens on all interfaces, exposes
  personal data without authentication, and deliberately accepts unsigned
  traffic when `LWE_SECRET` is absent; background storage read/modify/write
  races can bypass the daily cap/dedupe and overwrite queued work; malformed
  authenticated JSON can crash the receiver; and the core bulk/scrape behavior
  conflicts with LinkedIn's current published prohibition on browser
  extensions that scrape or automate the service.
- P1 correctness blockers include unrecovered `sending` queue items after a
  worker suspension, stale bulk-export state overwriting pause/stop, a race in
  tab-load detection, an inverted “clear all” filter, marking a lead deduped
  before delivery succeeds, and SPA handling that keys only on pathname.
- The 2026 SDUI parser is effectively untested: every checked fixture is the
  classic layout. Several SDUI strategies assume exact heading/anchor shapes
  and can produce empty or shifted records when optional lines or nested
  elements differ.
- URL canonicalizers accept hostile origins and nested `/in/...` paths as
  LinkedIn identities. This is both a data-integrity problem and a dangerous
  assumption when DOM input is treated as trusted.
- The bundled receiver verifies signatures but does not validate payload types
  or schema before calling `JSON.parse` on attacker-controlled fields. Its
  read endpoints return stored PII with no authentication; enabling CORS makes
  browser exfiltration trivial.
- The Deepline example safely escapes SQL string literals, but it does not
  perform the runtime validation its comments/docs promise, performs external
  enrichment/dataset writes before the import audit write, and submits DDL on
  every event. It is not an atomic or fully idempotent pipeline.
- Verification results: `npm run typecheck` and `npm run build` pass. `npm
  test` reaches 59 passed and 5 skipped, but the receiver suite cannot bind
  `0.0.0.0` in this sandbox. `npm run test:acceptance` cannot get past the
  fixture server's loopback bind (`listen EPERM`), so no acceptance behavior
  was actually exercised here. The report treats those as verification gaps,
  not as passing tests.
- Finding count: 4 P0, 25 P1, 8 P2, and 2 P3.

## Findings index

| ID | Severity | Area | File:line | Title |
|---|---|---|---|---|
| SEC-01 | P0 | Receiver/security | `receiver/server.mjs:16-20,157-176,223-224` | Reference receiver exposes PII and defaults to an unsafe network posture |
| BG-01 | P0 | Background | `src/background/service-worker.ts:60-117,143-160` | Concurrent captures race daily-cap, dedupe, and queue state |
| RCV-01 | P0 | Receiver | `receiver/server.mjs:73-83,125-155,201-204` | Untrusted payload fields can throw outside the error boundary and kill the server |
| LEG-01 | P0 | Terms/release | `README.md:15-24,63-72,127-134`; `docs/SPEC.md:82-125` | The product’s advertised bulk DOM scraper conflicts with LinkedIn’s published policy |
| SEC-02 | P1 | Extension security | `src/content/index.ts:34-35,239-242`; `src/background/service-worker.ts:325-391` | Secrets are sent to content scripts and message handlers do not enforce a trust boundary |
| SEC-03 | P1 | URL/data integrity | `src/shared/normalize.ts:36-55,70-94`; `src/content/parsers/*` | Canonicalizers accept arbitrary hosts and over-broad paths |
| SEC-04 | P1 | Permissions | `src/options/options.ts:68-95`; `src/shared/settings.ts:18-33` | “Send test” persists/uses settings without validation or host permission |
| SEC-05 | P1 | Signing/replay | `src/shared/signing.ts:22-30,63-86`; `receiver/server.mjs:105-123,194-196` | Freshness and replay guarantees are split, loose, and undocumented at the sender boundary |
| BG-02 | P1 | Background/MV3 | `src/background/service-worker.ts:120-141,393-401` | A suspended worker can strand items permanently in `sending` |
| BG-03 | P1 | Bulk export | `src/background/service-worker.ts:255-283,359-381` | Stale export snapshots can undo pause/stop and continue after user action |
| BG-04 | P1 | Bulk export | `src/background/service-worker.ts:197-224,250-262` | Tab-complete waiting has a missed-event race and weak tab ownership |
| BG-05 | P1 | Queue/UI | `src/background/queue.ts:40-43`; `src/popup/popup.ts:92-93` | “Clear history” keeps only `sending` items |
| BG-06 | P1 | Dedupe/delivery | `src/background/service-worker.ts:106-115` | Failed deliveries are marked deduped before they ever succeed |
| BG-07 | P1 | Daily cap | `src/background/service-worker.ts:20-45,60-89,112-117` | Daily cap uses UTC and charges queued/failed captures |
| CONTENT-01 | P1 | Content script | `src/content/index.ts:285-309` | SPA detection ignores query-string and `replaceState` navigation |
| CONTENT-02 | P1 | Content script | `src/content/index.ts:84-163,238-283`; `src/content/index.ts:300-309` | Observers, intervals, and listeners leak across SPA mounts |
| CONTENT-03 | P1 | Bulk capture | `src/content/index.ts:176-211` | Smooth scrolling and row-count fallback can miss rows or paginate incorrectly |
| PAR-01 | P1 | Parsers/SDUI | `src/content/parsers/profile.ts:79-186`; `src/content/parsers/search.ts:26-70` | SDUI grouping and ordered-line assumptions are brittle and untested |
| PAR-02 | P1 | People search | `src/content/parsers/search.ts:40-63` | Text-order parsing treats optional UI chatter as canonical fields |
| PAR-03 | P1 | Sales Navigator | `src/content/parsers/salesnav.ts:105-134` | Grouped experience parsing loses headings and misassigns roles |
| PAR-04 | P1 | Profile parser | `src/content/parsers/profile.ts:201-228` | Include flags still parse full history and classic fallback order contradicts the spec |
| PAY-01 | P1 | Payload/schema | `src/shared/mapping.ts:69-115`; `src/shared/types.ts:69-124` | Presets do not share a stable event/version contract |
| PAY-02 | P1 | Payload validation | `src/shared/mapping.ts:118-120`; `src/background/service-worker.ts:60-104` | Runtime settings and incoming records are trusted by TypeScript casts only |
| RCV-02 | P1 | Receiver robustness | `receiver/server.mjs:179-220` | Body-limit handling destroys connections and has no request error boundary |
| RCV-03 | P1 | Receiver schema/security | `receiver/server.mjs:125-155` | Receiver stores attacker-controlled types/URLs and uses an unsafe identity fallback |
| DEE-01 | P1 | Deepline example | `examples/deepline/linkedin-capture.play.ts:66-110,112-166` | Claimed validation/idempotency is not enforced and side effects are non-atomic |
| TEST-01 | P1 | Tests | `tests/fixtures/*`; `tests/unit/receiver.test.ts:26-40`; `docs/ACCEPTANCE_TESTS.md:69-81` | The test suite cannot substantiate SDUI/live/receiver claims |
| DOC-01 | P1 | Documentation | `README.md:43-51,127-134`; `docs/SPEC.md:120-143,254-260,323-333` | Documentation overstates safety, durability, and verified compatibility |
| PKG-01 | P1 | Packaging/privacy | `scripts/build.mjs:19-72`; `README.md:127-138` | Chrome Web Store privacy/release disclosures are incomplete |
| PAR-05 | P2 | Normalization | `src/shared/normalize.ts:3-32,96-112`; `src/content/parsers/common.ts:49-57` | Name cleaning and headline splitting fail legitimate common inputs |
| SEARCH-01 | P2 | Search provenance | `src/shared/search.ts:3-45,48-87` | Search parsing is lossy and can preserve sensitive session/query data |
| RCV-04 | P2 | Crypto implementation | `src/shared/signing.ts:38-60,82-86`; `receiver/server.mjs:100-123` | Standard secret/timestamp handling is permissive and duplicated |
| RCV-05 | P2 | Receiver privacy/concurrency | `receiver/server.mjs:157-177,218-224` | PII is logged/read without auth and SQLite deployment assumptions are undocumented |
| DEE-02 | P2 | Deepline example | `examples/deepline/linkedin-capture.play.ts:63-64,142-162,167-178` | Per-event DDL and multi-statement SQL increase cost and operational fragility |
| TEST-02 | P2 | Tests | `tests/acceptance/extension.spec.ts:268-275`; `tests/unit/*.test.ts` | Timing-heavy tests omit core negative/lifecycle cases |
| PKG-02 | P2 | Packaging/reproducibility | `package.json:10-17`; `scripts/icons.mjs:1-21`; `src/brand/*` | Build, icon generation, provenance, and release artifact policy are disconnected |
| DOC-02 | P2 | Documentation | `docs/SPEC.md:145-177,181-228`; `docs/RESEARCH.md:3-7,53-57` | “Verified live” and market/risk claims are not reproducible evidence |
| QUALITY-01 | P3 | Quality gates | `package.json:10-17`; `.github/workflows/ci.yml:15-20` | No lint, schema compatibility, or security regression gate |
| QUALITY-02 | P3 | UI resilience | `src/content/ui.ts:10-62`; `src/content/content.css:1-26` | The panel has weak accessibility/isolation guarantees |

## Detailed findings

### SEC-01 — P0 — Reference receiver exposes PII and defaults to an unsafe network posture

Location: `receiver/server.mjs:16-20,157-176,223-224`.

`server.listen(PORT)` has no host, so Node binds the reference server to the
wildcard address. The three read endpoints (`/leads`, `/imports`, `/searches`)
have no authentication, return up to hundreds of records, and include names,
URLs, locations, captured-by labels, custom fields, and provenance. The server
also treats an empty `LWE_SECRET` as an explicit unsigned mode at line 107.
`LWE_CORS=1` then adds `access-control-allow-origin: *` to those endpoints.
This makes a common “quick local receiver” command a LAN data service; on a
host/container with a public interface, any client can read or write data.

Why it matters: the receiver is documented as a reference implementation and
users are told to run it with only `LWE_SECRET` as optional setup. A leaked
lead database and unauthenticated ingestion are materially worse than a local
development inconvenience.

Fix:

```js
const HOST = process.env.LWE_HOST ?? "127.0.0.1";
if (!SECRET && process.env.NODE_ENV !== "development") {
  throw new Error("LWE_SECRET is required");
}
// Require a separate admin token for read endpoints, or remove them from the
// reference receiver entirely.
server.listen(PORT, HOST, () => { /* ... */ });
```

Require an explicit `LWE_ALLOW_UNSIGNED=1` for development, authenticate all
read routes with a separate admin credential, disable them by default, and
never use wildcard CORS. Add an integration test asserting the bind address,
401 on unauthenticated reads, and rejection when no secret is configured.

### BG-01 — P0 — Concurrent captures race daily-cap, dedupe, and queue state

Location: `src/background/service-worker.ts:60-117,143-160`.

`handleCapture` and `handleSearchCapture` independently load, mutate, and save
whole objects in `chrome.storage.local`. There is no mutex, version check, or
transaction. Two content-script messages can both observe the same daily count
and remaining capacity, both observe the same lead as unseen, append to their
own queue snapshot, and then overwrite one another. The final daily count can
under-count while more than the configured cap was queued, or one queued batch
can disappear. The same issue exists between capture and `flush`, which writes
whole queue arrays at lines 131/135 while a capture writes at line 115.

Why it matters: the daily cap and local dedupe are the primary safety and
correctness guardrails. This is a practical race during multi-select, export,
retry, or two tabs—not a theoretical storage API concern.

Fix by serializing all queue/dedupe/daily mutations in one service-worker
mutex, and hold the lock across the read/validate/mutate/write sequence. A
persisted revision can defend against worker re-entry, but it must not be a
blind last-write-wins replacement. Prefer separate per-key records or an
IndexedDB transaction for a durable compare-and-swap. Recompute the cap from
the same locked record and add tests that issue `Promise.all` captures with
overlapping leads and a nearly exhausted cap.

### RCV-01 — P0 — Untrusted payload fields can throw outside the error boundary and kill the server

Location: `receiver/server.mjs:73-83,125-155,201-204`.

`extractLeads(payload)` and `extractSearch(payload)` run before the `try` at
line 205. A signed request with a malformed but authenticated body can make
them throw: `normFlat` calls `JSON.parse(r.experience_json)` and
`JSON.parse(r.education_json)` without catching; `extractSearch` passes any
truthy `s.search_url` to `searchKey`, which assumes `.indexOf`; and
`Object.entries` assumes `payload.custom` is an object. `payload.leads` can
also be a non-object array whose items make `norm` access fail. These inputs
are reachable by a compromised sender, a shared-secret holder, or a test
endpoint receiving a malformed signed request.

Why it matters: the exception occurs in the HTTP `end` callback with no
request-level catch. The process can terminate, taking every webhook and read
endpoint down. Signature verification authenticates the sender; it does not
make JSON trustworthy.

Fix: validate a bounded schema before extraction, put parsing and the entire
transaction inside one `try`, and return 400 for malformed fields. Never parse
embedded JSON without a safe helper:

```js
function jsonArray(v) {
  if (v == null) return [];
  if (typeof v !== "string" || v.length > 200_000) throw new Error("bad array");
  const x = JSON.parse(v);
  if (!Array.isArray(x)) throw new Error("bad array");
  return x;
}
```

Use explicit object/string/number guards and add fuzz-style tests for every
shape accepted by `extractLeads`, `extractSearch`, and `extractImport`.

### LEG-01 — P0 — The product’s advertised bulk DOM scraper conflicts with LinkedIn’s published policy

Location: `README.md:15-24,63-72,127-134`; `docs/SPEC.md:82-125`.

The extension injects controls, smooth-scrolls lazy results, navigates through
pages, and sends up to 2,500 records. The docs frame this as a safer version
of competing exporters and suggest a 50–100 capture/day community threshold.
LinkedIn’s current [User Agreement](https://www.linkedin.com/legal/user-agreement)
prohibits developing or using browser plugins/add-ons or other processes to
scrape/copy the Services and prohibits unauthorized automated methods. Its
[automated activity guidance](https://www.linkedin.com/help/linkedin/answer/a1340567/automated-activity-on-linkedin)
and [prohibited software guidance](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions)
also say third-party extensions that scrape, modify appearance, or automate
activity can lead to restriction. The code’s random 4–9 second delay and
daily cap do not create a safe harbor.

Why it matters: publishing this as an exporter can expose users to account
restriction, contractual, privacy, and employment/compliance consequences.
The current wording materially understates the risk and gives a false sense
that a numeric threshold is endorsed.

Fix before publishing: obtain legal/product approval for the intended use,
remove or disable bulk navigation/export unless an authorized LinkedIn API or
written permission covers it, and make the install/readme warning explicit
that no cap or pacing guarantees compliance or prevents restriction. Remove
competitor-parity language that normalizes prohibited behavior. If the product
is retained for a permitted environment, document the authorization and limit
the build/configuration to that environment.

### SEC-02 — P1 — Secrets are sent to content scripts and message handlers do not enforce a trust boundary

Location: `src/content/index.ts:34-35,239-242`; `src/background/service-worker.ts:325-391`.

`GET_SETTINGS` returns the complete `Settings` object, including
`signingSecret` and `authHeaderValue`, to a content script injected on every
matched LinkedIn page. The content script only needs non-secret capture flags
and export timing. The background message switch also does not validate
sender URL, tab, page type, message shape, or authority before handling
`CAPTURE`, `SEARCH_CAPTURE`, `EXPORT_START`, and state-changing commands.

The isolated world prevents ordinary page JavaScript from directly reading
content-script variables, but it is not a reason to distribute secrets into a
page-facing execution context. A future content-script DOM-XSS, compromised
extension component, or unsafe cross-context refactor would turn this into
secret disclosure; unvalidated messages also make such a component able to
forge captures or start exports.

`chrome.storage.local` is profile-local, not a dedicated secret vault or an
encryption guarantee; anyone with access to the browser profile or an
extension compromise should be treated as able to recover it. The current
design is acceptable only if that threat is disclosed and the page-facing
surface is kept redacted.

Fix: expose a redacted `ContentSettings` response; keep signing/auth values
inside the worker/options context. Validate `sender.id === chrome.runtime.id`,
require expected extension pages for privileged commands, validate all message
fields at runtime, and for page-originated commands require a supported
`sender.tab.url` whose pathname matches the message. Treat all DOM-derived
records as untrusted input.

### SEC-03 — P1 — Canonicalizers accept arbitrary hosts and over-broad paths

Location: `src/shared/normalize.ts:36-55,70-94`; callers in
`src/content/parsers/profile.ts:168,212`, `search.ts:42`, and
`salesnav.ts:49-55,162-165`.

`canonicalizeLinkedInUrl`, `canonicalizeSalesNavUrl`, and
`canonicalizeCompanyUrl` parse a URL but never validate its hostname. For
example, a DOM href such as `https://evil.example/in/alice` becomes
`https://www.linkedin.com/in/alice`; an href under `/company/` on an arbitrary
origin is treated likewise. `canonicalizeLinkedInUrl` also matches the prefix
`/in/<segment>` without requiring the path to end there, so
`/in/alice/details/experience` becomes Alice’s canonical profile.

Why it matters: a page/DOM alteration can create false identities, poison
dedupe and receiver upserts, and cause enrichment to run against a person
selected by an attacker. It also contradicts the parser’s strict profile-route
classification.

Fix: parse and allow only LinkedIn’s documented host set (`www.linkedin.com`,
`linkedin.com`, and explicitly approved regional subdomains), reject userinfo,
credentials, unexpected ports, and suffix path segments, and validate IDs/slugs
against a conservative grammar. Apply the same host policy to company and
Sales Navigator URLs. Add hostile-host, nested-path, encoded-slash, and
unicode tests.

### SEC-04 — P1 — “Send test” persists/uses settings without validation or host permission

Location: `src/options/options.ts:68-95`; `src/shared/settings.ts:18-33`.

The Save path validates the URL and requests the optional host permission, but
the Test handler calls `saveSettings(read())` directly and never validates the
URL or calls `ensureHostPermission`. On a fresh install, a user can click Test
with an HTTPS endpoint that has not been granted; after changing an already
granted URL, the test can target a new host without requesting it. The test
also persists any URL accepted by the UI before the worker’s later validation.
Header names and values are not validated either, so newline/control input
turns into a repeated retryable fetch error or browser header exception.

Fix: share one `validateAndAuthorizeSettings` path between Save and Test;
request permission from the explicit Test gesture before sending; validate
header name/value with the `Headers` constructor and reject forbidden names;
do not persist a failed test configuration. Add tests for fresh-host Test,
host change, invalid URL, and invalid header values.

### SEC-05 — P1 — Freshness and replay guarantees are split, loose, and undocumented at the sender boundary

Location: `src/shared/signing.ts:22-30,63-86`; `receiver/server.mjs:105-123,194-196`.

The sender correctly signs the exact stored body and refreshes the timestamp
on retry. However, the shared LWE verifier accepts any finite numeric
timestamp, including fractional or negative values, while the Standard
receiver requires digit-only timestamps. The shared verifier has no event-id
replay store; the receiver alone detects event-id duplicates, and it chooses
the body’s `event_id` before the signed header IDs. The receiver’s replay check
is also an application policy rather than part of the reusable verification
contract.

This is not a cryptographic break when the bundled receiver is configured
correctly, but it is easy for downstream implementers to call
`verifySignature` and believe the result provides uniqueness. Timestamp
freshness prevents old replay only within the tolerance window; it does not
prevent immediate replay.

Fix: require integer Unix seconds in both schemes, require a bounded event-id
grammar and equality between body/header IDs, and document that HMAC
verification is authenticity only. Provide a reusable nonce/event store with
atomic insert-before-process semantics and test concurrent same-event
requests, fractional timestamps, missing IDs, and multiple Standard signature
versions.

### BG-02 — P1 — A suspended worker can strand items permanently in `sending`

Location: `src/background/service-worker.ts:120-141,393-401`.

`flush` writes an item as `sending` before awaiting `fetch`. If MV3 suspends or
the browser terminates the worker after that write and before the result write,
the item remains `sending`. `due()` excludes it, `nextWake()` excludes it,
`onStartup` only calls `flush`, and no recovery converts stale `sending` items
back to `pending`. The job can silently lose delivery forever.

Fix: store `sendingAt`/lease data and recover expired leases on worker startup
and before flush. Increment attempts atomically when claiming an item; on
lease expiry requeue or fail according to the retry policy. Add a test that
seeds a stale `sending` item, starts the worker, and verifies it is retried.

### BG-03 — P1 — Stale export snapshots can undo pause/stop and continue after user action

Location: `src/background/service-worker.ts:255-283,359-381`.

The loop loads `job` at line 243, checks its status after collection at line
262, then calls asynchronous `handleCapture` at line 271 and finally applies
`afterPage(job, ...)` using that old object. A user can pause or stop during
`handleCapture` (or while a response is being committed); the control handler
writes the terminal/paused job, then line 280 overwrites it with the stale
running snapshot. The same race can archive a job while the loop is about to
save another page.

Fix: use a persisted job revision/compare-and-swap and re-read immediately
before applying page results. If status is no longer `running`, discard the
page transition. Make stop set a cancellation token checked after every await;
do not rely on an in-memory `exportLoopRunning` flag for durable state. Add
stop/pause-at-each-await tests.

### BG-04 — P1 — Tab-complete waiting has a missed-event race and weak tab ownership

Location: `src/background/service-worker.ts:197-224,250-262`.

`waitForTabComplete` attaches `tabs.onUpdated` only after `tabs.update` has
resolved and never checks the current tab status. A fast navigation can emit
`status: complete` before the listener is attached, forcing a 30-second
timeout; collection then races a page that may not have the content script.
For a newly created tab, the loop can similarly skip waiting when `tab.url`
already equals the target. There is no `tabs.onRemoved` listener and no check
that an external navigation has not taken over the tab.

Fix: read `tabs.get` and accept an already-complete matching URL, attach the
listener before navigation where possible, resolve on matching URL plus
complete status, and reject immediately on tab removal or unexpected URL.
Record an ownership token and either use a dedicated tab or clearly warn that
the current tab will be navigated. Test fast completion, slow completion,
redirect, tab close, and manual navigation.

### BG-05 — P1 — “Clear history” keeps only `sending` items

Location: `src/background/queue.ts:40-43`; `src/popup/popup.ts:92-93`.

`filterByStatus(items, "all")` returns `items.filter(i => i.status ===
"sending")`. The popup sends `status: "all"` for “Clear history”, so pending,
sent, and failed items are removed but in-flight items are retained. A retained
`sending` item can also become the permanent stuck state described in BG-02.
The function’s `sent` and `failed` branches happen to remove the requested
status, making the `all` inversion easy to miss.

Fix: define the operation explicitly (`clearQueue()` returning `[]`, or
`filterByStatus` returning `[]` for `all`) and decide separately whether an
active `sending` request may be cancelled. Test all four statuses and the
actual popup command.

### BG-06 — P1 — Failed deliveries are marked deduped before they ever succeed

Location: `src/background/service-worker.ts:106-115`.

The code writes every accepted lead into the dedupe map at line 112, before
`flush` attempts the request. A permanent 401, max-attempt failure, queue
eviction, or browser shutdown leaves the identity suppressed for the full TTL.
The UI then reports “already sent” even though no receiver accepted it.

Fix: reserve an in-flight identity separately from `sent`; mark `sent` only
after a successful 2xx response, or make the reservation point to the queue
item and clear it on permanent failure. Keep explicit force-resend behavior.
Test recapture after 4xx, after max retries, after queue prune, and after a
worker restart.

### BG-07 — P1 — Daily cap uses UTC and charges queued/failed captures

Location: `src/background/service-worker.ts:20-45,60-89,112-117`.

`today()` uses `toISOString().slice(0, 10)`, so the cap resets at UTC midnight,
not the operator’s local day. The UI labels the value “today” without exposing
that convention. More importantly, `daily.count` is incremented when a lead is
accepted into the queue, before any webhook response; permanent 4xx failures,
queue loss, and a worker crash still consume the cap. A partial bulk page is
charged by the truncated leads, while skipped duplicates are not. These may be
reasonable policy choices, but they are not stated and can surprise operators
working across time zones or recovering failed deliveries.

Fix: choose and document UTC or a configured/user-local timezone, store the
boundary explicitly, and distinguish `captured`, `queued`, `attempted`, and
`delivered` counters. If the product intends to limit LinkedIn actions, count
successful capture/queue admission once under the BG-01 lock; if it intends to
limit accepted delivery, provide a failed-send recovery policy. Add tests at
the exact UTC/local boundary and for partial, duplicate, retry, and permanent
failure cases.

### CONTENT-01 — P1 — SPA detection ignores query-string and `replaceState` navigation

Location: `src/content/index.ts:285-309`.

`currentPath` stores only `location.pathname`. Navigating from one people or
Sales Navigator search to another query on the same pathname does not boot a
new page, so old row maps, selections, title/count, and parsed identities can
remain attached to the new DOM. The code patches `pushState` and listens to
`popstate`, but not `replaceState`; the 1.5-second poll also compares only
pathname. Bulk exports and manual sends can therefore use stale page state.

Fix: compare `location.href` components relevant to the page (at minimum
pathname + search, excluding only known tracking parameters), patch both
history methods, and use a single navigation controller. Tear down the old
mount before booting the new route. Add same-path/different-query and
`replaceState` acceptance tests.

### CONTENT-02 — P1 — Observers, intervals, and listeners leak across SPA mounts

Location: `src/content/index.ts:84-163,238-283,300-309`.

Each list setup creates a `MutationObserver` that is never disconnected; each
export-control setup can create a `setInterval` that is not cleared when the
panel is removed; each single-page setup adds a `runtime.onMessage` listener
that is never removed. Navigating repeatedly creates multiple observers and
listeners retaining old row maps and DOM nodes. Old observers can decorate a
new route with the old page type, while old intervals keep polling state.

Fix: make every setup return a disposer and keep one active controller. Call
`disconnect`, `clearInterval`, remove runtime/DOM listeners, and cancel pending
debounce timers during navigation. Scope observers to the results container
instead of `document.body`. Add a navigation stress test that counts observers,
listeners, DOM checkboxes, and sends after 20 route changes.

### CONTENT-03 — P1 — Smooth scrolling and row-count fallback can miss rows or paginate incorrectly

Location: `src/content/index.ts:176-211`.

`autoScroll` issues smooth scroll commands and samples after a fixed 700–1000
ms, without waiting for the scroll animation or a DOM stabilization condition.
It treats three equal row counts at the bottom as stable, but a delayed lazy
render can arrive after the last sample. If the selected scroller has no
working `scrollTo`, it loops 40 times and may still parse only the visible
rows. `detectHasNext` falls back to `rowCount >= 10` for people search and 25
for all other list types, so a full final page with no detectable pagination
control causes an extra request; a partial page caused by missed lazy rows
causes a premature stop.

Fix: use instant controlled scroll increments where possible, await scroll
position changes, debounce mutations, and require a quiet period plus a
bounded maximum. Prefer an explicit pagination state/disabled attribute; use
row count only as a conservative diagnostic, not proof of another page. Add
fixtures for delayed rows, nested scrollers, missing Next, disabled Next, and
partial pages.

### PAR-01 — P1 — SDUI grouping and ordered-line assumptions are brittle and untested

Location: `src/content/parsers/profile.ts:79-186`; `src/content/parsers/search.ts:26-70`.

The SDUI profile detector requires no `main h1` and a top-card ID ending in
`Topcard`. It then finds a heading by exact text, climbs at most ten parents,
and groups leaves by the absolute anchor URL. Any wrapper that changes the
anchor boundary, a translated heading, an entry without a company/school
anchor, or a nested unrelated link changes grouping. A no-anchor entry gets a
new group for every leaf (`noanchor:${out.length}`), which turns one job into
multiple malformed experiences. `sduiExperience` assumes line 0 is a title,
line 1 is a company only when the date is at index 2, and the first experience
is current.

The people-search SDUI path has the same “whole card in profile link” premise,
but no role/name anchor or text-node filtering beyond a few action labels.

Fix: add explicit SDUI fixtures for optional degree, missing company, translated
labels, nested spans, grouped roles, lazy card wrappers, and duplicate hidden
text. Parse semantic relationships/attributes where available, normalize
accessible-name text, and return a confidence/error signal rather than a
plausible wrong record.

### PAR-02 — P1 — Text-order parsing treats optional UI chatter as canonical fields

Location: `src/content/parsers/search.ts:40-63`.

The SDUI people-search parser assumes `lines[0]` is the name, the first degree
line divides metadata from body, `body[0]` is the headline, and `body[1]` is
location. Mutual connections are the only later stop condition. “Open to
work”, “Follow”, a pronoun line, “View profile”, a shared school, follower
counts, or a translated connection label can shift those positions. With no
degree, a card containing a name, headline, and location works by accident;
with an extra line the headline/location are wrong while the record remains
sendable.

Fix: identify the profile link’s accessible name, degree with a locale-aware
token map, and field containers/landmarks before using order. Reject or mark
low-confidence cards when a location cannot be distinguished. Add negative
fixtures with every optional line and non-English labels.

### PAR-03 — P1 — Grouped experience parsing loses headings and misassigns roles

Location: `src/content/parsers/salesnav.ts:105-134`.

`lines` contains only leaf elements. If the company `<h2>` or role `<h3>` wraps
text in a span, the heading itself is not a leaf and `h2`/`h3` are absent from
the metadata. The parser then treats the first leaf as a title or falls back
to a non-role line. When multiple roles are present, `findIndex` is called
twice and the slice boundaries are based on leaf ordering, not role containers;
dates or locations can be attached to the wrong role. The section is also
selected by an ID/class substring and only rows whose class contains
`experience-entry` are considered.

Fix: parse each experience entry by its role/company container, use
`textContent` from heading elements whether or not they have child spans, and
bound each role by the next role container. Add a grouped fixture with nested
heading spans, total tenure, overlapping dates, and missing location.

### PAR-04 — P1 — Include flags still parse full history and classic fallback order contradicts the spec

Location: `src/content/parsers/profile.ts:218-228`; spec
`docs/SPEC.md:173-177`.

When `includeExperience` is false, `experience` is first set to `[]`, but
`fullExperience` immediately calls `parseExperience(doc)` again to derive the
current title/company. This still traverses and reads the entire history and
can be expensive on a large profile; it also makes the privacy meaning of the
flag ambiguous. In the classic parser, company selection is current-company
button, then experience, then headline, while the spec says current title and
company come from experience first, then current-company control, then
headline. The fixture has equal values and hides the discrepancy.

Fix: add a dedicated current-role parser that reads only the top card/control
when history is excluded, and make the documented precedence match the code.
Test conflicting top-card/company/experience values and assert that excluded
history is not traversed or emitted.

### PAY-01 — P1 — Presets do not share a stable event/version contract

Location: `src/shared/mapping.ts:69-115`; `src/shared/types.ts:69-124`.

Generic bodies carry `schema_version: "1"`, nested `source`, and `custom`.
Flat single bodies omit `event` and `schema_version`; flat/deepline batch
bodies omit both `schema_version` and `source`, put import data both in the
envelope and each row, and rely on row-level `page_url`/`page_type`. Search
flat/deepline bodies likewise omit `schema_version` and use
`source_page_url` rather than the lead mapping’s `page_url`. `isPayload` only
checks `schema_version` and therefore rejects valid flat/deepline events while
accepting any object that happens to set it to `"1"`.

Why it matters: consumers cannot negotiate versions or branch consistently,
and the docs’ “stable payload” claim is false across presets.

Fix: publish a versioned envelope for every event, even when the data body is
flat; define exact schemas for single, batch, and search; either standardize
`source`/`custom` or explicitly version their flattened names. Use runtime
schema validation and contract tests that serialize each preset and replay it
through the reference receiver.

### PAY-02 — P1 — Runtime settings and incoming records are trusted by TypeScript casts only

Location: `src/shared/mapping.ts:118-120`; `src/background/service-worker.ts:60-104`.

`getSettings` merges arbitrary stored data into defaults without validating
types/ranges/enums. The options page casts select values to unions but storage
can contain invalid presets, negative/NaN caps, malformed custom objects, or
an auth header name. `handleCapture` trusts the message’s `pageType`, URLs,
lead arrays, and lead field types. A non-empty object can pass the name filter;
later `dedupeKey`, `JSON.stringify`, or the receiver can fail or produce bad
identity data.

Fix: validate/migrate settings on read and clamp every numeric field; validate
messages and `LeadRecord` at the worker boundary; enforce URL/page-type
consistency; reject records without a usable identity/name with a structured
error. Keep TypeScript types as compile-time help, not runtime validation.

### RCV-02 — P1 — Body-limit handling destroys connections and has no request error boundary

Location: `receiver/server.mjs:179-220`.

The receiver accumulates a UTF-8 stream into a JavaScript string and calls
`req.destroy()` when `raw.length > MAX_BODY`. It does not send 413, stop all
work for the request, handle `aborted`/`error`, or bound by bytes (multibyte
UTF-8 characters can exceed the intended 1 MB). Clients see a reset, logs do
not explain the rejection, and repeated oversized connections can still waste
resources. Exceptions in the data/end callbacks are not uniformly caught.

Fix: reject an oversized `Content-Length` early, count bytes from Buffers,
stop reading and return 413 cleanly, set a request timeout, and attach
`req.on("error")`. Put all per-request parsing/DB work inside a catch that
cannot terminate the process. Add oversized, chunked, aborted, invalid UTF-8,
and slow-client tests.

### RCV-03 — P1 — Receiver stores attacker-controlled types/URLs and uses an unsafe identity fallback

Location: `receiver/server.mjs:125-155`.

The receiver normalizes with nullish coalescing but does not enforce strings,
URL origins, allowed page types, array shapes, date formats, or bounded field
lengths. `dedupeKey` falls back to a case-folded `full_name|company_name`, so
missing URLs cause unrelated people with the same name/company to merge and a
malformed type can throw or become `String([object Object])`. The stored
`page_url`, `linkedin_url`, `sales_navigator_url`, and custom JSON are then
available through unauthenticated reads.

Fix: validate against the published schema, enforce maximum lengths, canonicalize
only approved LinkedIn URLs, require a stable URL/URN identity for upsert, and
use a namespaced hash for the fallback with an explicit collision warning.
Store rejected payloads only in bounded diagnostics, not as lead rows.

### DEE-01 — P1 — Claimed validation/idempotency is not enforced and side effects are non-atomic

Location: `examples/deepline/linkedin-capture.play.ts:66-110,112-166`.

The play’s runtime validation is only `if (!input.full_name)`. It accepts
arbitrary types for every other field and any event other than the special
`test`; the TypeScript type is erased at runtime. It may resolve a URL, run an
email waterfall, write the dataset, and only then execute the import audit
SQL. If the audit tool fails, the enrichment/dataset side effects remain and a
retry repeats them. If the resolver returns different URLs, the computed key
changes even for the same captured lead. The example relies on upstream
Deepline delivery dedupe rather than enforcing idempotency itself.

Fix: validate `event`, required fields, URL shapes, and bounded lengths at the
entry point; derive a stable identity from the original canonical URL/URN or a
documented hash; perform an atomic upsert or idempotency lookup before costly
plays; make downstream writes retry-safe and record an outbox/audit status.
Document that the example is a reference, not a transactional guarantee.

### TEST-01 — P1 — The test suite cannot substantiate SDUI/live/receiver claims

Location: `tests/fixtures/*`; `tests/unit/receiver.test.ts:26-40`;
`docs/ACCEPTANCE_TESTS.md:69-81`.

All three checked fixtures are classic markup. There is no SDUI profile,
SDUI people-search, grouped Sales Navigator lead, delayed lazy-render, nested
scroller, translated label, or DOM-change fixture. The “live verification”
table is a narrative claim with no captured fixture or reproducible script in
the repository. The five receiver tests are skipped when their `beforeAll`
cannot bind a listener; in this audit the result was 59 passed / 5 skipped.
The acceptance suite similarly failed before the first test because its local
fixture server could not bind loopback, leaving all 20 behaviors unverified.

Fix: check in sanitized SDUI fixtures and parser snapshots; make receiver tests
inject a handler or use a permitted test address; run acceptance in CI with a
known bind configuration and fail if no test reaches its assertions. Separate
“live/manual evidence” from automated acceptance and include capture date,
fixture provenance, and a refresh procedure.

### DOC-01 — P1 — Documentation overstates safety, durability, and verified compatibility

Location: `README.md:43-51,127-134`; `docs/SPEC.md:120-143,254-260,323-333`.

Concrete mismatches:

- README says Test verifies an endpoint, but Test bypasses URL validation and
  permission acquisition (`SEC-04`).
- “Idempotent” and “already sent” imply successful delivery, while dedupe is
  recorded before delivery (`BG-06`); retries can also be stranded (`BG-02`).
- “Guardrails” and “safe” 50–100 thresholds imply a protection the code cannot
  provide: the UI permits a 2,000/day cap, zero page delay, and arbitrary
  retries, while LinkedIn publishes a broader prohibition (`LEG-01`).
- The spec’s setting list omits `exportDefaultLimit`,
  `exportPageDelayMinMs`, and `exportPageDelayMaxMs`, despite those being
  persisted and user-facing.
- “Every criterion maps to an automated test” is not true for SDUI/live claims,
  and the current environment demonstrated the receiver/acceptance execution
  gap.
- The docs describe flat/deepline output as stable/versioned, but those bodies
  omit `schema_version` and vary source field names (`PAY-01`).

Fix: revise docs from observed behavior, mark guarantees as best effort, add
  a contract table generated from runtime schemas, document all settings and
  failure states, and link the official LinkedIn policy with a prominent
  “no compliance or restriction guarantee” warning.

### PKG-01 — P1 — Chrome Web Store privacy/release disclosures are incomplete

Location: `scripts/build.mjs:19-72`; `README.md:127-138`.

The generated manifest has icons and a short description, but there is no
privacy policy URL, no store-facing disclosure artifact, and no explicit
description of collected professional/personal data, destination control,
secret storage, optional host access, or retention in the receiver. The README
contains a local-only statement but the receiver, Deepline play, and arbitrary
webhook destinations are separate data processors. The extension also requests
content-script access across all paths on both LinkedIn host patterns; `activeTab`
is redundant for the always-matched content scripts.

Fix: prepare Chrome Web Store privacy declarations and a public privacy policy
covering data categories, processing, recipient control, local storage,
retention, deletion, and legal responsibility. Minimize permissions where
possible, explain the exact install-time and optional permission prompts, and
test the final packed artifact against Web Store manifest rules.

### PAR-05 — P2 — Name cleaning and headline splitting fail legitimate common inputs

Location: `src/shared/normalize.ts:3-32,96-112`; `src/content/parsers/common.ts:49-57`.

`cleanName` has a fixed English artifact/credential list and can strip a real
suffix such as “Sam Lee is hiring” or a surname/credential-like token after a
comma. `splitName` always makes the first whitespace token the first name, so
mononyms, family-name-first locales, particles, hyphenated/family compound
names, and suffixes are misrepresented. `splitHeadline` only recognizes
`at`, `@`, or a narrow dash pattern; headlines such as `VP Sales | Acme`,
`Acme — VP Sales`, localized equivalents, or multiple “at” phrases yield no
title/company or split the wrong segment. A failed split silently produces an
otherwise valid lead.

Fix: make cleanup locale-aware and conservative, preserve the original full
name, expose a confidence/source for derived title/company, and test a corpus
of names/headlines including Unicode, RTL, punctuation, and common LinkedIn
badges. Do not treat heuristics as authoritative fields.

### SEARCH-01 — P2 — Search parsing is lossy and can preserve sensitive session/query data

Location: `src/shared/search.ts:3-45,48-87`.

`decodeParams` silently overwrites duplicate query keys, decodes only values
with a best-effort fallback, and stores every parameter—including `sessionId`,
tracking parameters, and potentially account-specific tokens—in the
`search.params` payload. `parseSalesNavQuery` is a regex over a nested grammar:
it only recognizes uppercase underscore filter types, stops text at the first
comma/close parenthesis, and does not robustly handle nested/escaped commas,
excluded values, or future query syntax. `searchKey` removes only a parameter
whose raw key starts exactly with lowercase `page=`.

Fix: parse with a bounded grammar, allow repeated keys deliberately, classify
and redact session/tracking parameters before sending, normalize page-key case,
and preserve the original URL separately only when necessary. Add adversarial
query fixtures with nested parentheses, commas, percent-encoding, duplicate
keys, and sensitive session values.

### RCV-04 — P2 — Standard secret/timestamp handling is permissive and duplicated

Location: `src/shared/signing.ts:38-60,82-86`; `receiver/server.mjs:100-123`.

The browser and receiver implement separate base64 decoders. Both accept a
raw-secret fallback, but the browser’s invalid `whsec_...` fallback uses the
entire prefixed string while the receiver does the same through a separate
implementation; neither clearly matches the exact Standard Webhooks secret
contract for malformed/padded/base64url inputs. `atob`/`Buffer.from(...,
"base64")` are permissive, and the receiver only requires digit characters
for Standard timestamps but allows arbitrarily large values until the window
check. LWE accepts numeric fractions as described in SEC-05.

Fix: use one tested implementation or a shared conformance vector set; accept
only canonical base64 (plus the documented prefix), require a 64-bit bounded
integer timestamp, reject malformed signature lists, and document raw secret
fallback only if it is intentionally supported. Test padding, URL-safe
characters, invalid alphabet, empty keys, huge timestamps, and mixed signature
versions.

### RCV-05 — P2 — PII is logged/read without auth and SQLite deployment assumptions are undocumented

Location: `receiver/server.mjs:157-177,218-224`.

The receiver logs every lead’s full name to stdout and exposes full database
rows through read routes. Logs may be collected by process managers or shared
CI systems; read routes leak the same data even when `LWE_SECRET` protects
POSTs. SQLite is opened synchronously and without WAL/busy-timeout settings;
multiple processes or a slow disk can return locked/500 errors. The receiver
does not set security headers or define retention/deletion behavior.

Fix: default to structured, redacted logs (event ID/count only), authenticate
or remove read routes, add WAL/busy timeout and a single-process deployment
warning, and document database permissions, backup, retention, and deletion.

### DEE-02 — P2 — Per-event DDL and multi-statement SQL increase cost and operational fragility

Location: `examples/deepline/linkedin-capture.play.ts:63-64,142-162,167-178`.

The `lit` function correctly doubles single quotes, so the shown value
interpolation is not an obvious quote-injection bug. However, every event
submits `CREATE SCHEMA IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, and an
`INSERT` as one multi-statement SQL string. This requires schema DDL privilege,
adds cost/locks to every capture, may be rejected by a tool that allows one
statement, and has no transaction spanning the dataset write and audit insert.
`max_rows: 1` does not make the operation atomic or prevent the DDL.

Fix: provision schema/table once as a migration, use a parameterized query or
the platform’s supported structured database action, and write an idempotent
outbox/audit row before or atomically with downstream effects. Keep `lit` only
as a last-resort compatibility shim and add tests for quotes, backslashes,
Unicode, nulls, and very long values.

### TEST-02 — P2 — Timing-heavy tests omit core negative/lifecycle cases

Location: `tests/acceptance/extension.spec.ts:268-275`; `tests/unit/*.test.ts`.

`waitForJob` polls every 200 ms with a fixed timeout and acceptance runs with
zero retries. The tests do not cover worker suspension, stale `sending`, two
simultaneous captures, queue/storage write races, pause/stop during fetch or
navigation, tab close/redirect, `replaceState`, same-path query changes,
MutationObserver teardown, delayed lazy rows, malformed settings/messages,
hostile URLs, invalid headers, Standard replay, receiver malformed JSON, body
limits, unauthenticated reads, or Deepline runtime failures. Existing tests
assert happy-path classic fixtures and mocked fetch responses, so they can all
pass while the P0/P1 findings remain.

Fix: extract deterministic state-machine tests for every async boundary, use
fake clocks and injected tab/storage/fetch adapters, add negative/property
tests for parsers and receiver input, and keep a small number of real-browser
tests for navigation/permission behavior. Ensure a test failure is not hidden
by a skipped suite or an environment bind failure.

### PKG-02 — P2 — Build, icon generation, provenance, and release artifact policy are disconnected

Location: `package.json:10-17`; `scripts/icons.mjs:1-21`; `src/brand/*`.

`npm run build` copies already-generated icons and brand SVGs; it does not run
`icons.mjs`, so a clean checkout can build stale/missing icons unless generated
PNG files are committed. Icon generation depends on Playwright’s bundled
Chromium screenshot behavior but has no reproducibility/version check. The
brand assets have no per-file license/provenance note, despite being a
third-party brand family included in an MIT repository. There is no script to
produce a signed/zip release artifact or verify that the packed manifest
contains the intended production host permissions rather than `dist-test`.

Fix: decide whether generated assets are source-controlled; if not, make icon
generation a pinned, reproducible build step. Add asset attribution/licensing,
pack the production artifact in CI, assert `dist/manifest.json` has no
localhost/test matches, and publish checksums/release metadata.

### DOC-02 — P2 — “Verified live” and market/risk claims are not reproducible evidence

Location: `docs/SPEC.md:145-177`; `docs/RESEARCH.md:3-7,53-57`.

The spec presents a precise 2026 SDUI layout and live hit rates, but the repo
contains no sanitized live DOM captures, parser harness, or script that
reproduces those numbers. `RESEARCH.md` cites a raw file outside the repo and
mixes community posts, social content, and vendor claims into exact-looking
restriction thresholds and percentages. This is not adequate evidence for a
security/compliance-sensitive release and cannot be independently reviewed by
contributors.

Fix: check in sanitized, consented fixtures and a dated reproducibility report;
separate vendor/community anecdotes from measured results; remove exact safety
thresholds unless sourced and qualified; and record the LinkedIn policy review
date/links.

### QUALITY-01 — P3 — No lint, schema compatibility, or security regression gate

Location: `package.json:10-17`; `.github/workflows/ci.yml:15-20`.

CI runs typecheck, unit tests, build, and acceptance, but there is no lint or
format gate, dependency audit/SBOM, manifest permission assertion, runtime
schema contract test, fuzz test, or receiver security smoke test. The lack of
an explicit `npm run build:test`/production-manifest comparison means a test
build can hide packaging differences.

Fix: add focused gates for manifest diff, schemas, hostile inputs, dependency
advisories, and packed artifact inspection. Keep them proportional and avoid
treating a generic dependency scan as a substitute for the targeted tests.

### QUALITY-02 — P3 — The panel has weak accessibility/isolation guarantees

Location: `src/content/ui.ts:10-62`; `src/content/content.css:1-26`.

Buttons and inputs are created safely with `textContent`, and `all: initial`
helps reduce style inheritance, but the panel has no landmark/heading semantics,
labels for the dynamically-created checkbox/input, live-region status, focus
management, or keyboard announcement for state changes. The UI remains in the
page DOM rather than a shadow root; LinkedIn CSS or page DOM can cover, restyle,
remove, or spoof `.lwe-root`, while the very high z-index is not a security
boundary. The CSS also mutates LinkedIn rows with `position: relative !important`.

Fix: use a shadow root for extension UI, stable data ownership markers, real
labels and ARIA live status, visible focus styles, and teardown-safe event
management. Treat page DOM as hostile and never use CSS isolation as a trust
boundary.

## What is solid

- `src/shared/signing.ts` uses WebCrypto and signs the exact body string; the
  sender keeps the body byte-identical across retries and refreshes timestamp
  headers.
- `src/background/sender.ts:32-52` uses a timeout, `credentials: "omit"`,
  `redirect: "error"`, bounded response-error text, and sensible retry
  classification. It does not follow webhook redirects or send ambient
  cookies.
- DOM-to-UI output is created with `createElement`/`textContent`; there is no
  `innerHTML` interpolation in the extension UI. External footer links use
  `rel="noopener"`.
- Production manifest generation is deterministic from `package.json` and
  excludes localhost from `dist/`; test-only localhost matches are injected
  by `TEST_BUILD=1`.
- The manifest requests `storage`/`alarms` and LinkedIn hosts, while webhook
  hosts are requested at save time rather than granting all webhook hosts at
  install. This needs the Test-path fix and clearer permission UX, but the
  direction is reasonable.
- Queue transition logic and export state transitions are pure and easy to
  test (`src/background/queue.ts`, `src/shared/export-job.ts`). The problem is
  the service-worker persistence/coordination around them.
- SQLite writes in `receiver/server.mjs:48-66,85-93` use prepared statements
  and parameter binding. The SQL injection risk in the bundled receiver is
  low compared with the unvalidated JSON/operational exposure issues.
- `canonicalizeLinkedInUrl` removes query/tracking data and the mapping layer
  intentionally serializes history into JSON for flat receivers. Those
  contracts should be retained while adding host/path validation and schemas.
- The repository has a lockfile, strict TypeScript, a CI workflow, unit tests
  for the pure helpers, and a real-browser acceptance harness. These are good
  foundations for the remediation plan.

## Prioritized remediation plan

1. **P0 / release gate:** stop publishing/running the receiver on wildcard
   interfaces; require a secret outside explicit development mode; remove or
   authenticate PII read routes; make CORS restrictive. Add a malformed-input
   boundary so authenticated bad JSON returns 400 instead of terminating the
   process.
2. **P0 / product/legal gate:** get written authorization for the intended
   LinkedIn use or remove bulk DOM navigation/export. Rewrite README/SPEC
   safety language so pacing/caps are not represented as compliance protection.
3. **P0 / data-integrity gate:** serialize capture, queue, daily, and dedupe
   updates; add stale-claim recovery and compare-and-swap job transitions.
   Prove that concurrent captures cannot exceed the cap or lose queue items.
4. **P1 / delivery:** recover stale `sending`, fix `clear all`, defer dedupe
   marking until successful delivery, and make retry/idempotency semantics
   explicit for permanent failures and forced sends.
5. **P1 / export lifecycle:** replace tab-complete waiting with URL/status
   ownership, cancellation tokens, tab-close handling, and revision-checked
   page commits. Test pause/stop at every asynchronous boundary.
6. **P1 / content lifecycle:** add a navigation controller that handles
   `pushState`, `replaceState`, `popstate`, and query changes; dispose all
   observers, intervals, timers, and message listeners on every remount.
7. **P1 / parser correctness:** add sanitized classic + SDUI fixtures and
   confidence-aware parsers for optional text lines, nested headings, grouped
   roles, Unicode/locale text, lazy rows, and missing controls. Reject hostile
   URL origins and nested paths.
8. **P1 / contracts:** define runtime schemas for settings, messages, payloads,
   and receiver input. Version every preset consistently and add extension →
   receiver contract tests for generic/flat/deepline single, batch, and search
   events.
9. **P1 / privacy/release:** publish a privacy policy and Web Store data-use
   disclosures; document secret storage, optional permissions, retention,
   receiver exposure, and deletion. Remove unsupported “live verified” and
   community-threshold claims.
10. **P2 / example receiver:** provision Deepline tables separately, use the
    platform’s parameterized database action, validate runtime input, and make
    enrichment/dataset/import writes idempotent and failure-aware.
11. **P2/P3 / engineering hygiene:** add deterministic icon/artifact packaging,
    asset attribution, manifest smoke tests, dependency/SBOM checks, lint, and
    fake-clock/fuzz/security regression tests. Re-run this audit after all P0/P1
    changes and only call the acceptance suite passing when all 20 tests
    actually execute.
