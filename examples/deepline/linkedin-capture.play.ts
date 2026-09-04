/**
 * Deepline play that receives LinkedIn Webhook Exporter events.
 *
 * Pair with the extension's `deepline` mapping preset and `single` send mode.
 * The extension POSTs the flat record below verbatim as `input`, signed with
 * Standard Webhooks headers, and sets `x-deepline-dedupe-key` to the lead's
 * identity so a re-capture of the same profile does not create a second run.
 *
 * Order of operations (audit DEE-01): validate → derive a stable key from the
 * ORIGINAL identity → record the import row (status "received") → resolve /
 * enrich → dataset write → update the audit row. The audit row is written
 * before any paid step, so a failure downstream leaves a visible, retry-safe
 * record rather than silently repeated spend. Schema is provisioned once by
 * migrations/001_sales_nav_imports.sql, not per event (DEE-02).
 *
 *   deepline secrets set LINKEDIN_EXT_WEBHOOK_SECRET whsec_...
 *   deepline plays check ./examples/deepline/linkedin-capture.play.ts
 *   deepline plays publish ./examples/deepline/linkedin-capture.play.ts --json
 *     -> triggerBindings[0].endpointUrl is the webhook URL to paste into the extension
 */
import { definePlay } from 'deepline';

/** @mermaid
 * flowchart TD
 * capture["Validate the captured lead"] --> audit[("Record import row (received)")]
 * audit --> resolve[["Resolve public LinkedIn URL"]]
 * resolve --> email[["Find and validate work email"]]
 * email --> store[("Store lead row")]
 * store --> done[("Mark import row enriched")]
 * done --> out["Return the stored lead"]
 */

type CapturedLead = {
  schema_version?: string;
  event?: string;
  event_id: string;
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
  parse_warnings?: string | null;
  // Import provenance (who imported, when, from which search or list).
  import_id?: string | null;
  imported_by?: string | null;
  imported_at?: string | null;
  import_kind?: 'manual' | 'export' | null;
  import_search_url?: string | null;
  import_search_name?: string | null;
  import_list_id?: string | null;
  import_page?: number | null;
};

/** Escape a value for a SQL literal. query_customer_db takes one statement, no bind params. */
const lit = (v: unknown): string => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const PROFILE_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+\/?$/;
const SALESNAV_RE = /^https:\/\/(www\.)?linkedin\.com\/sales\/lead\/[A-Za-z0-9_-]{8,80}\/?$/;

/** Runtime validation at the entry point; the TypeScript type is erased at runtime. */
function validate(input: unknown): CapturedLead {
  if (!input || typeof input !== 'object') throw new Error('input must be an object');
  const i = input as Record<string, unknown>;
  const event = str(i.event, 40) ?? 'lead.captured';
  if (event !== 'lead.captured' && event !== 'test') throw new Error(`unsupported event ${event}`);
  const event_id = str(i.event_id, 64);
  if (!event_id || !/^[A-Za-z0-9_-]{8,64}$/.test(event_id)) throw new Error('event_id is required');
  const full_name = str(i.full_name, 200);
  if (event !== 'test' && !full_name) throw new Error('full_name is required');
  const linkedin_url = str(i.linkedin_url, 2048);
  const sales_navigator_url = str(i.sales_navigator_url, 2048);
  if (linkedin_url && !PROFILE_RE.test(linkedin_url)) throw new Error('linkedin_url must be a public /in/ profile URL');
  if (sales_navigator_url && !SALESNAV_RE.test(sales_navigator_url)) throw new Error('sales_navigator_url must be a /sales/lead/ URL');
  const page = Number(i.import_page);
  return {
    ...(i as CapturedLead),
    event,
    event_id,
    full_name: full_name ?? '',
    first_name: str(i.first_name, 200),
    last_name: str(i.last_name, 200),
    title: str(i.title, 300),
    company_name: str(i.company_name, 300),
    company_domain: str(i.company_domain, 253),
    email: str(i.email, 320),
    location: str(i.location, 300),
    linkedin_url,
    sales_navigator_url,
    company_linkedin_url: str(i.company_linkedin_url, 2048),
    captured_by: str(i.captured_by, 200),
    captured_at: str(i.captured_at, 40) ?? new Date().toISOString(),
    import_id: str(i.import_id, 64),
    imported_by: str(i.imported_by, 200),
    imported_at: str(i.imported_at, 40),
    import_kind: i.import_kind === 'export' ? 'export' : 'manual',
    import_search_url: str(i.import_search_url, 2048),
    import_search_name: str(i.import_search_name, 200),
    import_list_id: str(i.import_list_id, 64),
    import_page: Number.isInteger(page) && page > 0 ? page : null,
  };
}

