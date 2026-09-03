import type { EducationEntry, ExperienceEntry, LeadRecord } from "../../shared/types";
import {
  canonicalizeCompanyUrl,
  canonicalizeLinkedInUrl,
  cleanName,
  cleanText,
  parseConnectionDegree,
  slugFromCanonical,
  splitName,
  truncate
} from "../../shared/normalize";
import { attr, emptyLead, firstMatch, splitHeadline, text } from "./common";

export function isProfilePath(pathname: string): boolean {
  return /^\/in\/[^/]+\/?$/.test(pathname);
}

/** Section container lookup: LinkedIn renders `<div id="experience">` as an anchor
 *  whose parent <section> holds the list. */
function sectionByAnchor(doc: Document, id: string): Element | null {
  const anchor = doc.getElementById(id);
  return anchor?.closest("section") ?? null;
}

function parseExperience(doc: Document): ExperienceEntry[] {
  const section = sectionByAnchor(doc, "experience");
  if (!section) return [];
  const items = Array.from(section.querySelectorAll<HTMLElement>('li[data-lwe="experience-item"], li.artdeco-list__item, li.pvs-list__paged-list-item'));
  const out: ExperienceEntry[] = [];
  for (const li of items.slice(0, 10)) {
    const titleEl = firstMatch(li, ['[data-lwe="title"]', ".t-bold", ".mr1.t-bold", "div.display-flex.align-items-center span[aria-hidden=true]"]);
    const companyEl = firstMatch(li, ['[data-lwe="company"]', ".t-14.t-normal:not(.t-black--light)", "span.t-14.t-normal"]);
    const dateEl = firstMatch(li, ['[data-lwe="dates"]', ".pvs-entity__caption-wrapper", ".t-14.t-normal.t-black--light"]);
    const locEl = firstMatch(li, ['[data-lwe="location"]']);
    const companyLink = li.querySelector<HTMLAnchorElement>('a[href*="/company/"]');
    const title = cleanText(text(titleEl));
    if (!title) continue;
    let company = cleanText(text(companyEl));
    // Company cell often reads "Acme · Full-time"
    if (company) company = company.split(/\s[·•]\s/)[0].trim();
    out.push({
      title,
      company_name: company,
      company_linkedin_url: canonicalizeCompanyUrl(attr(companyLink, "href")),
      date_range: cleanText(text(dateEl)),
      location: cleanText(text(locEl))
    });
  }
  return out;
}

function parseEducation(doc: Document): EducationEntry[] {
  const section = sectionByAnchor(doc, "education");
  if (!section) return [];
  const items = Array.from(section.querySelectorAll<HTMLElement>('li[data-lwe="education-item"], li.artdeco-list__item, li.pvs-list__paged-list-item'));
  const out: EducationEntry[] = [];
  for (const li of items.slice(0, 5)) {
    const school = cleanText(text(firstMatch(li, ['[data-lwe="school"]', ".t-bold", ".mr1.t-bold"])));
    if (!school) continue;
    out.push({
      school,
      degree: cleanText(text(firstMatch(li, ['[data-lwe="degree"]', ".t-14.t-normal:not(.t-black--light)"]))),
      date_range: cleanText(text(firstMatch(li, ['[data-lwe="dates"]', ".pvs-entity__caption-wrapper", ".t-14.t-normal.t-black--light"])))
    });
  }
  return out;
}

/* ---------------- LinkedIn 2026 "SDUI" profile layout ----------------
 * Hashed class names, no <h1>, no section ids. Stable anchors are:
 *  - the top card: [id^="com.linkedin.sdui.profile.card."][id$="Topcard"]
 *  - <h2> section titles ("Experience", "Education", "About")
 *  - every Experience/Education line is a <p> inside an <a href="/company/…">
 *    or <a href="/school/…">, so entries group by their enclosing link.
 */

const DATE_RANGE = /(\b(19|20)\d{2}\b|\bPresent\b)/;

function leaves(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).filter((e) => e.children.length === 0 && (e.textContent ?? "").trim().length > 0);
}

function sduiTopCard(doc: Document): Element | null {
  return Array.from(doc.querySelectorAll('[id^="com.linkedin.sdui.profile.card."]')).find((e) => /Topcard$/i.test(e.id)) ?? null;
}

function isSdui(doc: Document): boolean {
  return !doc.querySelector("main h1") && !!sduiTopCard(doc);
}

