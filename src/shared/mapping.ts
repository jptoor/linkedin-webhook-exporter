import type { BatchPayload, EventName, ImportInfo, LeadRecord, MappingPreset, Payload, SearchPayload, SearchRecord, SinglePayload, SourceInfo } from "./types";
import { EVENT_NAMES, SCHEMA_VERSION } from "./types";

/** Every body, in every preset, starts with the same envelope fields so
 *  receivers can branch on `event` and negotiate on `schema_version`. */
function envelope(event: EventName, eventId: string, sentAt: string) {
  return { schema_version: SCHEMA_VERSION, event, event_id: eventId, sent_at: sentAt };
}

export function flattenSource(source: SourceInfo): Record<string, unknown> {
  return { page_type: source.page_type, page_url: source.page_url, captured_by: source.captured_by, extension_version: source.version };
}

export function flattenImport(imp: ImportInfo | null | undefined): Record<string, unknown> {
  if (!imp) return {};
  return { import_id: imp.import_id, imported_by: imp.imported_by, imported_at: imp.imported_at, import_kind: imp.import_kind, import_search_url: imp.search_url, import_search_name: imp.search_name, import_list_id: imp.list_id, import_page: imp.page };
}

function prefixCustom(custom: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(custom)) out[k.startsWith("custom_") ? k : `custom_${k}`] = v;
  return out;
}

/** Flatten one lead + source + custom fields into a single-level object.
 *  Suitable for Clay, Zapier, Make and spreadsheet-style receivers that key
 *  columns by top-level property name. */
export function flattenLead(lead: LeadRecord, source: SourceInfo, custom: Record<string, string>, eventId: string, sentAt: string, imp: ImportInfo | null = null): Record<string, unknown> {
  const { experience, education, parse_warnings, ...rest } = lead;
  return {
    ...envelope("lead.captured", eventId, sentAt),
    ...rest,
    experience_json: experience.length ? JSON.stringify(experience) : null,
    education_json: education.length ? JSON.stringify(education) : null,
    parse_warnings: parse_warnings.length ? parse_warnings.join(",") : null,
    ...flattenSource(source),
    ...flattenImport(imp),
    ...prefixCustom(custom)
  };
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
    ...envelope("lead.captured", eventId, sentAt),
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
        const body: SinglePayload = { ...envelope("lead.captured", eventId, sentAt), event: "lead.captured", source, lead, import: imp, custom };
        return { eventId, body, leads: [lead] };
      }
      return { eventId, body: rowFor(lead, eventId), leads: [lead] };
    });
  }

  const eventId = opts.eventId();
  if (preset === "generic") {
    const body: BatchPayload = { ...envelope("leads.captured", eventId, sentAt), event: "leads.captured", source, leads, import: imp, custom };
    return [{ eventId, body, leads }];
  }
  // Flat / Deepline batch: a versioned envelope with a `rows` array of flat
  // records; source/import/custom are repeated on the envelope for receivers
  // that only look at the top level.
  return [{ eventId, body: { ...envelope("leads.captured", eventId, sentAt), ...flattenSource(source), ...flattenImport(imp), ...prefixCustom(custom), rows: leads.map((l) => rowFor(l, eventId)) }, leads }];
}

/** Body for a saved search. Generic keeps the envelope; flat and Deepline
 *  presets send one flat object with `event: "search.captured"` so a play or a
 *  Clay/Zapier receiver can branch on it and hand the URL to a provider. */
export function buildSearchBody(search: SearchRecord, preset: MappingPreset, source: SourceInfo, custom: Record<string, string>, eventId: string, sentAt: string, imp: ImportInfo | null = null): unknown {
  if (preset === "generic") {
    const body: SearchPayload = { ...envelope("search.captured", eventId, sentAt), event: "search.captured", source, search, import: imp, custom };
    return body;
  }
  const { params, filters, ...rest } = search;
  return {
    ...envelope("search.captured", eventId, sentAt),
    ...rest,
    params_json: JSON.stringify(params),
    filters_json: JSON.stringify(filters),
    ...flattenSource(source),
    ...flattenImport(imp),
    ...prefixCustom(custom)
  };
}

/** True when `x` carries the versioned envelope every preset emits. */
export function isPayload(x: unknown): x is Payload | Record<string, unknown> {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return o.schema_version === SCHEMA_VERSION && typeof o.event === "string" && (EVENT_NAMES as readonly string[]).includes(o.event) && typeof o.event_id === "string";
}
