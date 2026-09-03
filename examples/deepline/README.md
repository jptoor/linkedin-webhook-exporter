# Deepline receiver

1. Create the signing secret (Standard Webhooks format, base64 with `whsec_` prefix):

   ```sh
   SECRET="whsec_$(openssl rand -base64 32)"
   deepline secrets set LINKEDIN_EXT_WEBHOOK_SECRET "$SECRET"
   ```

2. Publish the play and read the endpoint URL from the binding:

   ```sh
   deepline plays check ./examples/deepline/linkedin-capture.play.ts
   deepline plays publish ./examples/deepline/linkedin-capture.play.ts --json | jq -r '.triggerBindings[0].endpointUrl'
   ```

3. In the extension options:

   | Setting | Value |
   |---|---|
   | Webhook URL | the `endpointUrl` (`https://code.deepline.com/api/v2/webhooks/inbound/<token>`) |
   | Signing secret | `$SECRET` |
   | Signature scheme | Standard Webhooks |
   | Field mapping | Deepline |
   | Send mode | Single |

4. Click "Send test event". Deepline answers `202` with `event_id`, `run_id`, `deduped`.

Notes

- The body is the play's `input` verbatim. No envelope.
- `x-deepline-dedupe-key` is the lead's canonical LinkedIn URL for unforced
  single sends, so re-sending the same profile returns `"deduped": true` and
  does not start a second run. Forced resends use the event id.
- Deepline's enrichment providers reject `/sales/lead/` URLs. The play
  resolves a public URL from name + company for Sales Navigator captures
  before running the email waterfall.
- Do not put a workspace `dl_` API key in the extension. The inbound token is
  scoped to this one play.

## Import audit table

Every lead payload carries an `import` block (generic preset) or `import_*`
fields (flat / Deepline presets): `import_id` (one per click on a list page,
or the bulk-export job id), `imported_by`, `imported_at`, `import_kind`
(`manual` | `export`), `import_search_url`, `import_search_name` (Sales
Navigator keywords + filters, or the list id), `import_list_id`, `import_page`.

The play writes one row per (import, lead) into the workspace warehouse table
`sales.sales_nav_imports` through `query_customer_db`, so RevOps can answer
"who imported what, when, from which search":

```sql
SELECT imported_by, search_name, count(*) AS leads, min(imported_at) AS started
FROM sales.sales_nav_imports
GROUP BY 1, 2 ORDER BY started DESC;
```
