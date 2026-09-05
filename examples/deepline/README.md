# Deepline receivers

Two ways to land what reps push from the extension into Deepline:

| | Play run through the API (recommended) | Inbound webhook |
|---|---|---|
| What the rep sees | "Connect a play" once, then picks it in the side panel | "Connect a webhook" with a URL and secret |
| Credential | A Deepline API key (Bearer), stored only in the browser | A `whsec_` signing secret bound to one play |
| Extension → Deepline | `POST /api/v2/plays/run` with `{ name, input }` per person or per search | `POST /api/v2/webhooks/inbound/<token>` with the flat Deepline-preset body |
| Play input | Inferred from the play's input schema (see below) | The webhook body verbatim |
| Dedupe | `Idempotency-Key` / `x-deepline-dedupe-key` = the person's canonical URL | same |

## Two example plays

- `linkedin-capture.play.ts`: receives one person, records who imported them
  and from which search, resolves a public profile URL, finds an email, stores
  the lead. Works both as a webhook receiver and as a play picked in the panel
  (its input is the same flat record).
- `salesnav-search-import.play.ts`: receives a **forwarded Sales Navigator
  search** (`search_url`, `limit`, `search_name`, `imported_by`) and fetches the
  members server-side through WizLeads, then stores one row per person and
  records the import. This is what "Import search" in the side panel runs. The
  browser never pages through results.

## Setup

0. Provision the audit tables once:

   ```sh
   for f in examples/deepline/migrations/*.sql; do
     deepline tools run query_customer_db --input "$(jq -n --arg sql "$(cat "$f")" '{sql:$sql}')"
   done
   ```

1. Publish the plays:

   ```sh
   deepline plays check ./examples/deepline/linkedin-capture.play.ts
   deepline plays publish ./examples/deepline/linkedin-capture.play.ts --json
   deepline plays check ./examples/deepline/salesnav-search-import.play.ts   # needs WizLeads connected
   deepline plays publish ./examples/deepline/salesnav-search-import.play.ts --json
   ```

2. In the extension: **Settings → Connect a play**, paste an API key from the
   Deepline dashboard, **Load my plays**, pick one, **Save**. Repeat for the
   search-import play. Reps switch between them from the "Sending to" chip in
   the side panel and can pin favourites.

3. Webhook alternative (no API key in the browser): set a secret, publish
   `linkedin-capture` with its webhook binding, and connect the
   `triggerBindings[0].endpointUrl` as a webhook with scheme Standard Webhooks
   and shape "Flat with Deepline field names".

   ```sh
   SECRET="whsec_$(openssl rand -base64 32)"
   deepline secrets set LINKEDIN_EXT_WEBHOOK_SECRET "$SECRET"
   ```

## How the extension shapes a play's input

When a play is picked, the extension reads its input schema:

| Schema declares | The extension sends |
|---|---|
| `leads: array` | one run per push: `{ leads: [flat row, …], source, page_url, import_id, imported_by, custom, … }` |
| `lead: object` | one run per person: `{ lead: flat row, … provenance }` |
| known field names (`linkedin_url`, `first_name`, `last_name`, `title`, `company_name`, `location`, …) | one run per person with only those fields, Sales Navigator URL as a fallback for `linkedin_url` |
| `search_url` (or `sales_navigator_url`, `url`) | for "Import search": `{ search_url, limit, search_name, imported_by, import_id, saved_search_id, keywords, filters, … }` filtered to declared fields |
| no schema | the full flat Deepline row per person, or the full search record |

A play that requires something LinkedIn cannot provide (say `domain`) is
refused in the panel with a plain sentence before any request is made.

## Import audit tables

`sales.sales_nav_imports` has one row per (import, person): `import_id` (one
per push, even when the push spans several result pages), `imported_by`,
`imported_at`, `import_kind` (`manual` | `basket` | `search`), `search_url`,
`search_name`, `list_id`, `page`, plus the person and enrichment status.

`sales.sales_nav_search_imports` has one row per forwarded search:
`import_id`, `imported_by`, `search_url`, `search_name`, `saved_search_id`,
`requested_limit`, `provider_task_id`, `result_count`, `status`.

```sql
SELECT imported_by, search_name, count(*) AS people, min(imported_at) AS started
FROM sales.sales_nav_imports GROUP BY 1, 2 ORDER BY started DESC;

SELECT imported_by, search_name, requested_limit, result_count, status, imported_at
FROM sales.sales_nav_search_imports ORDER BY imported_at DESC;
```

## Notes

- Saved searches: Sales Navigator opens them as `?savedSearchId=…`, which only
  resolves for the owner. The extension asks the rep to press Sales Navigator's
  own "Share search" once, captures the copied link (which carries the full
  `query=` expression), and forwards that instead.
- `wizleads_scrape_salesnav` / `wizleads_get_task` are marked deprecated in the
  current catalog; `deepline plays check` warns but passes. Swap the provider
  step for whichever Sales Navigator search tool your workspace has connected
  (the play isolates it to one `ctx.tools.execute`).
- Deepline's enrichment providers reject `/sales/lead/` URLs. `linkedin-capture`
  resolves a public URL from name + company for Sales Navigator captures.
