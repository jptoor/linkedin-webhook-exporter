# Product specification: LinkedIn Webhook Exporter

Version 0.1.0 · 2026-09-03 · MIT

## 1. Summary

A Chrome extension (Manifest V3) that captures the person data visible on a
LinkedIn profile, LinkedIn people search, Sales Navigator search, Sales
Navigator lead list, or Sales Navigator lead page, and POSTs it as signed JSON
to one user-configured webhook. It does not enrich, does not call LinkedIn's
private APIs, does not talk to any server of its own, and stores settings only
in the local browser profile.

It is the capture and route layers of ZoomInfo / Apollo / Lusha / Exportly /
ClayGenies (see `RESEARCH.md`), with the reveal layer deliberately delegated to
the receiver. The primary receiver target is a Deepline play bound to an
inbound webhook; a Clay table webhook, Zapier / Make / n8n, or the bundled
SQLite reference receiver all work with the same payload.

## 2. Goals and non-goals

Goals

- One click on any supported page sends a correct, normalized record.
- Multi-select on list pages, single or batch delivery.
- Signed requests a receiver can verify before writing to a database.
- Idempotent delivery: retries never duplicate a row downstream.
- Guardrails that keep a rep under LinkedIn's observed restriction thresholds.
- Drop-in compatibility with Deepline inbound webhooks, including its field
  names, idempotency header, and Standard Webhooks signature scheme.

Non-goals

- Email or phone reveal. Send `linkedin_url` and let the receiver run a
  waterfall (Deepline `prebuilt/person-linkedin-to-email`, Clay, etc.).
- Automation beyond one explicit bulk export at a time: no scheduled runs, no
  auto-visiting profiles, no connection requests or messages.
- Any hosted backend, account, or telemetry.
- Firefox / Safari (MV3 Chromium only for v0.1).

## 3. Users and primary flows

| Persona | Flow |
|---|---|
| SDR on a profile page | Click "Send to webhook". Sees "Sent 1 · 97 left today". |
| SDR in Sales Navigator search | Tick 12 rows, click "Send 12 selected". Rows turn green. |
| RevOps owner | Sets webhook URL + secret once, picks the Deepline preset, sets a 75/day cap. |
| Engineer | Runs `npm run receiver`, points the extension at localhost, sees rows land in SQLite. |

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

### 4.2 Capture UI

- A floating panel (bottom-right) is injected only on supported page types
  and removed on SPA navigation away from them.
- Single pages: primary "Send to webhook", secondary "Force resend". If the
  profile was already sent, the panel says so on load.
- List pages: a checkbox is injected at the top-left of each result row;
  "Select all on page" toggles all; primary button reads "Send N selected"
  and is disabled at N=0. Rows already sent are outlined green. New rows that
  LinkedIn lazy-loads are decorated via a MutationObserver.
- Keyboard: `Alt+Shift+L` sends the current single page.
- All UI is scoped under `.lwe-root` with `all: initial` to avoid inheriting
  LinkedIn styles.

### 4.2b Bulk export (submit a search URL, get every result)

Parity target: Wiza, Prospeo, Findymail, Scalelist, lemlist, Exportly/Frontier
and ZoomInfo all offer "one click, every page" export from a Sales Navigator
search or lead list, capped by LinkedIn at 100 pages × 25 = 2,500 results.
Their UX, verified from their own YouTube walkthroughs:

| Tool | Entry point | Pre-run options | Progress | Limits noted |
|---|---|---|---|---|
| Wiza | "Export leads with Wiza" button top-right of Sales Nav | output type, list name, folder, number of contacts, accepted email types; confirmation shows duplicates checked, cost, ETA | queued → scraping → done in dashboard | 2,500 per search; split searches |
| Prospeo / Scalelist / Findymail | injected "Export" button | count to export | dashboard | 2,500 max; split by filters |
| lemlist | extension panel on Sales Nav results | campaign to add to, enrichment, duplicates ("updates existing leads instead of duplicating") | in-app | daily LinkedIn scan limits |
| Exportly / Frontier | sidebar wired to a Clay table | Clay table = destination + enrichment | Clay table | per-table |

Requirements

- Entry points: (a) "Export all" control in the injected panel on any Sales
  Navigator search, Sales Navigator lead list, or LinkedIn people search;
  (b) popup form that accepts a pasted URL (prefilled from the active tab) and
  opens a new tab for it.
