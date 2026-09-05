/**
 * Deepline play that receives a forwarded Sales Navigator search from the
 * Chrome extension and fetches the members server-side.
 *
 * The extension never pages through results in the browser. A rep opens a
 * search (or a saved search, after grabbing its shareable link), picks this
 * play in the side panel, sets "up to N people" and clicks Import search. The
 * extension runs this play through the API with:
 *
 *   { search_url, limit, search_name, imported_by, import_id, saved_search_id, … }
 *
 * The play records the import first (who, when, which search), launches a
 * WizLeads Sales Navigator scrape for the URL, waits for it, downloads the
 * result CSV, stores one row per member, and closes the import record with
 * the count. WizLeads uses its own Sales Navigator seats, so the search URL
 * must carry the full `query=` expression (a `savedSearchId` deep link only
 * resolves for its owner; the extension refuses to send one).
 *
 *   deepline plays check ./examples/deepline/salesnav-search-import.play.ts
 *   deepline plays publish ./examples/deepline/salesnav-search-import.play.ts --json
 *
 * Then in the extension: Settings → Connect a play → paste an API key → pick
 * "salesnav-search-import". Requires WizLeads credentials on the workspace
 * (`deepline providers`): the scrape is billed per result by WizLeads.
 */
import { definePlay } from 'deepline';

/** @mermaid
 * flowchart TD
 * validate["Validate the forwarded search"] --> audit[("Record the import (received)")]
 * audit --> launch["Launch WizLeads Sales Navigator scrape"]
 * launch --> poll["Wait for the task to finish"]
 * poll --> fetch["Download the result CSV"]
 * fetch --> store[("Store one row per member")]
 * store --> done[("Mark the import complete")]
 */

type SearchImport = {
  search_url: string;
  limit: number;
  search_name: string | null;
  imported_by: string | null;
  import_id: string;
  saved_search_id: string | null;
  keywords: string | null;
  filters: Record<string, string[]> | null;
  total_hint: number | null;
};

const lit = (v: unknown): string => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const SEARCH_RE = /^https:\/\/(www\.)?linkedin\.com\/sales\/search\/(people|company)\?/i;
const PAGE_SIZE = 25;
const MAX_LIMIT = 2500;

/** Small stable hash (FNV-1a) for a replay-safe fallback id. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function validate(input: unknown): SearchImport {
  if (!input || typeof input !== 'object') throw new Error('input must be an object');
  const i = input as Record<string, unknown>;
  const search_url = str(i.search_url ?? i.sales_navigator_url ?? i.url, 4096);
  if (!search_url || !SEARCH_RE.test(search_url)) throw new Error('search_url must be a Sales Navigator search URL');
  let decoded = search_url;
  try {
    decoded = decodeURIComponent(search_url);
  } catch {
    /* keep as-is */
  }
  if (!/[?&]query=/.test(decoded)) throw new Error('search_url must carry the full query expression (use the shareable link, not a savedSearchId deep link)');
  const limitRaw = Number(i.limit ?? i.max_results ?? 100);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : 100;
  // Deterministic fallback id: the same search + limit always maps to the same import.
  const import_id = str(i.import_id, 64) ?? str(i.event_id, 64) ?? `search-${fnv1a(`${search_url}|${limit}`)}`;
  return {
    search_url,
    limit,
    search_name: str(i.search_name ?? i.name, 200),
    imported_by: str(i.imported_by ?? i.captured_by, 200),
    import_id,
    saved_search_id: str(i.saved_search_id, 32),
    keywords: str(i.keywords, 500),
    filters: i.filters && typeof i.filters === 'object' ? (i.filters as Record<string, string[]>) : null,
    total_hint: Number.isFinite(Number(i.total_hint)) ? Number(i.total_hint) : null,
  };
}

/** Minimal CSV reader (quoted fields, embedded commas/newlines). */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (quoted) {
      if (ch === '"' && text[k + 1] === '"') {
        cell += '"';
        k++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[k + 1] === '\n') k++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  return body.map((r) => Object.fromEntries(keys.map((k, idx) => [k, (r[idx] ?? '').trim()])));
}

/** Pick the first present column among likely provider names. */
const col = (r: Record<string, string>, ...names: string[]): string | null => {
  for (const n of names) if (r[n]) return r[n];
  return null;
};

