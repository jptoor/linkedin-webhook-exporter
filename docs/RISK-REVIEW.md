# Risk review: Frontier-pattern layer (v0.3)

Scope: the four capabilities added to match Frontier / Exportly's extension
architecture, reviewed for account risk (LinkedIn), data risk (people and
credentials), and abuse risk (who can drive the extension). Each row says
what we do, what Frontier does, and why the residual risk is acceptable or
what would make it not.

| Area | What we ship | What Frontier ships | Residual risk | Mitigation in code |
|---|---|---|---|---|
| **Reading LinkedIn API responses** (`page-bridge.ts`) | MAIN-world script wraps `XMLHttpRequest.prototype.open` and `window.fetch`; when the page itself loads one of 9 allow-listed URLs (`sales-api/salesApiLeadSearch`, `salesApiPeopleSearch`, `salesApiProfiles`, `salesApiCompanies`, `salesApiAccountSearch`, `salesApiDashboardAccountTable`, `voyager/api/graphql`, `voyager/api/search/dash/clusters`, `voyager/api/identity/dash/profiles`) the response text is posted to the content script. | Same technique (`interceptor-script.js` patches `XMLHttpRequest.prototype.open`, reads `responseText`) on the same `sales-api` endpoints plus Salesforce `ListUi` / `RecordUi`; injected via `web_accessible_resources` and `runtime.getURL`. | **Medium.** Prototype patching is detectable by page code, and reading Voyager payloads is squarely against LinkedIn's User Agreement. It is also the industry norm (Frontier, Apollo, Lusha, Kaspr all do it) and it makes zero additional requests, so it does not change the rate profile LinkedIn sees. | Passive only: no requests are issued, modified, replayed or retried. Allow-list is substrings on the page's own URLs; everything else is untouched. Bodies over 2 MB are dropped. The parser is bounded (20k nodes, depth 12) and re-validates every URL against LinkedIn hosts before it can reach a payload. Off switch in Settings ("Use LinkedIn's own page data"), remote kill flag `intercept`. Registered as a `world: "MAIN"` content script rather than an injected `<script src>`, so it needs no `web_accessible_resources` and is not blocked by LinkedIn's CSP. |
| **Session sign-in** (`auth.ts`) | `cookies` permission scoped by `host_permissions` to `code.deepline.com`; `chrome.cookies.get` checks only whether `better-auth.session_token` exists; API calls use `credentials: "include"` so Chrome attaches the cookie itself; `chrome.cookies.onChanged` refreshes state. | `cookies` permission with `<all_urls>` host access; reads `credentials.access_token / refresh_token / id_token / pool_name` for `.api.befrontier.com`, decodes the id token locally, schedules refreshes. | **Low.** The cookie value never enters extension code or storage (AT-31 asserts storage never contains it). Cross-site request forgery is not a concern: extension-origin requests with host permission are first-party to Chrome, and every call is a read (`GET`) or an idempotent run keyed by `Idempotency-Key`. A rep who signs out of Deepline is signed out of the extension within a cookie-change event. | No `<all_urls>`. Session state cached 5 min in `storage.session` only. 401/403 on a run is not retried. API key remains an explicit "Advanced" alternative. |
| **Side panel per tab** | `chrome.sidePanel.setOptions({ tabId, enabled })` on tab updates: enabled only for LinkedIn URLs (loopback in the test build). | Enabled on LinkedIn, or on any site once the user enables broader access. | **None new.** | We never widen beyond LinkedIn. |
| **Web app channel** (`externally_connectable`) | `https://deepline.com/*`, `https://*.deepline.com/*` may send `ping`, `get_auth_state`, `open_side_panel`. Origin is re-validated in the handler (https + deepline.com host), every message is logged. | `exportly.ai`, `befrontier.com` may drive tab control, storage, DOM automation, interception rules, permissions and auth. | **Low.** Three read-only or gesture-bound operations; nothing that reads a page, changes settings or sends data. A compromised deepline.com page could learn the extension version and whether the rep is signed in, and open the panel. | Keep the operation set closed; adding DOM automation here would move this row to High. |
| **Telemetry** (`telemetry.ts`) | Product events (`installed`, `signed_in`, `destination_connected`, `push_queued`, `search_import_started`) with version, user agent, time zone, anonymous id and the Deepline user/org id; error reports to Deepline's failure endpoint; remote feature flags with local defaults. Segment is used only if a write key is compiled in. | Segment, Sentry, LaunchDarkly SDKs. | **Low.** Event properties are scrubbed of anything person- or secret-shaped before they leave (unit-tested); errors carry message and stack only. | Settings toggle (default on), `telemetry` kill flag, no vendor SDK, no people data. |
| **Permissions surface** | `storage`, `alarms`, `sidePanel`, `tabs`, `cookies`; hosts: LinkedIn + `code.deepline.com`; optional hosts on demand. | `storage`, `cookies`, `alarms`, `scripting`, `tabs`, `sidePanel`; hosts: `<all_urls>`, LinkedIn, Clay, Frontier. | We are strictly narrower: no `scripting`, no `<all_urls>`. |

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
- `tests/unit/telemetry-auth.test.ts`: no session call without the cookie; `credentials: "include"` and `redirect: "error"` on the session call; error reports never sent when disabled or signed out; secrets scrubbed from event properties.
- `tests/unit/worker.test.ts`: runs carry no bearer header when using the sign-in; cookie changes on other hosts are ignored; the external channel refuses non-Deepline and http origins and unknown operations.
- `tests/acceptance/extension.spec.ts` AT-30 / AT-31: end-to-end bridge enrichment on a page that calls the API itself; sign-in through a real cookie in Chromium with the cookie value never reaching extension storage.
