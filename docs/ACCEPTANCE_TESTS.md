# Acceptance tests

Two layers, both run in CI with `npm test && npm run test:acceptance`.

- **Unit** (`tests/unit`, vitest + jsdom): parsers against HTML fixtures,
  normalization, payload mapping, signing, queue state machine, sender, and an
  end-to-end test that spawns the reference receiver.
- **Acceptance** (`tests/acceptance`, Playwright): the built extension is
  loaded into Chromium. A local server serves fixture pages on LinkedIn-shaped
  paths (`/in/<slug>/`, `/sales/search/people`, `/search/results/people/`).
  A mock webhook records every request and can be told to fail. Settings are
  entered through the real options page. Nothing touches linkedin.com.

Run one: `npx playwright test -g "AT-03"` (the ids are in test titles' comments; use the title text).

## Acceptance criteria

| ID | Criterion | Given | When | Then | Test |
|---|---|---|---|---|---|
| AT-01 | Profile capture is complete, signed, and well-formed | Webhook + LWE secret + captured_by + custom fields configured; a profile page | Click "Send to webhook" | Panel shows "Sent 1". Exactly one POST with `Content-Type: application/json`, a UUID `X-LWE-Event-Id`, a timestamp within 60 s, and `X-LWE-Signature` equal to `sha256=HMAC(secret, "<ts>.<body>")`. Body has `schema_version "1"`, `event "lead.captured"`, matching `event_id`, `source.page_type "profile"`, `source.page_url`, `custom` from settings, and a lead with name split, title, company + company URL, location, canonical `/in/` URL, slug, degree, 2 experience entries, 1 education entry, about text, ISO `captured_at`. | `extension.spec.ts` "profile page: one click sends…" |
| AT-02 | Dedupe prevents double sends; force overrides | Same as AT-01 | Send, send again, reload, then "Force resend" | Second click reports "already sent" and no request is made. After reload the panel says "Already sent". Force resend produces a second request for the same profile. | "dedupe: the same profile…" |
| AT-03 | Sales Navigator multi-select, single mode | Sales Nav search fixture with 3 rows; single mode | Tick rows 1 and 2, click "Send 2 selected" | Button was disabled at 0 and reads the count. Two POSTs with distinct event ids, one lead each; the Bob row has `title`, `company_name`, canonical `sales_navigator_url`, `linkedin_member_urn`, `linkedin_url: null`, `connection_degree "3rd"`, `page_type "salesnav_search"`. Sent rows are outlined and unchecked. | "Sales Navigator search: select rows…" |
| AT-04 | Batch mode + flat preset | People-search fixture with 2 real rows and one anonymous "LinkedIn Member" row; batch + flat | "Select all on page", send | Anonymous row is not selectable. Exactly one POST: `event "leads.captured"`, `rows[]` of 2 flat objects (no nested values), Dana has canonical URL, title/company split from headline, `page_type "people_search"`. | "batch mode + flat preset…" |
| AT-05 | Deepline preset | Deepline preset, single mode | Send a profile | Body is flat and starts with `linkedin_url, first_name, last_name, title, company_name`; includes `company_domain: null`, `email: null`, `source`. `event_id` equals the header. `x-deepline-dedupe-key` and `Idempotency-Key` equal the canonical profile URL. | "deepline preset: flat row…" |
| AT-05b | Standard Webhooks signature | `whsec_` secret, `standard` scheme | Send a profile | No `X-LWE-Signature`. `webhook-id` equals the event id and contains no ".", `webhook-timestamp` is integer seconds, `webhook-signature` is `v1,<base64 HMAC(decoded key, "<id>.<ts>.<body>")>`. | "standard webhooks scheme…" |
| AT-06 | Retry on 5xx, identical body re-signed | Webhook returns 503 once | Send, then trigger retry | Queue item is `pending`, `attempts 1`, `lastStatus 503`, next attempt > 30 s out. On retry the body and event id are byte-identical, the signature is fresh and valid, and the item becomes `sent`. | "retry: a 503 is retried…" |
| AT-07 | No retry on 4xx | Webhook returns 401 | Send | One request only. Queue item is `failed`, `attempts 1`, `lastStatus 401`. Popup shows a failed pill. | "a 401 is not retried…" |
| AT-08 | Daily cap | `dailyCap 2`, dedupe off; Sales Nav fixture | Select all 3, send; then select 1, send | First send is rejected with "Daily cap reached" and no request. Second send succeeds and reports "1 left today". | "daily cap blocks…" |
| AT-09 | No webhook configured | Fresh install | Send from a profile | Rejected with "No webhook configured"; zero requests. | "no webhook configured…" |
| AT-10 | URL validation | Options page | Save `http://hooks.example.com/x`, then a localhost URL | First is rejected with "must use https"; second saves. | "options: rejects a plain-http…" |
| AT-11 | Test event | Secret + extra header `Authorization: Bearer tok` | Click "Send test event" | Status shows "responded 200". Request has `event "test"`, the bearer header, and a valid signature. | "options: test event…" |
| AT-12 | No UI on unsupported pages | Any | Visit a profile, then `/feed/` | Panel present on the profile, absent on the feed. | "no UI is injected…" |

### Bulk export

The fixture site serves a paginated Sales Navigator search at
`/sales/search/people?query=paged` with 60 results over 3 pages (25, 25, 10),
a "60 results" header, and a "Next" button that is disabled on the last page.
Page delays are set to 100 to 200 ms through the options page.

| ID | Criterion | Given | When | Then | Test |
|---|---|---|---|---|---|
| AT-13 | Export all pages from the panel honors the limit and order | Paged search, limit 40 | Click "Export all" | Job ends `done / limit` after 2 pages with 40 collected and sent; 40 webhook requests arrive in page order (Lead 1..40); page 1 payloads have no `page=` in `page_url`, page 2 payloads do; the panel reads "Done (limit reached)". | "export all pages from the panel…" |
| AT-14 | Export from the popup by URL | Popup with a pasted URL, limit 2500 | Click "Export all pages" | A tab opens; job ends `done / no_more_pages` after 3 pages with 60 sent; 60 distinct Sales Navigator URLs reach the webhook; popup shows "done (no more results)". | "export from the popup by URL…" |
| AT-15 | Stop mid-run | 3 s page delay | Stop after page 1 | Job is `stopped / user` with 1 page and 25 sent; no further requests arrive; the job moves to history. | "stop mid-run…" |
| AT-16 | Daily cap during export | `dailyCap 30` | Export all | Job is `stopped / daily_cap` after page 2 with exactly 30 sent; the webhook receives exactly 30. | "daily cap stops the export…" |
| AT-17 | Dedupe during export | Page 1 already sent manually; limit 30 | Export all | Job ends with 30 collected, 5 sent, 25 skipped; only Lead 26..30 are new requests. | "already-sent people are skipped…" |
| AT-18 | Pause and resume | 1.5 s page delay | Pause after page 1, wait, resume | Pages done does not advance while paused; after resume the job finishes with 3 pages and 60 sent. | "pause and resume from the popup" |
| AT-19 | Guardrails on start | No webhook; then a profile URL | Start export | "Configure a webhook first" and "not a Sales Navigator…" errors; zero requests. | "export refuses to start…" |

### Audit remediation and messy inputs

| ID | Criterion | Test |
|---|---|---|
| AT-20 | Same-path query change via `pushState`/`replaceState` remounts once; 20 route flips leave exactly one panel and 25 checkboxes | "navigating to a different query…" |
| AT-21 | Rows that render 250 ms after intersecting are all captured by auto-scroll before an export page is parsed | "delayed lazy rows…" |
| AT-22 | A lead list with no Next control exports one page and stops; Cyrillic, "Last, First", injected text, hostile company hosts, bad URNs handled; import carries the list id | "a lead list without a Next control…" |
| AT-23 | 2026-layout profile and people search: emoji/credential names, mononyms, unicode slugs, hostile hosts, nested paths, warnings on payloads | "2026-layout profile and people search…" |
| AT-24 | Every action appears in the activity log; neither the log nor page-visible settings contain the secret, auth header, or webhook host; popup shows the feed | "every action is logged…" |
| AT-25 | Page CSS cannot restyle or hide the shadow-root panel | "shadow-root panel…" |
| AT-26 | Two tabs sending at once never exceed the daily cap (all-or-nothing per manual send) | "two simultaneous sends…" |

## Unit-level acceptance criteria

| Area | Criterion | Test |
|---|---|---|
| Names | "Bob Okafor is reachable" → "Bob Okafor"; "Jane Doe, MBA · 2nd" → "Jane Doe"; pronouns stripped; whitespace collapsed | `normalize.test.ts` |
| URLs | Subdomain, query, trailing slash, and percent-encoding are normalized to `https://www.linkedin.com/in/<slug>`; non-profile URLs → null | `normalize.test.ts` |
| Sales Nav | Member URN and canonical lead URL extracted from `/sales/lead/<id>,NAME_SEARCH,…` | `normalize.test.ts` |
| Routing | `/in/x` profile, `/in/x/details/…` not, `/sales/search/people`, `/sales/lists/people/<id>`, `/sales/lead/<id>`, `/search/results/people` | `parsers.test.ts` |
| Profile parser | All fields from the fixture; include flags drop history but keep current title/company; headline fallback when no experience section | `parsers.test.ts` |
| List parsers | All Sales Nav rows parsed with identifiers; anonymous people-search rows skipped | `parsers.test.ts` |
| Mapping | Generic single/batch envelopes; flat has no nested values and `custom_` prefixes; Deepline key order and null placeholders | `mapping.test.ts` |
| Signing | Known HMAC vector; round-trip verify; tamper, wrong secret, stale, NaN rejected; Standard Webhooks `whsec_` decoding and `.` guard | `signing.test.ts` |
| Queue | Sent / retry-with-backoff / permanent-fail / max-attempts transitions; `due()` ordering; `nextWake`; pruning | `queue.test.ts` |
| Sender | Headers (content type, event id, version, idempotency, auth, signature), `credentials: omit`, `redirect: error`; status classification; network error and timeout retryable; standard scheme + Deepline dedupe header | `sender.test.ts` |
| Settings | https-only with localhost exception; origin pattern | `settings.test.ts` |
| Export job | URL classification; `?page=N` rewrite preserves LinkedIn encoding; result-count parsing; limit cap at 2,500; page advance; stop reasons (limit, no more pages, empty page, page 100, daily cap); pause/resume/stop/fail transitions; delay bounds | `export-job.test.ts` |
| Receiver | Refuses to start unsigned; loopback bind; reads need admin token; rejects unsigned/tampered/stale/fractional/malformed; header/body event id must match; concurrent replays acknowledged once; 17 malformed-but-signed shapes return 400 without crashing; oversized bodies 413; hostile URLs dropped; name-fallback identities hashed and flagged; imports and searches stored | `receiver.test.ts` |
| Worker | Sender trust boundary (other extension ids, hostile tabs, page vs popup privileges), redacted settings to content scripts, hostile URL re-validation, 5 concurrent captures against a cap of 30 admit exactly 30, dedupe reserve/confirm/release, stale lease recovery, clear-all keeps in-flight, log entries never contain secrets | `worker.test.ts` |
| Names/URLs | 20 name-cleaning cases (emoji, flags, pronouns, credentials, CJK, Cyrillic, Yoruba diacritics, Turkish, "Last, First"), particles/suffixes/mononyms, hostile hosts, nested paths, encoded slashes, slug length, unicode slugs | `normalize.test.ts` |
| Search grammar | Nested parentheses, commas inside values, ids without text, exclusions, junk/unbalanced input, 30 KB input, repeated keys, session/tracking redaction, case-insensitive page key | `search.test.ts` |
| Settings | Garbage coerced to defaults and clamps, reserved/invalid headers rejected, custom fields bounded, content settings carry no secrets | `settings.test.ts`, `validate.test.ts` |
| Signing | Fractional/negative/huge timestamps, malformed signatures, base64url and unpadded `whsec_`, malformed `whsec_` rejected, multi-signature headers, dotted ids | `signing.test.ts` |

## Live verification (2026-09-03, real LinkedIn session)

Parsers were injected into live pages in the developer's Chrome and the
parsed records pushed through the extension's own signing and sending code
into the reference SQLite receiver:

| Surface | Result |
|---|---|
| Profile (`/in/satyanadella/`) | name, headline, title, company + URL, location, degree, 5 experience entries |
| Sales Navigator search (`?query=(keywords:cro)`, 490K+ results) | 25/25 rows parsed; company on 21; URN + Sales Nav URL on all |
| Sales Navigator lead | name, headline, current role, company + URL, location, degree, 6 experience entries incl. grouped roles |
| People search (`?keywords=chief revenue officer&page=2`) | 10/10 rows; URL, headline, location, degree on all |
| Pipeline | 15 signed requests (2 `search.captured`, 13 `lead.captured`) accepted; tampered signature rejected with 401; `leads`, `searches`, and `sales_nav_imports` tables populated; the same person seen on a lead page and a search row upserted once with `send_count` 2 |

## Manual checks before a release

These cannot run in CI because they need a logged-in LinkedIn session.

1. Load `dist/` unpacked, open a real profile, a people search, a Sales Navigator search, a lead list, and a lead page. The panel appears on each and reads a name.
2. Send one profile to `npm run receiver` (with `LWE_SECRET`) and confirm a row in `leads.sqlite`.
3. Scroll a Sales Navigator search: lazily loaded rows get checkboxes.
4. Navigate profile → profile via in-app links: the panel re-mounts and the "Already sent" state is correct.
5. `Alt+Shift+L` sends the current profile.
6. Publish `examples/deepline/linkedin-capture.play.ts`, configure the Deepline preset with Standard Webhooks, send a test event, and confirm a `202` with `deduped: false`, then a re-send of the same profile returns `deduped: true`.
