import type { ExperienceEntry, LeadRecord } from "../../shared/types";
import {
  canonicalizeCompanyUrl,
  canonicalizeLinkedInUrl,
  canonicalizeSalesNavUrl,
  cleanName,
  cleanText,
  memberUrnFromSalesNavUrl,
  parseConnectionDegree,
  slugFromCanonical,
  splitName
} from "../../shared/normalize";
import { attr, emptyLead, firstMatch, text } from "./common";

export function isSalesNavSearchPath(pathname: string): boolean {
  return /^\/sales\/search\/people/.test(pathname);
}
export function isSalesNavListPath(pathname: string): boolean {
  return /^\/sales\/lists\/people\//.test(pathname);
}
export function isSalesNavLeadPath(pathname: string): boolean {
  return /^\/sales\/lead\//.test(pathname);
}

/** Row elements for Sales Navigator search results and lead lists. */
export function salesNavRows(doc: Document): HTMLElement[] {
  const selectors = [
    '[data-lwe="salesnav-row"]',
    "#search-results-container li.artdeco-list__item",
    "ol.artdeco-list > li.artdeco-list__item",
    'div[data-x--people-list--row]',
    "table.lists-table tbody tr",
    'tr[data-lwe="salesnav-row"]'
  ];
  for (const s of selectors) {
    const rows = Array.from(doc.querySelectorAll<HTMLElement>(s)).filter((r) => r.querySelector('a[href*="/sales/lead/"], a[href*="/sales/people/"], a[data-anonymize="person-name"]'));
    if (rows.length) return rows;
  }
  return [];
}

export function parseSalesNavRow(row: HTMLElement, now: string): LeadRecord | null {
  const lead = emptyLead(now);
  const nameLink = firstMatch(row, ['a[data-anonymize="person-name"]', 'a[href*="/sales/lead/"]', 'a[href*="/sales/people/"]', '[data-lwe="name"]']) as HTMLAnchorElement | null;
  lead.full_name = cleanName(text(nameLink)) ?? "";
  if (!lead.full_name) return null;
  Object.assign(lead, splitName(lead.full_name));

  const href = attr(nameLink, "href") ?? attr(row.querySelector('a[href*="/sales/lead/"]'), "href");
  lead.sales_navigator_url = canonicalizeSalesNavUrl(href);
  lead.linkedin_member_urn = memberUrnFromSalesNavUrl(href);
  // Some list views expose the public profile link via an "in/" anchor.
  const publicLink = row.querySelector<HTMLAnchorElement>('a[href*="linkedin.com/in/"], a[href^="/in/"]');
  lead.linkedin_url = canonicalizeLinkedInUrl(attr(publicLink, "href"));
  lead.linkedin_slug = slugFromCanonical(lead.linkedin_url);

  lead.title = cleanText(text(firstMatch(row, ['[data-anonymize="title"]', '[data-lwe="title"]', ".artdeco-entity-lockup__subtitle"])));
  const companyEl = firstMatch(row, ['a[data-anonymize="company-name"]', '[data-anonymize="company-name"]', '[data-lwe="company"]']);
  lead.company_name = cleanText(text(companyEl));
  lead.company_linkedin_url = canonicalizeCompanyUrl(attr(companyEl, "href"));
  lead.location = cleanText(text(firstMatch(row, ['[data-anonymize="location"]', '[data-lwe="location"]', ".artdeco-entity-lockup__caption"])));
  lead.connection_degree = parseConnectionDegree(text(firstMatch(row, ['[data-lwe="degree-badge"]', ".artdeco-entity-lockup__degree", 'span[class*="degree"]'])));
  lead.profile_image_url = attr(row.querySelector('img[data-anonymize="headshot-photo"], img'), "src");
  lead.headline = lead.title && lead.company_name ? `${lead.title} at ${lead.company_name}` : lead.title;
  return lead;
}

