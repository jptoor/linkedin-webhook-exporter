# Risk review: Frontier-pattern layer (v0.3)

Scope: the four capabilities added to match Frontier / Exportly's extension
architecture, reviewed for account risk (LinkedIn), data risk (people and
credentials), and abuse risk (who can drive the extension). Each row says
what we do, what Frontier does, and why the residual risk is acceptable or
what would make it not.

| Area | What we ship | What Frontier ships | Residual risk | Mitigation in code |
|---|---|---|---|---|
| **Reading LinkedIn API responses** (`page-bridge.ts`) | MAIN-world script wraps `XMLHttpRequest.prototype.open` and `window.fetch`; when the page itself loads one of 9 allow-listed URLs (`sales-api/salesApiLeadSearch`, `salesApiPeopleSearch`, `salesApiProfiles`, `salesApiCompanies`, `salesApiAccountSearch`, `salesApiDashboardAccountTable`, `voyager/api/graphql`, `voyager/api/search/dash/clusters`, `voyager/api/identity/dash/profiles`) the response text is posted to the content script. | Same technique (`interceptor-script.js` patches `XMLHttpRequest.prototype.open`, reads `responseText`) on the same `sales-api` endpoints plus Salesforce `ListUi` / `RecordUi`; injected via `web_accessible_resources` and `runtime.getURL`. | **Medium.** Prototype patching is detectable by page code, and reading Voyager payloads is squarely against LinkedIn's User Agreement. It is also the industry norm (Frontier, Apollo, Lusha, Kaspr all do it) and it makes zero additional requests, so it does not change the rate profile LinkedIn sees. | Passive only: no requests are issued, modified, replayed or retried. Allow-list is substrings on the page's own URLs; everything else is untouched. Bodies over 2 MB are dropped. The parser is bounded (20k nodes, depth 12) and re-validates every URL against LinkedIn hosts before it can reach a payload. Off switch in Settings ("Use LinkedIn's own page data"), remote kill flag `intercept`. Registered as a `world: "MAIN"` content script rather than an injected `<script src>`, so it needs no `web_accessible_resources` and is not blocked by LinkedIn's CSP. |
| **Session sign-in** (`auth.ts`) | No `cookies` permission. `GET /api/v2/auth/session` with `credentials: "include"` (Chrome attaches the cookie itself) tells the extension who is signed in; re-checked on panel open, when a Deepline-origin tab finishes loading, and at most every minute before a session-mode run is sent. Each queued session-mode run carries the `user\|org` identity that queued it and is failed (`account_changed` / `signed_out`), never sent, if the identity differs at send time. | `cookies` permission with `<all_urls>` host access; reads `credentials.access_token / refresh_token / id_token / pool_name` for `.api.befrontier.com`, decodes the id token locally, schedules refreshes. | **Low.** The cookie value never enters extension code or storage (AT-31 asserts storage never contains it). The `cookies` permission would have granted read access to LinkedIn cookies too (host permissions cover LinkedIn), which is why it was removed rather than scoped. Cross-site request forgery is not a concern: extension-origin requests with host permission are first-party to Chrome, and every call is a read (`GET`) or an idempotent run keyed by `Idempotency-Key`. | No `<all_urls>`. Session state cached 5 min in `storage.session` only. 401/403 on a run is not retried. Captures are rejected with `signed_out` when there is no session. API key remains an explicit "Advanced" alternative. |
| **Side panel per tab** | `chrome.sidePanel.setOptions({ tabId, enabled })` on tab updates: enabled only for LinkedIn URLs (loopback in the test build). | Enabled on LinkedIn, or on any site once the user enables broader access. | **None new.** | We never widen beyond LinkedIn. |
| **Web app channel** (`externally_connectable`) | `https://deepline.com/*`, `https://*.deepline.com/*` may send `ping`, `get_auth_state`, `open_side_panel`. Origin is re-validated in the handler (https + deepline.com host), every message is logged. | `exportly.ai`, `befrontier.com` may drive tab control, storage, DOM automation, interception rules, permissions and auth. | **Low.** Three read-only or gesture-bound operations; nothing that reads a page, changes settings or sends data. A compromised deepline.com page could learn the extension version and whether the rep is signed in, and open the panel. | Keep the operation set closed; adding DOM automation here would move this row to High. |
| **Telemetry** (`telemetry.ts`) | Product events (`installed`, `signed_in`, `destination_connected`, `push_queued`, `search_import_started`) with version, user agent, time zone, anonymous id and the Deepline user/org id; error reports to Deepline's failure endpoint; remote feature flags with local defaults. Segment is used only if a write key is compiled in. | Segment, Sentry, LaunchDarkly SDKs. | **Low.** Event properties are scrubbed of anything person- or secret-shaped before they leave (unit-tested); errors carry message and stack only. | Settings toggle (default on), `telemetry` kill flag, no vendor SDK, no people data. |
| **Permissions surface** | `storage`, `alarms`, `sidePanel`, `tabs`; hosts: LinkedIn + `code.deepline.com`; optional hosts on demand. | `storage`, `cookies`, `alarms`, `scripting`, `tabs`, `sidePanel`; hosts: `<all_urls>`, LinkedIn, Clay, Frontier. | We are strictly narrower: no `cookies`, no `scripting`, no `<all_urls>`. `scripts/pack.mjs` fails the release if any other permission appears. |

