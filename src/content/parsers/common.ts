import { cleanName } from "../../shared/normalize";
import type { LeadRecord, ParseWarning } from "../../shared/types";

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
    full_name_raw: null,
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
    captured_at: now,
    parse_warnings: []
  };
}

/** Set full_name from rendered text, keeping the raw text when cleaning altered it. */
export function setName(lead: LeadRecord, rendered: string | null | undefined): void {
  const raw = cleanTextRaw(rendered);
  const cleaned = cleanName(rendered) ?? "";
  lead.full_name = cleaned;
  lead.full_name_raw = raw && raw !== cleaned ? raw : null;
}
function cleanTextRaw(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).replace(/\s+/g, " ").trim();
  return t.length ? t.slice(0, 300) : null;
}

export function warn(lead: LeadRecord, w: ParseWarning): void {
  if (!lead.parse_warnings.includes(w)) lead.parse_warnings.push(w);
}

/** Text nodes in document order, whitespace-normalized, consecutive duplicates
 *  removed. Robust where element-level selectors are not (hashed classes,
 *  whole-card links). */
export function textLines(root: Element): string[] {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const out: string[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const parent = (n as Text).parentElement;
    if (parent && /^(script|style|noscript|template)$/i.test(parent.tagName)) continue;
    const t = (n.nodeValue ?? "").replace(/[\u200B-\u200F]/g, "").replace(/\s+/g, " ").trim();
    if (t && out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

/** Headline like "VP Sales at Acme" -> { title: "VP Sales", company: "Acme" }.
 *  Also handles "@", " - ", " | ", " — " and "Company — Title" is NOT guessed
 *  (ambiguous). Returns nulls, never a wrong split, when unsure. */
export function splitHeadline(headline: string | null): { title: string | null; company: string | null } {
  if (!headline) return { title: null, company: null };
  const h = headline.replace(/\s+/g, " ").trim();
  // "Title at Company [| rest]" — the first "at" clause only.
  const at = h.match(/^(.{2,120}?)\s+(?:at|@)\s+([^|•·]{2,120}?)(?:\s*[|•·].*)?$/i);
  if (at && !/\b(at|@)\b/i.test(at[1])) return { title: at[1].trim(), company: at[2].trim() };
  // "Title - Company" / "Title – Company" / "Title | Company": only when both
  // halves look like short labels (no sentences) and the first half looks like a role.
  const sep = h.match(/^([^|•·–—-]{2,80}?)\s+[-–—|]\s+([^|•·–—-]{2,80}?)$/);
  if (sep && ROLE_WORD.test(sep[1]) && !ROLE_WORD.test(sep[2])) return { title: sep[1].trim(), company: sep[2].trim() };
  if (sep && ROLE_WORD.test(sep[2]) && !ROLE_WORD.test(sep[1])) return { title: sep[2].trim(), company: sep[1].trim() };
  return { title: null, company: null };
}

const ROLE_WORD = /\b(chief|officer|ceo|cto|cfo|coo|cro|cmo|cpo|ciso|vp|svp|evp|avp|president|vice|director|head|manager|lead|founder|co-founder|cofounder|partner|engineer|developer|designer|analyst|consultant|architect|specialist|associate|executive|account|sales|marketing|recruiter|owner|principal|scientist|advisor|intern|student|professor|teacher|nurse|doctor|physician|attorney|lawyer|counsel)\b/i;

/** Location-looking text: contains a comma-separated place or a region word,
 *  no digits, no role words. Conservative on purpose. */
const COMPANY_SUFFIX = /\b(Inc\.?|LLC|L\.L\.C\.|Ltd\.?|Limited|GmbH|AG|S\.A\.|SA|SAS|SARL|B\.V\.|BV|N\.V\.|Oy|AB|A\/S|Pty|PLC|Corp\.?|Corporation|Co\.|Company|Group|Holdings|Partners|Sons|Labs|Studio|Technologies|Software|Ventures|Capital)\s*$/i;

export function looksLikeLocation(t: string): boolean {
  if (!t || t.length < 2 || t.length > 80 || /\d/.test(t)) return false;
  if (ROLE_WORD.test(t) || /\b(at|@)\b/i.test(t) || COMPANY_SUFFIX.test(t)) return false;
  return /,\s/.test(t) || /\b(Area|Region|Metropolitan|Greater|United States|United Kingdom|Canada|Australia|India|Germany|France|Remote)\b/i.test(t);
}

/** Lines LinkedIn adds around a person that are never a headline or location. */
export const CHATTER_RE = /^(message|connect|follow|following|pending|view profile|save|open to work|hiring|premium|verified|more|see more|show more|share|\.\.\.|…)$|mutual connection|followers?$|^\(?(he|she|they)\/|^•\s*$|^·\s*$|\bin common\b|\bviewed your\b|^actively (hiring|recruiting)|^provides services/i;
