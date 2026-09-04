import type { EducationEntry, ExperienceEntry, LeadRecord } from "../../shared/types";
import { canonicalizeCompanyUrl, canonicalizeLinkedInUrl, cleanName, cleanText, parseConnectionDegree, slugFromCanonical, splitName, truncate } from "../../shared/normalize";
import { attr, emptyLead, firstMatch, looksLikeLocation, splitHeadline, text, warn } from "./common";

export function isProfilePath(pathname: string): boolean {
  return /^\/in\/[^/]+\/?$/.test(pathname);
}

/** Path of the page's own URL (the worker already verified its host). */
function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export interface ProfileParseOptions {
  includeExperience?: boolean;
  includeEducation?: boolean;
  includeAbout?: boolean;
  now?: string;
}

const DATE_RANGE = /(\b(19|20)\d{2}\b|\bPresent\b|\bheute\b|\bactuel\b|\bactualidad\b)/i;
const DURATION = /\b\d+\s*(yrs?|mos?|years?|months?|Jahre?|ans|años)\b/i;

function isDateLine(t: string): boolean {
  return DATE_RANGE.test(t) && (/[-–—]/.test(t) || /present|heute|actuel|actualidad/i.test(t) || DURATION.test(t)) && t.length < 80;
}

/* ---------------- classic layout (pre-2026, kept for fixtures/regions) ---------------- */

function sectionByAnchor(doc: Document, id: string): Element | null {
  const anchor = doc.getElementById(id);
  return anchor?.closest("section") ?? null;
}

function parseExperienceClassic(doc: Document, limit = 10): ExperienceEntry[] {
  const section = sectionByAnchor(doc, "experience");
  if (!section) return [];
  const items = Array.from(section.querySelectorAll<HTMLElement>('li[data-lwe="experience-item"], li.artdeco-list__item, li.pvs-list__paged-list-item'));
  const out: ExperienceEntry[] = [];
  for (const li of items.slice(0, limit)) {
    const titleEl = firstMatch(li, ['[data-lwe="title"]', ".t-bold", ".mr1.t-bold", "div.display-flex.align-items-center span[aria-hidden=true]"]);
    const companyEl = firstMatch(li, ['[data-lwe="company"]', ".t-14.t-normal:not(.t-black--light)", "span.t-14.t-normal"]);
    const dateEl = firstMatch(li, ['[data-lwe="dates"]', ".pvs-entity__caption-wrapper", ".t-14.t-normal.t-black--light"]);
    const locEl = firstMatch(li, ['[data-lwe="location"]']);
    const companyLink = li.querySelector<HTMLAnchorElement>('a[href*="/company/"]');
    const title = cleanText(text(titleEl));
    if (!title) continue;
    let company = cleanText(text(companyEl));
    if (company) company = company.split(/\s[·•]\s/)[0].trim();
    out.push({ title, company_name: company, company_linkedin_url: canonicalizeCompanyUrl(attr(companyLink, "href")), date_range: cleanText(text(dateEl)), location: cleanText(text(locEl)) });
  }
  return out;
}

function parseEducationClassic(doc: Document): EducationEntry[] {
  const section = sectionByAnchor(doc, "education");
  if (!section) return [];
  const items = Array.from(section.querySelectorAll<HTMLElement>('li[data-lwe="education-item"], li.artdeco-list__item, li.pvs-list__paged-list-item'));
  const out: EducationEntry[] = [];
  for (const li of items.slice(0, 5)) {
    const school = cleanText(text(firstMatch(li, ['[data-lwe="school"]', ".t-bold", ".mr1.t-bold"])));
    if (!school) continue;
    out.push({ school, degree: cleanText(text(firstMatch(li, ['[data-lwe="degree"]', ".t-14.t-normal:not(.t-black--light)"]))), date_range: cleanText(text(firstMatch(li, ['[data-lwe="dates"]', ".pvs-entity__caption-wrapper", ".t-14.t-normal.t-black--light"]))) });
  }
  return out;
}

