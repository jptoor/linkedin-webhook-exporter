import type { BatchPayload, ImportInfo, LeadRecord, MappingPreset, Payload, SearchPayload, SearchRecord, SinglePayload, SourceInfo } from "./types";

/** Flatten one lead + source + custom fields into a single-level object.
 *  Suitable for Clay, Zapier, Make and spreadsheet-style receivers that key
 *  columns by top-level property name. */
export function flattenImport(imp: ImportInfo | null | undefined): Record<string, unknown> {
  if (!imp) return {};
  return { import_id: imp.import_id, imported_by: imp.imported_by, imported_at: imp.imported_at, import_kind: imp.import_kind, import_search_url: imp.search_url, import_search_name: imp.search_name, import_list_id: imp.list_id, import_page: imp.page };
}

export function flattenLead(lead: LeadRecord, source: SourceInfo, custom: Record<string, string>, eventId: string, sentAt: string, imp: ImportInfo | null = null): Record<string, unknown> {
  const { experience, education, ...rest } = lead;
  return {
    event_id: eventId,
    sent_at: sentAt,
    ...rest,
    experience_json: experience.length ? JSON.stringify(experience) : null,
    education_json: education.length ? JSON.stringify(education) : null,
    page_type: source.page_type,
    page_url: source.page_url,
    captured_by: source.captured_by,
    extension_version: source.version,
    ...flattenImport(imp),
    ...prefixCustom(custom)
  };
}

function prefixCustom(custom: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(custom)) out[k.startsWith("custom_") ? k : `custom_${k}`] = v;
  return out;
}

/** Deepline preset: flat record using the field names Deepline's people
 *  enrichment plays key on (`linkedin_url`, `first_name`, `last_name`, `title`,
 *  `company_name`, `company_domain`, `email`). The body is delivered verbatim
 *  as the play's `input`. Everything else is kept under the flat-preset names.
 *  Note: `/sales/lead/` URLs are rejected by Deepline's enrichment providers,
 *  so `linkedin_url` is only set when a public `/in/` URL was captured; the
 *  play should fall back to name + company for Sales Navigator captures. */
export function toDeeplineRow(lead: LeadRecord, source: SourceInfo, custom: Record<string, string>, eventId: string, sentAt: string, imp: ImportInfo | null = null): Record<string, unknown> {
  const flat = flattenLead(lead, source, custom, eventId, sentAt, imp);
  return {
    // Canonical Deepline play-input names first (prebuilt/person-linkedin-to-email,
    // prebuilt/name-and-domain-to-email-waterfall key on these).
    linkedin_url: lead.linkedin_url,
    first_name: lead.first_name,
    last_name: lead.last_name,
    title: lead.title,
    company_name: lead.company_name,
    // Not scrapable from LinkedIn; present so a play can fill it via enrichment.
    company_domain: null,
    email: null,
    source: "linkedin-webhook-exporter",
    ...flat
  };
}

export interface BuildOptions {
  preset: MappingPreset;
  mode: "single" | "batch";
  source: SourceInfo;
  custom: Record<string, string>;
  eventId: () => string;
  sentAt: string;
  import?: ImportInfo | null;
}

/** Produce one or more request bodies (as objects) for a set of leads. */
export function buildBodies(leads: LeadRecord[], opts: BuildOptions): Array<{ eventId: string; body: unknown; leads: LeadRecord[] }> {
  const { preset, mode, source, custom, sentAt } = opts;
  const imp = opts.import ?? null;
  const rowFor = (lead: LeadRecord, id: string) => (preset === "deepline" ? toDeeplineRow(lead, source, custom, id, sentAt, imp) : flattenLead(lead, source, custom, id, sentAt, imp));

  if (mode === "single") {
    return leads.map((lead) => {
      const eventId = opts.eventId();
      if (preset === "generic") {
        const body: SinglePayload = { schema_version: "1", event: "lead.captured", event_id: eventId, sent_at: sentAt, source, lead, import: imp, custom };
        return { eventId, body, leads: [lead] };
      }
      return { eventId, body: rowFor(lead, eventId), leads: [lead] };
    });
  }

  const eventId = opts.eventId();
  if (preset === "generic") {
    const body: BatchPayload = { schema_version: "1", event: "leads.captured", event_id: eventId, sent_at: sentAt, source, leads, import: imp, custom };
    return [{ eventId, body, leads }];
  }
  // Flat / Deepline batch: an envelope with a `rows` array of flat records.
  return [{ eventId, body: { event: "leads.captured", event_id: eventId, sent_at: sentAt, ...flattenImport(imp), rows: leads.map((l) => rowFor(l, eventId)) }, leads }];
}

/** Body for a saved search. Generic keeps the envelope; flat and Deepline
 *  presets send one flat object with `event: "search.captured"` so a play or a
 *  Clay/Zapier receiver can branch on it and hand the URL to a provider. */
export function buildSearchBody(search: SearchRecord, preset: MappingPreset, source: SourceInfo, custom: Record<string, string>, eventId: string, sentAt: string): unknown {
  if (preset === "generic") {
    const body: SearchPayload = { schema_version: "1", event: "search.captured", event_id: eventId, sent_at: sentAt, source, search, custom };
    return body;
  }
  const { params, filters, ...rest } = search;
  return {
    event: "search.captured",
    event_id: eventId,
    sent_at: sentAt,
    ...rest,
    params_json: JSON.stringify(params),
    filters_json: JSON.stringify(filters),
    source_page_url: source.page_url,
    captured_by: source.captured_by,
    extension_version: source.version,
    ...Object.fromEntries(Object.entries(custom).map(([k, v]) => [k.startsWith("custom_") ? k : `custom_${k}`, v]))
  };
}

export function isPayload(x: unknown): x is Payload {
  return !!x && typeof x === "object" && (x as Payload).schema_version === "1";
}
