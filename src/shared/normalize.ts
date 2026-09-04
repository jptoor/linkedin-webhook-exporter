/** Pure text/URL normalization helpers. No DOM, no chrome APIs.
 *
 *  Everything here treats its input as hostile: DOM text and hrefs come from
 *  a page the extension does not control. Canonicalizers therefore accept
 *  only LinkedIn hosts, reject credentials/ports, and require exact route
 *  shapes; name/headline heuristics stay conservative and report when they
 *  could not decide. */

/* ------------------------------------------------------------------ text */

/** Badges LinkedIn appends to a name in list rows and top cards. Only stripped
 *  as a trailing token so a real name is never truncated. */
/* eslint-disable no-misleading-character-class -- emoji sequences are intentionally matched as a class */
const TRAILING_BADGES = [
  /\s+is\s+reachable$/iu,
  /\s+has\s+a\s+premium\s+account$/iu,
  /\s+is\s+open\s+to\s+work$/iu,
  /\s+is\s+hiring$/iu,
  /\s+is\s+verified$/iu,
  /\s*[•·|]\s*(1st|2nd|3rd\+?)\s*(degree\s+connection)?$/iu,
  /\s*\((?:he|she|they|him|her|them|hers|his|any|ze|xe|ey)[^)]{0,30}\)$/iu,
  /\s*[\p{Extended_Pictographic}\p{Regional_Indicator}][\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\s]*$/u
];
/* eslint-enable no-misleading-character-class */

/** Exact credential tokens that LinkedIn users commonly append after a comma.
 *  Matched as whole comma-separated tokens only, never inside a name. */
const CREDENTIALS = new Set(["mba", "phd", "ph.d", "ph.d.", "cpa", "cfa", "pmp", "md", "jd", "msc", "bsc", "ms", "ma", "ba", "mph", "rn", "esq", "esq.", "dds", "pe", "ccie", "cissp", "csm", "cscp", "cpm", "frm"]);
/** Generational suffixes that belong to the last name. */
const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);
/** Surname particles kept with the last name ("van der", "de la", "bin"). */
const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "di", "da", "dos", "das", "du", "la", "le", "bin", "ibn", "al", "el", "mac", "mc", "st.", "st", "ter", "ten", "af", "av"]);

export function cleanText(input: string | null | undefined): string | null {
  if (input == null) return null;
  const t = String(input)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "") // zero-width + bidi controls
    .replace(/\s+/g, " ")
    .trim();
  return t.length ? t : null;
}

export function cleanName(input: string | null | undefined): string | null {
  const cleaned = cleanText(input);
  if (!cleaned) return null;
  let t: string = cleaned;
  let prev = "";
  while (prev !== t) {
    prev = t;
    for (const re of TRAILING_BADGES) t = t.replace(re, "").trim();
    // Drop trailing ", MBA" style credential tokens only when every token after
    // the first comma is a known credential; otherwise the comma is part of the name.
    const parts: string[] = t.split(",").map((p: string) => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts.slice(1).every((p) => CREDENTIALS.has(p.toLowerCase()) || SUFFIXES.has(p.toLowerCase()))) {
      const keepSuffix = parts.slice(1).filter((p) => SUFFIXES.has(p.toLowerCase()));
      t = [parts[0], ...keepSuffix].join(" ");
    }
    t = t.replace(/[\s,]+$/u, "").trim();
  }
  if (!t.length) return null;
  return t.length <= 200 ? t : Array.from(t).slice(0, 200).join("").trim();
}

/** Split a display name into first/last. Conservative: mononyms keep
 *  `last_name` null, particles and generational suffixes stay with the last
 *  name, and a "LAST, First" form is honored. Always keep `full_name` too;
 *  this is a heuristic, not an identity. */
export function splitName(fullName: string | null): { first_name: string | null; last_name: string | null } {
  if (!fullName) return { first_name: null, last_name: null };
  let name = fullName.trim();
  const comma = name.match(/^([^,]+),\s*([^,]+)$/);
  if (comma && !SUFFIXES.has(comma[2].trim().toLowerCase())) name = `${comma[2].trim()} ${comma[1].trim()}`;
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { first_name: null, last_name: null };
  if (tokens.length === 1) return { first_name: tokens[0], last_name: null };
  let split = 1;
  // "Mary Ann van der Berg": once a particle starts, everything after is last name.
  const particleIdx = tokens.findIndex((t, i) => i > 0 && PARTICLES.has(t.toLowerCase()));
  if (particleIdx > 0) split = particleIdx;
  return { first_name: tokens.slice(0, split).join(" "), last_name: tokens.slice(split).join(" ") };
}

