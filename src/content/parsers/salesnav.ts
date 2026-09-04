import type { ExperienceEntry, LeadRecord } from "../../shared/types";
import { canonicalizeCompanyUrl, canonicalizeLinkedInUrl, canonicalizeSalesNavUrl, cleanName, cleanText, memberUrnFromSalesNavUrl, parseConnectionDegree, slugFromCanonical, splitName } from "../../shared/normalize";
import { attr, emptyLead, firstMatch, looksLikeLocation, setName, text, warn } from "./common";

export function isSalesNavSearchPath(pathname: string): boolean {
  return /^\/sales\/search\/people/.test(pathname);
}
export function isSalesNavListPath(pathname: string): boolean {
  return /^\/sales\/lists\/people\//.test(pathname);
}
export function isSalesNavLeadPath(pathname: string): boolean {
  return /^\/sales\/lead\//.test(pathname);
}

/** Row elements for Sales Navigator search results and lead lists. Rows that
 *  are still skeletons (no lead link) are excluded. */
export function salesNavRows(doc: Document): HTMLElement[] {
  const selectors = ['[data-lwe="salesnav-row"]', "#search-results-container li.artdeco-list__item", "ol.artdeco-list > li.artdeco-list__item", "div[data-x--people-list--row]", "table.lists-table tbody tr", 'tr[data-lwe="salesnav-row"]'];
  for (const s of selectors) {
    const rows = Array.from(doc.querySelectorAll<HTMLElement>(s)).filter((r) => r.querySelector('a[href*="/sales/lead/"], a[href*="/sales/people/"], a[data-anonymize="person-name"]'));
    if (rows.length) return rows;
  }
  return [];
}

export function parseSalesNavRow(row: HTMLElement, now: string): LeadRecord | null {
  const lead = emptyLead(now);
  const nameEl = firstMatch(row, ['[data-anonymize="person-name"]', '[data-lwe="name"]', 'a[href*="/sales/lead/"]', 'a[href*="/sales/people/"]']);
  setName(lead, text(nameEl));
  if (!lead.full_name) return null;
  Object.assign(lead, splitName(lead.full_name));

  const link = nameEl?.closest("a") ?? row.querySelector('a[href*="/sales/lead/"], a[href*="/sales/people/"]');
  const href = attr(link, "href") ?? attr(row.querySelector('a[href*="/sales/lead/"]'), "href");
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
  if (!lead.company_name) warn(lead, "company_missing");
  lead.location = cleanText(text(firstMatch(row, ['[data-anonymize="location"]', '[data-lwe="location"]', ".artdeco-entity-lockup__caption"])));
  if (!lead.location) warn(lead, "location_missing");
  lead.connection_degree = parseConnectionDegree(text(firstMatch(row, ['[data-lwe="degree-badge"]', ".artdeco-entity-lockup__degree", 'span[class*="degree"]'])));
  if (!lead.connection_degree) warn(lead, "degree_missing");
  lead.profile_image_url = attr(row.querySelector('img[data-anonymize="headshot-photo"], img'), "src");
  lead.headline = lead.title && lead.company_name ? `${lead.title} at ${lead.company_name}` : lead.title;
  return lead;
}

export function parseSalesNavPage(doc: Document, now = new Date().toISOString()): LeadRecord[] {
  return salesNavRows(doc)
    .map((r) => parseSalesNavRow(r, now))
    .filter((l): l is LeadRecord => l !== null);
}

/* ---------------- lead page ---------------- */

const DATE_LINE = /(\b(19|20)\d{2}\b|Present)/i;
const isDate = (t: string) => DATE_LINE.test(t) && t.length < 60;

/** Heading text whether or not it wraps its text in spans. */
function headingText(el: Element): string | null {
  return cleanText(el.textContent);
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
      if (!dates && t && isDate(t) && t.length < 40) dates = t;
      if (company && dates) break;
    }
    out.push({ title, company_name: cleanText(text(company)), company_linkedin_url: canonicalizeCompanyUrl(attr(company, "href")), date_range: dates, location: null });
  }
  return out;
}