export default definePlay(
  'linkedin-extension-capture',
  async (ctx, rawInput: unknown) => {
    // @mermaid-node capture in:"rawInput" out:"input"
    const input = validate(rawInput);
    if (input.event === 'test') return { ok: true, test: true };

    // Stable identity from the ORIGINAL capture, never from resolver output,
    // so retries and re-captures land on the same rows.
    const key = input.linkedin_url ?? input.sales_navigator_url ?? `name:${input.full_name.toLowerCase()}|${(input.company_name ?? '').toLowerCase()}`;
    const importId = input.import_id ?? input.event_id;

    // 1. Audit row first (idempotent upsert; schema pre-provisioned by migration).
    // @mermaid-node audit out:"audit"
    const audit = await ctx.tools.execute({
      id: 'record_import',
      tool: 'query_customer_db',
      input: {
        sql: `INSERT INTO sales.sales_nav_imports (import_id, lead_key, imported_by, imported_at, import_kind, search_url, search_name, list_id, page, full_name, first_name, last_name, title, company_name, linkedin_url, sales_navigator_url, location, email, event_id, status)
VALUES (${lit(importId)}, ${lit(key)}, ${lit(input.imported_by ?? input.captured_by)}, ${lit(input.imported_at ?? input.captured_at)}, ${lit(input.import_kind)}, ${lit(input.import_search_url)}, ${lit(input.import_search_name)}, ${lit(input.import_list_id)}, ${lit(input.import_page)}, ${lit(input.full_name)}, ${lit(input.first_name)}, ${lit(input.last_name)}, ${lit(input.title)}, ${lit(input.company_name)}, ${lit(input.linkedin_url)}, ${lit(input.sales_navigator_url)}, ${lit(input.location)}, ${lit(input.email)}, ${lit(input.event_id)}, 'received')
ON CONFLICT (import_id, lead_key) DO UPDATE SET updated_at = now(), event_id = EXCLUDED.event_id`,
        max_rows: 1,
      },
      description: 'Record who imported this lead, when, and from which Sales Navigator search or list.',
      staleAfterSeconds: 0,
    });

    // 2. Resolve a public profile URL. Sales Navigator captures carry only a
    //    /sales/lead/ URL, which enrichment providers reject.
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

    // 3. Find a work email. Results are receipt-cached workspace-wide, so a
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

    // 4. Persist one row per lead, keyed by identity so upserts are stable.
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
          parse_warnings: input.parse_warnings ?? null,
        },
      ])
      .run({ key: 'key', description: 'Store LinkedIn captures from the Chrome extension.' });

    // 5. Close the audit row with what enrichment found.
    // @mermaid-node done out:"marked"
    const marked = await ctx.tools.execute({
      id: 'mark_import',
      tool: 'query_customer_db',
      input: {
        sql: `UPDATE sales.sales_nav_imports SET status = 'enriched', email = COALESCE(${lit(email)}, email), linkedin_url = COALESCE(${lit(linkedinUrl)}, linkedin_url), updated_at = now() WHERE import_id = ${lit(importId)} AND lead_key = ${lit(key)}`,
        max_rows: 1,
      },
      description: 'Mark the import row enriched with the resolved URL and email.',
      staleAfterSeconds: 0,
    });

    // @mermaid-node out out:"$output"
    return { key, linkedin_url: linkedinUrl, email, rows: await rows.count(), audit: !!audit, marked: !!marked };
  },
  {
    description: 'Receive LinkedIn Webhook Exporter captures, record import provenance, resolve a public profile URL, find a work email, and store the lead.',
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