function parseProfileClassic(doc: Document, pageUrl: string, opts: ProfileParseOptions, now: string): LeadRecord {
  const lead = emptyLead(now);
  const nameEl = firstMatch(doc, ['h1[data-lwe="name"]', "main h1", "h1.text-heading-xlarge", "h1"]);
  lead.full_name = cleanName(text(nameEl)) ?? "";
  if (!lead.full_name) {
    lead.full_name = cleanName(attr(doc.querySelector('meta[property="og:title"]'), "content")?.split(" - ")[0] ?? null) ?? cleanName((doc.title || "").replace(/\s*\|\s*LinkedIn\s*$/, "")) ?? "";
    if (lead.full_name) warn(lead, "name_from_title");
  }
  Object.assign(lead, splitName(lead.full_name));
  lead.headline = cleanText(text(firstMatch(doc, ['[data-lwe="headline"]', "main .text-body-medium.break-words", ".pv-text-details__left-panel .text-body-medium"])));
  lead.location = cleanText(text(firstMatch(doc, ['[data-lwe="location"]', "main .text-body-small.inline.t-black--light.break-words", ".pv-text-details__left-panel .text-body-small"])));
  if (!lead.location) warn(lead, "location_missing");
  lead.connection_degree = parseConnectionDegree(text(firstMatch(doc, ['[data-lwe="degree-badge"]', ".dist-value", "span.distance-badge"])));
  if (!lead.connection_degree) warn(lead, "degree_missing");
  lead.linkedin_url = canonicalizeLinkedInUrl(pageUrl) ?? canonicalizeLinkedInUrl(attr(doc.querySelector('link[rel="canonical"]'), "href")) ?? canonicalizeLinkedInUrl(safePath(pageUrl));
  lead.linkedin_slug = slugFromCanonical(lead.linkedin_url);
  const img = firstMatch(doc, ['img[data-lwe="photo"]', "main img.pv-top-card-profile-picture__image--show", "main img.pv-top-card-profile-picture__image", 'main img[alt$="profile photo"]', "main .pv-top-card img"]);
  lead.profile_image_url = attr(img, "src");

  // Precedence (documented in SPEC 4.3): the top-card "Current company"
  // control, then the first experience entry, then the headline.
  const currentCompanyBtn = firstMatch(doc, ['[data-lwe="current-company"]', 'button[aria-label^="Current company"]', 'main a[href*="/company/"][data-field="experience_company_logo"]']);
  // When history is excluded we still need the current role: read only the
  // first entry, not the whole list.
  const history = opts.includeExperience === false ? parseExperienceClassic(doc, 1) : parseExperienceClassic(doc);
  const current = history[0];
  const fromHeadline = splitHeadline(lead.headline);
  lead.company_name = cleanText(text(currentCompanyBtn)) ?? current?.company_name ?? fromHeadline.company;
  lead.company_linkedin_url = canonicalizeCompanyUrl(attr(currentCompanyBtn, "href")) ?? current?.company_linkedin_url ?? null;
  lead.title = current?.title ?? fromHeadline.title;
  if (!lead.company_name) warn(lead, "company_missing");
  if (!lead.title && lead.headline) warn(lead, "headline_unsplit");
  lead.experience = opts.includeExperience === false ? [] : history;
  lead.education = opts.includeEducation === false ? [] : parseEducationClassic(doc);
  if (opts.includeAbout !== false) {
    const aboutSection = sectionByAnchor(doc, "about");
    const aboutEl = aboutSection ? firstMatch(aboutSection, ['[data-lwe="about-text"]', ".inline-show-more-text", ".display-flex.full-width"]) : null;
    lead.about = truncate(cleanText(text(aboutEl)));
  }
  return lead;
}

/* ---------------- LinkedIn 2026 "SDUI" profile layout ----------------
 * Hashed class names, no <h1>, no section ids. Stable anchors are:
 *  - the top card: [id^="com.linkedin.sdui.profile.card."][id$="Topcard"]
 *  - <h2> section titles ("Experience", "Education", "About"; a few locales)
 *  - every Experience/Education line is a <p> inside an <a href="/company/…">
 *    or <a href="/school/…">; entries without a link are grouped by date line.
 */

const SECTION_LABELS: Record<"experience" | "education" | "about", RegExp> = {
  experience: /^(experience|berufserfahrung|expérience|experiencia|esperienza|ervaring|experiência)$/i,
  education: /^(education|ausbildung|formation|educación|formazione|opleiding|formação)$/i,
  about: /^(about|info|infos|à propos|acerca de|informazioni|over|sobre)$/i
};

function leaves(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).filter((e) => e.children.length === 0 && (e.textContent ?? "").trim().length > 0 && !/^(script|style|svg|noscript)$/i.test(e.tagName));
}

function sduiTopCard(doc: Document): Element | null {
  return Array.from(doc.querySelectorAll('[id^="com.linkedin.sdui.profile.card."]')).find((e) => /Topcard$/i.test(e.id)) ?? null;
}

export function isSdui(doc: Document): boolean {
  return !doc.querySelector("main h1") && !!sduiTopCard(doc);
}