/** Lead page "Experience" section. Two shapes, parsed by container rather
 *  than by leaf order so nested heading spans and multi-role employers work:
 *   flat:    <li> h2 title · p(company link) · span dates · p location
 *   grouped: <li> h2 company(link) · p total · [h3 role · span dates · p location]+
 */
export function salesNavExperienceSection(doc: Document): { entries: ExperienceEntry[]; uncertain: boolean } {
  // Note: Sales Navigator also renders a tab *button* whose id contains
  // "experience-section"; only the section/div containers hold entries.
  const section = doc.querySelector("#experience-section, section[id*='experience-section'], div[id*='experience-section']");
  if (!section) return { entries: [], uncertain: false };
  const out: ExperienceEntry[] = [];
  let uncertain = false;
  const linesOf = (root: Element, stopAt: Set<Element>) =>
    Array.from(root.querySelectorAll<HTMLElement>("*"))
      .filter((e) => e.children.length === 0 && (e.textContent ?? "").trim() && !/show more|see more|see less/i.test(e.textContent ?? "") && !Array.from(stopAt).some((s) => s !== root && s.contains(e)))
      .map((e) => ({ t: (e.textContent ?? "").replace(/\s+/g, " ").trim(), a: e.closest("a") }));
  for (const li of Array.from(section.querySelectorAll<HTMLElement>('li[class*="experience-entry"], li[data-lwe="experience-item"]')).slice(0, 10)) {
    const h2 = li.querySelector("h2");
    const roles = Array.from(li.querySelectorAll<HTMLElement>("h3"));
    const companyLink = (el: Element | null) => el?.closest("a") ?? el?.querySelector("a") ?? null;
    if (roles.length) {
      const companyName = h2 ? headingText(h2) : null;
      const companyUrl = canonicalizeCompanyUrl(attr(companyLink(h2), "href"));
      if (!companyName) uncertain = true;
      for (let i = 0; i < roles.length; i++) {
        const role = roles[i];
        const title = headingText(role);
        if (!title) continue;
        // Everything between this h3 and the next h3 belongs to this role.
        const scope = new Set<Element>(roles.slice(i + 1));
        const container = role.parentElement ?? li;
        const following: string[] = [];
        let el: Element | null = role;
        while ((el = nextInOrder(el, li))) {
          if (scope.has(el)) break;
          if (el.children.length === 0) {
            const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (t) following.push(t);
          }
        }
        void container;
        out.push({ title, company_name: companyName, company_linkedin_url: companyUrl, date_range: following.find(isDate) ?? null, location: following.find(looksLikeLocation) ?? null });
      }
      continue;
    }
    const lines = linesOf(li, new Set());
    if (!lines.length) continue;
    const title = h2 ? headingText(h2) : lines[0]?.t;
    if (!title) continue;
    const companyLine = lines.find((l) => l.t !== title && l.a && /company/.test(l.a.getAttribute("href") ?? "")) ?? lines.find((l) => l.t !== title && !isDate(l.t) && !looksLikeLocation(l.t));
    if (!companyLine) uncertain = true;
    out.push({ title, company_name: companyLine?.t ?? null, company_linkedin_url: canonicalizeCompanyUrl(companyLine?.a?.getAttribute("href") ?? null), date_range: lines.find((l) => isDate(l.t))?.t ?? null, location: lines.find((l) => looksLikeLocation(l.t) && l.t !== companyLine?.t)?.t ?? null });
  }
  return { entries: out, uncertain };
}

/** Depth-first successor within `root`. */
function nextInOrder(el: Element, root: Element): Element | null {
  if (el.firstElementChild) return el.firstElementChild;
  let cur: Element | null = el;
  while (cur && cur !== root) {
    if (cur.nextElementSibling) return cur.nextElementSibling;
    cur = cur.parentElement;
  }
  return null;
}

