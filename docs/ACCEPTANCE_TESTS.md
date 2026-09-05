# Acceptance tests

Two layers, both run in CI with `npm test && npm run test:acceptance`.

- **Unit** (`tests/unit`, vitest + jsdom): parsers against HTML fixtures,
  normalization, payload mapping, play input shaping, the selection basket,
  signing, queue state machine, sender (webhook and play run), the service
  worker against a fake `chrome.*`, and an end-to-end test that spawns the
  reference receiver.
- **Acceptance** (`tests/acceptance`, Playwright): the built extension is
  loaded into Chromium. A local server serves fixture pages on LinkedIn-shaped
  paths (`/in/<slug>/`, `/sales/search/people`, `/sales/lists/people/<id>`,
  `/search/results/people/`). A mock webhook records every request and can be
  told to fail; a mock Deepline API lists plays and accepts play runs. The
  side panel is exercised as a real extension page pinned to the fixture tab
  (`sidepanel.html?tab=<id>`). Nothing touches linkedin.com.

Run one: `npx playwright test -g "import search"` (use the title text).

## Acceptance criteria

| ID | Criterion | Setup | Action | Expected | Test |
|---|---|---|---|---|---|
| AT-01 | Profile push is complete, signed, well-formed | Webhook + LWE secret + name + tags; a profile page | Dock "Push to Hook" | "1 on the way". Exactly one POST with `application/json`, a UUID `X-LWE-Event-Id`, a fresh timestamp, `X-LWE-Signature = sha256=HMAC(secret, "<ts>.<body>")`. Body has the envelope, `source.page_type "profile"`, `custom`, `import.import_kind "manual"`, and a lead with name split, title, company + URL, location, canonical `/in/` URL, degree, 2 experience entries, 1 education entry, about text. | "profile page: one click pushes…" |
| AT-02 | Dedupe; "Push again" overrides | Same | Push, push again, reload, "Push again" | Second click says "pushed before" and sends nothing; after reload the dock says "Pushed before"; "Push again" sends a second request. | "dedupe: the same profile…" |
| AT-03 | Row pills select people; one request per person | Sales Nav fixture, 3 rows, single mode | Click "+" on rows 1 and 2, "Push 2" | Dock disabled at 0, count badge "2/3". Two POSTs with distinct event ids; Bob has Sales Navigator URL, URN, `linkedin_url: null`, degree "3rd"; both share one `import_id` with `import_kind "basket"`, `search_name "cro"`, `page 1`. Pushed rows outlined green, pills released, dock disabled again. | "Sales Navigator search: pick two people…" |
| AT-04 | Batch mode + flat shape | People-search fixture (one anonymous row); batch + flat | "Select page", push | Anonymous row not selectable. One POST: `event "leads.captured"`, `rows[]` of 2 flat objects, `page_type "people_search"`. | "batch mode + flat preset…" |
| AT-05 | Deepline shape | Deepline preset | Push a profile | Flat body starting with the envelope then `linkedin_url, first_name, last_name, title, company_name`; `company_domain: null`, `email: null`; `x-deepline-dedupe-key` and `Idempotency-Key` equal the canonical profile URL. | "deepline preset…" |
| AT-05b | Standard Webhooks signature | `whsec_` secret, `standard` scheme | Push a profile | No `X-LWE-Signature`; `webhook-id` = event id; `webhook-signature = v1,<base64 HMAC(decoded key, "<id>.<ts>.<body>")>`. | "standard webhooks scheme…" |
| AT-06 | Retry on 5xx re-signs the identical body | Webhook returns 503 once | Push, retry | Item `pending`, attempts 1, next attempt > 30 s out; retry sends byte-identical body and event id with a fresh valid signature; item `sent`. | "retry: a 503…" |
| AT-07 | No retry on 4xx; visible in the panel | Webhook returns 401 | Push | One request; item `failed`; side panel Recent shows a Failed chip and "Retry failed". | "a 401 is not retried…" |
| AT-08 | Daily cap; refused people stay selected | `dailyCap 2`, dedupe off; 3 rows | Select page, push; unselect, pick one, push | First push refused with "hit today's limit", nothing sent, still "Push 3"; second push "1 on the way · 1 left today". | "daily cap blocks pushes…" |
| AT-09 | Nothing connected | Fresh install | Push | "Choose where to send first"; zero requests; panel button reads "Choose where to send". | "nothing connected…" |
| AT-10 | Webhook URL validation in Settings | Settings page | Save `http://hooks.example.com/x`, then localhost | First rejected "must use https"; second saved, listed as current. | "settings: connecting a webhook…" |
| AT-11 | Test connection | Secret + extra header | "Test connection" | "answered 200"; request has `event "test"`, the bearer header, a valid signature. | "settings: test connection…" |
| AT-12 | No UI on unsupported pages | Any | Visit a profile, then `/feed/` | Dock present, then absent. | "no UI is injected…" |
| AT-13 | Picks survive moving between pages; one import | Paged search, 2 pages | Pick 2 on page 1, 2 on page 2, back to page 1, push | Dock keeps "Push 2" across navigation, page 1 pills still pressed; "4 on the way"; 4 requests with one `import_id`, `import_kind "basket"`, `import.page` values 1,1,2,2, `search_url` without session/page params; dock disabled after. | "picks survive moving between result pages…" |
| AT-14 | LinkedIn's own checkboxes select too | Sales Nav fixture with native checkboxes | Tick rows 1 and 3, untick 1, click pill 2 | "Push 2" then "Push 1"; pill 3 pressed; LinkedIn's box 2 becomes checked. | "Sales Navigator's own checkboxes…" |
| AT-15 | Side panel: list, remove, pinned button | Webhook named "Warm intro" | Panel "Select this page", remove Bob, push | Button reads "Pick people to push" → "Push 3 people to Warm intro"; list shows 3 then 2; dock badge "2/3"; "2 people on the way"; Alice and Carla delivered; Recent shows 2 Sent chips. | "side panel: shows the picked people…" |
| AT-16 | Play destination, mapped input | Play `warm-intro` (linkedin_url, first_name, last_name, company_name) | Panel "Push Jane to Warm intro" | `POST /api/v2/plays/run` with `Authorization: Bearer <key>`, `Idempotency-Key` = profile URL, body `{ name, input: {linkedin_url, first_name, last_name, company_name} }`; Recent chip "Running"; queue item carries `runId`. Nothing reaches the webhook. | "play destination: pushing a profile…" |
| AT-17 | Play with `leads[]` | Play `linkedin-capture` | Select page, push | One run: `input.leads` has 3 flat rows with `import_kind "basket"`, plus `import_search_name`, `imported_by`, `captured_by`. | "play with leads[]…" |
| AT-18 | Play that only takes searches refuses people | Play `salesnav-search-import` | Push a profile | "does not take people"; zero requests. | "a play that only takes searches…" |
| AT-19 | Connect a play through Settings | Mock Deepline | Wrong key, then right key, pick a play, save | "rejected" then "4 plays" (owned first); picked play summarised as "searches · one run per lead"; saved destination has the inferred input spec (`acceptsSearch`, `required: ["search_url"]`). | "settings: connecting a play…" |
| AT-20 | Import search to a play | Play `salesnav-search-import`, default limit 100 | Panel: limit 40, Import search; again | One run `{ search_url (no page/session), limit 40, search_name, imported_by }`; the tab is never navigated; second click "already imported". | "import search: the side panel hands…" |
| AT-21 | Import search to a webhook | Webhook | Dock "Import search" | One signed `search.captured` with `keywords`, `filters {REGION: [United States]}`, `limit 100`, `saved_search_id null`, `import.import_kind "search"`, no `sessionId`. | "import search to a webhook…" |
| AT-22 | Saved search needs the share link | `?savedSearchId=…` | Panel shows the notice, Import disabled; Sales Navigator copies a share link; Import | "Shareable link ready"; run's `search_url` is the shared query URL; no `sessionId` persisted. | "saved search: import waits…" |
| AT-23 | SPA route changes | Paged search | `pushState` / `replaceState` × 20 | Exactly one dock and 25 pills after every flip. | "navigating to a different query…" |
| AT-24 | Lead list with messy names | List 7263, 12 rows | Select page, push | 12 requests incl. Cyrillic and "Last, First" names; hostile company host dropped; every import carries `list_id "7263"` and `import_kind "basket"`. | "a lead list: select the page…" |
| AT-25 | 2026 layouts | SDUI profile and people search | Push; select page, push | Zoë parsed with warnings and 5 experience entries; 9 selectable rows; mononym, unicode slug, hostile host handled. | "2026-layout profile and people search…" |
| AT-26 | Logging and secret hygiene | Webhook with secret + bearer, plus a play with an API key | Push, push again | Log has capture, send and duplicate kinds; neither the log nor the panel's state contains the secret, the bearer, or the API key; Recent names the person. | "every action is logged…" |
| AT-27 | Shadow-root dock | Hostile page CSS | Inject `button { display:none; background:red }` | Dock button visible and not red. | "shadow-root dock…" |
| AT-28 | Daily cap across tabs | `dailyCap 30`, two pages of 25 | Push page 1, then page 2 | 25 sent; second push refused whole "(5 left)" and stays selected; state reports 25 sent, 25 in the basket. | "the daily cap holds across tabs…" |
| AT-30 | Page bridge fills what the DOM lacks | Sales Nav fixture whose own script calls `/sales-api/salesApiLeadSearch` (and Voyager) after load | Select page, push | Bob's payload carries the public `linkedin_url` and slug from the API's flagship URL, exact title/company/company URL and region, with `api_merged` in `parse_warnings`; Carla (no flagship URL in the payload) keeps `linkedin_url: null`; the log records `intercept.captured` with 3 people and the API total. | "page bridge: the sales-api response…" |
| AT-31 | Sign-in through the Deepline session | Mock Deepline that accepts a `better-auth.session_token` cookie; no destinations | Open the panel signed out; add the cookie; pick a play from the panel; push | Signed out: sign-in card and "Choose where to send". After the cookie: header shows the rep's email, "Pick the play" card, play list loads with `credentials: include` and no bearer; the run carries the cookie and no `Authorization`; the saved destination has an empty `apiKey`; the cookie value never appears in extension storage. | "sign-in flow: a Deepline session cookie…" |
| AT-29 | Switching destination; pins | Webhook "Zed hook" + play "Warm intro" | Open the chip, pin Zed hook, search "warm", pick the play, push | Sheet lists alphabetically, pinned first after starring, filters by search; both the panel button and the dock relabel to "Warm intro"; the run goes to Deepline, nothing to the webhook. | "switching the destination in the panel…" |

