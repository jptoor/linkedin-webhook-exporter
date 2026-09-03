import type { LeadRecord } from "../../shared/types";
import { canonicalizeLinkedInUrl, cleanName, cleanText, parseConnectionDegree, slugFromCanonical, splitName } from "../../shared/normalize";
import { attr, emptyLead, firstMatch, splitHeadline, text } from "./common";

export function isPeopleSearchPath(pathname: string): boolean {
  return /^\/search\/results\/(people|all)\/?/.test(pathname);
}

/** Result cards on linkedin.com/search/results/people. */
export function peopleSearchRows(doc: Document): HTMLElement[] {
  const selectors = [
    '[data-lwe="search-row"]',
    'li.reusable-search__result-container',
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

/** Text nodes in document order, whitespace-normalized, consecutive duplicates removed.
 *  The 2026 layout wraps the whole result card in the profile link, so
 *  element-level selectors cannot isolate the name; text order can. */
function textLines(root: Element): string[] {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const out: string[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = (n.nodeValue ?? "").replace(/\s+/g, " ").trim();
    if (t && out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

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
    // SDUI card: [name, (name), "• 2nd", headline, location, mutual-connection chatter…]
    const lines = textLines(row).filter((t) => !/^(Message|Connect|Follow|Pending)$/i.test(t) && !/^[,&]$/.test(t));
    lead.full_name = cleanName(lines[0] ?? null) ?? "";
    const rest = lines.slice(1).filter((t) => t !== lines[0]);
    const degreeIdx = rest.findIndex((t) => /^[•·]?\s*(1st|2nd|3rd)\b/.test(t));
    lead.connection_degree = degreeIdx >= 0 ? parseConnectionDegree(rest[degreeIdx]) : null;
    const after = degreeIdx >= 0 ? rest.slice(degreeIdx + 1) : rest;
    const stop = after.findIndex((t) => /mutual connection|followers$/i.test(t));
    const body = stop >= 0 ? after.slice(0, stop) : after;
    lead.headline = body[0] ?? null;
    lead.location = body[1] ?? null;
  }
  if (!lead.full_name || lead.full_name.toLowerCase() === "linkedin member") return null;
  Object.assign(lead, splitName(lead.full_name));
  const fromHeadline = splitHeadline(lead.headline);
  lead.title = fromHeadline.title;
  lead.company_name = fromHeadline.company;
  lead.profile_image_url = attr(row.querySelector("img"), "src");
  return lead;
}

export function parsePeopleSearchPage(doc: Document, now = new Date().toISOString()): LeadRecord[] {
  return peopleSearchRows(doc)
    .map((r) => parsePeopleSearchRow(r, now))
    .filter((l): l is LeadRecord => l !== null);
}
