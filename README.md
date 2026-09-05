<p><img src="src/brand/deepline-wordmark.svg" alt="Deepline" height="22"></p>

# Deepline for LinkedIn

Open-source Chrome extension (MIT) that lets a sales rep push the people they
are looking at on LinkedIn or Sales Navigator into a
[Deepline](https://deepline.com) play, or to any webhook (Clay, Zapier, your
own server), from a side panel. Pick a few people across several result
pages, push them with one button, or hand a whole Sales Navigator search to
Deepline and let the backend fetch the members.

No account of its own and no server of its own: it follows your Deepline
sign-in. Settings live in your browser profile only. Anonymous usage events
and error reports go to Deepline unless you turn them off (see PRIVACY.md).

> **Read before using.** LinkedIn's [User Agreement](https://www.linkedin.com/legal/user-agreement)
> prohibits browser extensions that scrape or automate its service, and
> LinkedIn [restricts accounts](https://www.linkedin.com/help/linkedin/answer/a1341387)
> that use them. This tool reads only what your browser already renders and
> acts only when you click, and it never pages through results on its own,
> but **no daily cap or dedupe setting makes that compliant or prevents a
> restriction.** Use it where you have the right to, at your own risk, with
> your own LinkedIn account. See [PRIVACY.md](PRIVACY.md).

## What a rep sees

- **Side panel** (toolbar icon or the dock in the corner of the page): what
  you are looking at, where it goes, and one pinned button that says exactly
  what will happen: "Push 4 people to Warm intro".
- **Pick people across pages**: a round "+" on every result row (Sales
  Navigator's own checkboxes work too). Picks stay while you move between
  pages; push them all at once. Cleared when the browser closes.
- **Import a whole search**: on a Sales Navigator search, set "up to N
  people" and click Import search. The search URL and filters go to the play
  you chose; Deepline fetches the members in the background. For a saved
  search, press Sales Navigator's own "Share search" once so the shareable
  link (with the full query) is sent instead of the private deep link.
- **Plays, not URLs**: sign in to Deepline once and pick a play from the
  panel; the extension follows your sign-in, so there is nothing to paste.
  Switch between plays from the "Sending to" chip; pin favourites. Webhooks
  with signing secrets and extra headers stay available under "Send to
  another tool" for everyone else.
- **Recent**: every push with a plain status (Sent, Running, Retrying,
  Failed) and a retry link. Full history with secrets redacted in Settings.
- **Fills in what LinkedIn hides**: a page-context bridge observes the API
  responses the LinkedIn page itself loads (the same Sales Navigator and
  Voyager endpoints Frontier reads) and adds public profile links, exact
  titles, companies and regions to what the DOM shows. Passive: it never
  sends a request. Off switch in Settings; see `docs/RISK-REVIEW.md`.

## Install (developer)

```sh
npm install
npm run build          # -> dist/
```

Chrome → `chrome://extensions` → Developer mode → Load unpacked → `dist/`.
Click the toolbar icon to open the side panel.

## Connect Deepline

1. Open the side panel on any LinkedIn page and click **Sign in to Deepline**
   (or just sign in to the Deepline app in another tab; the extension follows
   your sign-in, the way Frontier's does).
2. **Choose a play** in the panel. Your workspace's plays load from your own
   sign-in. Nothing to paste.
3. The pinned button now reads "Push … to <play>".

Prefer a key? Settings → Use a Deepline play → Advanced → paste an API key.

The extension reads the play's input schema and shapes the run input to it:
`leads[]` gets one run per push, `lead{}` or field names such as
`linkedin_url` / `first_name` / `company_name` get one run per person, and a
`search_url` field makes the play eligible for "Import search". Two reference
plays live in [`examples/deepline`](examples/deepline): one that stores and
enriches a person, one that fetches a forwarded search through WizLeads.

## Connect a webhook instead

Settings → **Connect a webhook**:

| Setting | What it does |
|---|---|
| Webhook URL | `https://` only (`http://localhost` allowed for dev). The host is requested as an optional permission on save. |
| Shape | nested JSON envelope, flat (Clay / Zapier / sheets), or flat with Deepline field names. |
| Batching | one request per person (recommended) or one request per push. |
| Advanced: signing | `LWE` (`X-LWE-Signature: sha256=hex` over `timestamp.body`) or [Standard Webhooks](https://www.standardwebhooks.com) (`webhook-id/-timestamp/-signature`, `whsec_` secrets). |
| Advanced: extra header | e.g. `Authorization: Bearer …`. |

Every request carries `X-LWE-Event-Id`, `Idempotency-Key` (the person's
canonical URL for unforced single sends) and, for the Deepline shape,
`x-deepline-dedupe-key`. Retries re-send byte-identical bodies.

## Try it locally in 60 seconds

```sh
LWE_SECRET=topsecret LWE_ADMIN_TOKEN=admin npm run receiver   # 127.0.0.1:8787, writes leads.sqlite
npm run build:test && npm run samples                          # sample LinkedIn-shaped pages on 127.0.0.1:8790
```

Load `dist-test/` as an unpacked extension, connect a webhook to
`http://127.0.0.1:8787/hook` with secret `topsecret` (scheme LWE), open a
sample page, click **Push**, then:

```sh
curl -H 'Authorization: Bearer admin' localhost:8787/leads
```

The receiver binds to loopback, refuses to start without a secret unless
`NODE_ENV=development LWE_ALLOW_UNSIGNED=1`, and only serves `/leads`,
`/searches`, `/imports` when `LWE_ADMIN_TOKEN` is set. It is a reference, not
a production service.

## Payload (webhook, nested shape, one person)

```json
{
  "schema_version": "1",
  "event": "lead.captured",
  "event_id": "5f0c…",
  "sent_at": "2026-09-05T15:04:05.000Z",
  "source": { "extension": "linkedin-webhook-exporter", "version": "0.2.0", "page_type": "salesnav_search", "page_url": "https://www.linkedin.com/sales/search/people?query=…&page=2", "captured_by": "jai" },
  "import": { "import_id": "9b1d…", "imported_by": "jai", "imported_at": "…", "import_kind": "basket", "search_url": "https://www.linkedin.com/sales/search/people?query=…", "search_name": "current title: CRO · region: United States", "list_id": null, "page": 2 },
  "custom": { "campaign": "q3" },
  "lead": {
    "full_name": "Jane Doe", "first_name": "Jane", "last_name": "Doe",
    "headline": null, "title": "VP of Sales", "company_name": "Acme Corp",
    "company_linkedin_url": "https://www.linkedin.com/sales/company/12345",
    "location": "Austin, Texas, United States",
    "linkedin_url": null, "linkedin_slug": null,
    "linkedin_member_urn": "ACwAAA…", "sales_navigator_url": "https://www.linkedin.com/sales/lead/ACwAAA…",
    "connection_degree": "2nd", "profile_image_url": "https://…", "about": null,
    "experience": [], "education": [], "captured_at": "…", "parse_warnings": []
  }
}
```

`import_kind` is `manual` (one click on a page), `basket` (a push of picked
people, possibly from several pages, sharing one `import_id`) or `search` (a
forwarded search, event `search.captured` with `search.search_url`,
`search.filters`, `search.limit`, `search.saved_search_id`). See the spec
for the flat and Deepline shapes and the play run inputs.

## Verify a request (Node)

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const ts = req.headers["x-lwe-timestamp"];
const expected = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${rawBody}`).digest("hex");
const ok = Math.abs(Date.now() / 1000 - ts) < 300 && timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-lwe-signature"]));
```

## Tests

```sh
npm test                 # unit (vitest): parsers, mapping, play input shaping, basket, signing, queue, worker, receiver
npm run test:acceptance  # Playwright: real extension in Chromium against fixture pages, a mock webhook and a mock Deepline API
npm run e2e              # drives every sample page with the real extension and writes docs/E2E-REPORT.md
```

## Safety and compliance

The extension only reads what LinkedIn renders to you and only acts on a
click. It never scrolls, paginates or navigates on its own: a whole-search
import is a single request that hands the search to your backend. LinkedIn's
terms prohibit scraping and automation by extensions regardless of pace;
keep the daily cap low and make sure you have a lawful basis for processing
the people you push. Nothing here is a safe harbor. You are responsible for
how you use this tool.

Detection surface, for the record: `cookies` is scoped to `code.deepline.com`
(sign-in state only), no `<all_urls>`, no `scripting`, no unsolicited fetches
to LinkedIn, on-page UI in a shadow root, every push is a real user click.
The page-context bridge patches `XMLHttpRequest` and `fetch` to observe the
responses LinkedIn's own page loads (see `docs/RISK-REVIEW.md` for what that
means for account risk) and the link "Share search" copies.

## Sample pages, tests, audit

- `npm run samples` serves static pages for every supported surface (classic
  and 2026 layouts, messy names, delayed rows, grouped experience) at
  LinkedIn-shaped paths for manual testing with the test build.
- `docs/AUDIT.md` is an independent audit; `docs/AUDIT-STATUS.md` tracks the
  fix for each finding.

Docs: [`docs/SPEC.md`](docs/SPEC.md) · [`docs/ACCEPTANCE_TESTS.md`](docs/ACCEPTANCE_TESTS.md) · [`docs/RESEARCH.md`](docs/RESEARCH.md) · [`examples/deepline`](examples/deepline)

## License

MIT. Built and maintained by [Deepline](https://deepline.com); contributions welcome.