## Unit-level acceptance criteria

| Area | Criterion | Test |
|---|---|---|
| Names | "Bob Okafor is reachable" → "Bob Okafor"; "Jane Doe, MBA · 2nd" → "Jane Doe"; pronouns stripped; 20 messy cases (emoji, flags, credentials, CJK, Cyrillic, Turkish, "Last, First"), particles/suffixes/mononyms | `normalize.test.ts` |
| URLs | Canonical `/in/<slug>`, Sales Navigator lead URL + URN, company URL; hostile hosts, nested paths, encoded slashes, slug length, unicode slugs | `normalize.test.ts` |
| Routing / parsers | Page-type detection; profile, list and lead parsers on classic and 2026 fixtures | `parsers.test.ts` |
| Mapping | Generic single/batch envelopes; flat has no nested values and `custom_` prefixes; Deepline key order and null placeholders; `import` nested vs prefixed; search bodies | `mapping.test.ts` |
| Play input | `leads[]` → batch, `lead{}` → per person, field names → mapped with aliases and Sales Navigator fallback, search URL fields, no schema → anything; unfillable required fields reported; run id extraction; base URL rules; play listing (owned then prebuilt) and key test through a fetch mock | `deepline.test.ts` |
| Basket | Idempotent add, 500 cap, pages counted per search, groups per (search, page) so each person keeps its page number, remove | `deepline.test.ts` |
| LinkedIn API | Intercept allow-list matches the Frontier endpoint set only; Sales Navigator and Voyager payloads yield people with ids, names, role, company (+URL), region, degree, photo, flagship URL; hostile hosts and photos rejected; bounded walk on 30k elements; `enrichLead` fills nulls and flagged fields, adds the public URL, never overrides clean DOM values | `linkedin-api.test.ts` |
| Telemetry / flags | Properties scrubbed of secrets and people; Segment payload shape; no fetch without a compiled key; error reports use session or key and never when disabled/signed out; flags keep defaults on failure and accept only known booleans | `telemetry-auth.test.ts` |
| Session auth | No session call without the cookie; `credentials: include` + `redirect: error`; user/org parsed; signed-out and 503 handled; cookie-change filter by host and name; sign-in URL | `telemetry-auth.test.ts`, `worker.test.ts` |
| Web app channel | `externally_connectable` handler refuses non-Deepline and http origins and unknown operations; ping reports version and sign-in; every message logged | `worker.test.ts` |
| Signing | Known HMAC vector; round-trip verify; tamper, wrong secret, stale, NaN rejected; Standard Webhooks `whsec_` decoding and `.` guard | `signing.test.ts` |
| Queue | Sent / retry-with-backoff / permanent-fail / max-attempts transitions; `due()` ordering; `nextWake`; pruning; items carry their destination | `queue.test.ts` |
| Sender | Webhook headers and signing; `credentials: omit`, `redirect: error`; play run POST with bearer, idempotency headers and run id; insecure base URL refused; status classification | `sender.test.ts` |
| Settings | Destination coercion (webhook and play), v0.1 single-webhook migration, duplicate ids, active id fallback, list bound; content settings and redacted destinations carry no secrets | `settings.test.ts` |
| Search grammar | Nested parentheses, exclusions, junk input, repeated keys, session redaction, `savedSearchId` extraction, `limit` on the record | `search.test.ts` |
| Receiver | Refuses to start unsigned; loopback bind; admin-token reads; rejects unsigned/tampered/stale/malformed; header/body event id must match; concurrent replays acknowledged once; oversized bodies 413; imports and searches stored | `receiver.test.ts` |
| Worker | Trust boundary (other extension ids, hostile tabs, page vs panel vs settings privileges), secrets blanked for pages and the panel, hostile URL re-validation, 5 concurrent captures against a cap of 30 admit exactly 30, dedupe reserve/confirm/release, stale lease recovery; play runs per lead with mapped input and run ids, play mismatch refused before any request, deleted destination fails pending items, play listing and key test, active destination and favourites; basket add/remove/clear in session storage with tab notifications, basket send with one import id per push and one capture per page, cap-refused people stay; search hand-off to webhook and play, saved search requires and then uses the share link, page context validation | `worker.test.ts` |

## Manual checks before a release

These cannot run in CI because they need a logged-in LinkedIn session.

1. Load `dist/` unpacked, open a real profile, a people search, a Sales Navigator search, a lead list, and a lead page. The dock appears on each; the side panel (toolbar icon) reads a name or a row count.
2. Connect a play with a real API key: plays load, the pinned button names the play, a push shows "Running" and a run appears in Deepline.
3. Pick people on two result pages of a real Sales Navigator search, then push from the panel: one import id, both pages' people arrive.
4. Open a saved search: the panel shows the private-link notice; "Get the shareable link" (or Sales Navigator's own Share search) enables Import search; the play receives a `query=` URL.
5. Navigate profile → profile via in-app links: the dock re-mounts and the "Pushed before" state is correct.
6. `Alt+Shift+L` pushes the current profile.