function sduiSectionByHeading(doc: Document, label: string): Element | null {
  const h = Array.from(doc.querySelectorAll("main h2, main h3")).find((x) => (x.textContent ?? "").trim() === label);
  if (!h) return null;
  let c: Element | null = h;
  for (let k = 0; k < 10 && c?.parentElement; k++) {
    c = c.parentElement;
    if (c.id && c.id.startsWith("com.linkedin.sdui.profile.card")) break;
  }
  return c;
}

/** Group <p> leaves by the enclosing company/school link; each group is one entry. */
function sduiEntries(section: Element): Array<{ href: string | null; lines: string[] }> {
  const out: Array<{ href: string | null; lines: string[] }> = [];
  let current: { href: string | null; lines: string[]; key: string } | null = null;
  for (const el of leaves(section)) {
    if (/^h[1-6]$/i.test(el.tagName)) continue;
    const a = el.closest("a");
    const href = a?.getAttribute("href") ?? null;
    const key = a ? (a as HTMLAnchorElement).href || href || "" : `noanchor:${out.length}`;
    const t = cleanText(el.textContent) ?? "";
    if (!t) continue;
    if (!current || current.key !== key) {
      current = { href, lines: [], key };
      out.push(current);
    }
    current.lines.push(t);
  }
  return out;
}

function sduiExperience(doc: Document): ExperienceEntry[] {
  const section = sduiSectionByHeading(doc, "Experience");
  if (!section) return [];
  const entries: ExperienceEntry[] = [];
  for (const g of sduiEntries(section).slice(0, 12)) {
    const dateIdx = g.lines.findIndex((l) => DATE_RANGE.test(l) && /[-–—]|Present|yrs?|mos?/.test(l));
    if (dateIdx < 1) continue;
    const title = g.lines[0];
    const company = dateIdx >= 2 ? g.lines[1] : null;
    const location = g.lines[dateIdx + 1] && !DATE_RANGE.test(g.lines[dateIdx + 1]) ? g.lines[dateIdx + 1] : null;
    entries.push({ title, company_name: company, company_linkedin_url: canonicalizeCompanyUrl(g.href), date_range: g.lines[dateIdx], location });
  }
  return entries;
}

function sduiEducation(doc: Document): EducationEntry[] {
  const section = sduiSectionByHeading(doc, "Education");
  if (!section) return [];
  const out: EducationEntry[] = [];
  for (const g of sduiEntries(section).slice(0, 6)) {
    if (!g.lines.length) continue;
    const dateIdx = g.lines.findIndex((l) => DATE_RANGE.test(l));
    out.push({ school: g.lines[0], degree: dateIdx > 1 ? g.lines.slice(1, dateIdx).join(", ") : dateIdx === -1 && g.lines[1] ? g.lines[1] : null, date_range: dateIdx >= 0 ? g.lines[dateIdx] : null });
  }
  return out;
}

function parseProfileSdui(doc: Document, pageUrl: string, opts: ProfileParseOptions, now: string): LeadRecord {
  const lead = emptyLead(now);
  const top = sduiTopCard(doc)!;
  const ls = leaves(top);
  const nameEl = ls.find((e) => /^h[1-3]$/i.test(e.tagName)) ?? null;
  lead.full_name = cleanName(nameEl?.textContent) ?? cleanName((doc.title || "").replace(/\s*\|\s*LinkedIn\s*$/, "")) ?? "";
  Object.assign(lead, splitName(lead.full_name));

  // Ordered <p> lines after the name: degree badges, headline, current company, location, "·".
  const nameIdx = nameEl ? ls.indexOf(nameEl) : -1;
  const contactIdx = ls.findIndex((e) => /contact info/i.test(e.textContent ?? ""));
  const between = ls.slice(nameIdx + 1, contactIdx > nameIdx ? contactIdx : undefined).filter((e) => e.tagName.toLowerCase() === "p").map((e) => cleanText(e.textContent) ?? "").filter((t) => t && t !== "·");
  const degrees = between.filter((t) => /^[·•]?\s*(1st|2nd|3rd)/.test(t));
  lead.connection_degree = parseConnectionDegree(degrees[0] ?? null);
  const rest = between.filter((t) => !/^[·•]?\s*(1st|2nd|3rd)/.test(t));
  lead.headline = rest[0] ?? null;
  lead.location = rest.length >= 2 ? rest[rest.length - 1] : null;
  const companyLine = rest.length >= 3 ? rest[1] : null;

  lead.linkedin_url = canonicalizeLinkedInUrl(pageUrl) ?? canonicalizeLinkedInUrl(attr(doc.querySelector('link[rel="canonical"]'), "href"));
  lead.linkedin_slug = slugFromCanonical(lead.linkedin_url);
  const imgs = Array.from(top.querySelectorAll<HTMLImageElement>("img")).filter((i) => !/cover/i.test(i.alt ?? ""));
  const img = imgs.find((i) => lead.full_name && (i.alt ?? "").includes(lead.full_name)) ?? imgs.find((i) => /profile|photo/i.test(i.alt ?? "")) ?? null;
  lead.profile_image_url = attr(img, "src");

  const experience = sduiExperience(doc);
  const current = experience[0];
  const fromHeadline = splitHeadline(lead.headline);
  lead.title = current?.title ?? fromHeadline.title;
  lead.company_name = companyLine ?? current?.company_name ?? fromHeadline.company;
  lead.company_linkedin_url = current?.company_linkedin_url ?? null;
  lead.experience = opts.includeExperience === false ? [] : experience;
  lead.education = opts.includeEducation === false ? [] : sduiEducation(doc);
  if (opts.includeAbout !== false) {
    const about = sduiSectionByHeading(doc, "About");
    lead.about = about ? truncate(cleanText(leaves(about).filter((e) => !/^h[1-6]$/i.test(e.tagName)).map((e) => e.textContent).join(" "))) : null;
  }
  return lead;
}

