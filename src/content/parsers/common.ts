import type { LeadRecord } from "../../shared/types";

export function text(el: Element | null | undefined): string | null {
  if (!el) return null;
  // Prefer aria-hidden spans LinkedIn uses for visible text, which avoids
  // duplicated visually-hidden copies of the same string.
  const visible = el.querySelector<HTMLElement>('span[aria-hidden="true"]');
  const raw = (visible ?? el).textContent ?? "";
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length ? t : null;
}

export function firstMatch(root: ParentNode, selectors: string[]): Element | null {
  for (const s of selectors) {
    const el = root.querySelector(s);
    if (el) return el;
  }
  return null;
}

export function attr(el: Element | null | undefined, name: string): string | null {
  const v = el?.getAttribute(name);
  return v && v.trim().length ? v.trim() : null;
}

export function emptyLead(now: string): LeadRecord {
  return {
    full_name: "",
    first_name: null,
    last_name: null,
    headline: null,
    title: null,
    company_name: null,
    company_linkedin_url: null,
    location: null,
    linkedin_url: null,
    linkedin_slug: null,
    linkedin_member_urn: null,
    sales_navigator_url: null,
    connection_degree: null,
    profile_image_url: null,
    about: null,
    experience: [],
    education: [],
    captured_at: now
  };
}

/** Headline like "VP Sales at Acme" -> { title: "VP Sales", company: "Acme" }. */
export function splitHeadline(headline: string | null): { title: string | null; company: string | null } {
  if (!headline) return { title: null, company: null };
  const m = headline.match(/^(.*?)\s+(?:at|@)\s+(.+?)(?:\s*[|•·].*)?$/i);
  if (m) return { title: m[1].trim() || null, company: m[2].trim() || null };
  // LinkedIn people search renders "Title - Company" for members without a custom headline.
  const dash = headline.match(/^([^|•·]{2,80}?)\s+[-–]\s+([^|•·]{2,80}?)(?:\s*[|•·].*)?$/);
  if (dash) return { title: dash[1].trim() || null, company: dash[2].trim() || null };
  return { title: null, company: null };
}
