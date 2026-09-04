import type { LeadRecord } from "../../shared/types";
import { canonicalizeLinkedInUrl, cleanName, cleanText, parseConnectionDegree, slugFromCanonical, splitName } from "../../shared/normalize";
import { attr, CHATTER_RE, emptyLead, firstMatch, looksLikeLocation, splitHeadline, text, textLines, warn } from "./common";

export function isPeopleSearchPath(pathname: string): boolean {
  return /^\/search\/results\/(people|all)\/?/.test(pathname);
}

/** Result cards on linkedin.com/search/results/people. */
export function peopleSearchRows(doc: Document): HTMLElement[] {
  const selectors = [
    '[data-lwe="search-row"]',
    "li.reusable-search__result-container",
    'div[data-view-name="search-entity-result-universal-template"]',
    'ul[role="list"] > li',
    // 2026 SDUI layout: hashed classes, ARIA list semantics only.
    'main [role="list"] [role="listitem"]'
  ];
  for (const s of selectors) {
    const rows = Array.from(doc.querySelectorAll<HTMLElement>(s)).filter((r) => r.querySelector('a[href*="/in/"]'));
    if (rows.length) return rows;
  }
  return [];
}

const DEGREE_LINE = /^[•·]?\s*(1st|2nd|3rd)\b/;

export function parsePeopleSearchRow(row: HTMLElement, now: string): LeadRecord | null {
  const lead = emptyLead(now);
  const link = row.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
  lead.linkedin_url = canonicalizeLinkedInUrl(attr(link, "href"));
  lead.linkedin_slug = slugFromCanonical(lead.linkedin_url);
  const classic = firstMatch(row, ['[data-lwe="name"]', 'span.entity-result__title-text a span[aria-hidden="true"]']);
  if (classic) {
    lead.full_name = cleanName(text(classic)) ?? "";
    lead.headline = cleanText(text(firstMatch(row, ['[data-lwe="headline"]', ".entity-result__primary-subtitle", 'div[class*="primary-subtitle"]'])));
    lead.location = cleanText(text(firstMatch(row, ['[data-lwe="location"]', ".entity-result__secondary-subtitle", 'div[class*="secondary-subtitle"]'])));
    lead.connection_degree = parseConnectionDegree(text(firstMatch(row, ['[data-lwe="degree-badge"]', ".entity-result__badge-text", 'span[class*="badge"]'])));
  } else {
    // SDUI card: the whole card is the profile link, so use text order.
    // [name, (name), "• 2nd", headline, location, chatter…]. Chatter lines
    // (Open to work, pronouns, followers, mutual connections, buttons) are
    // filtered rather than assumed absent; location is recognized by shape.
    warn(lead, "sdui_layout");
    const raw = textLines(row);
    // Some cards render the name twice in one text node ("Jane Doe Jane Doe").
    const doubled = (raw[0] ?? "").match(/^(.+?)\s+\1$/u);
    const name = cleanName(doubled ? doubled[1] : raw[0] ?? null) ?? "";
    lead.full_name = name;
    const rest = raw.slice(1).filter((t) => t !== raw[0] && !t.startsWith(raw[0] + " ") && !/^[,&]$/.test(t) && !CHATTER_RE.test(t));
    const degreeIdx = rest.findIndex((t) => DEGREE_LINE.test(t));
    lead.connection_degree = degreeIdx >= 0 ? parseConnectionDegree(rest[degreeIdx]) : null;
    const body = (degreeIdx >= 0 ? rest.slice(degreeIdx + 1) : rest).filter((t) => !DEGREE_LINE.test(t));
    const locIdx = body.findIndex(looksLikeLocation);
    lead.location = locIdx >= 0 ? body[locIdx] : null;
    lead.headline = body.find((t, i) => i !== locIdx) ?? null;
    if (!lead.location) warn(lead, "location_missing");
  }
  if (!lead.full_name || /^linkedin member$/i.test(lead.full_name) || /^membre linkedin$/i.test(lead.full_name) || /^linkedin-mitglied$/i.test(lead.full_name)) return null;
  Object.assign(lead, splitName(lead.full_name));
  if (!lead.connection_degree) warn(lead, "degree_missing");
  const fromHeadline = splitHeadline(lead.headline);
  lead.title = fromHeadline.title;
  lead.company_name = fromHeadline.company;
  if (lead.headline && !lead.title) warn(lead, "headline_unsplit");
  if (!lead.company_name) warn(lead, "company_missing");
  lead.profile_image_url = attr(row.querySelector("img"), "src");
  return lead;
}

export function parsePeopleSearchPage(doc: Document, now = new Date().toISOString()): LeadRecord[] {
  return peopleSearchRows(doc)
    .map((r) => parsePeopleSearchRow(r, now))
    .filter((l): l is LeadRecord => l !== null);
}
