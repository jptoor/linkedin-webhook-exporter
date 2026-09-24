# People Exporter

Open-source Chrome extension (MIT) for collecting people from supported profile
and search pages and sending them to a configured workflow or webhook. Select
people across pages, forward a search to a backend, or explicitly sync your
first-degree connections from the side panel.

Settings live in your browser profile. Usage reporting is enabled by default
and can be disabled in Settings. See [PRIVACY.md](PRIVACY.md) for data handling,
authentication, and reporting details.

## Features

- **Side panel:** shows the current page, selected destination, and send action.
- **Selection across pages:** collect people from multiple result pages and send
  them together. Selections clear when the browser closes.
- **Search import:** forward a shareable search URL, filters, and requested limit
  to a backend that retrieves the results.
- **Connection sync:** explicitly read first-degree connections and send them
  through the delivery queue, with a read limit and a Stop button.
- **Workflow destinations:** choose a configured workflow. Its input schema
  determines whether it receives a batch, an individual person, or a search.
- **Signed webhooks:** send nested or flat JSON with optional authentication
  headers and request signatures.
- **Recent activity:** inspect delivery status and retry failed deliveries.
  Full history is available in Settings with secrets redacted.
- **Page data:** supplement visible content with responses the supported page
  already loads. The setting disables use of intercepted responses; the page
  hooks remain installed until the extension is disabled.

## Install for development

```sh
npm install
npm run build          # writes dist/
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose
**Load unpacked**, and select `dist/`. Click the toolbar icon on a supported
page to open the side panel.

## Connect a webhook

Open Settings and choose **Connect a webhook**.

| Setting | Purpose |
|---|---|
| Webhook URL | HTTPS endpoint; loopback HTTP is allowed for development. Host access is requested when saving. |
| Shape | Nested JSON envelope or a flat record for spreadsheet-style receivers. |
| Batching | One request per person or one request per push. |
| Signing | `LWE` signatures or [Standard Webhooks](https://www.standardwebhooks.com). |
| Extra header | Optional authentication, such as `Authorization: Bearer …`. |

Requests carry event and idempotency identifiers. Delivery retries preserve the
original request body. See the [payload specification](docs/SPEC.md) for exact
fields, headers, destination-specific mappings, and signature verification.

## Try it locally

```sh
LWE_SECRET=topsecret LWE_ADMIN_TOKEN=admin npm run receiver
npm run build:test && npm run samples
```

The receiver listens at `127.0.0.1:8787`; sample pages are served at
`127.0.0.1:8790`. Load `dist-test/` as an unpacked extension, connect a webhook
to `http://127.0.0.1:8787/hook` with secret `topsecret` and the LWE signature
scheme, then open a sample page and click **Push**.

```sh
curl -H 'Authorization: Bearer admin' localhost:8787/leads
```

The receiver writes to `leads.sqlite` and binds to loopback. It refuses to start
without a signing secret unless `NODE_ENV=development LWE_ALLOW_UNSIGNED=1` is
set. Its read endpoints require `LWE_ADMIN_TOKEN`. It is a development reference,
not a production service.

## Sync first-degree connections

Choose a destination, open a signed-in tab on the supported platform, and select
**My connections → Sync my connections**. Set the maximum number to read first
(default 100). Your remaining daily export cap must cover that count.

The extension reads `JSESSIONID` in the tab and uses its CSRF value for
same-origin requests to the platform's private current-user and connections
endpoints. Connection records go through the existing delivery queue.
Credentials remain in content-script memory and are not stored or sent to a
destination.

Only one sync runs at a time. **Stop sync** cancels collection; previously queued
records still proceed to delivery. HTTP errors, challenge pages, account or
session changes, and unexpected response formats stop collection without
automatic retries. There is no scheduled refresh or automatic restart. Keep the
source tab open. A new manual sync starts at the beginning and applies the
configured deduplication rules.

Connection records include the network owner and connection date. These describe
relationships, not buying intent. See the [specification](docs/SPEC.md) for the
complete record format.

## Account restrictions and data handling

Ordinary capture reads the current page and observes selected responses that
page already loads. Explicit connection sync adds authenticated requests to a
private API. Search import hands retrieval to the selected backend.

Platform terms may prohibit these collection methods, and accounts can be
restricted. Neither pacing nor an export cap guarantees approval or protection
from restrictions. Use only accounts and data you are authorized to access.

The private API is unsupported and may change. Connection sync has been tested
against local fixtures; live compatibility has not been verified. Avoid live
collection while an account is restricted. A platform-provided data archive is
an alternative to authenticated crawling, but archive import is not implemented
in this extension.

## Tests

```sh
npm test                 # unit tests
npm run test:acceptance  # extension in Chromium against local fixtures and mock destinations
npm run e2e              # sample-page checks; writes docs/E2E-REPORT.md
```

`npm run samples` serves fixtures for supported layouts, including delayed rows,
messy names, and grouped experience. Use the test build for local sample pages.

## Documentation

- [Specification](docs/SPEC.md)
- [Acceptance tests](docs/ACCEPTANCE_TESTS.md)
- [Research](docs/RESEARCH.md)
- [Risk review](docs/RISK-REVIEW.md)
- [Audit](docs/AUDIT.md) and [finding status](docs/AUDIT-STATUS.md)
- [Privacy](PRIVACY.md)

## License

MIT. Contributions welcome.
