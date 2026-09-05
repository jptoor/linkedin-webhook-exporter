# Product specification: Deepline for LinkedIn (LinkedIn Webhook Exporter)

Version 0.2.0 · 2026-09-05 · MIT

## 1. Summary

A Chrome extension (Manifest V3) for sales reps. From a side panel that
follows the active tab, a rep pushes the person on a LinkedIn profile or Sales
Navigator lead page, picks people across several result pages of a Sales
Navigator search, lead list or LinkedIn people search and pushes them all at
once, or hands a whole Sales Navigator search to a backend that fetches the
members. The destination is a Deepline play run through the API with the
org's API key, or any webhook (Clay, Zapier, a custom server) with signed
JSON. The extension never pages through results itself, does not call
LinkedIn's private APIs, does not talk to any server of its own, and stores
settings only in the local browser profile.

The user experience is modelled on lemlist's and Frontier's side panels
(`RESEARCH.md`): a destination chip, a list of selected people, one pinned
primary button that says exactly what will happen, and plain sales
vocabulary. Engineering concepts (webhooks, signing, schemas) stay behind
"Advanced" on the settings page.

## 2. Goals and non-goals

Goals

- One click on any supported page pushes a correct, normalized record.
- Picks survive moving between result pages; one push, one import id.
- Plays as first-class destinations: list the org's plays from the API, pick
  one, and shape the run input to the play's declared schema.
- Whole-search import as a single request (search URL + filters + limit) to
  a backend provider; no browser-side pagination.
- Signed webhook requests a receiver can verify before writing to a database.
- Idempotent delivery: retries never duplicate a row downstream.
- Guardrails that keep a rep under LinkedIn's observed restriction thresholds.

Non-goals