- Pre-run options: max results (default 500, hard cap 2,500). Destination and
  dedupe are the global settings; every page flows through the same capture
  pipeline (dedupe, daily cap, queue, signing), so the receiver gets the same
  payload as a manual send with `source.page_url` carrying the page.
- Pagination: rewrite `?page=N` on the source URL, preserving LinkedIn's own
  query encoding byte for byte. Rows are lazy-rendered, so the content script
  auto-scrolls the results container until the row count stabilizes before
  parsing. Next-page detection uses the pagination "Next" button, falling back
  to "25 rows on the page".
- Pacing: a random delay between pages (default 4 to 9 s) plus a settle delay
  after load. No parallel tabs. One job at a time.
- Stop conditions, each reported in the UI and in the job record: limit
  reached, no more pages (or page 100), empty page, daily cap (job stops after
  sending what the cap allows), user stop, error (tab closed, no webhook,
  content script unreachable).
- Controls: pause, resume, stop from the panel or the popup. Progress shows
  pages done, results collected, sent, already-sent skipped, and the
  estimated page count from LinkedIn's "N results" header.
- Durability: the job record lives in `chrome.storage.local`; a 1-minute
  watchdog alarm and the startup hook resume a running job if the service
  worker was suspended. The last 20 jobs are kept as history.
- Limit semantics: the limit counts results collected (same as competitors'
  "number of contacts"), not sends, so a search full of already-sent people
  still terminates.

### 4.2c Saved searches and import provenance

- **`search.captured`**: on any Sales Navigator search, lead list, or LinkedIn
  people search the panel offers "Save search", and every bulk export records
  the search automatically. The payload carries `search_url`, the decoded
  `params`, the Sales Navigator `query_expression`, parsed `filters`
  (e.g. `{ "CURRENT_TITLE": ["CRO"], "REGION": ["United States"] }`),
  `keywords`, `total_hint`, `page`, and `list_id`. A backend provider
  (Deepline play, Edges, Apify) can re-run the same search server-side from
  this record. Dedupe key is the URL without `page`.
- **`import`** on every lead payload (nested in the generic preset,
  `import_*` fields in flat / Deepline presets): `import_id` (one per click on
  a list page, or the bulk-export job id), `imported_by`, `imported_at`,
  `import_kind` (`manual` | `export`), `search_url`, `search_name` (keywords +
  filters, or the list id), `list_id`, `page`. The reference receiver keeps a
  `sales_nav_imports` table keyed by (import, lead); the Deepline play writes
  the same rows to `sales.sales_nav_imports` in the workspace `customer_db`.

### 4.2d LinkedIn's 2026 layout (verified live on 2026-09-03)

LinkedIn's profile and people-search pages now render with hashed class
names, no `<h1>`, and no section ids ("SDUI"). Parsers therefore anchor on:

| Surface | Anchor | Notes |
|---|---|---|
| Profile top card | `[id^="com.linkedin.sdui.profile.card."][id$="Topcard"]`; `<h2>` = name; ordered `<p>` lines = degree, headline, company, location before the "Contact info" link | Experience/Education/About are lazy cards found by their `<h2>` text; each entry's lines sit inside the company/school `<a>`, so entries group by link. They only render once scrolled into view **in a visible tab**. |
| People search | `main [role="list"] [role="listitem"]`; the whole card is the profile link, so fields come from text-node order: name, `• 2nd`, headline, location | 10 results per page, `?page=N`, "Next" button. |
| Sales Navigator search / list | `#search-results-container li.artdeco-list__item` with `data-anonymize` attributes (`person-name`, `title`, `company-name`, `location`) and the member URN in the lead link | Rows are skeletons until they intersect the viewport; the content script smooth-scrolls. 25 per page, `?page=N`. |
| Sales Navigator lead | `h1[data-anonymize="person-name"]`, `[data-anonymize="headline"]`, `#experience-section li[class*="experience-entry"]` (flat, or grouped by company with `<h3>` roles) | Location has no attribute; taken from the current role. Degree is a sibling span of the name. No public `/in/` link is exposed. |