/** Single Sales Navigator lead detail page. */
export function parseSalesNavLead(doc: Document, pageUrl: string, now = new Date().toISOString()): LeadRecord {
  const lead = emptyLead(now);
  const nameEl = firstMatch(doc, ['h1[data-anonymize="person-name"]', '[data-lwe="name"]', "main h1", "h1"]);
  setName(lead, text(nameEl));
  if (!lead.full_name) {
    lead.full_name = cleanName((doc.title || "").replace(/\s*\|\s*Sales Navigator\s*$/, "")) ?? "";
    if (lead.full_name) warn(lead, "name_from_title");
  }
  Object.assign(lead, splitName(lead.full_name));
  lead.headline = cleanText(text(firstMatch(doc, ['[data-anonymize="headline"]', '[data-lwe="headline"]'])));
  const section = salesNavExperienceSection(doc);
  if (section.uncertain) warn(lead, "experience_grouping_uncertain");
  const roles = section.entries.length ? section.entries : salesNavCurrentRoles(doc);
  lead.title = roles[0]?.title ?? cleanText(text(firstMatch(doc, ['[data-anonymize="job-title"]', '[data-lwe="title"]']))) ?? lead.headline;
  const companyEl = firstMatch(doc, ['a[data-anonymize="company-name"]', '[data-anonymize="company-name"]', '[data-lwe="company"]']);
  lead.company_name = roles[0]?.company_name ?? cleanText(text(companyEl));
  lead.company_linkedin_url = roles[0]?.company_linkedin_url ?? canonicalizeCompanyUrl(attr(companyEl, "href"));
  if (!lead.company_name) warn(lead, "company_missing");
  lead.experience = roles;
  // Location: explicit attribute, else the top card line under the name, else
  // the current role's location (flagged as a guess).
  const explicitLoc = cleanText(text(firstMatch(doc, ['[data-anonymize="location"]', '[data-lwe="location"]'])));
  const topScope = nameEl?.closest("section") ?? nameEl?.parentElement?.parentElement ?? null;
  const topLoc = topScope ? Array.from(topScope.querySelectorAll<HTMLElement>("p, span, div")).find((e) => e.children.length === 0 && looksLikeLocation((e.textContent ?? "").trim())) : null;
  if (explicitLoc) lead.location = explicitLoc;
  else if (topLoc) lead.location = cleanText(topLoc.textContent);
  else if (roles.find((r) => r.location)) {
    lead.location = roles.find((r) => r.location)!.location;
    warn(lead, "location_guessed");
  } else warn(lead, "location_missing");
  const degreeEl = nameEl ? Array.from(nameEl.parentElement?.parentElement?.querySelectorAll<HTMLElement>("span") ?? []).find((s) => /^[·•]?\s*(1st|2nd|3rd)\b/.test((s.textContent ?? "").trim())) : null;
  lead.connection_degree = parseConnectionDegree(text(degreeEl ?? firstMatch(doc, ['span[class*="degree"]', '[data-lwe="degree-badge"]'])));
  if (!lead.connection_degree) warn(lead, "degree_missing");
  // The page's own URL was already checked by the worker (LinkedIn host, or
  // loopback in the test build), so derive the identity from its path.
  const ownPath = (() => {
    try {
      return new URL(pageUrl).pathname;
    } catch {
      return pageUrl;
    }
  })();
  lead.sales_navigator_url = canonicalizeSalesNavUrl(ownPath);
  lead.linkedin_member_urn = memberUrnFromSalesNavUrl(ownPath);
  const publicLink = firstMatch(doc, ['a[href*="linkedin.com/in/"]', 'a[href^="/in/"]', '[data-lwe="public-profile"]']);
  lead.linkedin_url = canonicalizeLinkedInUrl(attr(publicLink, "href"));
  lead.linkedin_slug = slugFromCanonical(lead.linkedin_url);
  lead.profile_image_url = attr(doc.querySelector('img[data-anonymize="headshot-photo"]'), "src");
  return lead;
}