/* ------------------------------------------------------------------- URLs */

/** LinkedIn hosts we accept as identity sources: the apex, www, and the
 *  two-letter regional subdomains LinkedIn uses for public profiles. */
export function isLinkedInHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "linkedin.com" || h === "www.linkedin.com" || /^[a-z]{2}\.linkedin\.com$/.test(h);
}

function parseLinkedInUrl(href: string | null | undefined, base = "https://www.linkedin.com"): URL | null {
  if (!href || typeof href !== "string" || href.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  if (!isLinkedInHost(u.hostname)) return null;
  return u;
}

/** Profile slug grammar: unicode letters/digits, dash, underscore, percent
 *  escapes (LinkedIn percent-encodes non-ASCII slugs). 3..120 chars. */
const SLUG_RE = /^(?:[\p{L}\p{N}_-]|%[0-9A-Fa-f]{2}){3,120}$/u;

/** Returns https://www.linkedin.com/in/<slug> or null unless the URL is a
 *  LinkedIn host and the path is exactly /in/<slug>[/]. */
export function canonicalizeLinkedInUrl(href: string | null | undefined, base = "https://www.linkedin.com"): string | null {
  const u = parseLinkedInUrl(href, base);
  if (!u) return null;
  const m = u.pathname.match(/^\/in\/([^/]+)\/?$/);
  if (!m) return null;
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* keep raw */
  }
  if (slug.includes("/") || slug.includes("\\")) return null;
  const encoded = encodeURIComponent(slug).replace(/%20/g, "-");
  if (!SLUG_RE.test(encoded)) return null;
  return `https://www.linkedin.com/in/${encoded}`;
}

export function slugFromCanonical(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/in\/([^/?#]+)/);
  return m ? m[1] : null;
}

const URN_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** Extract member URN (ACwAAA...) from a Sales Navigator lead URL on a LinkedIn host. */
export function memberUrnFromSalesNavUrl(href: string | null | undefined): string | null {
  const u = parseLinkedInUrl(href);
  if (!u) return null;
  const m = u.pathname.match(/^\/sales\/(?:lead|people)\/([^/,]+)/);
  return m && URN_RE.test(m[1]) ? m[1] : null;
}

export function canonicalizeSalesNavUrl(href: string | null | undefined, base = "https://www.linkedin.com"): string | null {
  const u = parseLinkedInUrl(href, base);
  if (!u) return null;
  const m = u.pathname.match(/^\/sales\/(lead|people)\/([^/]+)\/?$/);
  if (!m) return null;
  const id = m[2].split(",")[0];
  return URN_RE.test(id) ? `https://www.linkedin.com/sales/lead/${id}` : null;
}

const COMPANY_ID_RE = /^(?:[\p{L}\p{N}_.-]|%[0-9A-Fa-f]{2}){1,120}$/u;

export function canonicalizeCompanyUrl(href: string | null | undefined, base = "https://www.linkedin.com"): string | null {
  const u = parseLinkedInUrl(href, base);
  if (!u) return null;
  const m = u.pathname.match(/^\/(company|school|sales\/company)\/([^/]+)\/?(?:[a-z-]+\/?)?$/);
  if (!m) return null;
  const kind = m[1] === "sales/company" ? "company" : m[1];
  const id = m[2].split(",")[0];
  return COMPANY_ID_RE.test(id) ? `https://www.linkedin.com/${kind}/${id}` : null;
}

export function parseConnectionDegree(text: string | null | undefined): "1st" | "2nd" | "3rd" | null {
  if (!text) return null;
  const m = text.match(/(?:^|[^\w])(1st|2nd|3rd)(?:\+|\b)/);
  return m ? (m[1] as "1st" | "2nd" | "3rd") : null;
}

/** Truncate long free text (about sections) to keep payloads small. Never splits a surrogate pair. */
export function truncate(text: string | null, max = 2000): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

/** Identity key for dedupe: canonical public URL, else Sales Nav URL, else
 *  name+company. The name fallback is explicitly weak (collisions possible)
 *  and receivers should treat `name:` keys as low confidence. */
export function dedupeKey(lead: { linkedin_url: string | null; sales_navigator_url: string | null; full_name: string; company_name: string | null }): string {
  if (lead.linkedin_url) return lead.linkedin_url.toLowerCase();
  if (lead.sales_navigator_url) return lead.sales_navigator_url.toLowerCase();
  return `name:${lead.full_name.toLowerCase().normalize("NFKC")}|${(lead.company_name ?? "").toLowerCase().normalize("NFKC")}`;
}