export function parseSalesNavPage(doc: Document, now = new Date().toISOString()): LeadRecord[] {
  return salesNavRows(doc)
    .map((r) => parseSalesNavRow(r, now))
    .filter((l): l is LeadRecord => l !== null);
}

const LOCATION_LIKE = /^[^\d]{2,60}$/;
function looksLikeLocation(t: string): boolean {
  return LOCATION_LIKE.test(t) && (/,\s/.test(t) || /\b(Area|Region|Metropolitan)\b/.test(t)) && !/\b(at|CEO|Chief|Officer|Founder|Director|Manager|Head|VP|President|Partner)\b/i.test(t);
}

/** "Current roles" on a lead page: job-title / company / date triplets. */
function salesNavCurrentRoles(doc: Document): ExperienceEntry[] {
  const out: ExperienceEntry[] = [];
  for (const titleEl of Array.from(doc.querySelectorAll<HTMLElement>('[data-anonymize="job-title"]')).slice(0, 6)) {
    const title = cleanText(text(titleEl));
    if (!title) continue;
    let company: Element | null = null;
    let dates: string | null = null;
    let el: Element | null = titleEl;
    for (let k = 0; k < 6 && el; k++) {
      el = el.nextElementSibling ?? (el.parentElement && el.parentElement !== doc.body ? el.parentElement.nextElementSibling : null);
      if (!el) break;
      company ??= el.matches('[data-anonymize="company-name"]') ? el : el.querySelector('[data-anonymize="company-name"]');
      const t = cleanText(el.textContent);
      if (!dates && t && /\b(19|20)\d{2}\b|Present/.test(t) && t.length < 40) dates = t;
      if (company && dates) break;
    }
    out.push({ title, company_name: cleanText(text(company)), company_linkedin_url: canonicalizeCompanyUrl(attr(company, "href")), date_range: dates, location: null });
  }
  return out;
}

/** Lead page "Experience" section. Two shapes:
 *   flat:    <li> h2 title · p(company link) · span dates · p location
 *   grouped: <li> h2 company(link) · p total · [h3 role · span dates · p location]+
 */
function salesNavExperienceSection(doc: Document): ExperienceEntry[] {
  // Note: Sales Navigator also renders a tab *button* whose id contains
  // "experience-section"; only the section/div containers hold entries.
  const section = doc.querySelector("#experience-section, section[id*='experience-section'], div[id*='experience-section']");
  if (!section) return [];
  const out: ExperienceEntry[] = [];
  const isDate = (t: string) => /\b(19|20)\d{2}\b|Present/.test(t) && t.length < 60;
  for (const li of Array.from(section.querySelectorAll<HTMLElement>('li[class*="experience-entry"]')).slice(0, 10)) {
    const lines = Array.from(li.querySelectorAll<HTMLElement>("*"))
      .filter((e) => e.children.length === 0 && (e.textContent ?? "").trim() && !/show more|see more/i.test(e.textContent ?? ""))
      .map((e) => ({ tag: e.tagName.toLowerCase(), t: (e.textContent ?? "").replace(/\s+/g, " ").trim(), a: e.closest("a") }));
    if (!lines.length) continue;
    const h2 = lines.find((l) => l.tag === "h2");
    const roles = lines.filter((l) => l.tag === "h3");
    const companyOf = (l?: { t: string; a: HTMLAnchorElement | null }) => ({ name: l?.t ?? null, url: canonicalizeCompanyUrl(l?.a?.getAttribute("href") ?? null) });
    if (roles.length) {
      const company = companyOf(h2);
      for (const role of roles) {
        const i = lines.indexOf(role);
        const after = lines.slice(i + 1, lines.findIndex((l, k) => k > i && l.tag === "h3") === -1 ? undefined : lines.findIndex((l, k) => k > i && l.tag === "h3"));
        out.push({ title: role.t, company_name: company.name, company_linkedin_url: company.url, date_range: after.find((l) => isDate(l.t))?.t ?? null, location: after.find((l) => looksLikeLocation(l.t))?.t ?? null });
      }
      continue;
    }
    const title = h2?.t ?? lines[0].t;
    const companyLine = lines.find((l) => l !== h2 && l.a && /company/.test(l.a.getAttribute("href") ?? "")) ?? lines.find((l) => l !== h2 && !isDate(l.t) && !looksLikeLocation(l.t));
    out.push({ title, company_name: companyLine?.t ?? null, company_linkedin_url: canonicalizeCompanyUrl(companyLine?.a?.getAttribute("href") ?? null), date_range: lines.find((l) => isDate(l.t))?.t ?? null, location: lines.find((l) => looksLikeLocation(l.t) && l.t !== companyLine?.t)?.t ?? null });
  }
  return out;
}

