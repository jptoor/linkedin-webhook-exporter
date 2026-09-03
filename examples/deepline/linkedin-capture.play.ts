/**
 * Deepline play that receives LinkedIn Webhook Exporter events.
 *
 * Pair with the extension's `deepline` mapping preset and `single` send mode.
 * The extension POSTs the flat record below verbatim as `input`, signed with
 * Standard Webhooks headers, and sets `x-deepline-dedupe-key` to the lead's
 * identity so a re-capture of the same profile does not create a second run.
 *
 *   deepline secrets set LINKEDIN_EXT_WEBHOOK_SECRET whsec_...
 *   deepline plays check ./examples/deepline/linkedin-capture.play.ts
 *   deepline plays publish ./examples/deepline/linkedin-capture.play.ts --json
 *     -> triggerBindings[0].endpointUrl is the webhook URL to paste into the extension
 */
import { definePlay } from 'deepline';

/** @mermaid
 * flowchart TD
 * capture["Validate the captured lead"] --> resolve[["Resolve public LinkedIn URL"]]
 * resolve --> email[["Find and validate work email"]]
 * email --> store[("Store lead row")]
 * store --> imports[("Record in customer_db sales_nav_imports")]
 * imports --> out["Return the stored lead"]
 */

type CapturedLead = {
  // Canonical Deepline input names (first in the payload).
  linkedin_url: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company_name: string | null;
  company_domain: string | null;
  email: string | null;
  source: string;
  // Everything else the extension captured.
  event_id: string;
  sent_at: string;
  full_name: string;
  headline: string | null;
  location: string | null;
  company_linkedin_url: string | null;
  linkedin_slug: string | null;
  linkedin_member_urn: string | null;
  sales_navigator_url: string | null;
  connection_degree: '1st' | '2nd' | '3rd' | null;
  page_type: string;
  page_url: string;
  captured_by: string | null;
  captured_at: string;
  // Import provenance (who imported, when, from which search or list).
  import_id?: string | null;
  imported_by?: string | null;
  imported_at?: string | null;
  import_kind?: 'manual' | 'export' | null;
  import_search_url?: string | null;
  import_search_name?: string | null;
  import_list_id?: string | null;
  import_page?: number | null;
  // Test events from the options page.
  event?: string;
};

