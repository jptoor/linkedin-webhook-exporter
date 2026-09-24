# People Exporter

Open-source Chrome extension (MIT) for collecting people from supported profile
and search pages and sending them to a configured play or webhook. Select
people across pages, forward a search to a backend, or import your full connections export from the side panel.

Settings live in your browser profile. Usage reporting is off by default for new installs
and can be enabled in Settings. Existing choices are preserved. See [PRIVACY.md](PRIVACY.md) for data handling,
authentication, and reporting details.

## Features

- **Side panel:** shows the current page, selected destination, and send action.
- **Selection across pages:** collect people from multiple result pages and send
  them together. Selections clear when the browser closes.
- **Search import:** forward a shareable search URL, filters, and requested limit
  to a backend that retrieves the results.
- **Connections import:** download your full data archive, preview Connections.csv
  locally, and confirm before sending records through the delivery queue.
- **Play destinations:** choose a configured play. Its input schema
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

## Connect a play

1. Connect your workspace from the side panel, or use an API key in Settings.
2. Select **Choose a play** and pick the play that should receive your records.
3. Use the **Sending to** selector to switch destinations or pin favourites.

The extension reads each play's input schema and shapes the input accordingly:

- `leads[]`: one run per batch of people.
- `lead{}` or individual fields such as `first_name` and `company_name`: one
  run per person.
- `search_url`: enables forwarding a search for the play to retrieve.

The [play examples and setup READMEs](examples/) are included in the repository.
They cover storing and enriching captured people, and fetching the results of a
forwarded search. Follow the accompanying README to configure and run each play.
See the [specification](docs/SPEC.md) for input mapping details.

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

## Import all connections

1. Use the side panel’s **Request your full connections export** link.
2. Select **Download larger data archive, including connections**, then request it.
3. Wait for the download email, extract the archive, and select only `Connections.csv`.
4. Enter your profile URL and review the local preview, destination, and daily cap.
5. Confirm that this is your own full export, then click **Import connections**.

The archive flow does not crawl connections or read a session token.
It excludes email and unrelated columns; never upload the complete ZIP. The file
and declared owner cannot be independently verified. Connection records indicate
relationships, not buying intent or relationship strength.

Stopping an import leaves previously queued records in the delivery queue.
If the daily cap interrupts an import, keep deduplication enabled and import the
same file again after increasing the cap or waiting. “Processed” and “queued” do
not mean delivered: check Recent activity for failures.

## Optional live connections sync

Expand **Optional: sync connections from your signed-in account** in the side
panel. Open a signed-in platform tab, choose a destination and read limit, then
acknowledge the account risk and click **Sync my connections**. Archive import
remains the recommended path.

Live sync uses the private connections API and a session CSRF value held only in
the content script's memory. It does not store or export that value. Each run
requires fresh confirmation. There is no scheduled sync or automatic collection
retry. Account/session changes, challenges, timeouts, rate limits and malformed
responses stop collection. The Stop button stops collection; already queued
records still proceed to delivery. Only one archive import or live sync runs at
a time. Limits and pacing do not guarantee protection against restrictions.

## Account restrictions and data handling

Manual page capture and passive response observation remain available and can
violate platform terms. Archive import removes the extra authenticated requests
from bulk connection collection; it does not establish platform approval for the
rest of the extension. Search import delegates collection to your chosen backend.

Read the [current risk review](docs/EXTENSION-RISK-REVIEW.md) before deployment.
It covers remaining page hooks, credentials, retention, telemetry, destination
changes, and the limits of a user-provided archive.

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
