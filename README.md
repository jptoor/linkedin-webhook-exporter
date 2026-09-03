<p><img src="src/brand/deepline-wordmark.svg" alt="Deepline" height="22"></p>

# LinkedIn Webhook Exporter

Open-source Chrome extension that captures the person data LinkedIn already
shows you (profile pages, people search, Sales Navigator search, lists, and
lead pages) and POSTs it as signed JSON to one webhook you control: a
[Deepline](https://deepline.com) play, a Clay table, Zapier / Make / n8n, or
the bundled SQLite receiver.

It does the capture and route layers that ZoomInfo, Apollo, Lusha, Exportly
and ClayGenies sell, and leaves email/phone reveal to your receiver. No
account, no server, no telemetry. Settings live in your browser profile only.

- **One click** on a profile, **multi-select** on list pages.
- **Export a whole search**: paste a Sales Navigator search or list URL (or click "Export all" on the page) and every page is walked up to your limit, LinkedIn's 2,500 cap, or your daily cap, with pause/stop. Same flow as Wiza, Prospeo, lemlist and Exportly, minus their cloud.
- **Stable payload** with normalized names and canonical URLs; three presets
  (generic envelope, flat, Deepline field names).
- **Signed** with HMAC-SHA256 in either the LWE scheme or
  [Standard Webhooks](https://www.standardwebhooks.com) (Deepline / Svix native).
- **Idempotent**: `Idempotency-Key` and `x-deepline-dedupe-key` are the lead's
  identity, retries re-send byte-identical bodies, receivers can dedupe safely.
- **Guardrails**: local dedupe, daily cap (default 100), no automation.
- **Saved searches + import audit**: "Save search" sends the Sales Navigator query (decoded filters, keywords, result count) as `search.captured`; every lead carries who imported it, when, and from which search or list, ready for a `sales_nav_imports` table.

Docs: [`docs/SPEC.md`](docs/SPEC.md) · [`docs/ACCEPTANCE_TESTS.md`](docs/ACCEPTANCE_TESTS.md) · [`docs/RESEARCH.md`](docs/RESEARCH.md) · [`examples/deepline`](examples/deepline)

## Install (developer)

```sh
npm install
npm run build          # -> dist/
```

Chrome → `chrome://extensions` → Developer mode → Load unpacked → `dist/`.

## Configure

Open the extension options:

| Setting | What it does |
|---|---|
| Webhook URL | `https://` only (`http://localhost` allowed for dev). The host is requested as an optional permission on save. |
| Signing secret + scheme | `LWE` (`X-LWE-Signature: sha256=hex`) or `Standard Webhooks` (`webhook-id/-timestamp/-signature`, `whsec_` secrets). |
| Extra header | e.g. `x-deepline-webhook-secret` or `Authorization: Bearer …`. |
| Field mapping | `generic` (nested envelope), `flat` (Clay/Zapier/sheets), `deepline`. |
| Send mode | `single` (one request per lead, recommended) or `batch`. |
| Dedupe / TTL / daily cap | Safety controls. |
| Captured by / custom fields | Provenance and tags carried on every payload. |

Click **Send test event** to verify the endpoint.

## Try it locally in 60 seconds

```sh
LWE_SECRET=topsecret npm run receiver        # http://localhost:8787/hook, writes leads.sqlite
```

Set the webhook URL to `http://localhost:8787/hook`, secret `topsecret`,
scheme LWE. Open any LinkedIn profile, click **Send to webhook**, then
`curl localhost:8787/leads`.

## Export a whole Sales Navigator search

On any Sales Navigator search, lead list, or LinkedIn people search, the panel
shows "Export all pages, up to N". Or open the popup, paste the URL, set a
limit, and click "Export all pages". The extension walks `?page=1..100` in the
same tab with a randomized 4 to 9 s delay between pages, auto-scrolls each page
so lazy rows render, and sends every lead through the normal pipeline (dedupe,
daily cap, signed webhook). Progress, pause, and stop live in the panel and the
popup. LinkedIn shows at most 2,500 results per search; split bigger searches
with filters, as every competitor recommends.

## Payload (generic preset, single mode)

```json
{
  "schema_version": "1",
  "event": "lead.captured",
  "event_id": "5f0c…",
  "sent_at": "2026-09-03T15:04:05.000Z",
  "source": { "extension": "linkedin-webhook-exporter", "version": "0.1.0", "page_type": "profile", "page_url": "https://www.linkedin.com/in/jane-doe-123/", "captured_by": "jai" },
  "custom": { "campaign": "q3" },
  "lead": {
    "full_name": "Jane Doe", "first_name": "Jane", "last_name": "Doe",
    "headline": "VP of Sales at Acme Corp", "title": "VP of Sales",
    "company_name": "Acme Corp", "company_linkedin_url": "https://www.linkedin.com/company/12345",
    "location": "Austin, Texas, United States",
    "linkedin_url": "https://www.linkedin.com/in/jane-doe-123", "linkedin_slug": "jane-doe-123",
    "linkedin_member_urn": null, "sales_navigator_url": null,
    "connection_degree": "2nd", "profile_image_url": "https://…", "about": "…",
    "experience": [{ "title": "VP of Sales", "company_name": "Acme Corp", "company_linkedin_url": "https://www.linkedin.com/company/12345", "date_range": "Jan 2023 - Present · 3 yrs 8 mos", "location": null }],
    "education": [{ "school": "University of Texas at Austin", "degree": "MBA, Marketing", "date_range": "2014 - 2016" }],
    "captured_at": "2026-09-03T15:04:04.000Z"
  }
}
```

Headers: `X-LWE-Event-Id`, `X-LWE-Version`, `Idempotency-Key`, plus the
signature headers for the chosen scheme. See the spec for the flat and
Deepline shapes.

## Verify a request (Node)

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const ts = req.headers["x-lwe-timestamp"];
const expected = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${rawBody}`).digest("hex");
const ok = Math.abs(Date.now() / 1000 - ts) < 300 && timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-lwe-signature"]));
```

## Deepline

See [`examples/deepline`](examples/deepline). Short version: publish the
example play, paste its `endpointUrl` as the webhook, choose the Deepline
preset + Standard Webhooks with the play's `whsec_` secret. Bodies arrive as
the play's `input` verbatim; `x-deepline-dedupe-key` makes re-captures a
no-op.

## Tests

```sh
npm test                 # unit (vitest): parsers, mapping, signing, queue, sender, receiver e2e
npm run test:acceptance  # Playwright: real extension in Chromium against fixture pages + mock webhook
```

## Safety and compliance

The extension only reads what LinkedIn renders to you and only acts on a
click. LinkedIn's terms prohibit automated access; community-reported
restriction thresholds are around 50 to 100 captures per day. Keep the daily
cap conservative, prefer profile-page capture over bulk Sales Navigator
capture, and make sure you have a lawful basis for processing the people you
capture. You are responsible for how you use this tool.

## License

MIT. Built and maintained by [Deepline](https://deepline.com); contributions welcome.