## Things that are still true and worth saying out loud

- Nothing here makes LinkedIn use compliant. Reading Voyager payloads, even
  passively, is a User Agreement violation and LinkedIn can restrict the
  account. The daily cap, dedupe and "no automation" stance limit the blast
  radius; they are not a defence.
- The page bridge runs on every LinkedIn page load. If LinkedIn ever ships a
  check for patched `XMLHttpRequest` prototypes, the flag `intercept` can turn
  it off remotely without a release.
- `tabs` lets the extension see URLs of all tabs; we use it to follow the
  active LinkedIn tab and relay actions. It is not used to read other sites.
- The reference receiver and the Deepline plays store people data. Who is
  allowed to push what, and the lawful basis for it, remains the operator's
  responsibility.

## Verified by tests

- `tests/unit/linkedin-api.test.ts`: hostile hosts and photo URLs rejected, bounded walk on a 30k-element payload, non-people skipped.
- `tests/unit/telemetry-auth.test.ts`: `credentials: "include"`, `redirect: "error"` and `cache: "no-store"` on the session call, no cookies API; identity key binds user and org; Deepline tabs matched by exact origin; secrets, e-mails, JWTs and query strings scrubbed out of error messages, stacks and event properties.
- `tests/unit/worker.test.ts`: runs carry no bearer header when using the sign-in and are bound to `sessionIdentity`; a signed-out rep gets `signed_out` for pushes and search imports; a run queued as one user is failed with `account_changed` instead of being retried after another user signs in; Deepline tabs (not LinkedIn tabs) finishing a load refresh the session; the external channel refuses non-Deepline, http and arbitrary-subdomain origins, unknown operations, and returns only `{ signedIn, baseUrl }`.
- `tests/unit/linkedin-api.test.ts` / `search.test.ts`: `about` is never filled from the API when the operator turned it off; `source.page_url` loses session and tracking parameters but keeps the page number.
- `tests/acceptance/extension.spec.ts` AT-30 / AT-31 / AT-32: end-to-end bridge enrichment on a page that calls the API itself; sign-in through a real cookie in Chromium with the cookie value never reaching extension storage; synthetic clicks and forged bridge messages from a page script change nothing while a real click still pushes.

## Second-opinion review

`docs/RISK-REVIEW-CODEX.md` is an independent adversarial review of the same
layer (Codex, gpt-5.6). Its "do not ship" findings CR-01 to CR-05 and the P2
items CR-06 to CR-13 are all addressed; the status table at the end of that
file maps each finding to the fix and the test that pins it.