- Email or phone reveal. Send `linkedin_url` and let the play run a waterfall.
- Any automation: no scrolling, paging, auto-visiting, connection requests or
  messages. (v0.1's browser-side "export all pages" was removed on purpose.)
- Any hosted backend, account, or telemetry.
- Firefox / Safari (MV3 Chromium only).

## 3. Users and primary flows

| Persona | Flow |
|---|---|
| SDR on a profile page | Side panel shows the person; pinned button reads "Push Jane to Warm intro". Click. "1 person on the way." |
| SDR in Sales Navigator search | Clicks "+" on four rows, goes to page 2, clicks two more; the button reads "Push 6 people to Warm intro". Rows turn green after the push. |
| SDR with a big search | Sets "up to 200 people", clicks Import search. Deepline fetches the members; the panel says "Importing up to 200 people". |
| SDR with a saved search | Panel says the link is private; "Get the shareable link" presses Sales Navigator's own Share search; then Import search works. |
| RevOps owner | Settings → Connect a play: pastes an API key, loads plays, picks two, pins one. Sets a 75/day cap. |
| Engineer | Connects a webhook with a signing secret, runs `npm run receiver`, sees rows land in SQLite. |

## 4. Functional requirements

### 4.1 Supported pages and what is captured

| Page type | URL pattern | Records | Fields available |
|---|---|---|---|
| `profile` | `/in/<slug>` | 1 | all fields incl. experience, education, about |
| `people_search` | `/search/results/people` | N, user-selected | name, headline, title+company (from headline), location, public URL, degree, photo |
| `salesnav_search` | `/sales/search/people` | N, user-selected | name, title, company (+ company URL), location, degree, photo, Sales Nav lead URL, member URN |
| `salesnav_list` | `/sales/lists/people/<id>` | N, user-selected | same as `salesnav_search` |
| `salesnav_lead` | `/sales/lead/<id>` | 1 | name, headline, title, company, location, Sales Nav URL, member URN, public URL if linked |

Sales Navigator does not expose the public `/in/` URL in search rows, so
`linkedin_url` is `null` for those records and `sales_navigator_url` +
`linkedin_member_urn` are set instead. Receivers must not pass
`/sales/lead/` URLs to enrichment providers (Deepline rejects them); resolve
by name + company first.

### 4.2 Surfaces

Side panel (`sidepanel.html`, Chrome side panel API, opens from the toolbar
icon or the on-page dock; pinned to a tab with `?tab=<id>` for tests):

- **Sending to** chip: the active destination. Tapping it opens a bottom
  sheet with search, pinned favourites first, kind badges (Play / Webhook),
  and "Connect a play or webhook" (Settings).
- **This page** (profile / lead page): avatar, name, title · company ·
  location; "Add to selection instead".
- **Selected people** (list pages): the basket, newest first, with avatar,
  name, title · company and a remove control; "Select this page (N)" /
  "Unselect this page", "Add ticked rows" (Sales Navigator's own checkboxes),
  "Clear". Empty state teaches the "+" pill.
- **Whole search** (Sales Navigator search only): "Import everyone from
  “<search name>”", "up to [N] people", Import search. Disabled with a plain
  reason when the destination has no search input. Saved-search notice with
  "Get the shareable link".
- **Recent**: last 8 sends with status chips (Queued, Sending, Retrying,
  Sent / Running, Failed), "Retry failed", History.
- **Pinned action bar**: one button whose label is computed from state:
  "Choose where to send", "Push Jane to <dest>", "Push 4 people to <dest>",
  or disabled "Pick people to push". Below it: pushed today / left today and
  a "resend duplicates" checkbox.

On-page dock (shadow root, bottom-right, injected only on supported page
types and removed on SPA navigation away): brand mark, a count badge
(`selected/on page`), primary "Push" / "Push N" / "Push to <dest>", quiet
secondary actions ("Select page", "Import search", "Push again"), a status
line, and a button that opens the side panel.

Row toggles: a visible round "+" pill on every result row that becomes "✓"
when selected; rows in the selection get a left accent, pushed rows a green
outline. When LinkedIn renders its own checkbox in the row, ticking it
selects the person too and the pill mirrors it; the pill also ticks the box.
`Alt+Shift+L` pushes the current single page.

### 4.2b Selection basket (cross-page)

- The basket is a map of identity key → `{ lead, pageType, pageUrl,
  pageTitle, addedAt }` in `chrome.storage.session` (never `local`), capped
  at 500. It survives navigation and worker restarts and is cleared when the
  browser closes.
- Adding is idempotent; the worker validates leads and the page origin.
  Every change is broadcast to the side panel and to every LinkedIn tab so
  pills reflect picks made elsewhere.
- Pushing the basket uses one `import_id` and one capture per (search, page)
  group so each person keeps `import.search_url`, `search_name`, `list_id`
  and `page`. `import_kind` is `basket`. People the destination accepted
  leave the basket; people refused (daily cap, play mismatch) stay so the rep
  can retry. Duplicates are skipped and reported unless "resend duplicates".

### 4.2c Whole-search import and saved searches

- **Import search** sends one `search.captured` record (webhook) or one play
  run (Deepline) with `search_url` (no page/session params), decoded
  `params`, the Sales Navigator `query_expression`, parsed `filters`,
  `keywords`, `total_hint`, the requested `limit` (default 100, max 2,500),
  `list_id`, `saved_search_id`, and an `import` block (`import_kind:
  "search"`). The backend re-runs the search server-side (reference play:
  `examples/deepline/salesnav-search-import.play.ts` via WizLeads). Dedupe key
  is the URL without `page`, per destination.
- **Saved searches** open as `/sales/search/people?savedSearchId=<id>`, a
  deep link that only resolves for its owner. The extension refuses to send
  it. A MAIN-world helper (`main-world.ts`) wraps `navigator.clipboard.write*`
  and observes the link Sales Navigator's own "Share search" copies (it
  carries the full `query=`), forwards it to the worker, which stores it per
  saved-search id in session storage. The panel offers "Get the shareable
  link" (presses Share search programmatically) and sends the share link with
  `saved_search_id` set. Nothing else on the page is observed.
- **`import`** on every person payload (nested in the generic shape,
  `import_*` fields in flat / Deepline shapes): `import_id`, `imported_by`,
  `imported_at`, `import_kind` (`manual` | `basket` | `search`),
  `search_url`, `search_name` (keywords + filters, or the list id),
  `list_id`, `page`. The reference receiver keeps a `sales_nav_imports` table
  keyed by (import, lead); the Deepline plays write `sales.sales_nav_imports`
  and `sales.sales_nav_search_imports` in the workspace `customer_db`.

### 4.2e Destinations

Settings hold a list of destinations (max 25) and the active one:

| Kind | Fields | Send |
|---|---|---|
| `webhook` | url, signingSecret, signatureScheme (`lwe` \| `standard`), authHeaderName/Value, mappingPreset (`generic` \| `flat` \| `deepline`), sendMode (`single` \| `batch`), favorite | `POST url` with the payload (section 4.4/4.5) |
| `deepline_play` | baseUrl (https, or http localhost), apiKey, playKey, playName, input spec, favorite | `POST <base>/api/v2/plays/run` with `Authorization: Bearer <apiKey>` and body `{ name: playKey, input }` |

Play input spec is inferred from the play's input schema when it is picked
(`inferPlayInput`): `leads: array` → `batch` (one run per push with all flat
rows + provenance), `lead: object` → `lead` (one run per person), otherwise
`mapped` (one run per person with only the declared field names, from a
table of aliases: `linkedin_url`, `profile_url`, `full_name`, `name`,
`first_name`, `last_name`, `title`, `job_title`, `company_name`, `company`,
`location`, …; Sales Navigator URL as a fallback for `linkedin_url`). A play
declaring `search_url` / `sales_navigator_url` / `url` accepts searches. A
play without a schema accepts anything and gets the flat Deepline row. A
required field the extension cannot fill is reported in the panel before any
request. Pages may only send to the active destination; the side panel may
name another one.

A v0.1 single-webhook configuration is migrated into the first destination
on read.

### 4.2f Page bridge (LinkedIn API responses)

A MAIN-world content script (`content/page-bridge.ts`, `document_start`)
wraps `XMLHttpRequest.prototype.open` and `window.fetch`. When the page
itself loads one of the allow-listed URLs (`/sales-api/salesApiLeadSearch`,
`salesApiPeopleSearch`, `salesApiProfiles`, `salesApiCompanies`,
`salesApiAccountSearch`, `salesApiDashboardAccountTable`,
`/voyager/api/graphql`, `/voyager/api/search/dash/clusters`,
`/voyager/api/identity/dash/profiles`; the same set Frontier intercepts on
LinkedIn) the response text (≤ 2 MB) is posted to the content script on the
page's origin under the `LWE_BRIDGE` channel. The bridge never issues,
modifies or replays a request.

`shared/linkedin-api.ts` walks the payload (bounded: 20k nodes, depth 12)
and collects people: Sales Navigator ids (`ACwAAA…`), Voyager profile ids
(`ACoAAA…`), public identifiers / flagship URLs, names, current role and
company (with company URL), region, degree, photo, summary, plus the search
`paging.total`. The content script keeps an `ApiIndex` per route and
`enrichLead()` merges it into DOM-parsed records: DOM values that were read
cleanly win; API values fill nulls, replace fields the parser flagged as
guessed, add the public `linkedin_url` Sales Navigator never renders, and
append the `api_merged` warning. Rows already decorated are re-parsed when
data lands. Off switch: Settings `intercept`; remote kill flag `intercept`.

### 4.2g Deepline sign-in (session)

Like Frontier picking up its web app's session, the extension treats the
rep's Deepline sign-in as its credential, but without the `cookies`
permission: `GET /api/v2/auth/session` with `credentials: "include"` returns
the user and active org, and Chrome attaches the cookie itself. State is
re-checked when the panel opens, when a tab on the Deepline origin finishes
loading (a sign-in or sign-out just happened), and at most every minute
before a session-mode run goes out. Every queue item created on the sign-in
carries `sessionIdentity` (`user|org`); at send time the item is failed with
`signed_out` / `account_changed` if the current identity differs, so a
retry never runs under another account. Captures and search imports are
rejected with `signed_out` when there is no session. Plays are listed and
run the same way (no `Authorization` header). A play destination with an
empty `apiKey` means "use my sign-in"; the panel's picker adds such plays
directly (`ADD_PLAY_DESTINATION`). API keys remain an Advanced option.
Remote flags are enforced: `session_auth` off makes the extension signed
out and refuses session-mode play listing; `search_import` off rejects
search imports with `search_import_disabled`; `intercept` off is applied on
top of the operator's setting and clears what was already observed.
The side panel is enabled per tab only on LinkedIn URLs
(`chrome.sidePanel.setOptions`). The Deepline web app may send `ping`,
`get_auth_state` and `open_side_panel` through `externally_connectable`
(origin re-validated, every message logged).

### 4.2h Telemetry, error reports, flags

`shared/telemetry.ts`: Segment-shaped `track` events (extension, version,
user agent, time zone, anonymous id, Deepline user/org id) sent to Segment
only when `SEGMENT_WRITE_KEY` was compiled in, always recorded in the local
history as `telemetry.event`; uncaught errors from the worker, panel and
settings page posted to Deepline's `POST /api/v2/cli/report-failure` when a
session or key exists; feature flags (`intercept`, `session_auth`,
`search_import`, `telemetry`) fetched from `<base>/api/v2/extension/flags`
with local defaults. Properties are scrubbed of secrets and people before
leaving. Gated by Settings `telemetry`.

### 4.2d LinkedIn's 2026 layout (verified live on 2026-09-03)

LinkedIn's profile and people-search pages now render with hashed class
names, no `<h1>`, and no section ids ("SDUI"). Parsers therefore anchor on:

| Surface | Anchor | Notes |
|---|---|---|
| Profile top card | `[id^="com.linkedin.sdui.profile.card."][id$="Topcard"]`; `<h2>` = name; ordered `<p>` lines = degree, headline, company, location before the "Contact info" link | Experience/Education/About are lazy cards found by their `<h2>` text; each entry's lines sit inside the company/school `<a>`, so entries group by link. They only render once scrolled into view **in a visible tab**. |
| People search | `main [role="list"] [role="listitem"]`; the whole card is the profile link, so fields come from text-node order: name, `• 2nd`, headline, location | 10 results per page, `?page=N`, "Next" button. |
| Sales Navigator search / list | `#search-results-container li.artdeco-list__item` with `data-anonymize` attributes (`person-name`, `title`, `company-name`, `location`) and the member URN in the lead link | Rows are skeletons until they intersect the viewport; the content script smooth-scrolls. 25 per page, `?page=N`. |
| Sales Navigator lead | `h1[data-anonymize="person-name"]`, `[data-anonymize="headline"]`, `#experience-section li[class*="experience-entry"]` (flat, or grouped by company with `<h3>` roles) | Location has no attribute; taken from the current role. Degree is a sibling span of the name. No public `/in/` link is exposed. |

These findings are dated manual evidence from one session, kept here for
context; the reproducible versions are the sample pages in `samples/` that
model each structure. Live results on real pages: profile (name, headline, title, company + URL,
location, degree, 5 experience entries), Sales Navigator search (25/25 rows;
company on 21, the rest have no company link), Sales Navigator lead (name,
headline, current role, company + URL, location, degree, 6 experience
entries), LinkedIn people search (10/10 rows with URL, headline, location,
degree; title/company split when the headline has "at" or " - ").

### 4.3 Normalization

- Names: collapse whitespace; strip LinkedIn artifacts ("is reachable",
  "· 2nd", pronouns in parentheses) and trailing credentials (", MBA").
  Split into `first_name` (first token) and `last_name` (rest).
- URLs: public profile URLs canonicalize to `https://www.linkedin.com/in/<slug>`
  (subdomains, query strings, trailing slashes removed). Sales Nav lead URLs
  canonicalize to `https://www.linkedin.com/sales/lead/<id>`. Company URLs to
  `https://www.linkedin.com/company/<id-or-slug>`.
- Current title/company (classic layout): the top-card "Current company"
  control first, then the first experience entry, then the headline split.
  In the 2026 layout: the top card's company line, then the first experience
  entry, then the headline. When history is excluded only the first entry is
  read. Headline splits recognize " at ", " @ ", " - ", " | " and " — " and
  refuse to guess when neither side looks like a role.
- Every record carries `parse_warnings` (e.g. `location_missing`,
  `headline_unsplit`, `sdui_layout`, `experience_grouping_uncertain`,
  `name_from_title`) so receivers can route low-confidence rows to review.
- Names: trailing badges (reachable, open to work, hiring, pronouns, emoji,
  degree) and exact credential tokens after a comma are stripped; mononyms
  keep `last_name` null; particles ("van der", "de la") and generational
  suffixes stay with the last name; "Last, First" is honored.
- URLs: only LinkedIn hosts (apex, www, two-letter regional subdomains) are
  accepted; credentials, ports and nested paths are rejected; slugs and URNs
  must match a conservative grammar. Hostile hrefs become `null`.
- `about` is truncated to 2,000 characters; experience is capped at 10
  entries and education at 5.

### 4.4 Payload

Canonical `LeadRecord` (all keys always present, `null` when unknown):

```
full_name, first_name, last_name, headline, title, company_name,
company_linkedin_url, location, linkedin_url, linkedin_slug,
linkedin_member_urn, sales_navigator_url, connection_degree ("1st"|"2nd"|"3rd"),
profile_image_url, about, experience[], education[], captured_at
```

`experience[]`: `{ title, company_name, company_linkedin_url, date_range, location }`
`education[]`: `{ school, degree, date_range }`

Three mapping presets and two send modes:

| Preset | Single mode body | Batch mode body |
|---|---|---|
| `generic` | `{ schema_version:"1", event:"lead.captured", event_id, sent_at, source{}, lead{}, custom{} }` | same envelope with `event:"leads.captured"` and `leads[]` |
| `flat` | one-level object: all lead fields + `event_id, sent_at, page_type, page_url, captured_by, extension_version, experience_json, education_json, custom_<k>` | `{ event, event_id, sent_at, rows[] }` of flat objects |
| `deepline` | flat object with Deepline play-input names first: `linkedin_url, first_name, last_name, title, company_name, company_domain:null, email:null, source`, then all flat fields | `{ event, event_id, sent_at, rows[] }` |

`source`: `{ extension, version, page_type, page_url, captured_by }`.
`custom`: free-form key/value pairs from settings (e.g. `campaign=q3`).

A test event (`event:"test"`) is sent from the options page to validate the
endpoint; receivers should accept and ignore it.

### 4.4b Envelope

Every body, in every preset and for every event, starts with
`schema_version`, `event`, `event_id`, `sent_at`. Flat and Deepline batch
bodies repeat `source`, `import`, and `custom` fields on the envelope and in
each row. `isPayload()` checks the event enum.

### 4.5 Transport

- `POST <webhookUrl>` with `Content-Type: application/json`, `credentials: omit`,
  `redirect: error`, 15 s timeout.
- Headers on every request: `X-LWE-Event-Id` (UUID v4), `X-LWE-Version`,
  `Idempotency-Key`.
- `Idempotency-Key` (and `x-deepline-dedupe-key` when the Deepline preset is
  selected) is the lead's identity key for unforced single sends, so a
  re-capture of the same profile is a no-op downstream, and the event id for
  batches and forced resends.
- Timestamps are integer unix seconds; event ids match `[A-Za-z0-9_-]{8,64}`.
  Verification proves authenticity and freshness only; receivers must keep
  their own event-id store for uniqueness (the reference receiver does,
  inside its transaction, and requires header/body ids to match).
- Signature (when a secret is set), one of:
  - **LWE**: `X-LWE-Timestamp: <unix s>`, `X-LWE-Signature: sha256=<hex HMAC-SHA256(secret, "<ts>.<body>")>`.
  - **Standard Webhooks**: `webhook-id: <event id>`, `webhook-timestamp: <unix s>`,
    `webhook-signature: v1,<base64 HMAC-SHA256(key, "<id>.<ts>.<body>")>`
    where `key` is the base64-decoded secret (optional `whsec_` prefix), or the
    raw UTF-8 bytes if the secret is not valid base64. This is exactly what
    Deepline's `standard-webhooks` auth verifies.
- Optional extra header (name + value) for bearer or shared-secret receivers,
  e.g. `x-deepline-webhook-secret` or `Authorization: Bearer …`.
- Webhook URL must be `https://`; `http://localhost` and `http://127.0.0.1`
  are allowed for development. The host is requested as an optional
  permission when saved, so the extension never holds blanket host access.

### 4.5b Activity log

Every capture request, admission, rejection, duplicate skip, send attempt and
result, retry schedule, lease recovery, basket change, share-link capture,
play listing, queue command, settings change, destination switch and
destination test is appended to a local ring buffer (last 1,000 entries,
512 KB) with structured, secret-redacted details. The side panel shows the
recent sends; the settings page previews and downloads the history as JSON.

### 4.6 Delivery guarantees

- Every send is persisted to a queue in `chrome.storage.local` before the
  first attempt. The stored body is the exact bytes signed on every retry.
- All queue, dedupe, counter, and export-job writes run under one async mutex
  in the service worker, so concurrent captures (two tabs, export + click)
  cannot lose items or exceed the cap.
- A claimed (`sending`) item carries a 90 s lease; if the worker is suspended
  mid-request the lease expires and the item is retried.
- Dedupe identities are reserved when queued, confirmed on a 2xx, and
  released on a permanent failure, so "already sent" means delivered.
- Response classification: 2xx = sent; 408 / 425 / 429 / 5xx / network error /
  timeout = retry; any other 4xx = failed, no retry.
- Backoff: 1 m, 5 m, 30 m, 2 h, 6 h; 6 attempts max. Retries are driven by
  `chrome.alarms` so they survive service-worker suspension.
- Popup shows the last 25 sends with status, "Retry failed", and "Clear".
- Sent items are pruned after 24 h; the queue is capped at 500 entries.

### 4.7 Safety controls

- Daily cap (default 100, maximum 2,000) on admissions into the queue, per
  local calendar day. A manual capture that would exceed it is rejected
  whole; a bulk-export page is truncated to what remains. Delivered and
  failed counts are tracked separately. The cap is a convenience for the
  operator, not a compliance mechanism: LinkedIn prohibits scraping and
  automation by extensions regardless of volume.
- Dedupe by identity key with a TTL (default 30 days). Duplicates are skipped
  and reported, never silently dropped. Force resend overrides.
- Interactive capture never scrolls, paginates, or navigates on its own. Bulk
  export does paginate, only after an explicit start, one page at a time with
  randomized delays, under the same daily cap, and with a visible pause/stop.
- Reads only rendered DOM. No Voyager/REST calls to LinkedIn.

### 4.8 Settings

All in `chrome.storage.local` (never `sync`), validated and clamped on every
read (`sanitizeSettings`):

| Setting | Type / range | Default |
|---|---|---|
| `destinations[]` | see 4.2e; ids `[A-Za-z0-9_-]{1,64}`, max 25 | [] |
| `activeDestinationId` | must exist, else first | null |
| `dedupe` / `dedupeTtlDays` | bool / 1..365 | true / 30 |
| `dailyCap` | 1..2000 | 100 |
| `searchDefaultLimit` | 1..2500 | 100 |
| `capturedBy` | ≤200 chars | "" |
| `customFields` | ≤20 keys, values ≤500 chars | {} |
| `includeExperience` / `includeEducation` / `includeAbout` | bool | true |

Content scripts receive only `includeExperience`, `includeEducation`,
`includeAbout`, `dedupe`, `searchDefaultLimit`, `hasDestination`,
`destinationName`, `destinationKind`. The side panel receives destinations
with secrets blanked; only the settings page reads them in full.

## 5. Deepline integration

Two paths, both in `examples/deepline`:

1. **Play run through the API** (default rep flow). The extension lists plays
   with `GET /api/v2/plays?origin=owned|prebuilt&limit=100` and runs one with
   `POST /api/v2/plays/run` (`{ name, input }`, `Authorization: Bearer <key>`,
   `Idempotency-Key` / `x-deepline-dedupe-key` = the person's canonical URL).
   The response's `workflowId` is kept on the queue item and shown as
   "Running". 401/403 fail without retry; 429/5xx retry with backoff. The API
   key is stored in `chrome.storage.local` and sent only to the configured
   base URL, whose origin is requested as an optional host permission.
2. **Inbound webhook** (no API key in the browser). Publish a play with a
   `standard-webhooks` binding, connect its `endpointUrl` as a webhook with
   the Deepline shape and the `whsec_` secret. Bodies arrive as the play's
   `input` verbatim; Deepline dedupes runs on `x-deepline-dedupe-key`.

`linkedin-capture.play.ts` stores and enriches one person and records the
import; `salesnav-search-import.play.ts` receives a forwarded search and
fetches the members through WizLeads. Both write audit rows to
`sales.sales_nav_imports` / `sales.sales_nav_search_imports` before any paid
step.

## 6. Security and privacy

- Secrets (signing secret, auth header) live in `chrome.storage.local` for
  the browser profile. They leave the machine only as an HMAC signature or as
  the configured header to the configured host.
- The receiver can verify authenticity (HMAC), freshness (timestamp within
  300 s), and uniqueness (event id) before touching a database. The bundled
  receiver does all three and writes with parameterized SQL only.
- Permissions: `storage`, `alarms`, `sidePanel`, `tabs` (to follow the
  active LinkedIn tab and relay panel actions to it), LinkedIn hosts,
  `code.deepline.com`, and one optional host per destination granted at
  save time. No `cookies`, no `<all_urls>`, no `scripting`.
  `docs/RISK-REVIEW.md` compares this surface with Frontier's line by line.
- Only real user gestures drive the on-page UI: dock buttons, row pills and
  the mirrored native checkbox ignore events with `isTrusted === false`, so
  a page script cannot push, select or open the panel. Bridge messages are
  untrusted input: responses are ingested only for same-origin allow-listed
  URLs, share links only for a LinkedIn Sales Navigator search URL while a
  saved search is open, and the worker re-validates both again.
- The web-app channel (`externally_connectable`) accepts exact hosts only
  (`deepline.com`, `www.deepline.com`, `code.deepline.com`, the configured
  base); `get_auth_state` returns `{ signedIn, baseUrl }` and nothing about
  the user.
- The API key is the credential for play runs; it is blanked in everything a
  content script or the side panel can read, and never logged.
- No third-party scripts, fonts, or network calls. The MAIN-world helper
  only forwards clipboard text that looks like a Sales Navigator search URL.
- Users capture only data LinkedIn already renders to them; operators are
  responsible for lawful basis (GDPR/CCPA) and for LinkedIn's terms.

## 7. Architecture

```
src/shared      types, normalize, mapping, signing, settings, messages, deepline (play input shaping, API), basket, search (pure, unit-tested)
src/content     parsers/{profile,salesnav,search}, ui (dock + pills), index (router, page context, basket sync), main-world (share-link hook)
src/background  service-worker (capture → dedupe → cap → queue → send; basket; page context; destinations), queue (pure), sender (webhook + play run)
src/sidepanel   the rep-facing panel
src/options     settings: destinations (plays, webhooks), limits, history
receiver/       reference receiver: verify → dedupe → SQLite upsert
examples/       Deepline play
tests/unit      vitest + jsdom fixtures
tests/acceptance Playwright with the real extension loaded, fixture site, mock webhook
```

Build: esbuild → `dist/`. Test build (`dist-test/`) adds localhost to content
script matches so acceptance tests run against fixture HTML served on
LinkedIn-shaped paths, never against linkedin.com.

## 8. Acceptance criteria

See `ACCEPTANCE_TESTS.md`. Every criterion maps to an automated test
(`AT-xx` in `tests/acceptance/extension.spec.ts`) or a unit test.

## 9. Known limitations and roadmap

- LinkedIn changes its DOM regularly. Parsers use ordered selector fallbacks
  and the UI reports when a name cannot be read; fixtures should be refreshed
  when that happens. `data-lwe-*` attributes are honored first so a fork can
  pin selectors.
- Sales Navigator rows carry no public URL; resolving it is the receiver's job.
- `wizleads_scrape_salesnav` is deprecated in Deepline's catalog; the search
  import play isolates the provider call so it can be swapped.
- Chrome opens the side panel from the toolbar icon; opening it from the
  on-page dock depends on Chrome honoring the click as a user gesture.
- v0.3 candidates: company pages, per-play field pickers, CSV fallback,
  Firefox build.
