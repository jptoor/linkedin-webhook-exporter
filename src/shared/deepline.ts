/** Deepline play destinations: discover callable plays through the API, infer
 *  how a play wants its input, and build `POST /api/v2/plays/run` requests.
 *  Everything here is pure except the two fetch helpers, which take a fetch
 *  implementation so they can be unit-tested. */
import { flattenImport, flattenSource, toDeeplineRow } from "./mapping";
import type { ImportInfo, LeadRecord, PlayInputSpec, SearchRecord, SourceInfo } from "./types";

export const DEFAULT_BASE_URL = "https://code.deepline.com";

/** A callable play as listed by `GET /api/v2/plays` (subset we use). */
export interface PlaySummary {
  playKey: string;
  name: string;
  displayName: string;
  description: string | null;
  origin: "owned" | "prebuilt" | string;
  inputSchema: Record<string, unknown> | null;
  input: PlayInputSpec;
}

/** Lead fields a LinkedIn page can provide, keyed by the input property names
 *  plays commonly declare. Order matters: the first alias present in a schema
 *  wins the value. */
const LEAD_FIELD_ALIASES: Record<string, (lead: LeadRecord) => unknown> = {
  linkedin_url: (l) => l.linkedin_url ?? l.sales_navigator_url,
  linkedin: (l) => l.linkedin_url ?? l.sales_navigator_url,
  linkedin_profile_url: (l) => l.linkedin_url ?? l.sales_navigator_url,
  profile_url: (l) => l.linkedin_url ?? l.sales_navigator_url,
  url: (l) => l.linkedin_url ?? l.sales_navigator_url,
  sales_navigator_url: (l) => l.sales_navigator_url,
  linkedin_member_urn: (l) => l.linkedin_member_urn,
  full_name: (l) => l.full_name,
  name: (l) => l.full_name,
  person_name: (l) => l.full_name,
  first_name: (l) => l.first_name,
  last_name: (l) => l.last_name,
  title: (l) => l.title,
  job_title: (l) => l.title,
  headline: (l) => l.headline,
  company_name: (l) => l.company_name,
  company: (l) => l.company_name,
  organization: (l) => l.company_name,
  company_linkedin_url: (l) => l.company_linkedin_url,
  location: (l) => l.location,
  connection_degree: (l) => l.connection_degree,
  profile_image_url: (l) => l.profile_image_url,
  about: (l) => l.about
};
const SEARCH_URL_FIELDS = ["search_url", "sales_navigator_url", "sales_nav_url", "salesnav_url", "url", "linkedin_search_url"];

function schemaProperties(schema: Record<string, unknown> | null | undefined): { fields: string[]; required: string[]; types: Record<string, string> } {
  const props = schema && typeof schema.properties === "object" && schema.properties ? (schema.properties as Record<string, unknown>) : {};
  const fields = Object.keys(props);
  const required = Array.isArray(schema?.required) ? (schema!.required as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const types: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    const t = v && typeof v === "object" ? (v as { type?: unknown }).type : undefined;
    types[k] = Array.isArray(t) ? String(t.find((x) => x !== "null") ?? "") : typeof t === "string" ? t : "";
  }
  return { fields, required, types };
}

/** Decide how to feed leads to a play from its declared input schema. A play
 *  without a schema accepts anything: we send the flat Deepline row per lead. */
export function inferPlayInput(schema: Record<string, unknown> | null | undefined): PlayInputSpec {
  const { fields, required, types } = schemaProperties(schema);
  if (!fields.length) return { mode: "mapped", fields: [], required: [], acceptsSearch: true, acceptsLeads: true };
  const acceptsSearch = fields.some((f) => SEARCH_URL_FIELDS.includes(f));
  if (fields.includes("leads") && (types.leads === "array" || types.leads === "")) return { mode: "batch", fields, required, acceptsSearch, acceptsLeads: true };
  if (fields.includes("lead") && (types.lead === "object" || types.lead === "")) return { mode: "lead", fields, required, acceptsSearch, acceptsLeads: true };
  const mappable = fields.filter((f) => f in LEAD_FIELD_ALIASES);
  // A play whose only URL-ish field is a search URL should not receive leads.
  const leadOnly = mappable.filter((f) => !(f === "url" && acceptsSearch && !fields.includes("linkedin_url")));
  return { mode: "mapped", fields, required, acceptsSearch, acceptsLeads: leadOnly.length > 0 };
}

export function summarizePlayInput(spec: PlayInputSpec): string {
  if (!spec.fields.length) return "accepts any input (no schema)";
  const req = spec.required.length ? ` · required: ${spec.required.join(", ")}` : "";
  const mode = spec.mode === "batch" ? "one run per send (leads[])" : spec.mode === "lead" ? "one run per lead (lead{})" : "one run per lead (mapped fields)";
  const what = [spec.acceptsLeads ? "leads" : null, spec.acceptsSearch ? "searches" : null].filter(Boolean).join(" + ") || "nothing the extension can provide";
  return `${what} · ${mode}${req}`;
}

export interface PlayRun {
  /** Sent as `input` to the run API. */
  input: Record<string, unknown>;
  leads: LeadRecord[];
  label: string;
}

const META = (source: SourceInfo, imp: ImportInfo | null, custom: Record<string, string>) => ({ source: "linkedin-webhook-exporter", ...flattenSource(source), ...flattenImport(imp), custom });

