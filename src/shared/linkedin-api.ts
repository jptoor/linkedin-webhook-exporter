/** Normalize the JSON LinkedIn's own pages fetch (Sales Navigator sales-api,
 *  Voyager GraphQL) into people records the DOM parser can be enriched with.
 *
 *  This is the same passive pattern Frontier / Exportly use: the page bridge
 *  observes responses the page already requested and hands the text here.
 *  Nothing in this file makes a request. The walker is deliberately tolerant:
 *  LinkedIn renames fields often, so we look for the shapes of a person
 *  (name + a member identifier) anywhere in the payload instead of trusting
 *  one schema, and we only keep fields that can be re-validated. */
import { canonicalizeCompanyUrl, canonicalizeLinkedInUrl, cleanName, cleanText, splitName } from "./normalize";
import type { LeadRecord } from "./types";

/** URL patterns worth reading. Identical to the set Frontier intercepts on
 *  LinkedIn, plus the Voyager search cluster endpoint. Kept as substrings so
 *  the page bridge can test them without a regex engine. */
export const INTERCEPT_PATTERNS: readonly string[] = [
  "/sales-api/salesApiLeadSearch",
  "/sales-api/salesApiPeopleSearch",
  "/sales-api/salesApiProfiles",
  "/sales-api/salesApiCompanies",
  "/sales-api/salesApiAccountSearch",
  "/sales-api/salesApiDashboardAccountTable",
  "/voyager/api/graphql",
  "/voyager/api/search/dash/clusters",
  "/voyager/api/identity/dash/profiles"
];

export function isInterceptedUrl(url: string): boolean {
  return INTERCEPT_PATTERNS.some((p) => url.includes(p));
}

/** A person as seen in an API payload. All optional except the identifier. */
export interface ApiPerson {
  /** Sales Navigator member id (ACwAAA…) when present. */
  sales_id: string | null;
  /** Flagship (voyager) profile id (ACoAAA…) when present. */
  profile_id: string | null;
  /** Public slug from `publicIdentifier` or a navigation URL. */
  public_identifier: string | null;
  linkedin_url: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  title: string | null;
  company_name: string | null;
  company_linkedin_url: string | null;
  location: string | null;
  connection_degree: "1st" | "2nd" | "3rd" | null;
  profile_image_url: string | null;
  about: string | null;
}

export interface ApiSearchMeta {
  total: number | null;
  start: number | null;
  count: number | null;
}

export interface ParsedApi {
  people: ApiPerson[];
  meta: ApiSearchMeta;
  /** Which family of endpoint produced it. */
  kind: "sales" | "voyager" | "unknown";
}

const SALES_ID_RE = /\(?(ACwAAA[A-Za-z0-9_-]{6,80})/;
const PROFILE_ID_RE = /fsd_profile:(ACoAAA[A-Za-z0-9_-]{6,80})/;
const MAX_TEXT = 300;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = MAX_TEXT): string | null => (typeof v === "string" && v.trim() ? cleanText(v.slice(0, max)) : null);
/** `{ text: "…" }` or a plain string. */
const textOf = (v: unknown, max = MAX_TEXT): string | null => (isObj(v) ? str(v.text, max) : str(v, max));

function degreeOf(v: unknown): ApiPerson["connection_degree"] {
  if (typeof v === "number") return v === 1 ? "1st" : v === 2 ? "2nd" : v === 3 ? "3rd" : null;
  if (typeof v === "string") {
    const m = v.match(/\b(1|2|3)(st|nd|rd)?\b|DISTANCE_(1|2|3)/);
    const n = m ? Number(m[1] ?? m[3]) : NaN;
    return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : null;
  }
  return null;
}

