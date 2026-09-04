/** Runtime validation for data crossing trust boundaries: content-script
 *  messages into the worker, settings out of storage, and lead records that
 *  originated in a page's DOM. TypeScript types are compile-time only. */
import { canonicalizeCompanyUrl, canonicalizeLinkedInUrl, canonicalizeSalesNavUrl, cleanText, isLinkedInHost } from "./normalize";
import { PAGE_TYPES, type EducationEntry, type ExperienceEntry, type LeadRecord, type PageType, type ParseWarning } from "./types";

const MAX = { name: 200, text: 300, headline: 500, about: 4000, url: 2048, entries: 20, warnings: 20 } as const;

function optStr(v: unknown, max: number): string | null {
  return typeof v === "string" ? cleanText(v.slice(0, max)) : null;
}

export function isPageType(v: unknown): v is PageType {
  return typeof v === "string" && (PAGE_TYPES as readonly string[]).includes(v);
}

/** Accept page URLs on LinkedIn hosts, plus loopback for the test build. */
export function isAllowedPageUrl(url: unknown, allowLoopback: boolean): url is string {
  if (typeof url !== "string" || url.length > MAX.url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && isLinkedInHost(u.hostname)) return true;
    return allowLoopback && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

function experience(v: unknown): ExperienceEntry[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX.entries).flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    const title = optStr(o.title, MAX.text);
    if (!title) return [];
    return [{ title, company_name: optStr(o.company_name, MAX.text), company_linkedin_url: canonicalizeCompanyUrl(optStr(o.company_linkedin_url, MAX.url)), date_range: optStr(o.date_range, 100), location: optStr(o.location, MAX.text) }];
  });
}
function education(v: unknown): EducationEntry[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX.entries).flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    const school = optStr(o.school, MAX.text);
    if (!school) return [];
    return [{ school, degree: optStr(o.degree, MAX.text), date_range: optStr(o.date_range, 100) }];
  });
}

/** Re-validate a LeadRecord that came from a content script. URLs are
 *  re-canonicalized (which rejects non-LinkedIn hosts), strings are bounded,
 *  and a record without a usable name is rejected. */
export function validateLead(input: unknown): LeadRecord | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const full_name = optStr(o.full_name, MAX.name);
  if (!full_name) return null;
  const degree = o.connection_degree === "1st" || o.connection_degree === "2nd" || o.connection_degree === "3rd" ? o.connection_degree : null;
  const linkedin_url = canonicalizeLinkedInUrl(optStr(o.linkedin_url, MAX.url));
  const sales_navigator_url = canonicalizeSalesNavUrl(optStr(o.sales_navigator_url, MAX.url));
  const urn = optStr(o.linkedin_member_urn, 80);
  const captured = optStr(o.captured_at, 40);
  const img = optStr(o.profile_image_url, MAX.url);
  const warnings = Array.isArray(o.parse_warnings) ? (o.parse_warnings.filter((w) => typeof w === "string").slice(0, MAX.warnings) as ParseWarning[]) : [];
  return {
    full_name,
    first_name: optStr(o.first_name, MAX.name),
    last_name: optStr(o.last_name, MAX.name),
    headline: optStr(o.headline, MAX.headline),
    title: optStr(o.title, MAX.text),
    company_name: optStr(o.company_name, MAX.text),
    company_linkedin_url: canonicalizeCompanyUrl(optStr(o.company_linkedin_url, MAX.url)),
    location: optStr(o.location, MAX.text),
    linkedin_url,
    linkedin_slug: linkedin_url ? (linkedin_url.match(/\/in\/([^/?#]+)/)?.[1] ?? null) : null,
    linkedin_member_urn: urn && /^[A-Za-z0-9_-]{8,80}$/.test(urn) ? urn : null,
    sales_navigator_url,
    connection_degree: degree,
    profile_image_url: img && /^https:\/\/([a-z0-9-]+\.)*licdn\.com\//i.test(img) ? img : null,
    about: optStr(o.about, MAX.about),
    experience: experience(o.experience),
    education: education(o.education),
    captured_at: captured && !Number.isNaN(Date.parse(captured)) ? captured : new Date().toISOString(),
    parse_warnings: warnings
  };
}

export function validateLeads(input: unknown, max = 100): LeadRecord[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, max).map(validateLead).filter((l): l is LeadRecord => l !== null);
}