/** Build the run inputs for a set of leads under the play's input spec. */
export function buildLeadRuns(spec: PlayInputSpec, leads: LeadRecord[], source: SourceInfo, imp: ImportInfo | null, custom: Record<string, string>, eventId: () => string, sentAt: string): PlayRun[] {
  const row = (l: LeadRecord, id: string) => toDeeplineRow(l, source, custom, id, sentAt, imp);
  if (spec.mode === "batch") {
    const id = eventId();
    return [{ input: { leads: leads.map((l) => row(l, id)), ...META(source, imp, custom) }, leads, label: `${leads.length} leads` }];
  }
  if (spec.mode === "lead") {
    return leads.map((l) => {
      const id = eventId();
      return { input: { lead: row(l, id), ...META(source, imp, custom) }, leads: [l], label: l.full_name };
    });
  }
  return leads.map((l) => {
    const id = eventId();
    if (!spec.fields.length) return { input: row(l, id), leads: [l], label: l.full_name };
    const input: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const pick = LEAD_FIELD_ALIASES[f];
      if (!pick) continue;
      const v = pick(l);
      if (v != null && v !== "") input[f] = v;
    }
    return { input, leads: [l], label: l.full_name };
  });
}

/** Input for a search handed to a play. With a schema, only declared fields
 *  are sent (so a strict play does not reject unknown keys); the search URL
 *  lands on whichever URL field the play declares. */
export function buildSearchRun(spec: PlayInputSpec, search: SearchRecord, source: SourceInfo, imp: ImportInfo | null, custom: Record<string, string>, searchName: string | null): Record<string, unknown> {
  const full: Record<string, unknown> = {
    search_url: search.search_url,
    search_name: searchName,
    limit: search.limit,
    page_type: search.page_type,
    surface: search.surface,
    query_expression: search.query_expression,
    keywords: search.keywords,
    filters: search.filters,
    total_hint: search.total_hint,
    list_id: search.list_id,
    saved_search_id: search.saved_search_id,
    imported_by: imp?.imported_by ?? source.captured_by,
    import_id: imp?.import_id ?? null,
    ...META(source, imp, custom)
  };
  if (!spec.fields.length) return full;
  const input: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (SEARCH_URL_FIELDS.includes(f)) input[f] = search.search_url;
    else if (f in full && full[f] != null) input[f] = full[f];
    else if (f === "max_results" || f === "max" || f === "count") input[f] = search.limit;
    else if (f === "name") input[f] = searchName;
  }
  return input;
}

/** Fields a play requires that no LinkedIn page can fill (so the operator
 *  learns before sending rather than from a 400). */
export function unfillableRequired(spec: PlayInputSpec, purpose: "leads" | "search"): string[] {
  if (!spec.fields.length) return [];
  return spec.required.filter((f) => {
    if (purpose === "search") return !(SEARCH_URL_FIELDS.includes(f) || ["search_name", "limit", "name", "imported_by", "import_id", "max_results", "page_type", "surface", "keywords", "filters"].includes(f));
    if (spec.mode === "batch") return f !== "leads";
    if (spec.mode === "lead") return f !== "lead";
    return !(f in LEAD_FIELD_ALIASES);
  });
}

/* ------------------------------------------------------------ API */

export function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw.trim() || DEFAULT_BASE_URL);
  if (u.username || u.password) throw new Error("Base URL must not contain credentials");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) throw new Error("Base URL must use https:// (http:// only for localhost)");
  return `${u.protocol}//${u.host}`;
}

export function runEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/v2/plays/run`;
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

function toSummary(p: Record<string, unknown>): PlaySummary | null {
  const playKey = typeof p.playKey === "string" ? p.playKey : typeof p.reference === "string" ? p.reference : null;
  if (!playKey) return null;
  const schema = p.inputSchema && typeof p.inputSchema === "object" ? (p.inputSchema as Record<string, unknown>) : null;
  const name = typeof p.name === "string" ? p.name : playKey;
  return {
    playKey,
    name,
    displayName: typeof p.displayName === "string" && p.displayName ? p.displayName : name,
    description: typeof p.description === "string" ? p.description : null,
    origin: typeof p.origin === "string" ? p.origin : "owned",
    inputSchema: schema,
    input: inferPlayInput(schema)
  };
}

/** List callable plays: the org's own first, then Deepline prebuilt ones. */
export async function listPlays(baseUrl: string, apiKey: string, fetchImpl: FetchLike = fetch): Promise<PlaySummary[]> {
  const base = normalizeBaseUrl(baseUrl);
  const out: PlaySummary[] = [];
  for (const origin of ["owned", "prebuilt"] as const) {
    const res = await fetchImpl(`${base}/api/v2/plays?origin=${origin}&limit=100`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, credentials: "omit", redirect: "error" });
    if (res.status === 401 || res.status === 403) throw new Error("Deepline rejected the API key");
    if (!res.ok) throw new Error(`Deepline responded ${res.status}`);
    const json = (await res.json()) as { plays?: unknown };
    const plays = Array.isArray(json.plays) ? json.plays : [];
    for (const p of plays) {
      if (p && typeof p === "object") {
        const s = toSummary(p as Record<string, unknown>);
        if (s && !out.some((o) => o.playKey === s.playKey)) out.push({ ...s, origin });
      }
    }
  }
  return out;
}

/** Cheap credential check: one page of one play. */
export async function testApiKey(baseUrl: string, apiKey: string, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  try {
    const res = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/v2/plays?limit=1`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, credentials: "omit", redirect: "error" });
    if (res.ok) return { ok: true, status: res.status, error: null };
    return { ok: false, status: res.status, error: res.status === 401 || res.status === 403 ? "API key rejected" : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Extract the run id from a run API response body, whatever the field name. */
export function runIdFrom(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  for (const k of ["workflowId", "runId", "id", "run_id", "workflow_id"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  const run = o.run && typeof o.run === "object" ? (o.run as Record<string, unknown>) : null;
  if (run) for (const k of ["workflowId", "id"]) if (typeof run[k] === "string") return run[k] as string;
  return null;
}