function imageOf(v: unknown): string | null {
  if (!isObj(v)) return null;
  const root = str(v.rootUrl, 1024);
  const artifacts = Array.isArray(v.artifacts) ? v.artifacts : [];
  const last = artifacts[artifacts.length - 1];
  const seg = isObj(last) ? str(last.fileIdentifyingUrlPathSegment, 1024) : null;
  const url = root && seg ? root + seg : null;
  return url && /^https:\/\/([a-z0-9-]+\.)*licdn\.com\//i.test(url) ? url : null;
}

function companyOf(pos: Obj): { name: string | null; url: string | null } {
  const res = isObj(pos.companyUrnResolutionResult) ? pos.companyUrnResolutionResult : null;
  const name = str(pos.companyName) ?? (res ? str(res.name) : null);
  const urn = str(pos.companyUrn) ?? (res ? str(res.entityUrn) : null);
  const id = urn?.match(/(?:fs_salesCompany|company):(\d+)/)?.[1] ?? null;
  return { name, url: id ? canonicalizeCompanyUrl(`https://www.linkedin.com/company/${id}`) : null };
}

/** Sales Navigator person (lead search row, people search row, profile). */
function salesPerson(o: Obj): ApiPerson | null {
  const urn = str(o.entityUrn, 400) ?? str(o.objectUrn, 400) ?? "";
  const salesId = urn.match(SALES_ID_RE)?.[1] ?? null;
  const first = str(o.firstName);
  const last = str(o.lastName);
  const full = str(o.fullName) ?? (first || last ? [first, last].filter(Boolean).join(" ") : null);
  if (!salesId && !full) return null;
  if (!full) return null;
  const positions = Array.isArray(o.currentPositions) ? o.currentPositions : Array.isArray(o.positions) ? o.positions : [];
  const current = positions.find((p) => isObj(p) && (p.current === true || p.current === undefined)) ?? positions[0];
  const pos = isObj(current) ? current : {};
  const company = companyOf(pos);
  const flagship = str(o.flagshipProfileUrl, 1024);
  const publicId = str(o.publicIdentifier, 200);
  const linkedin = canonicalizeLinkedInUrl(flagship ?? (publicId ? `https://www.linkedin.com/in/${publicId}` : null));
  return {
    sales_id: salesId,
    profile_id: null,
    public_identifier: linkedin ? (linkedin.match(/\/in\/([^/?#]+)/)?.[1] ?? null) : publicId,
    linkedin_url: linkedin,
    full_name: cleanName(full),
    first_name: first ? cleanName(first) : null,
    last_name: last ? cleanName(last) : null,
    headline: str(o.headline, 500) ?? null,
    title: str(pos.title) ?? null,
    company_name: company.name,
    company_linkedin_url: company.url,
    location: str(o.geoRegion) ?? str(o.location) ?? str(o.locationName) ?? null,
    connection_degree: degreeOf(o.degree ?? o.memberDistance),
    profile_image_url: imageOf(o.profilePictureDisplayImage) ?? imageOf(o.pictureInfo),
    about: str(o.summary, 2000)
  };
}

/** Voyager entity result (people search) or dash profile. */
function voyagerPerson(o: Obj): ApiPerson | null {
  const type = str(o.$type, 200) ?? "";
  const urn = str(o.entityUrn, 400) ?? "";
  const profileId = urn.match(PROFILE_ID_RE)?.[1] ?? (urn.startsWith("urn:li:fsd_profile:") ? (urn.match(/fsd_profile:([A-Za-z0-9_-]{6,80})/)?.[1] ?? null) : null);
  if (/EntityResultViewModel/.test(type) || (o.navigationUrl && o.title)) {
    const nav = str(o.navigationUrl, 1024);
    const linkedin = canonicalizeLinkedInUrl(nav);
    const name = cleanName(textOf(o.title));
    if (!name) return null;
    const { first_name, last_name } = splitName(name);
    return {
      sales_id: null,
      profile_id: profileId,
      public_identifier: linkedin ? (linkedin.match(/\/in\/([^/?#]+)/)?.[1] ?? null) : null,
      linkedin_url: linkedin,
      full_name: name,
      first_name,
      last_name,
      headline: textOf(o.primarySubtitle, 500),
      title: null,
      company_name: null,
      company_linkedin_url: null,
      location: textOf(o.secondarySubtitle),
      connection_degree: degreeOf(textOf(o.entityCustomTrackingInfo && isObj(o.entityCustomTrackingInfo) ? o.entityCustomTrackingInfo.memberDistance : null) ?? textOf(o.badgeText)),
      profile_image_url: null,
      about: null
    };
  }
  if (/identity\.profile\.Profile$/.test(type) || (profileId && (o.firstName || o.publicIdentifier))) {
    const first = str(o.firstName);
    const last = str(o.lastName);
    const full = first || last ? [first, last].filter(Boolean).join(" ") : null;
    if (!full) return null;
    const publicId = str(o.publicIdentifier, 200);
    const linkedin = canonicalizeLinkedInUrl(publicId ? `https://www.linkedin.com/in/${publicId}` : null);
    return {
      sales_id: null,
      profile_id: profileId,
      public_identifier: publicId,
      linkedin_url: linkedin,
      full_name: cleanName(full),
      first_name: cleanName(first),
      last_name: cleanName(last),
      headline: str(o.headline, 500),
      title: null,
      company_name: null,
      company_linkedin_url: null,
      location: isObj(o.geoLocation) ? str((o.geoLocation as Obj).defaultLocalizedName) : (str(o.locationName) ?? null),
      connection_degree: null,
      profile_image_url: null,
      about: str(o.summary, 2000)
    };
  }
  return null;
}

/** Walk a payload and collect people; bounded so a hostile or huge response
 *  cannot pin the content script. */
export function parseInterceptedResponse(url: string, text: string, maxNodes = 20_000): ParsedApi {
  const kind: ParsedApi["kind"] = url.includes("/sales-api/") ? "sales" : url.includes("/voyager/") ? "voyager" : "unknown";
  const out: ParsedApi = { people: [], meta: { total: null, start: null, count: null }, kind };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return out;
  }
  const seen = new Map<string, ApiPerson>();
  let nodes = 0;
  const visit = (v: unknown, depth: number) => {
    if (nodes++ > maxNodes || depth > 12) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    if (isObj(v.paging) && out.meta.total == null) {
      const p = v.paging as Obj;
      out.meta = { total: typeof p.total === "number" ? p.total : null, start: typeof p.start === "number" ? p.start : null, count: typeof p.count === "number" ? p.count : null };
    }
    const person = kind === "sales" ? salesPerson(v) : voyagerPerson(v) ?? salesPerson(v);
    if (person) {
      const key = person.sales_id ?? person.profile_id ?? person.public_identifier ?? `name:${person.full_name}`;
      const prev = seen.get(key);
      seen.set(key, prev ? mergePeople(prev, person) : person);
    }
    for (const x of Object.values(v)) if (x && typeof x === "object") visit(x, depth + 1);
  };
  visit(root, 0);
  out.people = Array.from(seen.values());
  return out;
}

function mergePeople(a: ApiPerson, b: ApiPerson): ApiPerson {
  const out = { ...a };
  for (const k of Object.keys(b) as Array<keyof ApiPerson>) if (out[k] == null && b[k] != null) (out as Record<string, unknown>)[k] = b[k];
  return out;
}

/** In-memory index of people seen in intercepted responses for one page. */
export class ApiIndex {
  private bySales = new Map<string, ApiPerson>();
  private byProfile = new Map<string, ApiPerson>();
  private bySlug = new Map<string, ApiPerson>();
  private byName = new Map<string, ApiPerson>();
  total: number | null = null;
  responses = 0;
  people = 0;

  ingest(url: string, text: string): ParsedApi {
    const parsed = parseInterceptedResponse(url, text);
    this.responses++;
    if (parsed.meta.total != null) this.total = parsed.meta.total;
    for (const p of parsed.people) {
      this.people++;
      if (p.sales_id) this.bySales.set(p.sales_id, mergePeople(this.bySales.get(p.sales_id) ?? p, p));
      if (p.profile_id) this.byProfile.set(p.profile_id, mergePeople(this.byProfile.get(p.profile_id) ?? p, p));
      if (p.public_identifier) this.bySlug.set(p.public_identifier.toLowerCase(), mergePeople(this.bySlug.get(p.public_identifier.toLowerCase()) ?? p, p));
      if (p.full_name) this.byName.set(nameKey(p.full_name, p.company_name), p);
    }
    return parsed;
  }

  /** Find the API record for a DOM-parsed lead: Sales Navigator id first, then
   *  public slug, then exact name + company. */
  lookup(lead: LeadRecord): ApiPerson | null {
    const salesId = lead.linkedin_member_urn ?? lead.sales_navigator_url?.match(SALES_ID_RE)?.[1] ?? null;
    if (salesId && this.bySales.has(salesId)) return this.bySales.get(salesId)!;
    if (lead.linkedin_slug && this.bySlug.has(lead.linkedin_slug.toLowerCase())) return this.bySlug.get(lead.linkedin_slug.toLowerCase())!;
    return this.byName.get(nameKey(lead.full_name, lead.company_name)) ?? null;
  }

  get size(): number {
    return this.bySales.size + this.byProfile.size;
  }
}

function nameKey(name: string, company: string | null): string {
  return `${name.toLowerCase().normalize("NFKC")}|${(company ?? "").toLowerCase()}`;
}

/** Fill what the DOM could not read from what the API said. The DOM stays
 *  the source of truth for anything it read cleanly; API values only fill
 *  nulls, replace fields the parser flagged as guessed, and add the public
 *  profile URL Sales Navigator never renders. */
export function enrichLead(lead: LeadRecord, api: ApiPerson | null): LeadRecord {
  if (!api) return lead;
  const warn = new Set(lead.parse_warnings);
  const out: LeadRecord = { ...lead, parse_warnings: [...lead.parse_warnings] };
  const fill = <K extends keyof LeadRecord>(k: K, v: LeadRecord[K] | null | undefined, force = false) => {
    if (v == null || v === "") return;
    if (force || out[k] == null || out[k] === "") (out as unknown as Record<string, unknown>)[k] = v;
  };
  if (api.full_name && (warn.has("name_from_title") || warn.has("name_fallback_key"))) {
    out.full_name = api.full_name;
    out.first_name = api.first_name ?? out.first_name;
    out.last_name = api.last_name ?? out.last_name;
    out.parse_warnings = out.parse_warnings.filter((w) => w !== "name_from_title" && w !== "name_fallback_key");
  }
  fill("first_name", api.first_name);
  fill("last_name", api.last_name);
  fill("headline", api.headline);
  fill("title", api.title, warn.has("headline_unsplit"));
  fill("company_name", api.company_name, warn.has("company_missing") || warn.has("headline_unsplit"));
  fill("company_linkedin_url", api.company_linkedin_url);
  fill("location", api.location, warn.has("location_guessed") || warn.has("location_missing"));
  fill("connection_degree", api.connection_degree);
  fill("profile_image_url", api.profile_image_url);
  fill("about", api.about);
  if (api.linkedin_url && !out.linkedin_url) {
    out.linkedin_url = api.linkedin_url;
    out.linkedin_slug = api.public_identifier;
  }
  if (out.linkedin_member_urn == null && api.sales_id) out.linkedin_member_urn = api.sales_id;
  out.parse_warnings = out.parse_warnings.filter((w) => !((w === "location_missing" || w === "location_guessed") && api.location) && !(w === "company_missing" && api.company_name) && !(w === "headline_unsplit" && api.title));
  if (!out.parse_warnings.includes("api_merged")) out.parse_warnings.push("api_merged");
  return out;
}