/** Single Sales Navigator lead detail page. */
export function parseSalesNavLead(doc: Document, pageUrl: string, now = new Date().toISOString()): LeadRecord {
  const lead = emptyLead(now);
  const nameEl = firstMatch(doc, ['h1[data-anonymize="person-name"]', '[data-lwe="name"]', "main h1", "h1"]);
  lead.full_name = cleanName(text(nameEl)) ?? "";
  Object.assign(lead, splitName(lead.full_name));
  lead.headline = cleanText(text(firstMatch(doc, ['[data-anonymize="headline"]', '[data-lwe="headline"]'])));
  const fromSection = salesNavExperienceSection(doc);
  const roles = fromSection.length ? fromSection : salesNavCurrentRoles(doc);
  lead.title = roles[0]?.title ?? cleanText(text(firstMatch(doc, ['[data-anonymize="job-title"]', '[data-lwe="title"]']))) ?? lead.headline;
  const companyEl = firstMatch(doc, ['a[data-anonymize="company-name"]', '[data-anonymize="company-name"]', '[data-lwe="company"]']);
  lead.company_name = roles[0]?.company_name ?? cleanText(text(companyEl));
  lead.company_linkedin_url = roles[0]?.company_linkedin_url ?? canonicalizeCompanyUrl(attr(companyEl, "href"));
  lead.experience = roles;
  // Location has no data-anonymize on lead pages; take the first location-looking
  // leaf paragraph near the top card.
  const explicitLoc = cleanText(text(firstMatch(doc, ['[data-anonymize="location"]', '[data-lwe="location"]'])));
  if (explicitLoc) lead.location = explicitLoc;
  else if (roles.find((r) => r.location)) lead.location = roles.find((r) => r.location)!.location;
  else {
    const scope = nameEl?.closest("section")?.parentElement ?? doc.querySelector("main") ?? doc.body;
    const p = Array.from(scope.querySelectorAll<HTMLElement>("p, span")).find((e) => e.children.length === 0 && looksLikeLocation((e.textContent ?? "").trim()));
    lead.location = cleanText(p?.textContent) ?? null;
  }
  const degreeEl = nameEl ? Array.from(nameEl.parentElement?.parentElement?.querySelectorAll<HTMLElement>("span") ?? []).find((s) => /^[·•]?\s*(1st|2nd|3rd)\b/.test((s.textContent ?? "").trim())) : null;
  lead.connection_degree = parseConnectionDegree(text(degreeEl ?? firstMatch(doc, ['span[class*="degree"]', '[data-lwe="degree-badge"]'])));
  lead.sales_navigator_url = canonicalizeSalesNavUrl(pageUrl);
  lead.linkedin_member_urn = memberUrnFromSalesNavUrl(pageUrl);
  const publicLink = firstMatch(doc, ['a[href*="linkedin.com/in/"]', 'a[href^="/in/"]', '[data-lwe="public-profile"]']);
  lead.linkedin_url = canonicalizeLinkedInUrl(attr(publicLink, "href"));
  lead.linkedin_slug = slugFromCanonical(lead.linkedin_url);
  lead.profile_image_url = attr(doc.querySelector('img[data-anonymize="headshot-photo"]'), "src");
  return lead;
}