export interface ProfileParseOptions {
  includeExperience?: boolean;
  includeEducation?: boolean;
  includeAbout?: boolean;
  now?: string;
}

export function parseProfile(doc: Document, pageUrl: string, opts: ProfileParseOptions = {}): LeadRecord {
  const now = opts.now ?? new Date().toISOString();
  if (isSdui(doc)) return parseProfileSdui(doc, pageUrl, opts, now);
  const lead = emptyLead(now);

  const nameEl = firstMatch(doc, ['h1[data-lwe="name"]', "main h1", "h1.text-heading-xlarge", "h1"]);
  lead.full_name = cleanName(text(nameEl)) ?? cleanName(attr(doc.querySelector('meta[property="og:title"]'), "content")?.split(" - ")[0] ?? null) ?? "";
  Object.assign(lead, splitName(lead.full_name));

  lead.headline = cleanText(text(firstMatch(doc, ['[data-lwe="headline"]', "main .text-body-medium.break-words", ".pv-text-details__left-panel .text-body-medium"])));
  lead.location = cleanText(text(firstMatch(doc, ['[data-lwe="location"]', "main .text-body-small.inline.t-black--light.break-words", ".pv-text-details__left-panel .text-body-small"])));

  const degreeEl = firstMatch(doc, ['[data-lwe="degree-badge"]', ".dist-value", "span.distance-badge"]);
  lead.connection_degree = parseConnectionDegree(text(degreeEl));

  // Canonical URL: prefer the page's own URL, else <link rel=canonical>.
  lead.linkedin_url = canonicalizeLinkedInUrl(pageUrl) ?? canonicalizeLinkedInUrl(attr(doc.querySelector('link[rel="canonical"]'), "href"));
  lead.linkedin_slug = slugFromCanonical(lead.linkedin_url);

  const img = firstMatch(doc, ['img[data-lwe="photo"]', "main img.pv-top-card-profile-picture__image--show", "main img.pv-top-card-profile-picture__image", 'main img[alt$="profile photo"]', "main .pv-top-card img"]);
  lead.profile_image_url = attr(img, "src");

  // Current company: top-card "Current company" button, else first experience entry.
  const currentCompanyBtn = firstMatch(doc, ['[data-lwe="current-company"]', 'button[aria-label^="Current company"]', 'main a[href*="/company/"][data-field="experience_company_logo"]']);
  const experience = opts.includeExperience === false ? [] : parseExperience(doc);
  const fullExperience = experience.length ? experience : parseExperience(doc);
  const current = fullExperience[0];
  const fromHeadline = splitHeadline(lead.headline);
  lead.company_name = cleanText(text(currentCompanyBtn)) ?? current?.company_name ?? fromHeadline.company;
  lead.company_linkedin_url = canonicalizeCompanyUrl(attr(currentCompanyBtn, "href")) ?? current?.company_linkedin_url ?? null;
  lead.title = current?.title ?? fromHeadline.title;
  lead.experience = experience;
  lead.education = opts.includeEducation === false ? [] : parseEducation(doc);

  if (opts.includeAbout !== false) {
    const aboutSection = sectionByAnchor(doc, "about");
    const aboutEl = aboutSection ? firstMatch(aboutSection, ['[data-lwe="about-text"]', ".inline-show-more-text", ".display-flex.full-width"]) : null;
    lead.about = truncate(cleanText(text(aboutEl)));
  }
  return lead;
}
