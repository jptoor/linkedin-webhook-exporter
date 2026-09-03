/** Pure text/URL normalization helpers. No DOM, no chrome APIs. */

const ARTIFACT_SUFFIXES = [
  /\bis reachable\b.*$/i,
  /\bhas a premium account\b.*$/i,
  /\bis open to work\b.*$/i,
  /\bis hiring\b.*$/i,
  /\s*[•·]\s*(1st|2nd|3rd\+?|3rd)\s*$/i,
  /\s*\((He|She|They)\/[^)]*\)\s*$/i
];

export function cleanText(input: string | null | undefined): string | null {
  if (input == null) return null;
  const t = input.replace(/\s+/g, " ").replace(/ /g, " ").trim();
  return t.length ? t : null;
}

export function cleanName(input: string | null | undefined): string | null {
  let t = cleanText(input);
  if (!t) return null;
  for (const re of ARTIFACT_SUFFIXES) t = t.replace(re, "").trim();
  // Strip trailing credentials like ", MBA" / ", PhD" / ", CPA"
  t = t.replace(/,\s*(MBA|PhD|Ph\.D\.?|CPA|CFA|PMP|MD|JD|MSc|BSc|M\.?S\.?|B\.?A\.?)\b.*$/i, "").trim();
  return t.length ? t : null;
}

export function splitName(fullName: string | null): { first_name: string | null; last_name: string | null } {
  if (!fullName) return { first_name: null, last_name: null };
  const parts = fullName.split(" ").filter(Boolean);
  if (parts.length === 0) return { first_name: null, last_name: null };
  if (parts.length === 1) return { first_name: parts[0], last_name: null };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

/** Returns https://www.linkedin.com/in/<slug> or null if not a public profile URL. */
export function canonicalizeLinkedInUrl(href: string | null | undefined, base = "https://www.linkedin.com"): string | null {
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  const m = u.pathname.match(/^\/in\/([^/?#]+)/i);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    slug = m[1];
  }
  slug = slug.replace(/\/+$/, "");
  if (!slug) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(slug).replace(/%20/g, "-")}`;
}

export function slugFromCanonical(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/in\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** Extract member URN (ACwAAA...) from a Sales Navigator lead URL. */
export function memberUrnFromSalesNavUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = href.match(/\/sales\/(?:lead|people)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function canonicalizeSalesNavUrl(href: string | null | undefined, base = "https://www.linkedin.com"): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    const m = u.pathname.match(/^\/sales\/(lead|people)\/([^/?#]+)/);
    if (!m) return null;
    const id = m[2].split(",")[0];
    return `https://www.linkedin.com/sales/lead/${id}`;
  } catch {
    return null;
  }
}

export function canonicalizeCompanyUrl(href: string | null | undefined, base = "https://www.linkedin.com"): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    const m = u.pathname.match(/^\/(company|school|sales\/company)\/([^/?#]+)/);
    if (!m) return null;
    const kind = m[1] === "sales/company" ? "company" : m[1];
    return `https://www.linkedin.com/${kind}/${m[2].split(",")[0]}`;
  } catch {
    return null;
  }
}

export function parseConnectionDegree(text: string | null | undefined): "1st" | "2nd" | "3rd" | null {
  if (!text) return null;
  const m = text.match(/\b(1st|2nd|3rd)\b/);
  return m ? (m[1] as "1st" | "2nd" | "3rd") : null;
}

/** Truncate long free text (about sections) to keep payloads small. */
export function truncate(text: string | null, max = 2000): string | null {
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Identity key for dedupe: canonical public URL, else Sales Nav URL, else name+company. */
export function dedupeKey(lead: { linkedin_url: string | null; sales_navigator_url: string | null; full_name: string; company_name: string | null }): string {
  if (lead.linkedin_url) return lead.linkedin_url.toLowerCase();
  if (lead.sales_navigator_url) return lead.sales_navigator_url.toLowerCase();
  return `name:${lead.full_name.toLowerCase()}|${(lead.company_name ?? "").toLowerCase()}`;
}