Live results on real pages: profile (name, headline, title, company + URL,
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
- Current title/company: from the experience list's first entry, else from
  the top-card "Current company" control, else by splitting the headline on
  " at " / " @ ".
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

### 4.5 Transport

- `POST <webhookUrl>` with `Content-Type: application/json`, `credentials: omit`,
  `redirect: error`, 15 s timeout.
- Headers on every request: `X-LWE-Event-Id` (UUID v4), `X-LWE-Version`,
  `Idempotency-Key`.
- `Idempotency-Key` (and `x-deepline-dedupe-key` when the Deepline preset is
  selected) is the lead's identity key for unforced single sends, so a
  re-capture of the same profile is a no-op downstream, and the event id for
  batches and forced resends.
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

### 4.6 Delivery guarantees

- Every send is persisted to a queue in `chrome.storage.local` before the
  first attempt. The stored body is the exact bytes signed on every retry.
- Response classification: 2xx = sent; 408 / 425 / 429 / 5xx / network error /
  timeout = retry; any other 4xx = failed, no retry.
- Backoff: 1 m, 5 m, 30 m, 2 h, 6 h; 6 attempts max. Retries are driven by
  `chrome.alarms` so they survive service-worker suspension.
- Popup shows the last 25 sends with status, "Retry failed", and "Clear".
- Sent items are pruned after 24 h; the queue is capped at 500 entries.

### 4.7 Safety controls

- Daily cap (default 100 leads/day, configurable). A capture that would
  exceed it is rejected with the remaining count shown. Community guidance
  (Vayne, Yalc, Clura, 2026) puts safe extension-driven capture at 50 to 100
  profiles/day; Sales Navigator bulk scraping is the most restricted pattern.
- Dedupe by identity key with a TTL (default 30 days). Duplicates are skipped
  and reported, never silently dropped. Force resend overrides.
- Interactive capture never scrolls, paginates, or navigates on its own. Bulk
  export does paginate, only after an explicit start, one page at a time with
  randomized delays, under the same daily cap, and with a visible pause/stop.
- Reads only rendered DOM. No Voyager/REST calls to LinkedIn.

### 4.8 Settings

All in `chrome.storage.local` (never `sync`):

`webhookUrl, signingSecret, signatureScheme, authHeaderName, authHeaderValue,
mappingPreset, sendMode, dedupe, dedupeTtlDays, dailyCap, capturedBy,
customFields, includeExperience, includeEducation, includeAbout`.

## 5. Deepline integration

Deepline's inbound webhook is `POST https://code.deepline.com/api/v2/webhooks/inbound/<token>`.
The JSON body is delivered verbatim as the play's typed `input`; there is no
envelope. The token in the URL is the credential; the play may additionally
require a shared secret (`x-deepline-webhook-secret` or `Authorization: Bearer`)
or Standard Webhooks HMAC. Deepline dedupes runs on `x-deepline-dedupe-key`
(falling back to `Idempotency-Key`). Responses are `202` with
`{ event_id, run_id, deduped }`.

Extension configuration for Deepline:

| Setting | Value |
|---|---|
| Webhook URL | the `endpointUrl` returned by `deepline plays publish` |
| Field mapping | `deepline` |
| Send mode | `single` |
| Signature scheme | `standard` with the play's `whsec_` secret (or leave blank and set the extra header `x-deepline-webhook-secret`) |

A reference play lives in `examples/deepline/linkedin-capture.play.ts`. It
validates the input, resolves a public URL for Sales Navigator captures via
name + company, runs the email waterfall, and writes the row to the
workspace dataset. Because Deepline's receipts are content-addressed, a
re-POST of an unchanged profile costs ~0 credits even before the dedupe key
short-circuits the run.

Never put a workspace `dl_` API key in the extension. The inbound token is
scoped to one play; `/api/v2/plays/run` is not.

## 6. Security and privacy

- Secrets (signing secret, auth header) live in `chrome.storage.local` for
  the browser profile. They leave the machine only as an HMAC signature or as
  the configured header to the configured host.
- The receiver can verify authenticity (HMAC), freshness (timestamp within
  300 s), and uniqueness (event id) before touching a database. The bundled
  receiver does all three and writes with parameterized SQL only.
- Minimal permissions: `storage`, `alarms`, `activeTab`, LinkedIn hosts, and
  one optional host granted at save time.
- No third-party scripts, fonts, or network calls.
- Users capture only data LinkedIn already renders to them; operators are
  responsible for lawful basis (GDPR/CCPA) and for LinkedIn's terms.

## 7. Architecture

```
src/shared      types, normalize, mapping, signing, settings, messages   (pure, unit-tested)
src/content     parsers/{profile,salesnav,search}, ui, index (router)   (DOM in, LeadRecord out)
src/background  service-worker (capture → dedupe → cap → queue → send), queue (pure), sender
src/options     settings page
src/popup       status + queue
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
- v0.2 candidates: company pages, "Send + open next" on lists, CSV fallback,
  per-preset field pickers, Firefox build.