export default definePlay(
  'salesnav-search-import',
  async (ctx, rawInput: unknown) => {
    // @mermaid-node validate in:"rawInput" out:"input"
    const input = validate(rawInput);
    const pages = Math.max(1, Math.ceil(input.limit / PAGE_SIZE));

    // 1. Record the import before any paid step, so a failure is visible and retry-safe.
    // @mermaid-node audit out:"audit"
    const audit = await ctx.tools.execute({
      id: 'record_search_import',
      tool: 'query_customer_db',
      input: {
        sql: `INSERT INTO sales.sales_nav_search_imports (import_id, imported_by, imported_at, search_url, search_name, saved_search_id, requested_limit, total_hint, status)
VALUES (${lit(input.import_id)}, ${lit(input.imported_by)}, now(), ${lit(input.search_url)}, ${lit(input.search_name)}, ${lit(input.saved_search_id)}, ${lit(input.limit)}, ${lit(input.total_hint)}, 'received')
ON CONFLICT (import_id) DO UPDATE SET updated_at = now(), requested_limit = EXCLUDED.requested_limit`,
        max_rows: 1,
      },
      description: 'Record who forwarded which Sales Navigator search, when, and how many results they asked for.',
      staleAfterSeconds: 0,
    });

    // 2. Launch the scrape. WizLeads pages the search on its own seats.
    // @mermaid-node launch out:"task"
    const task = (await ctx.tools.execute({
      id: 'launch_scrape',
      tool: 'wizleads_scrape_salesnav',
      input: {
        name: `ext:${input.import_id}:${(input.search_name ?? 'search').slice(0, 60)}`,
        type: 'salesnav-profile',
        inputs: { accounts: null, links: [{ link: input.search_url, end_page: pages }], useAccountless: true, enrichEmails: false },
        account: 'salesnav',
        wait_for_completion: true,
        max_wait_ms: 25_000,
      },
      description: `Scrape up to ${input.limit} people (${pages} pages) from the forwarded search.`,
      staleAfterSeconds: 0,
    })) as unknown as { task_id: string; status?: string; link?: string | null; link_size?: number | null };

    // 3. Poll until the task reaches a terminal state (bounded).
    // @mermaid-node poll out:"detail"
    let detail: { status?: string; link?: string | null; link_size?: number | null } = task;
    for (let attempt = 0; attempt < 60 && !detail.link && !/^(done|completed|success|failed|error)$/i.test(detail.status ?? ''); attempt++) {
      await new Promise((r) => setTimeout(r, 10_000));
      detail = (await ctx.tools.execute({
        id: 'poll_task',
        tool: 'wizleads_get_task',
        input: { task_id: task.task_id },
        description: 'Check whether the Sales Navigator scrape has finished.',
        staleAfterSeconds: 0,
      })) as unknown as typeof detail;
    }
    if (!detail.link) {
      await ctx.tools.execute({
        id: 'mark_failed',
        tool: 'query_customer_db',
        input: { sql: `UPDATE sales.sales_nav_search_imports SET status = 'failed', provider_task_id = ${lit(task.task_id)}, updated_at = now() WHERE import_id = ${lit(input.import_id)}`, max_rows: 1 },
        description: 'Mark the import failed: the provider did not produce a result file in time.',
        staleAfterSeconds: 0,
      });
      throw new Error(`WizLeads task ${task.task_id} did not finish (status ${detail.status ?? 'unknown'})`);
    }

    // 4. Download the CSV the provider produced.
    // @mermaid-node fetch out:"csv"
    const csv = (await ctx.tools.execute({
      id: 'download_results',
      tool: 'generic_http_request',
      input: { url: detail.link, method: 'GET' },
      description: 'Download the scrape result file.',
      staleAfterSeconds: 0,
    })) as unknown as { status_code: number; data?: unknown; body?: string; text?: string };
    const text = typeof csv.data === 'string' ? csv.data : (csv.body ?? csv.text ?? '');
    if (csv.status_code !== 200 || !text) throw new Error(`result download failed (${csv.status_code})`);

    const people = parseCsv(text).slice(0, input.limit);

    // 5. Store one row per member, keyed by the Sales Navigator/LinkedIn URL.
    // @mermaid-node store type:"dataset" out:"rows"
    const rows = await ctx
      .dataset(
        'salesnav_search_members',
        people.map((r) => {
          const profile = col(r, 'linkedin_url', 'profile_url', 'linkedin', 'url', 'sales_navigator_url', 'salesnav_url');
          const full = col(r, 'full_name', 'name') ?? [col(r, 'first_name'), col(r, 'last_name')].filter(Boolean).join(' ');
          return {
            key: profile ?? `name:${full.toLowerCase()}|${(col(r, 'company', 'company_name') ?? '').toLowerCase()}`,
            import_id: input.import_id,
            imported_by: input.imported_by,
            search_name: input.search_name,
            search_url: input.search_url,
            full_name: full || null,
            first_name: col(r, 'first_name'),
            last_name: col(r, 'last_name'),
            title: col(r, 'title', 'job_title', 'headline'),
            company_name: col(r, 'company', 'company_name', 'current_company'),
            location: col(r, 'location', 'geo', 'region'),
            linkedin_url: profile,
            email: col(r, 'email', 'work_email'),
            raw: r,
          };
        }),
      )
      .run({ key: 'key', description: 'Store every member the provider returned for the forwarded search.' });

    // 6. Close the import with the count.
    // @mermaid-node done out:"marked"
    const marked = await ctx.tools.execute({
      id: 'mark_done',
      tool: 'query_customer_db',
      input: { sql: `UPDATE sales.sales_nav_search_imports SET status = 'done', provider_task_id = ${lit(task.task_id)}, result_count = ${lit(people.length)}, updated_at = now() WHERE import_id = ${lit(input.import_id)}`, max_rows: 1 },
      description: 'Mark the import complete with the number of people fetched.',
      staleAfterSeconds: 0,
    });

    return { import_id: input.import_id, search_name: input.search_name, requested: input.limit, fetched: people.length, rows: await rows.count(), task_id: task.task_id, audit: !!audit, marked: !!marked };
  },
  {
    description: 'Fetch the members of a forwarded Sales Navigator search through WizLeads, record who imported it, and store one row per person.',
    billing: { maxCreditsPerRun: 10 },
  },
);