function sduiSection(doc: Document, kind: keyof typeof SECTION_LABELS): Element | null {
  const h = Array.from(doc.querySelectorAll("main h2, main h3")).find((x) => SECTION_LABELS[kind].test((x.textContent ?? "").trim()));
  if (!h) return null;
  let c: Element | null = h;
  for (let k = 0; k < 10 && c?.parentElement; k++) {
    c = c.parentElement;
    if (c.id && c.id.startsWith("com.linkedin.sdui.profile.card")) break;
  }
  return c;
}

interface Group {
  href: string | null;
  lines: string[];
  anchored: boolean;
}

/** Group leaf lines into entries. Lines inside the same company/school link
 *  belong together; lines outside any link accumulate until a date line
 *  (plus an optional location) closes the entry. */
function sduiEntries(section: Element, headingEl: Element | null): Group[] {
  const out: Group[] = [];
  let current: (Group & { key: string }) | null = null;
  const closeUnanchored = (g: Group | null) => g && !g.anchored && g.lines.some(isDateLine);
  for (const el of leaves(section)) {
    if (/^h[1-6]$/i.test(el.tagName) && (el === headingEl || SECTION_LABELS.experience.test(el.textContent ?? "") || SECTION_LABELS.education.test(el.textContent ?? ""))) continue;
    if (/show all|see all|show more|see more|mehr anzeigen|voir plus/i.test(el.textContent ?? "")) continue;
    const a = el.closest("a");
    const href = a?.getAttribute("href") ?? null;
    const t = cleanText(el.textContent) ?? "";
    if (!t) continue;
    if (a) {
      const key = (a as HTMLAnchorElement).href || href || "";
      if (!current || current.key !== key) {
        current = { href, lines: [], anchored: true, key };
        out.push(current);
      }
      current.lines.push(t);
      continue;
    }
    // Unanchored line: continue the open unanchored group unless it is complete.
    if (!current || current.anchored || (closeUnanchored(current) && !looksLikeLocation(t))) {
      current = { href: null, lines: [], anchored: false, key: `noanchor:${out.length}` };
      out.push(current);
    }
    current.lines.push(t);
  }
  return out;
}

function entryFromGroup(g: Group): ExperienceEntry | null {
  const dateIdx = g.lines.findIndex(isDateLine);
  if (dateIdx < 1) return null;
  const title = g.lines[0];
  const company = dateIdx >= 2 ? g.lines.slice(1, dateIdx).find((l) => !looksLikeLocation(l)) ?? null : null;
  const after = g.lines.slice(dateIdx + 1);
  const location = after.find(looksLikeLocation) ?? null;
  return { title, company_name: company, company_linkedin_url: canonicalizeCompanyUrl(g.href), date_range: g.lines[dateIdx], location };
}

function sduiExperience(doc: Document, limit = 12): { entries: ExperienceEntry[]; uncertain: boolean } {
  const section = sduiSection(doc, "experience");
  if (!section) return { entries: [], uncertain: false };
  const heading = Array.from(section.querySelectorAll("h2, h3")).find((h) => SECTION_LABELS.experience.test((h.textContent ?? "").trim())) ?? null;
  const groups = sduiEntries(section, heading);
  const entries: ExperienceEntry[] = [];
  let uncertain = false;
  for (const g of groups.slice(0, limit * 2)) {
    const e = entryFromGroup(g);
    if (!e) {
      if (g.lines.length > 1) uncertain = true;
      continue;
    }
    if (!g.anchored) uncertain = true;
    entries.push(e);
    if (entries.length >= limit) break;
  }
  return { entries, uncertain };
}

function sduiEducation(doc: Document): EducationEntry[] {
  const section = sduiSection(doc, "education");
  if (!section) return [];
  const heading = Array.from(section.querySelectorAll("h2, h3")).find((h) => SECTION_LABELS.education.test((h.textContent ?? "").trim())) ?? null;
  const out: EducationEntry[] = [];
  for (const g of sduiEntries(section, heading).slice(0, 6)) {
    if (!g.lines.length) continue;
    const dateIdx = g.lines.findIndex((l) => DATE_RANGE.test(l) && l.length < 60);
    out.push({ school: g.lines[0], degree: dateIdx > 1 ? g.lines.slice(1, dateIdx).join(", ") : dateIdx === -1 && g.lines[1] ? g.lines[1] : null, date_range: dateIdx >= 0 ? g.lines[dateIdx] : null });
  }
  return out;
}

const DEGREE_LINE = /^[·•]?\s*(1st|2nd|3rd)\b/;

