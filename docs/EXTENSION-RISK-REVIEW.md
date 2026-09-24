# Extension risk review — September 23, 2026

Require the official full connections export for bulk imports. Do not collect
connections through a signed-in session. This removes a source of extra profile
requests; it does not make the remaining page-capture extension risk-free.

## Comparable products

[Happenstance](https://happenstance.ai/security) says it processes supported
network exports locally, lets users select what to share, and previews uploads.
Its account connectors use OAuth and request read-only access where available.
These are vendor statements, not an audit of its code or evidence of LinkedIn
approval. Its sharing and disconnect controls are also worth following.

[Connect The Dots](https://ctd.ai/faqs) supports uploading LinkedIn data without
connecting email. It describes a connection alone as a weak relationship signal;
reciprocal communications contribute stronger evidence. Do not equate a CSV
connection with a close relationship, current employment, or buying intent.

[LinkedIn's export instructions](https://www.linkedin.com/help/recruiter/answer/a566336?lang=en-US)
direct members to request the larger archive including connections. Import only
Connections.csv, not the full ZIP containing unrelated personal information.
[LinkedIn's extension policy](https://www.linkedin.com/help/linkedin/answer/a1340567)
means pacing or copying another vendor's implementation cannot guarantee an
account will avoid restrictions.

## Findings and disposition

| Risk | Evidence in this repository | Disposition |
|---|---|---|
| High: authenticated bulk collection | The former content/connections.ts read a CSRF value and paginated private endpoints. | Removed. The old start message fails explicitly; bulk import requires CSV and confirmation. |
| High: passive page interception | content/page-bridge.ts hooks fetch, XHR and clipboard. Disabling interception stops consumption, not installed hooks. | Still present for manual capture. Disable the extension on the platform for an archive-only operating policy; a future archive-only package should remove these scripts and host permissions. |
| High: silent queue loss | background/queue.ts previously kept only the newest 500 records, including unsent records. | Fixed: pending, sending and failed items are retained; only sent history is capped. New capture rejects queues beyond a 6 MB budget rather than evicting pending work. |
| High: credentials in local storage | Destination API keys, headers and signing secrets share extension storage with queue data. | Local storage restricted to trusted extension contexts. Browser-profile access still exposes it; it is not an encrypted credential vault. |
| Medium: destination changes | Queued records refer to a destination ID; delivery resolves current configuration. | Changing an endpoint under the same ID can redirect pending deliveries. Drain or inspect pending work before changing it. Import detects changed configuration between batches, but this is not an immutable delivery pin. |
| Medium: untrusted source data | Page-context messages can be forged by the host page; CSV contents can be edited. | Validate and normalize data. Archive owner is explicitly declared and source marked archive; neither identity nor completeness is verified. Never treat it as authenticated relationship evidence. |
| Medium: personal-data retention | Queue bodies, dedupe keys and history can contain profile identifiers. | Raw CSV is not persisted; unused columns including email are excluded. Sent retention is pruned on queue activity, not a guaranteed wall-clock deletion deadline. Failed/pending bodies persist until handled or storage cleared. |
| Medium: reporting | Telemetry is enabled by default; errors can contain arbitrary text. Remote flags are fetched separately. | Existing behavior retained and disclosed. Redaction is not anonymization; disable reporting when required and audit the configured receiver. |
| Medium: partial imports and duplicates | Daily caps, interruption, storage limits and global dedupe affect admission. | Show processed/queued/skipped counts and explicit failures. Restart requires user action. Dedupe is owner/member scoped, not destination scoped; a new destination may skip previously exported members. |
| Medium: crash consistency | Queue admission updates several storage values. | A crash or quota failure between writes remains a recovery risk. The size guard reduces quota pressure but is not a transaction guarantee. Verify Recent activity before retrying. |
| Medium: downstream processing | A selected play can enrich records, spend credits or send data elsewhere; search forwarding delegates retrieval. | Preview the destination and disclose potential credits. Review the play and receiver independently; moving collection to a backend does not establish permission. |
| Medium: extension privileges and updates | Automatic content scripts run on supported pages; optional webhook origins grant outbound access. | No cookies or scripting permission added. Review packaged permissions and updates; source review does not attest third-party builds or dependencies. |

## Required import flow

1. Request the official larger data archive including all connections.
2. Wait for the official download, extract it locally, and select Connections.csv.
3. Enter the network owner's profile URL. Preview count, sample rows and fields.
4. Review the destination and remaining daily allowance; confirm ownership and export scope.
5. Import. Check delivery history separately: queued does not mean delivered.

The parser rejects malformed files before admission, including missing required
columns, invalid URLs/dates and duplicate member rows. It supports CSV quoting,
BOMs and the export preamble. The limits are 10 MB and 30,000 records. Dates stay
date-only; no connection timestamp or verified owner URN is invented. Stopping
admission does not cancel deliveries already queued. Full export is a user
requirement; a CSV alone cannot prove all connections were included.

## Review scope

Static source inspection, official product documentation and local Chromium
fixtures. No live member account was crawled, no account restriction was probed,
and no third-party service implementation was audited. Manual capture remains
available. Use an archive-only build if eliminating platform page access is a
release requirement. Plays and their setup READMEs are retained.