/** Escape a value for a SQL literal. query_customer_db takes one statement, no bind params. */
const lit = (v: unknown): string => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export default definePlay(
  'linkedin-extension-capture',
  async (ctx, input: CapturedLead) => {
    if (input.event === 'test') return { ok: true, test: true };
    if (!input.full_name) throw new Error('full_name is required');

    // 1. Resolve a public profile URL. Sales Navigator captures carry only a
    //    /sales/lead/ URL, which enrichment providers reject.
    // @mermaid-node capture in:"input" out:"linkedinUrl"
    let linkedinUrl = input.linkedin_url;
    if (!linkedinUrl && input.first_name && input.last_name) {
      // @mermaid-node resolve out:"lookup"
      const lookup = await ctx.runPlay(
        'resolve_linkedin',
        'prebuilt/person-to-linkedin',
        {
          first_name: input.first_name,
          last_name: input.last_name,
          ...(input.company_name ? { company_name: input.company_name } : {}),
          ...(input.company_domain ? { domain: input.company_domain } : {}),
        },
        { description: 'Resolve the public LinkedIn URL for a Sales Navigator capture.' },
      );
      linkedinUrl = (lookup as { linkedin_url?: string | null }).linkedin_url ?? null;
    }

    // 2. Find a work email. `prebuilt/person-linkedin-to-email` runs the
    //    provider waterfall; results are receipt-cached workspace-wide, so a
    //    re-POST of the same profile is nearly free.
    let email: string | null = input.email;
    let emailSource: string | null = null;
    if (!email && linkedinUrl) {
      // @mermaid-node email out:"found"
      const found = await ctx.runPlay(
        'find_email',
        'prebuilt/person-linkedin-to-email',
        { linkedin_url: linkedinUrl },
        { description: 'Find and validate a work email for the captured profile.' },
      );
      const r = found as { email?: string | null; email_source?: string | null; email_found_and_valid?: boolean };
      if (r.email_found_and_valid) {
        email = r.email ?? null;
        emailSource = r.email_source ?? null;
      }
    }

    // 3. Persist one row per lead, keyed by identity so upserts are stable.
    const key = linkedinUrl ?? input.sales_navigator_url ?? `${input.full_name}|${input.company_name ?? ''}`;
    // @mermaid-node store type:"dataset" out:"rows"
    const rows = await ctx
      .dataset('linkedin_captures', [
        {
          key,
          linkedin_url: linkedinUrl,
          first_name: input.first_name,
          last_name: input.last_name,
          full_name: input.full_name,
          title: input.title,
          company_name: input.company_name,
          company_linkedin_url: input.company_linkedin_url,
          location: input.location,
          email,
          email_source: emailSource,
          sales_navigator_url: input.sales_navigator_url,
          connection_degree: input.connection_degree,
          page_type: input.page_type,
          captured_by: input.captured_by,
          captured_at: input.captured_at,
        },
      ])
      .run({ key: 'key', description: 'Store LinkedIn captures from the Chrome extension.' });

    // 4. Audit table in the workspace warehouse: one row per (import, lead) so
    //    RevOps can see who imported what, when, and from which search or list.
    //    query_customer_db requires a schema-qualified, customer-managed table.
    // @mermaid-node imports out:"imported"
    const imported = await ctx.tools.execute({
      id: 'record_import',
      tool: 'query_customer_db',
      input: {
        sql: `CREATE SCHEMA IF NOT EXISTS sales;
CREATE TABLE IF NOT EXISTS sales.sales_nav_imports (
  import_id text NOT NULL, lead_key text NOT NULL, imported_by text, imported_at timestamptz, import_kind text,
  search_url text, search_name text, list_id text, page integer,
  full_name text, first_name text, last_name text, title text, company_name text,
  linkedin_url text, sales_navigator_url text, location text, email text, event_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, lead_key)
);
INSERT INTO sales.sales_nav_imports (import_id, lead_key, imported_by, imported_at, import_kind, search_url, search_name, list_id, page, full_name, first_name, last_name, title, company_name, linkedin_url, sales_navigator_url, location, email, event_id)
VALUES (${lit(input.import_id ?? input.event_id)}, ${lit(key)}, ${lit(input.imported_by ?? input.captured_by)}, ${lit(input.imported_at ?? input.captured_at)}, ${lit(input.import_kind ?? 'manual')}, ${lit(input.import_search_url)}, ${lit(input.import_search_name)}, ${lit(input.import_list_id)}, ${lit(input.import_page)}, ${lit(input.full_name)}, ${lit(input.first_name)}, ${lit(input.last_name)}, ${lit(input.title)}, ${lit(input.company_name)}, ${lit(linkedinUrl)}, ${lit(input.sales_navigator_url)}, ${lit(input.location)}, ${lit(email)}, ${lit(input.event_id)})
ON CONFLICT (import_id, lead_key) DO UPDATE SET email = COALESCE(EXCLUDED.email, sales.sales_nav_imports.email), linkedin_url = COALESCE(EXCLUDED.linkedin_url, sales.sales_nav_imports.linkedin_url);`,
        max_rows: 1,
      },
      description: 'Record who imported this lead, when, and from which Sales Navigator search or list.',
      staleAfterSeconds: 0,
    });

    // @mermaid-node out out:"$output"
    return { key, linkedin_url: linkedinUrl, email, rows: await rows.count(), imported: !!imported };
  },
  {
    description: 'Receive LinkedIn Webhook Exporter captures, resolve a public profile URL, find a work email, and store the lead.',
    webhook: {
      auth: {
        type: 'standard-webhooks',
        headerFamily: 'standard',
        signingSecrets: ['LINKEDIN_EXT_WEBHOOK_SECRET'],
        toleranceSeconds: 300,
      },
    },
    billing: { maxCreditsPerRun: 2 },
  },
);