function parseProfileSdui(doc: Document, pageUrl: string, opts: ProfileParseOptions, now: string): LeadRecord {
  const lead = emptyLead(now);
  warn(lead, "sdui_layout");
  const top = sduiTopCard(doc)!;
  const ls = leaves(top);
  const nameEl = ls.find((e) => /^h[1-3]$/i.test(e.tagName)) ?? Array.from(top.querySelectorAll("h1, h2, h3"))[0] ?? null;
  lead.full_name = cleanName(nameEl?.textContent) ?? "";
  if (!lead.full_name) {
    lead.full_name = cleanName((doc.title || "").replace(/\s*\|\s*LinkedIn\s*$/, "")) ?? "";
    if (lead.full_name) warn(lead, "name_from_title");
  }
  Object.assign(lead, splitName(lead.full_name));

  // Ordered <p> lines after the name: degree badges, headline, current company, location, "·".
  const nameIdx = nameEl ? ls.indexOf(nameEl as HTMLElement) : -1;
  const contactIdx = ls.findIndex((e) => /contact info|kontaktinfo|coordonnées|información de contacto/i.test(e.textContent ?? ""));
  const between = ls
    .slice(nameIdx + 1, contactIdx > nameIdx ? contactIdx : undefined)
    .filter((e) => e.tagName.toLowerCase() === "p")
    .map((e) => cleanText(e.textContent) ?? "")
    .filter((t) => t && t !== "·" && t !== "•");
  const degrees = between.filter((t) => DEGREE_LINE.test(t));
  lead.connection_degree = parseConnectionDegree(degrees[0] ?? null);
  if (!lead.connection_degree) warn(lead, "degree_missing");
  const rest = between.filter((t) => !DEGREE_LINE.test(t) && !/^\d[\d,.]*\s*(followers|connections|abonnés|follower)/i.test(t));
  lead.headline = rest[0] ?? null;
  // Location is the last line before "Contact info" when it looks like one;
  // otherwise search the remaining lines and flag the guess.
  const last = rest.length >= 2 ? rest[rest.length - 1] : null;
  if (last && looksLikeLocation(last)) lead.location = last;
  else {
    const guess = rest.slice(1).find(looksLikeLocation) ?? null;
    lead.location = guess;
    warn(lead, guess ? "location_guessed" : "location_missing");
  }
  const companyLine = rest.length >= 3 && rest[1] !== lead.location ? rest[1] : null;

  lead.linkedin_url = canonicalizeLinkedInUrl(pageUrl) ?? canonicalizeLinkedInUrl(attr(doc.querySelector('link[rel="canonical"]'), "href")) ?? canonicalizeLinkedInUrl(safePath(pageUrl));
  lead.linkedin_slug = slugFromCanonical(lead.linkedin_url);
  const imgs = Array.from(top.querySelectorAll<HTMLImageElement>("img")).filter((i) => !/cover|banner|logo/i.test(i.alt ?? ""));
  const img = imgs.find((i) => lead.full_name && (i.alt ?? "").includes(lead.full_name)) ?? imgs.find((i) => /profile|photo|foto/i.test(i.alt ?? "")) ?? null;
  lead.profile_image_url = attr(img, "src");

  const exp = sduiExperience(doc, opts.includeExperience === false ? 1 : 12);
  if (exp.uncertain) warn(lead, "experience_grouping_uncertain");
  const current = exp.entries[0];
  const fromHeadline = splitHeadline(lead.headline);
  lead.title = current?.title ?? fromHeadline.title;
  lead.company_name = companyLine ?? current?.company_name ?? fromHeadline.company;
  lead.company_linkedin_url = current?.company_linkedin_url ?? null;
  if (!lead.company_name) warn(lead, "company_missing");
  if (!lead.title && lead.headline) warn(lead, "headline_unsplit");
  lead.experience = opts.includeExperience === false ? [] : exp.entries;
  lead.education = opts.includeEducation === false ? [] : sduiEducation(doc);
  if (opts.includeAbout !== false) {
    const about = sduiSection(doc, "about");
    lead.about = about ? truncate(cleanText(leaves(about).filter((e) => !/^h[1-6]$/i.test(e.tagName)).map((e) => e.textContent).join(" "))) : null;
  }
  return lead;
}

export function parseProfile(doc: Document, pageUrl: string, opts: ProfileParseOptions = {}): LeadRecord {
  const now = opts.now ?? new Date().toISOString();
  return isSdui(doc) ? parseProfileSdui(doc, pageUrl, opts, now) : parseProfileClassic(doc, pageUrl, opts, now);
}
